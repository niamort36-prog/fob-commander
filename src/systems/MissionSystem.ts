/**
 * MissionSystem — missions hors de la FOB.
 *
 * Cycle : préparation (les soldats rejoignent le point de départ, les véhicules prennent la piste)
 * → trajet aller → objectif → trajet retour → retour à la base et compte rendu.
 * La chance de succès est estimée à la préparation (compétences, effectif, renseignement,
 * dotation, véhicules) puis modifiée par les réponses aux messages radio (RadioSystem).
 * La résolution détermine le résultat, les pertes, les gains et les effets sur la carte.
 */
import type { Command } from '../core/Commands';
import type { LoadoutDef, MissionEffects, MissionTypeDef, SupportDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { MapSelection } from '../core/GameEvents';
import type { Agent, BuildingInstance, GridPos, Id, KmPos, MissionInstance, MissionResult, MissionTarget, ResourceBag, Vehicle } from '../core/GameState';
import { pushLog } from '../core/Log';
import { bagEntries, canAfford, gain, spend } from '../core/resources';
import { formatClock, formatNumber, t } from '../utils/i18n';
import { newId } from '../utils/ids';
import type { System } from './System';
import { commsOf, commsPenalty, gearMissionBonus, hourAt, isNightHour } from './modules';
import { gridRefOf } from './WorldSystem';

export interface MissionPlan {
  typeId: string;
  target: MissionTarget;
  memberIds: Id[];
  vehicleIds: Id[];
  loadout: string;
  /** Appui feu (missions.json support) ; absent ou « none » = aucun. */
  support?: string;
  /** Hélicoptère de transport de la base (héliportage). */
  heliId?: string;
}

export type SupportBlock = 'requires' | 'range' | 'cooldown' | 'hours' | 'resources' | 'vehicle';

export interface MissionEstimate {
  chance: number;
  low: number;
  high: number;
  distanceKm: number;
  travelHours: number;
  objectiveHours: number;
  motorized: boolean;
  costs: ResourceBag;
  /** Officiers au TOC (présents / requis) et effet attendu sur la chance. */
  toc: { present: number; required: number; mod: number };
  /** Liaison radio : pénalité de distance, liaison satellite. */
  comms: { penalty: number; global: boolean; bonus: number };
  /** Objectif atteint de nuit et équipement de l'équipe. */
  night: boolean;
  gear: { name: string; short: string; n: number }[];
  /** Héliporté. */
  heli: boolean;
  /** Bonus de discrétion de l'appareil (hélicoptère léger). */
  stealth: number;
  /** Appareil sans protection (pertes plus lourdes). */
  fragile: boolean;
}

export type MissionBlock = 'target' | 'members' | 'requires' | 'limit' | 'resources' | 'vehicles' | 'support' | 'helo';

const dist = (a: KmPos, b: KmPos): number => Math.hypot(a.x - b.x, a.y - b.y);

export class MissionSystem implements System {
  readonly id = 'missions';

  constructor(private readonly ctx: GameContext) {}

  private get cfg() {
    return this.ctx.content.missions.config;
  }

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private hoursToTicks(h: number): number {
    return Math.max(1, Math.round((h * 60) / this.ctx.content.balance.time.minutesPerTick));
  }

  // ------------------------------------------------------------ Requêtes

  active(): MissionInstance[] {
    return Object.values(this.ctx.state.missions).filter((m) => m.phase !== 'done');
  }

  availableAgents(): Agent[] {
    return Object.values(this.ctx.state.agents).filter((a) => a.status === 'on_base' && !a.missionId && a.health >= this.cfg.minHealth);
  }

  availableVehicles(): Vehicle[] {
    return Object.values(this.ctx.state.vehicles).filter((v) => this.ctx.content.vehicle(v.defId).role === 'patrol' && v.state === 'idle');
  }

  loadout(id: string): LoadoutDef {
    return this.ctx.content.missions.loadouts.find((l) => l.id === id) ?? this.ctx.content.missions.loadouts[0];
  }

  /** Cible de mission à partir d'une sélection sur la carte. */
  targetFrom(sel: MapSelection): MissionTarget | null {
    const region = this.ctx.content.region;
    if (sel.kind === 'fob') return { kind: 'fob', id: null, pos: { ...this.ctx.site.regionPos }, name: t('mission.sector') };
    if (sel.kind === 'village') {
      const v = region.villages.find((x) => x.id === sel.id);
      return v ? { kind: 'village', id: v.id, pos: { ...v.pos }, name: v.name } : null;
    }
    if (sel.kind === 'site') {
      const site = region.sites.find((x) => x.id === sel.id);
      return site ? { kind: 'site', id: site.id, pos: { ...site.pos }, name: site.name } : null;
    }
    if (sel.kind === 'sector') {
      const g = region.gridKm;
      const cx = Math.floor(sel.x / g) * g + g / 2;
      const cy = Math.floor(sel.y / g) * g + g / 2;
      const ref = gridRefOf(region.size.width, region.size.height, g, cx, cy);
      return { kind: 'sector', id: ref, pos: { x: cx, y: cy }, name: t('map.sector', { ref }) };
    }
    if (sel.kind === 'contact') {
      const c = this.ctx.state.region.contacts[sel.id];
      if (!c?.known) return null;
      const kind = region.contactKinds[this.ctx.sim.intel.contactDef(c.id).kind];
      return { kind: 'contact', id: c.id, pos: { ...c.estPos }, name: c.reliability < 0.3 ? t('map.unidentified') : kind.label };
    }
    return null;
  }

  /** Types de mission possibles sur une cible. */
  typesFor(target: MissionTarget): MissionTypeDef[] {
    return this.ctx.content.missions.types.filter((d) => {
      if (!d.targets.includes(target.kind)) return false;
      if (target.kind === 'contact' && d.contactKinds) {
        const kind = this.ctx.sim.intel.contactDef(target.id!).kind;
        if (!d.contactKinds.includes(kind)) return false;
      }
      if (d.requires?.leader && target.kind === 'village') {
        const v = this.ctx.content.region.villages.find((x) => x.id === target.id);
        if (!v?.leader) return false;
      }
      return true;
    });
  }

  /** Village concerné par une mission : le village visé, sinon le plus proche de l'objectif. */
  private villageOf(target: MissionTarget): string | null {
    if (target.kind === 'village') return target.id;
    let best: string | null = null;
    let bestD = 6;
    for (const v of this.ctx.content.region.villages) {
      const d = dist(v.pos, target.pos);
      if (d < bestD) {
        bestD = d;
        best = v.id;
      }
    }
    return best;
  }

  /** Estimation de la mission (chance de succès, fourchette, durées, coûts). */
  estimate(plan: MissionPlan): MissionEstimate {
    const def = this.ctx.content.missionType(plan.typeId);
    const members = plan.memberIds.map((id) => this.ctx.state.agents[id]).filter(Boolean);
    const loadout = this.loadout(plan.loadout);
    const distanceKm = Math.max(0.5, dist(this.ctx.site.regionPos, plan.target.pos));
    const seats = plan.vehicleIds.length * this.cfg.vehicleCapacity;
    const heli = plan.heliId ? this.ctx.state.vehicles[plan.heliId] : undefined;
    const heliDef = heli ? this.ctx.content.vehicle(heli.defId) : null;
    const motorized = heli !== undefined || (plan.vehicleIds.length > 0 && seats >= members.length);
    const speed = heli ? (heliDef?.heliSpeedKmh ?? this.cfg.heli.speedKmh) : (motorized ? this.cfg.vehicleSpeedKmh : this.cfg.footSpeedKmh) * loadout.speed;
    const travelHours = distanceKm / speed;

    // Compétences : moyenne de l'équipe et meilleur élément (le chef de groupe compte)
    const weights = Object.entries(def.skills);
    const score = (a: Agent): number => (weights.reduce((s, [k, w]) => s + w * (a.skills[k] ?? 0), 0) / 100) * a.efficiency;
    const scores = members.map(score);
    const avg = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0;
    const best = scores.length ? Math.max(...scores) : 0;
    const ideal = (def.minMembers + def.maxMembers) / 2;
    const size = Math.max(0.6, Math.min(1.15, members.length / ideal));
    const leader = members.length ? Math.max(...members.map((a) => a.skills.leadership ?? 0)) / 1000 : 0;
    let team = (avg * 0.6 + best * 0.4) * size + leader;
    for (const [type, bonus] of Object.entries(def.specialistBonus ?? {})) if (members.some((a) => a.defId === type)) team += bonus;

    let difficulty = def.difficulty;
    let reliability = 0.7;
    if (plan.target.kind === 'contact' && plan.target.id) {
      const c = this.ctx.state.region.contacts[plan.target.id];
      difficulty += this.ctx.content.region.contactKinds[this.ctx.sim.intel.contactDef(plan.target.id).kind].strength;
      reliability = c?.reliability ?? 0.3;
    }
    const vid = this.villageOf(plan.target);
    if (def.influenceDifficulty && vid) difficulty += (this.ctx.state.region.villages[vid]?.influence ?? 0) / 250;

    let chance = 0.5 + (team - difficulty) * 2;
    chance += (reliability - 0.5) * 0.3 + loadout.success + (motorized ? this.cfg.vehicleSuccessBonus : 0);
    const support = this.supportDef(plan.support);
    if (support) chance += support.success ?? 0;
    // Liaison radio avec le TOC (portée de l'antenne, liaison satellite)
    const comms = commsOf(this.ctx.content, this.ctx.state);
    const commsPen = commsPenalty(this.ctx.content, this.ctx.state, distanceKm);
    chance += comms.success - commsPen;
    // Suivi depuis le TOC : officiers présents pour l'ensemble des missions en cours (celle-ci comprise)
    const present = this.officersAtToc();
    const required = this.requiredOfficers(1);
    const tocMod = this.tocModifier(present, required);
    chance += tocMod;
    // Équipement (vision nocturne si l'objectif est atteint de nuit)
    const assembly = this.hoursToTicks(this.cfg.assemblyTimeoutMin / 120);
    const night = isNightHour(this.ctx.content, hourAt(this.ctx.content, this.now + assembly + this.hoursToTicks(travelHours)));
    const gear = gearMissionBonus(this.ctx.content, members, night);
    chance += gear.success;
    // Hélicoptère léger : approche discrète à basse altitude
    const stealth = heliDef?.stealthBonus ?? 0;
    chance += stealth;
    chance = Math.max(0.05, Math.min(0.95, chance));
    const spread = this.cfg.estimateSpread * (1 - reliability);

    const costs: ResourceBag = { ...loadout.consumes };
    if (plan.vehicleIds.length) costs.fuel = Math.ceil(distanceKm * 2 * plan.vehicleIds.length * this.cfg.fuelPerKmPerVehicle);
    if (heli) costs.fuel = (costs.fuel ?? 0) + Math.ceil(distanceKm * 2 * this.cfg.heli.fuelPerKm * (heliDef?.heliFuelMult ?? 1));
    for (const [id, n] of bagEntries(support?.cost)) costs[id] = (costs[id] ?? 0) + n;
    return {
      chance,
      low: Math.max(0.02, chance - spread),
      high: Math.min(0.98, chance + spread),
      distanceKm,
      travelHours,
      objectiveHours: def.objectiveHours * (heliDef?.objectiveMult ?? 1),
      motorized,
      costs,
      toc: { present, required, mod: tocMod },
      comms: { penalty: commsPen, global: comms.global, bonus: comms.success },
      night,
      gear: gear.items.map((g) => ({ name: g.item.name, short: g.item.short, n: g.n })),
      heli: heli !== undefined,
      stealth,
      fragile: (heliDef?.protection ?? 0) > 1,
    };
  }

  // ------------------------------------------------------------ TOC

  /** Officiers en service au TOC (activité « Travaille au TOC »). */
  officersAtToc(): number {
    const types = this.cfg.toc.officerTypes;
    return Object.values(this.ctx.state.agents).filter((a) => types.includes(a.defId) && a.activity?.id === 'command' && a.activity.stage === 'acting').length;
  }

  /** Officiers nécessaires pour suivre les missions hors de la base (plus `extra` missions). */
  requiredOfficers(extra = 0): number {
    const out = this.active().filter((m) => m.phase === 'outbound' || m.phase === 'objective' || m.phase === 'inbound').length;
    return this.cfg.toc.officersPerMission * (out + extra);
  }

  /** Effet du suivi sur la chance de succès : bonus si assez d'officiers, pénalité sinon. */
  tocModifier(present: number, required: number): number {
    if (required <= 0) return 0;
    const ratio = Math.min(1, present / required);
    return ratio >= 1 ? this.cfg.toc.staffedBonus : -this.cfg.toc.understaffedPenalty * (1 - ratio);
  }

  // ------------------------------------------------------------ Appui feu

  supportDef(id: string | null | undefined): SupportDef | null {
    if (!id || id === 'none') return null;
    return this.ctx.content.missions.support.find((x) => x.id === id) ?? null;
  }

  /** Bâtiment d'appui en service (batterie d'obusiers, piste d'aviation). */
  private supportBase(def: SupportDef): BuildingInstance | null {
    if (!def.requires) return null;
    return Object.values(this.ctx.state.fob.buildings).find((b) => b.defId === def.requires && (b.state === 'active' || b.state === 'damaged')) ?? null;
  }

  /** Heures restantes avant qu'un appui soit de nouveau disponible. */
  supportCooldownHours(def: SupportDef): number {
    const ready = Number(this.ctx.state.progression.flags[`support_${def.id}`] ?? 0);
    const left = ready - this.now;
    return left > 0 ? Math.ceil((left * this.ctx.content.balance.time.minutesPerTick) / 60) : 0;
  }

  /** Raison pour laquelle un appui est indisponible sur cette cible, ou null. */
  supportBlock(id: string, target: MissionTarget): SupportBlock | null {
    const def = this.supportDef(id);
    if (!def) return null;
    if (def.vehicle && !this.freeHeli(def.vehicle)) return 'vehicle';
    if (def.requires && !this.supportBase(def)) return 'requires';
    if (def.rangeKm !== undefined && dist(this.ctx.site.regionPos, target.pos) > def.rangeKm) return 'range';
    if (this.supportCooldownHours(def) > 0) return 'cooldown';
    if (def.hours) {
      const h = Math.floor(this.ctx.state.time.minuteOfDay / 60);
      const [a, b] = def.hours;
      const inside = a <= b ? h >= a && h < b : h >= a || h < b;
      if (!inside) return 'hours';
    }
    if (!canAfford(this.ctx.state, def.cost)) return 'resources';
    return null;
  }

  /** Hélicoptère de la base posé et non réservé par une autre mission. */
  freeHeli(defId: string): Vehicle | null {
    const used = new Set(this.active().flatMap((m) => [m.heliId, m.supportVehicleId]).filter(Boolean));
    return this.ctx.sim.supply.idleHelis(defId).find((v) => !used.has(v.id)) ?? null;
  }

  /** Raison pour laquelle le plan est impossible, ou null. */
  check(plan: MissionPlan): MissionBlock | null {
    const def = this.ctx.content.missions.types.find((d) => d.id === plan.typeId);
    if (!def || !this.typesFor(plan.target).includes(def)) return 'target';
    if (plan.target.kind === 'contact' && !this.ctx.state.region.contacts[plan.target.id ?? '']?.known) return 'target';
    if (this.active().length >= this.cfg.maxActive) return 'limit';
    const avail = new Set(this.availableAgents().map((a) => a.id));
    if (plan.memberIds.length < def.minMembers || plan.memberIds.length > def.maxMembers || plan.memberIds.some((id) => !avail.has(id))) return 'members';
    const members = plan.memberIds.map((id) => this.ctx.state.agents[id]);
    if (def.requires?.sf && members.filter((a) => a.defId === 'sf' || a.defId === 'sf_commander').length < def.requires.sf) return 'requires';
    if (def.requires?.routine && !members.some((a) => this.ctx.content.personnel(a.defId).routine === def.requires!.routine)) return 'requires';
    const freeVehicles = new Set(this.availableVehicles().map((v) => v.id));
    if (plan.vehicleIds.some((id) => !freeVehicles.has(id))) return 'vehicles';
    if (plan.heliId) {
      const heli = this.ctx.state.vehicles[plan.heliId];
      const free = heli ? this.freeHeli(heli.defId) : null;
      if (!heli || !free || free.id !== heli.id || plan.vehicleIds.length > 0 || plan.memberIds.length > (this.ctx.content.vehicle(heli.defId).passengers ?? 0)) return 'helo';
    }
    if (plan.support && plan.support !== 'none') {
      const sb = this.supportBlock(plan.support, plan.target);
      if (sb && sb !== 'resources') return 'support';
    }
    if (!canAfford(this.ctx.state, this.estimate(plan).costs)) return 'resources';
    return null;
  }

  // ------------------------------------------------------------ Lancement

  launch(plan: MissionPlan): MissionInstance | null {
    const block = this.check(plan);
    if (block) {
      this.ctx.bus.emit('mission:rejected', { reason: block });
      return null;
    }
    const s = this.ctx.state;
    const def = this.ctx.content.missionType(plan.typeId);
    const est = this.estimate(plan);
    spend(s, est.costs);
    const used = new Set(this.active().map((m) => m.callsign));
    const callsign = this.ctx.content.missions.callsigns.find((c) => !used.has(c)) ?? `Mike ${this.active().length + 1}-1`;
    const m: MissionInstance = {
      id: newId(s, 'msn'),
      defId: def.id,
      callsign,
      target: { ...plan.target, pos: { ...plan.target.pos } },
      memberIds: [...plan.memberIds],
      vehicleIds: [...plan.vehicleIds],
      loadout: plan.loadout,
      phase: 'assembling',
      startTick: this.now,
      phaseStartTick: this.now,
      phaseEndTick: this.now + this.hoursToTicks(this.cfg.assemblyTimeoutMin / 60),
      travelTicks: this.hoursToTicks(est.travelHours),
      objectiveTicks: this.hoursToTicks(est.objectiveHours),
      distanceKm: est.distanceKm,
      estimate: est.chance,
      tocSamples: 0,
      tocStaffed: 0,
      commsPenalty: est.comms.penalty,
      night: est.night,
      mods: { success: 0, casualty: 0 },
      radioQueue: [],
      radioLog: [],
      result: null,
      aborted: false,
      casualties: { kia: [], wounded: [] },
      enemyKilled: 0,
      gains: [],
      reportId: null,
      support: this.supportDef(plan.support)?.id ?? null,
      salvos: 0,
      heliId: plan.heliId ?? null,
      supportVehicleId: (() => {
        const sd = this.supportDef(plan.support);
        return sd?.vehicle ? (this.freeHeli(sd.vehicle)?.id ?? null) : null;
      })(),
    };
    m.estimateBase = est.chance - est.toc.mod;
    s.missions[m.id] = m;
    const sup = this.supportDef(m.support);
    if (sup?.cooldownHours) s.progression.flags[`support_${sup.id}`] = this.now + this.hoursToTicks(sup.cooldownHours);
    for (const id of m.memberIds) {
      const a = s.agents[id];
      a.missionId = m.id;
      this.ctx.sim.agents.recall(a);
    }
    // Les véhicules prennent la piste jusqu'au bord de la carte
    for (const id of m.vehicleIds) this.ctx.sim.supply.sendPatrolVehicle(s.vehicles[id], 'out');
    this.ctx.sim.radio.schedule(m);
    this.log(m, t('mission.logDeparture', { n: m.memberIds.length, v: m.vehicleIds.length }));
    pushLog(this.ctx, 'info', 'log.missionLaunched', { callsign, name: def.name, target: m.target.name });
    this.ctx.bus.emit('mission:launched', { id: m.id });
    return m;
  }

  /** Point de départ des missions : là où la piste entre dans le périmètre. */
  departurePoint(): GridPos {
    const { fob } = this.ctx.state;
    const z = fob.zone;
    const track = this.ctx.content.terrainIndex.get('track');
    const nav = this.ctx.sim.agents.nav;
    let best: GridPos | null = null;
    let bestD = Infinity;
    for (let y = z.y; y < z.y + z.height; y++) {
      for (let x = z.x; x < z.x + z.width; x++) {
        if (fob.terrain[y * fob.width + x] !== track || !nav.walkable(x, y)) continue;
        const d = Math.hypot(x - fob.entry.x, y - fob.entry.y);
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    if (best) return best;
    return { x: Math.min(z.x + z.width - 1, Math.max(z.x, fob.entry.x)), y: Math.min(z.y + z.height - 1, Math.max(z.y, fob.entry.y)) };
  }

  log(m: MissionInstance, text: string): void {
    m.radioLog.push({ tick: this.now, text });
  }

  // ------------------------------------------------------------ Simulation

  handleCommand(cmd: Command): boolean {
    if (cmd.type !== 'launchMission') return false;
    this.launch({ typeId: cmd.typeId, target: cmd.target, memberIds: cmd.memberIds, vehicleIds: cmd.vehicleIds, loadout: cmd.loadout, support: cmd.support, heliId: cmd.heliId });
    return true;
  }

  onTick(): void {
    // Relevé horaire du suivi des missions depuis le TOC
    if (this.now % this.hoursToTicks(1) === 0) {
      const present = this.officersAtToc();
      const required = this.requiredOfficers();
      for (const m of this.active()) {
        if (m.phase !== 'outbound' && m.phase !== 'objective' && m.phase !== 'inbound') continue;
        m.tocSamples = (m.tocSamples ?? 0) + 1;
        m.tocStaffed = (m.tocStaffed ?? 0) + (required > 0 ? Math.min(1, present / required) : 1);
      }
    }
    for (const m of this.active()) {
      switch (m.phase) {
        case 'assembling': {
          const members = m.memberIds.map((id) => this.ctx.state.agents[id]).filter(Boolean);
          const ready = members.every((a) => a.activity?.id === 'deploy' && a.activity.stage === 'acting');
          if (ready || this.now >= m.phaseEndTick) this.depart(m);
          break;
        }
        case 'outbound':
          if (this.now >= m.phaseEndTick) {
            this.setPhase(m, 'objective', m.objectiveTicks, t('mission.logObjective', { target: m.target.name }));
            this.ctx.sim.world.onObjective(m);
            const sup = this.supportDef(m.support);
            if (sup) {
              this.log(m, t('mission.logSupport', { name: sup.name }));
              m.salvos = sup.salvos ?? 0;
            }
          }
          break;
        case 'objective':
          this.fireSalvo(m);
          if (this.now >= m.phaseEndTick) {
            this.resolve(m);
            this.setPhase(m, 'inbound', m.travelTicks, t('mission.logReturn'));
          }
          break;
        case 'inbound':
          if (this.now >= m.phaseEndTick) this.returnHome(m);
          break;
        default:
          break;
      }
    }
  }

  private setPhase(m: MissionInstance, phase: MissionInstance['phase'], ticks: number, logText: string): void {
    m.phase = phase;
    m.phaseStartTick = this.now;
    m.phaseEndTick = this.now + ticks;
    this.log(m, logText);
    this.ctx.bus.emit('mission:phase', { id: m.id, phase });
  }

  /** Mission à pied : ni hélicoptère ni véhicule, l'unité sort de la carte en marchant. */
  private onFoot(m: MissionInstance): boolean {
    return !m.heliId && m.vehicleIds.length === 0;
  }

  /**
   * L'unité part vers l'objectif. À pied, les soldats marchent jusqu'au bord de la carte avant de
   * disparaître ; en véhicule ou héliportés, ils embarquent au point de départ.
   */
  private depart(m: MissionInstance): void {
    for (const id of m.memberIds) {
      const a = this.ctx.state.agents[id];
      if (!a) continue;
      if (this.onFoot(m)) {
        this.ctx.sim.agents.marchOut(a); // le couchage reste attribué pendant la mission
        continue;
      }
      a.status = 'on_mission';
      a.activity = null;
      a.path = []; // le couchage reste attribué pendant la mission
    }
    this.setPhase(m, 'outbound', m.travelTicks, t('mission.logOutbound'));
    for (const id of [m.heliId, m.supportVehicleId]) {
      const heli = id ? this.ctx.state.vehicles[id] : undefined;
      if (heli && heli.state === 'idle') this.ctx.sim.supply.sendHeli(heli, 'out');
    }
    const sup = this.supportDef(m.support);
    if (sup?.flyover) {
      this.ctx.sim.supply.spawnFlyover(sup.flyover);
      this.ctx.sim.supply.spawnFlyover(sup.flyover);
      pushLog(this.ctx, 'info', 'log.flyover', { callsign: m.callsign });
    }
  }

  /** Prolonge l'étape en cours (réponse radio). */
  extend(m: MissionInstance, hours: number): void {
    if (hours > 0 && m.phase !== 'done' && m.phase !== 'assembling') m.phaseEndTick += this.hoursToTicks(hours);
  }

  /** Interrompt la mission : résolution immédiate (chance réduite) et retour. */
  abort(m: MissionInstance): void {
    if (m.phase === 'inbound' || m.phase === 'done' || m.phase === 'returning') return;
    m.aborted = true;
    const elapsed = m.phase === 'outbound' ? this.now - m.phaseStartTick : m.travelTicks;
    this.resolve(m);
    this.setPhase(m, 'inbound', Math.max(1, elapsed), t('mission.logAbort'));
  }

  /** Position de l'unité sur la carte régionale. */
  position(m: MissionInstance): KmPos {
    const fob = this.ctx.site.regionPos;
    const span = Math.max(1, m.phaseEndTick - m.phaseStartTick);
    const p = Math.min(1, (this.now - m.phaseStartTick) / span);
    let k = 0;
    if (m.phase === 'outbound') k = p;
    else if (m.phase === 'objective') {
      // Ratissage d'un secteur ou d'un lieu : l'unité tourne dans la zone
      if (m.target.kind === 'sector' || m.target.kind === 'site') {
        const r = m.target.kind === 'sector' ? this.ctx.content.region.gridKm * 0.35 : 0.8;
        const a = p * Math.PI * 3;
        return { x: m.target.pos.x + Math.cos(a) * r * Math.min(1, p * 4), y: m.target.pos.y + Math.sin(a) * r * Math.min(1, p * 4) };
      }
      k = 1;
    }
    else if (m.phase === 'inbound') k = m.aborted ? Math.max(0, 1 - p) * this.abortReach(m) : 1 - p;
    return { x: fob.x + (m.target.pos.x - fob.x) * k, y: fob.y + (m.target.pos.y - fob.y) * k };
  }

  private abortReach(m: MissionInstance): number {
    return Math.min(1, (m.phaseEndTick - m.phaseStartTick) / Math.max(1, m.travelTicks));
  }

  // ------------------------------------------------------------ Résolution

  private rand(a: number, b: number): number {
    return a + this.ctx.random() * (b - a);
  }

  private resolve(m: MissionInstance): void {
    if (m.result) return;
    const s = this.ctx.state;
    const def = this.ctx.content.missionType(m.defId);
    const loadout = this.loadout(m.loadout);
    // Suivi réel depuis le TOC pendant la mission
    const ratio = m.tocSamples ? (m.tocStaffed ?? 0) / m.tocSamples : 1;
    const tocMod = ratio >= 1 ? this.cfg.toc.staffedBonus : -this.cfg.toc.understaffedPenalty * (1 - ratio);
    const base = m.estimateBase ?? m.estimate;
    let chance = Math.max(0.03, Math.min(0.97, base + tocMod + m.mods.success));
    if (m.aborted) chance *= this.cfg.abortSuccessMult;
    const r = this.ctx.random();
    let result: MissionResult = r < chance ? 'success' : r < chance + (1 - chance) * 0.5 ? 'partial' : 'failure';
    if (m.aborted && result === 'success') result = 'partial'; // une mission interrompue n'est jamais un plein succès
    m.result = result;

    // Pertes
    const tier = result === 'failure' ? 1.8 : result === 'partial' ? 1 : 0.6;
    const motorized = m.vehicleIds.length * this.cfg.vehicleCapacity >= m.memberIds.length && m.vehicleIds.length > 0;
    const heliDef = m.heliId && s.vehicles[m.heliId] ? this.ctx.content.vehicle(s.vehicles[m.heliId].defId) : null;
    const protection = heliDef
      ? (heliDef.protection ?? this.cfg.vehicleProtection)
      : motorized
      ? m.vehicleIds.reduce((sum, id) => sum + (this.ctx.content.vehicle(s.vehicles[id]?.defId ?? 'mrap').protection ?? this.cfg.vehicleProtection), 0) / m.vehicleIds.length
      : 1;
    const sup = this.supportDef(m.support);
    const supportRisk = 1 + (sup?.casualty ?? 0);
    const members = m.memberIds.map((id) => s.agents[id]).filter(Boolean);
    const gearRisk = 1 + gearMissionBonus(this.ctx.content, members, m.night === true).casualty;
    const risk = Math.max(0, Math.min(0.9, def.risk * tier * (1 + m.mods.casualty) * (1 + loadout.casualty) * protection * supportRisk * gearRisk));
    for (const id of m.memberIds) {
      const a = s.agents[id];
      if (!a || this.ctx.random() >= risk) continue;
      const name = `${a.rank} ${a.lastName}`;
      if (this.ctx.random() < this.cfg.kiaShare) {
        m.casualties.kia.push(name);
        this.ctx.sim.attacks.kill(a, false);
      } else {
        a.health = Math.max(5, a.health - this.rand(30, 65));
        m.casualties.wounded.push(name);
      }
    }
    m.memberIds = m.memberIds.filter((id) => s.agents[id]);

    // Gains et effets
    this.applyEffects(m, def.rewards[result]);
    if (result !== 'failure' && (m.target.kind === 'site' || m.target.kind === 'sector')) m.gains.push(...this.ctx.sim.world.visit(m, result === 'partial'));
    for (const id of m.memberIds) s.agents[id].xp += result === 'success' ? this.cfg.xpSuccess : result === 'partial' ? this.cfg.xpPartial : 0;
    const prog = this.ctx.content.balance.progression;
    this.ctx.sim.economy.gainPoints(result === 'success' ? (prog.pointsMissionSuccess ?? 0) : result === 'partial' ? (prog.pointsMissionPartial ?? 0) : 0);
    const morale = m.casualties.kia.length > 0 ? this.cfg.kiaMorale : result === 'success' ? this.cfg.successMorale : 0;
    if (morale) for (const a of Object.values(s.agents)) a.needs.morale = Math.max(0, Math.min(100, a.needs.morale + morale));
    if (sup?.collateral && this.ctx.random() < sup.collateral) this.supportCollateral(m);
    this.ctx.sim.diplomacy.onMissionResolved(m);
    this.log(m, t(`mission.logResult.${result}`));
    pushLog(this.ctx, result === 'failure' || m.casualties.kia.length ? 'bad' : result === 'success' ? 'good' : 'warn', 'log.missionResult', {
      callsign: m.callsign,
      result: t(`mission.result.${result}`),
      kia: m.casualties.kia.length,
      wounded: m.casualties.wounded.length,
    });
  }

  private applyEffects(m: MissionInstance, e: MissionEffects): void {
    const s = this.ctx.state;
    const intel = this.ctx.sim.intel;
    const out = m.gains;
    if (e.funds) {
      gain(s, { funds: e.funds });
      out.push(t('fx.resource', { name: this.ctx.content.resource('funds').name, value: `+${formatNumber(e.funds)}` }));
    }
    if (e.reputation) {
      s.progression.reputation = Math.max(0, Math.min(100, s.progression.reputation + e.reputation));
      out.push(t('fx.reputation', { value: (e.reputation > 0 ? '+' : '−') + Math.abs(e.reputation) }));
    }
    const vid = this.villageOf(m.target);
    if (vid && (e.villageAttitude || e.villageInfluence)) {
      intel.adjustVillage(vid, e.villageAttitude ?? 0, e.villageInfluence ?? 0);
      const name = this.ctx.content.region.villages.find((v) => v.id === vid)!.name;
      if (e.villageAttitude) out.push(t('fx.village', { name, value: (e.villageAttitude > 0 ? '+' : '−') + Math.abs(e.villageAttitude) }));
      if (e.villageInfluence) out.push(t('fx.influence', { name, value: (e.villageInfluence > 0 ? '+' : '−') + Math.abs(e.villageInfluence) }));
    }
    if (e.intelTarget && m.target.kind === 'contact' && m.target.id) {
      intel.report(m.target.id, e.intelTarget, 'mission');
      out.push(t('fx.intelConfirmed', { label: m.target.name }));
    }
    if (e.revealRadiusKm) {
      const n = this.revealAround(m.target.pos, e.revealRadiusKm);
      if (n) out.push(t('fx.revealed', { n }));
    }
    if (e.neutralize && !m.targetMoved && m.target.kind === 'contact' && m.target.id && s.region.contacts[m.target.id]) {
      this.ctx.sim.diplomacy.onContactNeutralized(m.target.id, intel.contactDef(m.target.id).kind);
      delete s.region.contacts[m.target.id];
      out.push(t('fx.neutralized', { label: m.target.name }));
      this.ctx.bus.emit('intel:contact', { id: m.target.id });
    }
    if (e.escort) {
      s.progression.flags.escort_until = this.now + this.hoursToTicks(this.cfg.escortHours);
      out.push(t('fx.escort', { hours: this.cfg.escortHours }));
    }
    if (e.clearIed && s.progression.flags.ied_on_road) {
      delete s.progression.flags.ied_on_road;
      out.push(t('fx.iedCleared'));
    }
    if (e.meet && vid) {
      const leader = this.ctx.content.region.villages.find((v) => v.id === vid)?.leader;
      if (leader) intel.meet(leader);
    }
    if (e.enemyKilled) m.enemyKilled += Math.round(this.rand(e.enemyKilled[0], e.enemyKilled[1]));
  }

  /** Salves tirées depuis la batterie de la base pendant l'action sur l'objectif. */
  private fireSalvo(m: MissionInstance): void {
    if (!m.salvos || this.now % 4 !== 0) return;
    const sup = this.supportDef(m.support);
    const base = sup ? this.supportBase(sup) : null;
    m.salvos--;
    if (!base) return;
    const c = this.ctx.sim.agents.buildingCenter(base);
    this.ctx.bus.emit('artillery:fire', { x: c.x + 0.5, y: c.y + 0.5 });
  }

  /** L'appui feu touche des civils : réputation, village voisin, tension régionale. */
  private supportCollateral(m: MissionInstance): void {
    const s = this.ctx.state;
    const vid = this.villageOf(m.target);
    s.progression.reputation = Math.max(0, s.progression.reputation + this.cfg.collateralReputation);
    if (vid) this.ctx.sim.intel.adjustVillage(vid, this.cfg.collateralAttitude, 5);
    this.ctx.sim.diplomacy.incident('collateral');
    m.gains.push(t('report.supportCollateral'));
    this.log(m, t('mission.logCollateral'));
    pushLog(this.ctx, 'bad', 'log.collateral', { callsign: m.callsign });
  }

  /** Révèle les contacts autour d'un point (patrouille, renseignement). */
  revealAround(pos: KmPos, radiusKm: number): number {
    let n = 0;
    for (const c of Object.values(this.ctx.state.region.contacts)) {
      if (dist(c.truePos, pos) > radiusKm) continue;
      const before = c.known;
      this.ctx.sim.intel.report(c.id, 0.7, 'mission');
      if (!before) n++;
    }
    return n;
  }

  // ------------------------------------------------------------ Retour et compte rendu

  private returnHome(m: MissionInstance): void {
    for (const id of [m.heliId, m.supportVehicleId]) {
      const heli = id ? this.ctx.state.vehicles[id] : undefined;
      if (heli && (heli.state === 'away' || heli.state === 'mission_out')) this.ctx.sim.supply.sendHeli(heli, 'back');
    }
    const s = this.ctx.state;
    const spot = this.departurePoint();
    const nav = this.ctx.sim.agents.nav;
    for (const id of m.memberIds) {
      const a = s.agents[id];
      if (!a) continue;
      // Un soldat encore en route vers la sortie (mission écourtée) rentre directement
      const stillOnMap = a.status === 'on_base' && a.activity?.id === 'march_out';
      a.missionId = null;
      if (this.onFoot(m) && a.status !== 'kia') {
        a.activity = null;
        if (stillOnMap) a.status = 'on_base';
        else this.ctx.sim.agents.marchIn(a, spot);
      } else {
        const cell = nav.randomWalkableNear(spot, 2, () => this.ctx.random()) ?? spot;
        a.pos = { x: cell.x + 0.5, y: cell.y + 0.5 };
        a.prevPos = { ...a.pos };
        a.status = 'on_base';
        a.activity = null;
        a.path = [];
      }
      // Munitions consommées dehors : à recompléter au dépôt
      const cap = this.ctx.content.personnel(a.defId).ammoCapacity ?? 0;
      if (cap > 0) a.ammo = Math.max(0, (a.ammo ?? cap) - cap * (0.3 + 0.5 * this.ctx.random()));
    }
    for (const id of m.vehicleIds) {
      const v = s.vehicles[id];
      if (v) this.ctx.sim.supply.sendPatrolVehicle(v, 'back');
    }
    m.phase = 'done';
    m.phaseStartTick = this.now;
    this.log(m, t('mission.logBack'));
    this.writeReport(m);
    this.ctx.sim.agents.markHomesDirty();
    pushLog(this.ctx, 'info', 'log.missionBack', { callsign: m.callsign });
    this.ctx.bus.emit('mission:done', { id: m.id, reportId: m.reportId! });
    // Historique limité
    const done = Object.values(s.missions).filter((x) => x.phase === 'done').sort((a, b) => b.startTick - a.startTick);
    for (const old of done.slice(10)) delete s.missions[old.id];
  }

  private clock(tick: number): string {
    const time = this.ctx.content.balance.time;
    const total = time.startHour * 60 + tick * time.minutesPerTick;
    return `J${Math.floor(total / 1440) + 1} ${formatClock(total % 1440)}`;
  }

  private writeReport(m: MissionInstance): void {
    const s = this.ctx.state;
    const def = this.ctx.content.missionType(m.defId);
    const region = this.ctx.content.region;
    const grid = (p: KmPos): string => `${String.fromCharCode(65 + Math.floor(p.x / region.gridKm))}${Math.floor(p.y / region.gridKm) + 1}`;
    const result = m.result ?? 'failure';
    const lines: string[] = [
      t('report.header', { callsign: m.callsign }),
      t('report.mission', { name: def.name, target: m.target.name, grid: grid(m.target.pos) }),
      t('report.force', { n: m.memberIds.length + m.casualties.kia.length, v: m.vehicleIds.length, loadout: this.loadout(m.loadout).name }),
      t('report.times', { start: this.clock(m.startTick), end: this.clock(this.now), km: m.distanceKm.toFixed(1) }),
      '',
      t('report.chronology'),
      ...m.radioLog.map((l) => `  ${this.clock(l.tick)} — ${l.text}`),
      '',
      t('report.result', { result: t(`mission.result.${result}`) }) + (m.aborted ? ` ${t('report.aborted')}` : ''),
      `  ${def.texts[result]}`,
      ...(this.supportDef(m.support) ? [t('report.support', { name: this.supportDef(m.support)!.name })] : []),
      ...(m.heliId && s.vehicles[m.heliId] ? [t('report.helo', { name: this.ctx.content.vehicle(s.vehicles[m.heliId].defId).name })] : []),
      t('report.estimate', { estimate: Math.round(m.estimate * 100) }),
      t('report.toc', { pct: Math.round((m.tocSamples ? (m.tocStaffed ?? 0) / m.tocSamples : 1) * 100) }),
      t('report.comms', { state: m.commsPenalty ? t('planner.commsWeak', { pct: Math.round(m.commsPenalty * 100) }) : t('planner.commsGood') }),
      t('report.friendly', { kia: m.casualties.kia.length, wounded: m.casualties.wounded.length }),
    ];
    if (m.casualties.kia.length) lines.push(`  ${t('report.kiaNames', { names: m.casualties.kia.join(', ') })}`);
    if (m.casualties.wounded.length) lines.push(`  ${t('report.woundedNames', { names: m.casualties.wounded.join(', ') })}`);
    lines.push(t('report.enemy', { n: m.enemyKilled }));
    lines.push(t('report.gains'));
    lines.push(...(m.gains.length ? m.gains.map((g) => `  • ${g}`) : [`  ${t('report.noGains')}`]));
    lines.push('', t(`report.reco.${result}`));
    const report = {
      id: newId(s, 'rpt'),
      missionId: m.id,
      callsign: m.callsign,
      title: `${def.name} — ${m.target.name}`,
      day: s.time.day,
      minute: s.time.minuteOfDay,
      result,
      lines,
      read: false,
    };
    s.missionReports.unshift(report);
    if (s.missionReports.length > 20) s.missionReports.length = 20;
    m.reportId = report.id;
  }
}
