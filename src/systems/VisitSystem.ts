/**
 * VisitSystem — visites physiques des événements de la base (events.json → visit).
 *
 * Au lieu de s'ouvrir aussitôt, un événement de visite fait venir la délégation dans la vue FOB :
 *  - à pied depuis la piste (villageoise, informateur, déserteur) ;
 *  - en charrette ou en véhicule (ancien du village et ses hommes, société privée) : le véhicule
 *    roule jusqu'au point de rencontre, l'escorte marche à ses côtés ;
 *  - en hélicoptère (général, journaliste) : il se pose sur l'hélisurface (ou une zone dégagée),
 *    les passagers débarquent et rejoignent le point de rencontre.
 * Le dialogue s'ouvre à l'arrivée du chef de délégation devant le TOC (ou à l'entrée de la base).
 * Après le dialogue, les visiteurs restent un moment, puis repartent comme ils sont venus
 * (aussitôt en cas d'attaque).
 */
import type { EventVisitDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { GridPos, Vehicle, VisitState, Visitor } from '../core/GameState';
import { pushLog } from '../core/Log';
import { newId } from '../utils/ids';
import { BuildSystem } from './BuildSystem';
import type { System } from './System';

export class VisitSystem implements System {
  readonly id = 'visits';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('event:closed', ({ eventId }) => this.onEventClosed(eventId));
    ctx.bus.on('combat:started', () => this.leaveNow());
  }

  private get cfg() {
    return this.ctx.content.visitors.config;
  }

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private minutesToTicks(m: number): number {
    return Math.max(1, Math.round(m / this.ctx.content.balance.time.minutesPerTick));
  }

  get active(): VisitState | null {
    return this.ctx.hasGame ? (this.ctx.state.visit ?? null) : null;
  }

  private get nav() {
    return this.ctx.sim.agents.nav;
  }

  // ------------------------------------------------------------ Lieux

  /**
   * Point de rencontre : devant l'entrée du TOC s'il est dans une zone autorisée aux civils,
   * sinon à l'entrée de la base.
   */
  meetPoint(): GridPos {
    const s = this.ctx.state;
    this.nav.ensure();
    const toc = Object.values(s.fob.buildings).find((b) => b.defId === this.cfg.meetBuilding && (b.state === 'active' || b.state === 'damaged'));
    if (toc) {
      const def = this.ctx.content.building(toc.defId);
      const door = (def.entrance ? BuildSystem.entranceCells(def, toc.pos, toc.rot) : this.nav.accessCells(toc)).filter((c) => this.nav.walkable(c.x, c.y) && this.nav.civilAllowed(c.x, c.y));
      if (door.length) return door[Math.floor(door.length / 2)];
    }
    return this.ctx.sim.missions.departurePoint();
  }

  /**
   * Places libres de la zone de livraison (aire de déchargement), où se garent par défaut les
   * véhicules des visiteurs et des civils, si elle est accessible aux civils.
   */
  deliveryParking(): GridPos[] {
    const s = this.ctx.state;
    this.nav.ensure();
    const out: GridPos[] = [];
    for (const b of Object.values(s.fob.buildings)) {
      if (b.defId !== 'unloading_zone' || (b.state !== 'active' && b.state !== 'damaged')) continue;
      const slots = this.ctx.content.building(b.defId).services?.parking?.slots ?? 1;
      for (let i = 0; i < slots; i++) {
        const c = this.nav.parkingCell(b, i);
        if (!this.nav.drivable(c.x, c.y) || !this.nav.civilAllowed(c.x, c.y)) continue;
        const taken = Object.values(s.vehicles).some((v) => v.altitude <= 0 && Math.hypot(v.pos.x - (c.x + 0.5), v.pos.y - (c.y + 0.5)) < 1.2);
        if (!taken) out.push(c);
      }
    }
    return out;
  }

  /** Cases libres autour d'un point (anneaux successifs), pour l'escorte ou un véhicule. */
  private around(p: GridPos, ok: (x: number, y: number) => boolean, min = 1, max = 4): GridPos[] {
    const out: GridPos[] = [];
    for (let r = min; r <= max; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (ok(p.x + dx, p.y + dy)) out.push({ x: p.x + dx, y: p.y + dy });
        }
      }
      if (out.length >= 8) break;
    }
    return out;
  }

  /** Aire de poser : hélisurface libre, sinon une zone dégagée près du point de rencontre. */
  private landingSpot(meet: GridPos): { cell: GridPos; padId: string | null } {
    const s = this.ctx.state;
    const pad = Object.values(s.fob.buildings).find(
      (b) =>
        b.defId === 'helipad' &&
        (b.state === 'active' || b.state === 'damaged') &&
        !Object.values(s.vehicles).some((v) => v.targetId === b.id && this.ctx.content.vehicle(v.defId).kind === 'air'),
    );
    if (pad) return { cell: this.nav.parkingCell(pad, 0), padId: pad.id };
    // Zone dégagée assez large pour le rotor et le fuselage (5 × 5 cases sans bâtiment)
    const clear = (x: number, y: number): boolean => {
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (!this.nav.walkable(x + dx, y + dy) || this.ctx.sim.build.buildingAt({ x: x + dx, y: y + dy })) return false;
      return true;
    };
    const spots = this.around(meet, clear, 5, 14);
    return { cell: spots[0] ?? meet, padId: null };
  }

  // ------------------------------------------------------------ Arrivée

  /** Fait venir la délégation d'un événement de visite. Renvoie false si impossible. */
  begin(eventId: string): boolean {
    const s = this.ctx.state;
    const def = this.ctx.content.event(eventId);
    const visit = def.visit;
    if (!visit || s.visit) return false;
    this.nav.ensure();
    const speaker = this.ctx.content.events.speakers[def.speaker];
    const name = speaker?.name ?? speaker?.role ?? def.title;
    const meet = this.meetPoint();
    const entry = s.fob.entry;
    let mode = visit.mode;
    let vehicleId: string | null = null;
    let landing: GridPos | null = null;

    const visitors: Visitor[] = [this.makeVisitor(visit.leader, name, entry, true)];
    for (const e of visit.escort) for (let i = 0; i < e.count; i++) visitors.push(this.makeVisitor(e.visual, null, entry, false));

    if (mode === 'cart' || mode === 'vehicle') {
      // Stationnement : zone de livraison, sinon près du point de rencontre (zones autorisées)
      const parking = this.deliveryParking();
      const goals = parking.length ? parking : this.around(meet, (x, y) => this.nav.drivable(x, y) && this.nav.civilAllowed(x, y), 1, 5);
      const path = goals.length ? this.nav.findCivilPath(entry, goals, true) : null;
      if (path) {
        const v = this.ctx.sim.supply.spawnVisitVehicle(visit.vehicle ?? 'cart', entry);
        v.path = path;
        v.state = 'inbound';
        vehicleId = v.id;
        visitors[0].riding = true;
      } else mode = 'foot';
    }
    if (mode === 'helicopter') {
      const spot = this.landingSpot(meet);
      landing = spot.cell;
      const v = this.ctx.sim.supply.spawnVisitVehicle(this.cfg.heliVehicle, entry);
      v.path = [spot.cell];
      v.state = 'inbound';
      v.targetId = spot.padId;
      vehicleId = v.id;
      for (const p of visitors) p.riding = true;
    }
    s.visit = {
      eventId,
      mode,
      phase: 'arriving',
      name,
      vehicleId,
      visitors,
      meet,
      landing,
      untilTick: this.now + this.minutesToTicks(this.cfg.maxWaitHours * 60),
      startedTick: this.now,
    };
    // Les marcheurs se mettent en route (l'escorte d'une charrette marche à son pas)
    for (const p of visitors) if (!p.riding) this.walkTo(p, p.leader ? [meet] : this.escortGoals(meet));
    pushLog(this.ctx, 'info', mode === 'helicopter' ? 'log.visitHelicopter' : 'log.visitArriving', { name });
    this.ctx.bus.emit('visit:started', { eventId });
    return true;
  }

  private makeVisitor(visual: string, name: string | null, at: GridPos, leader: boolean): Visitor {
    const pos = { x: at.x + 0.5, y: at.y + 0.5 };
    return { id: newId(this.ctx.state, 'vis'), visual, name, pos, prevPos: { ...pos }, path: [], leader, riding: false, gone: false, nextWander: 0 };
  }

  private escortGoals(meet: GridPos): GridPos[] {
    const cells = this.around(meet, (x, y) => this.nav.walkable(x, y) && this.nav.civilAllowed(x, y), 1, 3);
    return cells.length ? cells : [meet];
  }

  private walkTo(p: Visitor, goals: GridPos[]): void {
    const start = { x: Math.floor(p.pos.x), y: Math.floor(p.pos.y) };
    // Les visiteurs ne passent pas les portes interdites aux civils
    const path = this.nav.findCivilPath(start, goals) ?? this.nav.findPath(start, goals);
    if (path) p.path = path;
    else {
      // Inaccessible : le visiteur apparaît sur place (base entièrement close)
      const g = goals[0];
      p.pos = { x: g.x + 0.5, y: g.y + 0.5 };
      p.prevPos = { ...p.pos };
      p.path = [];
    }
  }

  // ------------------------------------------------------------ Simulation

  onTick(): void {
    const v = this.active;
    if (!v) return;
    const s = this.ctx.state;
    for (const p of v.visitors) p.prevPos = { ...p.pos };
    const veh = v.vehicleId ? s.vehicles[v.vehicleId] : undefined;

    // Véhicule de la délégation
    if (veh && (veh.state === 'inbound' || veh.state === 'outbound')) {
      const done = this.ctx.sim.supply.driveStep(veh);
      if (done && veh.state === 'inbound') this.vehicleArrived(v, veh);
      else if (done) {
        delete s.vehicles[veh.id];
        v.vehicleId = null;
      }
    }
    // Les passagers suivent leur véhicule
    if (veh) for (const p of v.visitors) if (p.riding) p.pos = { x: veh.pos.x, y: veh.pos.y };

    // Marcheurs (chacun à son pas, légèrement différent, pour ne pas marcher en file parfaite)
    const base = this.cfg.walkSpeed * this.ctx.content.balance.time.minutesPerTick;
    v.visitors.forEach((p, i) => {
      if (!p.riding && !p.gone) this.walk(p, base * (1 - (i % 4) * 0.06));
    });

    switch (v.phase) {
      case 'arriving': {
        const leader = v.visitors.find((p) => p.leader)!;
        const arrived = !leader.riding && leader.path.length === 0;
        if ((arrived || this.now > v.untilTick) && this.ctx.sim.events.start(v.eventId)) {
          v.phase = 'meeting';
          pushLog(this.ctx, 'info', 'log.visitArrived', { name: v.name });
        }
        break;
      }
      case 'staying':
        if (this.now >= v.untilTick || s.combat.active) this.leave(v);
        else this.wander(v);
        break;
      case 'leaving':
        this.updateLeaving(v);
        break;
      default:
        break;
    }
  }

  private walk(p: Visitor, speed: number): void {
    let budget = speed;
    while (budget > 0 && p.path.length > 0) {
      const next = p.path[0];
      const tx = next.x + 0.5;
      const ty = next.y + 0.5;
      const dx = tx - p.pos.x;
      const dy = ty - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        p.pos = { x: tx, y: ty };
        p.path.shift();
        budget -= d;
      } else {
        p.pos = { x: p.pos.x + (dx / d) * budget, y: p.pos.y + (dy / d) * budget };
        budget = 0;
      }
    }
  }

  /** Le véhicule est arrivé : le chef descend de la charrette, les passagers de l'hélicoptère débarquent. */
  private vehicleArrived(v: VisitState, veh: Vehicle): void {
    veh.state = 'unloading';
    veh.altitude = 0;
    for (const p of v.visitors) {
      if (!p.riding) continue;
      p.riding = false;
      p.pos = { x: veh.pos.x, y: veh.pos.y };
      p.prevPos = { ...p.pos };
      this.walkTo(p, p.leader ? [v.meet] : this.escortGoals(v.meet));
    }
  }

  private onEventClosed(eventId: string): void {
    const v = this.active;
    if (!v || v.eventId !== eventId || v.phase !== 'meeting') return;
    const visit = this.ctx.content.event(eventId).visit as EventVisitDef;
    v.phase = 'staying';
    v.untilTick = this.now + this.minutesToTicks(visit.stayMinutes);
    if (this.ctx.state.combat.active) this.leave(v);
  }

  /** Pendant le séjour, les visiteurs se promènent dans les zones de la base qui leur sont autorisées. */
  private wander(v: VisitState): void {
    for (const p of v.visitors) {
      if (p.riding || p.gone || p.path.length > 0 || this.now < p.nextWander) continue;
      p.nextWander = this.now + this.minutesToTicks(this.cfg.wanderEveryMin * (0.6 + this.ctx.random() * 0.8));
      const cell = this.nav.randomCivilCellNear(v.meet, this.cfg.wanderRadius, () => this.ctx.random());
      if (cell) this.walkTo(p, [cell]);
    }
  }

  /** Attaque contre la base : les visiteurs s'en vont sans attendre (le dialogue en cours se termine d'abord). */
  private leaveNow(): void {
    const v = this.active;
    if (v && (v.phase === 'staying' || v.phase === 'arriving')) this.leave(v);
  }

  private leave(v: VisitState): void {
    const s = this.ctx.state;
    v.phase = 'leaving';
    const veh = v.vehicleId ? s.vehicles[v.vehicleId] : undefined;
    pushLog(this.ctx, 'info', 'log.visitLeaving', { name: v.name });
    for (const p of v.visitors) {
      if (p.riding) continue;
      const exit: GridPos =
        veh && v.mode === 'helicopter'
          ? { x: Math.floor(veh.pos.x), y: Math.floor(veh.pos.y) }
          : veh && p.leader
            ? { x: Math.floor(veh.pos.x), y: Math.floor(veh.pos.y) }
            : s.fob.entry;
      this.walkTo(p, [exit]);
    }
  }

  private updateLeaving(v: VisitState): void {
    const s = this.ctx.state;
    const veh = v.vehicleId ? s.vehicles[v.vehicleId] : undefined;
    const entry = s.fob.entry;
    for (const p of v.visitors) {
      if (p.riding || p.gone || p.path.length > 0) continue;
      const near = (q: { x: number; y: number }): boolean => Math.abs(p.pos.x - q.x) < 1.6 && Math.abs(p.pos.y - q.y) < 1.6;
      if (veh && (v.mode === 'helicopter' || p.leader) && near(veh.pos)) p.riding = true;
      else if (near({ x: entry.x + 0.5, y: entry.y + 0.5 }) || !veh) p.gone = true;
      else this.walkTo(p, [entry]); // trajet interrompu : on repart vers la sortie
    }
    // Le véhicule repart quand ses passagers sont à bord
    if (veh && veh.state === 'unloading') {
      const waiting = v.visitors.filter((p) => !p.gone && !p.riding && (v.mode === 'helicopter' || p.leader));
      if (waiting.length === 0) {
        veh.state = 'outbound';
        if (this.ctx.content.vehicle(veh.defId).kind !== 'air') {
          const path = this.nav.findVehiclePath({ x: Math.floor(veh.pos.x), y: Math.floor(veh.pos.y) }, [entry]);
          veh.path = path ?? [];
        } else veh.path = [];
        veh.targetId = null;
      }
    }
    if (!v.vehicleId) for (const p of v.visitors) if (p.riding) p.gone = true;
    if (v.visitors.every((p) => p.gone) && !v.vehicleId) {
      s.visit = null;
      this.ctx.bus.emit('visit:ended', { eventId: v.eventId });
    }
  }
}
