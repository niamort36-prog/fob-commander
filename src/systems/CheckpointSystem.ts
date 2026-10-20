/**
 * CheckpointSystem — va-et-vient des civils à la base et fouille au poste de garde.
 *
 * De jour, des civils (ouvriers, marchands, paysans…) viennent à la base à pied ou en véhicule
 * (pick-up, camion décoré). Ils s'arrêtent au poste de garde le plus proche de l'entrée pour être
 * fouillés, puis entrent jusqu'au TOC, y restent un moment et repartent.
 *
 * Parmi eux se cachent parfois des menaces (visitors.json → traffic.threats) :
 *  - un tireur qui ouvre le feu une fois dans l'enceinte (attaque « insider ») ;
 *  - un porteur de ceinture explosive qui se fait sauter près d'un groupe de soldats ;
 *  - une voiture piégée qui explose au cœur de la base.
 * La fouille les démasque selon le niveau du poste et la présence d'une sentinelle
 * (buildings.json → guard_post → checkpoint). Une menace arrêtée rapporte une prime et du moral ;
 * un engin démasqué peut tout de même exploser au poste (moins souvent si le poste est équipé).
 */
import type { ThreatKind } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { BuildingInstance, Entrant, GridPos, Id, Vehicle } from '../core/GameState';
import { emptyCheckpoint } from '../core/GameState';
import { pushLog } from '../core/Log';
import { gain } from '../core/resources';
import { newId } from '../utils/ids';
import type { System } from './System';

export class CheckpointSystem implements System {
  readonly id = 'checkpoint';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('combat:started', () => this.evacuate());
  }

  private get cfg() {
    return this.ctx.content.visitors.traffic;
  }

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private get nav() {
    return this.ctx.sim.agents.nav;
  }

  private ticks(minutes: number): number {
    return Math.max(1, Math.round(minutes / this.ctx.content.balance.time.minutesPerTick));
  }

  private rand(min: number, max: number): number {
    return min + this.ctx.random() * (max - min);
  }

  get state() {
    this.ctx.state.checkpoint ??= emptyCheckpoint();
    return this.ctx.state.checkpoint;
  }

  // ------------------------------------------------------------ Pression ennemie

  /**
   * Pression ennemie autour de la FOB (0..1) : emprise insurgée des villages proches et groupes
   * ennemis dans les environs (cellules, poseurs d'engins, mortiers), pondérés par leurs effectifs
   * et leur proximité.
   */
  pressure(): { value: number; influence: number; groups: number } {
    const p = this.cfg.pressure;
    const s = this.ctx.state;
    const fob = this.ctx.site.regionPos;
    const d = (a: { x: number; y: number }): number => Math.hypot(a.x - fob.x, a.y - fob.y);
    // Emprise insurgée moyenne des villages proches (pondérée par la proximité)
    let wSum = 0;
    let infSum = 0;
    for (const v of this.ctx.content.region.villages) {
      const dist = d(v.pos);
      if (dist > p.nearKm) continue;
      const w = 1 - (dist / p.nearKm) * 0.6;
      wSum += w;
      infSum += w * (s.region.villages[v.id]?.influence ?? 0);
    }
    const influence = wSum > 0 ? infSum / wSum / 100 : 0;
    // Groupes ennemis dans les environs
    let groups = 0;
    let weight = 0;
    for (const c of Object.values(s.region.contacts)) {
      const k = p.contactWeights[this.ctx.sim.world.kindOf(c)];
      if (!k) continue;
      const dist = d(c.truePos);
      if (dist > p.contactKm) continue;
      groups++;
      weight += k * (c.strength ?? 1) * (1 - (dist / p.contactKm) * 0.7);
    }
    const contacts = Math.min(1, weight / p.contactsFull);
    const value = Math.max(0, Math.min(1, p.influenceShare * influence + (1 - p.influenceShare) * contacts));
    return { value, influence, groups };
  }

  /** Niveau de la pression ennemie : 0 faible, 1 moyenne, 2 forte. */
  pressureLevel(value = this.pressure().value): 0 | 1 | 2 {
    const [a, b] = this.cfg.pressure.levels;
    return value >= b ? 2 : value >= a ? 1 : 0;
  }

  private lerp(range: [number, number], k: number): number {
    return range[0] + (range[1] - range[0]) * Math.max(0, Math.min(1, k));
  }

  // ------------------------------------------------------------ Poste de contrôle

  private operational(b: BuildingInstance): boolean {
    return b.state === 'active' || b.state === 'damaged';
  }

  /** Poste de garde où les civils sont fouillés : le plus proche de l'entrée de la base. */
  post(): BuildingInstance | null {
    const entry = this.ctx.state.fob.entry;
    let best: BuildingInstance | null = null;
    let bestD = Infinity;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (!this.operational(b) || !this.ctx.content.building(b.defId).checkpoint) continue;
      const d = Math.hypot(b.pos.x - entry.x, b.pos.y - entry.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** Une sentinelle est à son poste dans cette guérite. */
  manned(post: BuildingInstance): boolean {
    return Object.values(this.ctx.state.agents).some((a) => a.activity?.id === 'guard' && a.activity.stage === 'acting' && a.activity.targetId === post.id);
  }

  /** Chance de démasquer une menace à la fouille dans ce poste (0..1). */
  detectChance(post: BuildingInstance | null): number {
    if (!post) return this.cfg.detectNoPost;
    const cp = this.ctx.sim.build.stats(post).checkpoint;
    if (!cp) return this.cfg.detectNoPost;
    return Math.max(this.cfg.detectNoPost, cp.detect * (this.manned(post) ? 1 : this.cfg.unmannedMult));
  }

  /** Case d'attente devant la guérite, côté extérieur (vers l'entrée de la base). */
  private checkCell(post: BuildingInstance, vehicle: boolean): GridPos | null {
    const entry = this.ctx.state.fob.entry;
    const ok = (x: number, y: number): boolean => (vehicle ? this.nav.drivable(x, y) : this.nav.walkable(x, y));
    const max = vehicle ? 3 : 2;
    for (let r = 1; r <= max; r++) {
      let best: GridPos | null = null;
      let bestD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = post.pos.x + dx;
          const y = post.pos.y + dy;
          if (!ok(x, y) || this.nav.gateAt(x, y)) continue;
          const d = Math.hypot(x - entry.x, y - entry.y);
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Destination dans la base : devant le TOC (ou au centre). */
  private destination(vehicle: boolean): GridPos[] {
    const meet = this.ctx.sim.visits.meetPoint();
    const out: GridPos[] = [];
    for (let r = vehicle ? 1 : 0; r <= (vehicle ? 5 : 3); r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = meet.x + dx;
          const y = meet.y + dy;
          if (vehicle ? this.nav.drivable(x, y) : this.nav.walkable(x, y)) out.push({ x, y });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ Arrivées

  onTick(): void {
    if (!this.ctx.hasGame) return;
    const s = this.ctx.state;
    const cp = this.state;
    for (const e of cp.entrants) e.prevPos = { ...e.pos };
    const hour = s.time.minuteOfDay / 60;
    const [h0, h1] = this.cfg.hours;
    if (!s.combat.active && hour >= h0 && hour < h1 && this.now >= cp.nextTick) {
      cp.nextTick = this.now + this.ticks(this.rand(this.cfg.intervalMin[0], this.cfg.intervalMin[1]));
      if (cp.entrants.filter((e) => e.phase !== 'detained').length < this.cfg.maxEntrants) this.spawn();
    }
    for (const e of [...cp.entrants]) this.update(e);
  }

  /** Tire au hasard le type de menace cachée parmi les arrivants (null : civil ordinaire). */
  private rollThreat(): ThreatKind | null {
    const s = this.ctx.state;
    if (s.time.day <= this.cfg.graceDays) return null;
    const threat = this.ctx.site.threat * this.ctx.sim.diplomacy.threatMult() * this.lerp(this.cfg.pressure.freqMult, this.pressure().value);
    if (this.ctx.random() >= this.cfg.threatChance * threat) return null;
    const kinds = Object.entries(this.cfg.threats) as [ThreatKind, { weight: number }][];
    let r = this.ctx.random() * kinds.reduce((t, [, k]) => t + k.weight, 0);
    for (const [id, k] of kinds) {
      r -= k.weight;
      if (r <= 0) return id;
    }
    return kinds[0][0];
  }

  /** Fait venir un civil (ou une menace déguisée). Renvoie l'arrivant, ou null si la base est inaccessible. */
  spawn(threat: ThreatKind | null = this.rollThreat(), forceVehicle?: boolean): Entrant | null {
    this.nav.ensure();
    const vehicle = forceVehicle ?? (threat ? !this.cfg.threats[threat].foot : this.ctx.random() < this.cfg.vehicleChance);
    const e = this.plan(threat, vehicle) ?? (vehicle && !threat ? this.plan(null, false) : null);
    if (e) this.state.entrants.push(e);
    return e;
  }

  private plan(threat: ThreatKind | null, vehicle: boolean): Entrant | null {
    const s = this.ctx.state;
    const post = this.post();
    const check = post ? this.checkCell(post, vehicle) : null;
    const dests = this.destination(vehicle);
    const entry = s.fob.entry;
    const find = (from: GridPos, goals: GridPos[]): GridPos[] | null => (vehicle ? this.nav.findVehiclePath(from, goals) : this.nav.findPath(from, goals));
    // Trajet jusqu'au poste (s'il existe), sinon directement jusqu'au TOC
    const first = check ? find(entry, [check]) : dests.length ? find(entry, dests) : null;
    if (!first || first.length === 0) return null;
    const cells = vehicle ? this.cfg.approachCells.vehicle : this.cfg.approachCells.foot;
    const startIdx = Math.max(0, first.length - 1 - cells);
    const start = first[startIdx];
    const path = first.slice(startIdx + 1);
    const pos = { x: start.x + 0.5, y: start.y + 0.5 };
    const walkers = this.cfg.walkers;
    const e: Entrant = {
      id: newId(s, 'civ'),
      visual: walkers[Math.floor(this.ctx.random() * walkers.length)],
      threat,
      vehicleId: null,
      pos,
      prevPos: { ...pos },
      path,
      phase: check ? 'approach' : 'inside',
      postId: check && post ? post.id : null,
      checkCell: check,
      dest: check ? check : (path[path.length - 1] ?? start),
      exit: { ...start },
      until: 0,
      searched: false,
      power: threat ? this.pressure().value : undefined,
    };
    if (vehicle) {
      const ids = this.cfg.vehicles;
      const v = this.ctx.sim.supply.spawnVisitVehicle(ids[Math.floor(this.ctx.random() * ids.length)], start);
      v.civilian = true;
      v.path = path;
      v.state = 'inbound';
      e.vehicleId = v.id;
      e.path = [];
    }
    // Base sans poste de garde : un soldat remarque parfois quelque chose d'anormal
    if (!check && threat && this.ctx.random() < this.cfg.detectNoPost * this.stealth(e)) {
      e.searched = true;
      e.until = -1; // démasqué à l'arrivée dans le périmètre
    }
    return e;
  }

  // ------------------------------------------------------------ Simulation

  private vehicleOf(e: Entrant): Vehicle | undefined {
    return e.vehicleId ? this.ctx.state.vehicles[e.vehicleId] : undefined;
  }

  /** Avance d'un pas ; renvoie true à l'arrivée. */
  private move(e: Entrant): boolean {
    const v = this.vehicleOf(e);
    if (e.vehicleId) {
      if (!v) return true;
      const done = v.path.length === 0 || this.ctx.sim.supply.driveStep(v);
      e.pos = { x: v.pos.x, y: v.pos.y };
      return done;
    }
    let budget = this.ctx.content.visitors.config.walkSpeed * this.ctx.content.balance.time.minutesPerTick;
    while (budget > 0 && e.path.length > 0) {
      const next = e.path[0];
      const tx = next.x + 0.5;
      const ty = next.y + 0.5;
      const dx = tx - e.pos.x;
      const dy = ty - e.pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        e.pos = { x: tx, y: ty };
        e.path.shift();
        budget -= d;
      } else {
        e.pos = { x: e.pos.x + (dx / d) * budget, y: e.pos.y + (dy / d) * budget };
        budget = 0;
      }
    }
    return e.path.length === 0;
  }

  private setPath(e: Entrant, goals: GridPos[]): boolean {
    if (!goals.length) return false;
    const v = this.vehicleOf(e);
    const from = { x: Math.floor(e.pos.x), y: Math.floor(e.pos.y) };
    const path = v ? this.nav.findVehiclePath(from, goals) : this.nav.findPath(from, goals);
    if (!path) return false;
    if (v) v.path = path;
    else e.path = path;
    return true;
  }

  private inZone(e: Entrant): boolean {
    const z = this.ctx.state.fob.zone;
    return e.pos.x >= z.x && e.pos.y >= z.y && e.pos.x < z.x + z.width && e.pos.y < z.y + z.height;
  }

  private update(e: Entrant): void {
    if (e.vehicleId && !this.vehicleOf(e)) return this.remove(e);
    switch (e.phase) {
      case 'approach':
        if (this.move(e)) {
          e.phase = 'search';
          e.until = this.now + this.ticks(e.vehicleId ? this.cfg.searchMin.vehicle : this.cfg.searchMin.foot);
        }
        break;
      case 'search':
        if (this.now >= e.until) this.endSearch(e);
        break;
      case 'inside': {
        // Démasqué par une patrouille (base sans poste de garde)
        if (e.until === -1 && this.inZone(e)) return this.caught(e);
        const arrived = this.move(e);
        if (e.threat === 'vest' && this.inZone(e) && this.agentsNear(e.pos, 2.5) >= this.cfg.vest.triggerAgents) return this.detonate(e, false);
        if (!arrived) break;
        if (e.threat === 'gunman') return this.openFire(e);
        if (e.threat === 'vbied') return this.detonate(e, false);
        e.phase = 'business';
        e.until = this.now + this.ticks(e.threat === 'vest' ? this.cfg.vest.waitMin : this.rand(this.cfg.stayMin[0], this.cfg.stayMin[1]));
        break;
      }
      case 'business':
        if (e.threat === 'vest' && (this.now >= e.until || this.agentsNear(e.pos, 2.5) >= this.cfg.vest.triggerAgents)) return this.detonate(e, false);
        if (this.now >= e.until) this.leave(e);
        break;
      case 'leaving':
        if (this.move(e)) this.remove(e);
        break;
      case 'detained':
        if (this.now >= e.until) this.remove(e);
        break;
      default:
        break;
    }
  }

  private agentsNear(p: { x: number; y: number }, r: number): number {
    let n = 0;
    for (const a of Object.values(this.ctx.state.agents)) if (a.status === 'on_base' && Math.hypot(a.pos.x - p.x, a.pos.y - p.y) <= r) n++;
    return n;
  }

  /** Fin de la fouille : menace démasquée ou passage autorisé vers l'intérieur. */
  private endSearch(e: Entrant): void {
    const cp = this.state;
    cp.stats.searched++;
    e.searched = true;
    const post = e.postId ? this.ctx.state.fob.buildings[e.postId] : null;
    if (e.threat && this.ctx.random() < this.detectChance(post ?? null) * this.stealth(e)) return this.caught(e);
    e.phase = 'inside';
    // Destination dans la base ; si le véhicule ne peut pas entrer, l'affaire se règle au poste
    const dests = this.destination(!!e.vehicleId);
    if (!this.setPath(e, dests)) {
      if (e.threat === 'vbied') return this.detonate(e, false);
      e.phase = 'business';
      e.until = this.now + this.ticks(this.rand(this.cfg.stayMin[0], this.cfg.stayMin[1]) / 2);
      return;
    }
    const v = this.vehicleOf(e);
    const path = v ? v.path : e.path;
    e.dest = path[path.length - 1] ?? e.dest;
  }

  /** Discrétion de la menace : un réseau bien implanté prépare mieux ses hommes (multiplicateur de détection). */
  private stealth(e: Entrant): number {
    return this.stealthAt(e.power ?? 0);
  }

  stealthAt(power: number): number {
    return this.lerp(this.cfg.pressure.stealth, power);
  }

  // ------------------------------------------------------------ Issues

  private rewardMorale(delta: number): void {
    for (const a of Object.values(this.ctx.state.agents)) a.needs.morale = Math.max(0, Math.min(100, a.needs.morale + delta));
  }

  /** Menace démasquée : arrestation (prime, moral), ou explosion au poste pour un engin. */
  private caught(e: Entrant): void {
    const s = this.ctx.state;
    const threat = e.threat!;
    const post = e.postId ? s.fob.buildings[e.postId] : null;
    if (threat !== 'gunman') {
      const cpDef = post ? this.ctx.sim.build.stats(post).checkpoint : null;
      const risk = cpDef?.detonate ?? 0.5;
      if (this.ctx.random() < risk) return this.detonate(e, true);
    }
    // Réseau plus actif : capture plus précieuse (renseignement, prime)
    const reward = this.cfg.reward[threat];
    const funds = Math.round(reward.funds * (1 + 0.5 * (e.power ?? 0)));
    gain(s, { funds });
    this.rewardMorale(reward.morale);
    this.state.stats.caught++;
    // La sentinelle qui a démasqué la menace gagne de l'expérience
    for (const a of Object.values(s.agents)) {
      if (post && a.activity?.id === 'guard' && a.activity.stage === 'acting' && a.activity.targetId === post.id) this.ctx.sim.career.gain(a, this.ctx.content.balance.career.checkpointCatchXp);
    }
    pushLog(this.ctx, 'good', `log.cp.caught.${threat}`, { funds });
    this.ctx.bus.emit('checkpoint:caught', { x: e.pos.x, y: e.pos.y });
    e.phase = 'detained';
    e.path = [];
    const v = this.vehicleOf(e);
    if (v) v.path = [];
    e.until = this.now + this.ticks(this.cfg.detainMin);
  }

  /** Le tireur sort son arme dans l'enceinte : il devient un assaillant. */
  private openFire(e: Entrant): void {
    this.state.stats.missed++;
    this.rewardMorale(this.cfg.missedMorale / 2);
    // Pression forte : il n'est pas seul, d'autres hommes armés surgissent avec lui
    const [g0, g1] = this.cfg.pressure.gunmen;
    const n = Math.min(g1, g0 + Math.floor(this.ctx.random() * (1 + (e.power ?? 0) * (g1 - g0))));
    pushLog(this.ctx, 'bad', n > 1 ? 'log.cp.missed.gunmen' : 'log.cp.missed.gunman', { n });
    const at = { x: Math.floor(e.pos.x), y: Math.floor(e.pos.y) };
    this.remove(e);
    this.ctx.sim.attacks.startInsider(at, n);
  }

  /** Explosion d'une ceinture ou d'une voiture piégée (au poste si l'engin a été démasqué). */
  private detonate(e: Entrant, atCheckpoint: boolean): void {
    const threat = e.threat === 'vbied' ? 'vbied' : 'vest';
    const def = threat === 'vbied' ? this.cfg.vbied : this.cfg.vest;
    const mult = (atCheckpoint ? this.cfg.caughtBlastMult : 1) * this.lerp(this.cfg.pressure.powerMult, e.power ?? 0);
    const v = this.vehicleOf(e);
    const p = v ? { ...v.pos } : { ...e.pos };
    this.remove(e);
    const { kia, wounded } = this.ctx.sim.attacks.blast(p.x, p.y, def, mult);
    this.state.stats.missed += atCheckpoint ? 0 : 1;
    if (atCheckpoint) this.state.stats.caught++;
    this.rewardMorale(atCheckpoint ? this.cfg.missedMorale / 2 : this.cfg.missedMorale);
    pushLog(this.ctx, 'bad', `log.cp.${atCheckpoint ? 'blastPost' : 'missed'}.${threat}`, { kia, wounded });
  }

  private leave(e: Entrant): void {
    e.phase = 'leaving';
    const v = this.vehicleOf(e);
    if (v) v.state = 'outbound';
    if (!this.setPath(e, [e.exit])) this.remove(e);
  }

  private remove(e: Entrant): void {
    const s = this.ctx.state;
    if (e.vehicleId) delete s.vehicles[e.vehicleId];
    this.state.entrants = this.state.entrants.filter((x) => x.id !== e.id);
  }

  /** Attaque contre la base : les civils s'en vont (les menaces cachées renoncent). */
  private evacuate(): void {
    if (!this.ctx.hasGame) return;
    for (const e of [...this.state.entrants]) {
      if (e.phase === 'detained' || e.phase === 'leaving') continue;
      this.leave(e);
    }
  }

  /** Arrivants dont le véhicule est celui-ci (pour l'affichage). */
  entrantOfVehicle(id: Id): Entrant | undefined {
    return this.state.entrants.find((e) => e.vehicleId === id);
  }
}
