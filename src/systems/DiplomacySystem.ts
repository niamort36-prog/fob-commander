/**
 * DiplomacySystem — géopolitique du district (Phase 7).
 *
 *  - Villages : chaque jour, l'emprise insurgée monte près des groupes ennemis et baisse avec la
 *    présence de la coalition (patrouilles, postes de police, bonne attitude) ; l'attitude revient
 *    lentement vers une valeur d'équilibre (besoins satisfaits, emprise insurgée).
 *  - Actions civilo-militaires (aide, MEDCAP, indemnisation, rétribution, shura), projets
 *    (puits, école, dispensaire, piste, poste de police), demandes des chefs et promesses
 *    (tenues ou non), recrutement d'auxiliaires locaux (avec risque d'infiltration).
 *  - Stabilité régionale quotidienne (attitude, emprise, force ennemie, incidents récents) :
 *    elle module le budget du commandement, la fréquence des attaques et le risque routier.
 *  - Réaction de l'insurrection : de nouveaux groupes apparaissent près des villages tenus.
 *  - Campagne : phases d'objectifs successives, délais, récompenses, sanctions, victoire ou relève.
 */
import type { CampaignObjectiveDef, DiploActionDef, DiplomacyConfig, ProjectDef, StanceDef, VillageDef } from '../core/ContentTypes';
import type { Command } from '../core/Commands';
import type { GameContext } from '../core/GameContext';
import type { Agent, CampaignNoticeKind, KmPos, MissionInstance, VillageDiplomacy } from '../core/GameState';
import { pushLog } from '../core/Log';
import { canAfford, gain, spend } from '../core/resources';
import { t } from '../utils/i18n';
import { newId } from '../utils/ids';
import type { System } from './System';

export type ActionBlock = 'cooldown' | 'resources' | 'leader' | 'personnel' | 'pending';
export type ProjectBlock = 'satisfied' | 'active' | 'resources' | 'hostile';
export type RecruitBlock = 'attitude' | 'none' | 'resources';

export interface NeedStatus {
  need: string;
  satisfied: boolean;
  project: ProjectDef | null;
  /** Avancement du projet en cours (0..1), null si aucun. */
  progress: number | null;
}

export interface ObjectiveProgress {
  value: number;
  target: number;
  done: boolean;
}

const COUNTERS = ['missionsSuccess', 'projectsDone', 'promisesKept', 'contactsNeutralized', 'auxiliaries'] as const;
type Counter = (typeof COUNTERS)[number];

const dist = (a: KmPos, b: KmPos): number => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const lerp = (a: number, b: number, k: number): number => a + (b - a) * clamp(k, 0, 1);

/** Distance d'un point à une polyligne (km). */
function distToPolyline(p: KmPos, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const k = len > 0 ? clamp(((p.x - ax) * dx + (p.y - ay) * dy) / len, 0, 1) : 0;
    best = Math.min(best, Math.hypot(p.x - (ax + dx * k), p.y - (ay + dy * k)));
  }
  return best;
}

export class DiplomacySystem implements System {
  readonly id = 'diplomacy';
  private roadVillages: string[] | null = null;
  private basePressures: Map<string, number> | null = null;

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('time:newDay', () => this.daily());
    ctx.bus.on('time:hour', () => this.hourly());
    ctx.bus.on('combat:started', () => this.incident('attack'));
    ctx.bus.on('combat:death', ({ friendly }) => {
      if (friendly) this.incident('kia');
    });
  }

  private get cfg() {
    return this.ctx.content.diplomacy.config;
  }

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private get ticksPerDay(): number {
    return Math.round(1440 / this.ctx.content.balance.time.minutesPerTick);
  }

  private hoursToTicks(h: number): number {
    return Math.max(1, Math.round((h * 60) / this.ctx.content.balance.time.minutesPerTick));
  }

  // ------------------------------------------------------------ Initialisation

  onStateLoaded(): void {
    const s = this.ctx.state;
    const d = s.diplomacy;
    if (!s.region.initialized) return; // IntelSystem initialise la région avant nous (ordre des systèmes)
    if (d.initialized) return;
    for (const v of this.ctx.content.region.villages) {
      const st = s.region.villages[v.id];
      d.villages[v.id] = {
        satisfied: [],
        lastPatrolTick: -100000,
        cooldowns: {},
        demand: null,
        promise: null,
        auxiliaries: 0,
        prevAttitude: st?.attitude ?? v.attitude,
        prevInfluence: st?.influence ?? v.influence,
      };
    }
    d.incidents = this.cfg.incidents.initial;
    // La stabilité de départ reflète la situation réelle du district
    s.region.stability = Math.round(this.computeStability());
    d.history = [s.region.stability];
    this.startPhase(0, 'start');
    d.initialized = true;
  }

  // ------------------------------------------------------------ Requêtes

  villageDef(id: string): VillageDef {
    const v = this.ctx.content.region.villages.find((x) => x.id === id);
    if (!v) throw new Error(`Village inconnu : ${id}`);
    return v;
  }

  village(id: string): VillageDiplomacy {
    return this.ctx.state.diplomacy.villages[id];
  }

  stance(attitude: number): StanceDef {
    return this.cfg.stances.find((s) => attitude <= s.max) ?? this.cfg.stances[this.cfg.stances.length - 1];
  }

  stability(): number {
    return this.ctx.state.region.stability;
  }

  /** Tendance de la stabilité (différence avec la veille). */
  stabilityTrend(): number {
    const h = this.ctx.state.diplomacy.history;
    return h.length >= 2 ? h[h.length - 1] - h[h.length - 2] : 0;
  }

  /** Multiplicateur du budget quotidien du commandement. */
  budgetMult(): number {
    return lerp(this.cfg.budget.min, this.cfg.budget.max, this.stability() / 100);
  }

  /** Multiplicateur de la fréquence des attaques contre la base. */
  threatMult(): number {
    const { min, max, nearKm } = this.cfg.threat;
    const fob = this.ctx.site.regionPos;
    const near = this.ctx.content.region.villages.filter((v) => dist(v.pos, fob) <= nearKm);
    const pool = near.length ? near : this.ctx.content.region.villages;
    const inf = pool.reduce((s, v) => s + (this.ctx.state.region.villages[v.id]?.influence ?? 0), 0) / Math.max(1, pool.length);
    return lerp(max, min, this.stability() / 100) * (0.6 + (0.8 * inf) / 100);
  }

  /** Villages proches des routes (leur emprise conditionne la sécurité des convois). */
  private roadVillageIds(): string[] {
    if (!this.roadVillages) {
      const roads = this.ctx.content.region.roads;
      this.roadVillages = this.ctx.content.region.villages
        .filter((v) => roads.some((r) => distToPolyline(v.pos, r.points as [number, number][]) <= this.cfg.roadRisk.roadKm))
        .map((v) => v.id);
    }
    return this.roadVillages;
  }

  /** Multiplicateur du risque d'embuscade des convois. */
  roadRiskMult(): number {
    const { min, max, projectMult } = this.cfg.roadRisk;
    const ids = this.roadVillageIds();
    if (!ids.length) return 1;
    const inf = ids.reduce((s, id) => s + (this.ctx.state.region.villages[id]?.influence ?? 0), 0) / ids.length;
    const roadProjects = Object.values(this.ctx.state.diplomacy.villages).reduce(
      (n, v) => n + v.satisfied.filter((need) => this.projectFor(need)?.roadSafety).length,
      0,
    );
    return lerp(min, max, inf / 100) * Math.pow(projectMult, roadProjects);
  }

  projectFor(need: string): ProjectDef | undefined {
    return this.ctx.content.diplomacy.projects.find((p) => p.need === need);
  }

  activeProject(villageId: string, need: string) {
    return Object.values(this.ctx.state.diplomacy.projects).find((p) => p.villageId === villageId && this.ctx.content.project(p.projectId).need === need);
  }

  needs(villageId: string): NeedStatus[] {
    const v = this.village(villageId);
    return this.villageDef(villageId).needs.map((need) => {
      const p = this.activeProject(villageId, need);
      return {
        need,
        satisfied: v.satisfied.includes(need),
        project: this.projectFor(need) ?? null,
        progress: p ? clamp((this.now - p.startTick) / Math.max(1, p.endTick - p.startTick), 0, 1) : null,
      };
    });
  }

  private leaderOf(villageId: string) {
    const id = this.villageDef(villageId).leader;
    return id ? this.ctx.content.region.personalities.find((p) => p.id === id) : undefined;
  }

  cooldownLeftHours(villageId: string, action: DiploActionDef): number {
    const last = this.village(villageId).cooldowns[action.id];
    if (last === undefined) return 0;
    const left = last + this.hoursToTicks(action.cooldownDays * 24) - this.now;
    return left > 0 ? Math.ceil((left * this.ctx.content.balance.time.minutesPerTick) / 60) : 0;
  }

  actionBlock(villageId: string, actionId: string): ActionBlock | null {
    const a = this.ctx.content.diploAction(actionId);
    const leader = this.leaderOf(villageId);
    if (a.requiresLeader && (!leader || leader.stance === 'hostile')) return 'leader';
    if (a.shura && this.village(villageId).demand) return 'pending';
    if (a.requiresPersonnel && !Object.values(this.ctx.state.agents).some((x) => x.defId === a.requiresPersonnel && x.status === 'on_base')) return 'personnel';
    if (this.cooldownLeftHours(villageId, a) > 0) return 'cooldown';
    if (!canAfford(this.ctx.state, a.cost)) return 'resources';
    return null;
  }

  projectBlock(villageId: string, projectId: string): ProjectBlock | null {
    const p = this.ctx.content.project(projectId);
    if (this.village(villageId).satisfied.includes(p.need)) return 'satisfied';
    if (this.activeProject(villageId, p.need)) return 'active';
    if (this.ctx.state.region.villages[villageId].attitude <= this.cfg.stances[0].max) return 'hostile';
    if (!canAfford(this.ctx.state, p.cost)) return 'resources';
    return null;
  }

  /** Auxiliaires encore recrutables dans un village. */
  auxiliariesAvailable(villageId: string): number {
    const a = this.cfg.auxiliary;
    const cap = Math.min(a.maxPerVillage, Math.floor((this.villageDef(villageId).population / 1000) * a.per1000));
    return Math.max(0, cap - this.village(villageId).auxiliaries);
  }

  recruitBlock(villageId: string, count: number): RecruitBlock | null {
    if (this.ctx.state.region.villages[villageId].attitude < this.cfg.auxiliary.minAttitude) return 'attitude';
    if (count < 1 || count > this.auxiliariesAvailable(villageId)) return 'none';
    if (!canAfford(this.ctx.state, { funds: this.cfg.auxiliary.price * count })) return 'resources';
    return null;
  }

  /** Probabilité qu'une recrue soit infiltrée par l'insurrection. */
  infiltrationRisk(villageId: string): number {
    const a = this.cfg.auxiliary;
    return clamp(a.infiltrationBase + this.ctx.state.region.villages[villageId].influence * a.infiltrationPerInfluence, 0, 0.8);
  }

  hasInfiltrator(): boolean {
    return Object.values(this.ctx.state.agents).some((a) => a.infiltrator);
  }

  // ------------------------------------------------------------ Actions

  private adjust(villageId: string, attitude = 0, influence = 0): void {
    this.ctx.sim.intel.adjustVillage(villageId, attitude, influence);
    this.ctx.bus.emit('diplomacy:changed', { villageId });
  }

  act(villageId: string, actionId: string): boolean {
    if (this.actionBlock(villageId, actionId)) return false;
    const a = this.ctx.content.diploAction(actionId);
    const s = this.ctx.state;
    spend(s, a.cost);
    this.village(villageId).cooldowns[a.id] = this.now;
    if (a.shura) {
      this.shura(villageId);
      return true;
    }
    this.adjust(villageId, a.attitude ?? 0, a.influence ?? 0);
    if (a.reputation) s.progression.reputation = clamp(s.progression.reputation + a.reputation, 0, 100);
    pushLog(this.ctx, 'good', 'log.diploAction', { action: a.name, village: this.villageDef(villageId).name });
    return true;
  }

  /** Shura : réunion avec le chef et les anciens. */
  private shura(villageId: string): void {
    const s = this.ctx.state;
    const cfg = this.cfg.shura;
    const st = s.region.villages[villageId];
    const vdef = this.villageDef(villageId);
    const leader = this.leaderOf(villageId)!;
    const met = s.region.personalities[leader.id]?.met ?? false;
    const chance = clamp(
      cfg.base + st.attitude * cfg.attitudeWeight + s.progression.reputation * cfg.reputationWeight + st.influence * cfg.influenceWeight + (met ? cfg.metBonus : 0),
      0.05,
      0.95,
    );
    const success = this.ctx.random() < chance;
    let need: string | null = null;
    if (success) {
      this.ctx.sim.intel.meet(leader.id);
      this.adjust(villageId, cfg.successAttitude);
      const v = this.village(villageId);
      const open = vdef.needs.filter((n) => !v.satisfied.includes(n) && !this.activeProject(villageId, n) && v.promise?.need !== n);
      if (open.length && !v.promise) {
        need = open[Math.floor(this.ctx.random() * open.length)];
        v.demand = { need, untilTick: this.now + this.hoursToTicks(this.cfg.promise.demandHours) };
      }
      // Les anciens parlent : renseignement sur les groupes proches
      for (const c of Object.values(s.region.contacts)) {
        if (dist(c.truePos, vdef.pos) <= cfg.revealKm && this.ctx.random() < cfg.revealChance) this.ctx.sim.intel.report(c.id, 0.55, 'village');
      }
      pushLog(this.ctx, 'good', 'log.shuraSuccess', { village: vdef.name, leader: leader.name });
    } else {
      this.adjust(villageId, cfg.failureAttitude);
      pushLog(this.ctx, 'warn', 'log.shuraFailure', { village: vdef.name, leader: leader.name });
    }
    this.ctx.bus.emit('diplomacy:shura', { villageId, success, need });
  }

  /** Réponse à la demande d'un chef : promettre (avec délai) ou refuser. */
  answerDemand(villageId: string, accept: boolean): boolean {
    const v = this.village(villageId);
    if (!v?.demand) return false;
    const p = this.cfg.promise;
    if (accept) {
      v.promise = { need: v.demand.need, deadlineTick: this.now + this.hoursToTicks(p.days * 24) };
      this.adjust(villageId, p.attitude);
      pushLog(this.ctx, 'info', 'log.promiseMade', { village: this.villageDef(villageId).name, need: t(`need.${v.demand.need}`), days: p.days });
    } else {
      this.adjust(villageId, p.refuseAttitude);
    }
    v.demand = null;
    return true;
  }

  startProject(villageId: string, projectId: string): boolean {
    if (this.projectBlock(villageId, projectId)) return false;
    const p = this.ctx.content.project(projectId);
    const s = this.ctx.state;
    spend(s, p.cost);
    const id = newId(s, 'prj');
    s.diplomacy.projects[id] = { id, projectId, villageId, startTick: this.now, endTick: this.now + this.hoursToTicks(p.days * 24) };
    pushLog(this.ctx, 'info', 'log.projectStarted', { name: p.name, village: this.villageDef(villageId).name, days: p.days });
    this.ctx.bus.emit('diplomacy:changed', { villageId });
    return true;
  }

  /** Un besoin du village est satisfait (projet terminé ou financé par un événement). */
  satisfyNeed(villageId: string, need: string): void {
    const v = this.village(villageId);
    if (!v || v.satisfied.includes(need)) return;
    v.satisfied.push(need);
    this.checkPromise(villageId);
    this.ctx.bus.emit('diplomacy:changed', { villageId });
  }

  recruit(villageId: string, count: number): Agent[] {
    if (this.recruitBlock(villageId, count)) return [];
    const s = this.ctx.state;
    const a = this.cfg.auxiliary;
    const vdef = this.villageDef(villageId);
    spend(s, { funds: a.price * count });
    const name = t('diplomacy.auxGroup', { village: vdef.name });
    let group = Object.values(s.groups).find((g) => g.name === name);
    if (!group) {
      const id = newId(s, 'grp');
      group = { id, name, kind: 'squad', memberIds: [], missionId: null };
      s.groups[id] = group;
    }
    const risk = this.infiltrationRisk(villageId);
    const out: Agent[] = [];
    for (let i = 0; i < count; i++) {
      const agent = this.ctx.sim.agents.createAgent(a.type, group.id, s.fob.entry);
      agent.origin = villageId;
      if (this.ctx.random() < risk) {
        agent.infiltrator = true;
        const insiderQueued = s.events.queue.some((q) => q.eventId === a.insiderEvent);
        if (!insiderQueued) {
          const [h0, h1] = a.insiderDelayHours;
          s.events.queue.push({ eventId: a.insiderEvent, atTick: this.now + this.hoursToTicks(h0 + this.ctx.random() * (h1 - h0)) });
        }
      }
      group.memberIds.push(agent.id);
      out.push(agent);
    }
    this.village(villageId).auxiliaries += count;
    s.diplomacy.campaign.stats.auxiliaries += count;
    this.adjust(villageId, a.attitudeCost * count);
    this.ctx.sim.agents.markHomesDirty();
    pushLog(this.ctx, 'good', 'log.auxRecruited', { count, village: vdef.name });
    return out;
  }

  /** Sort de l'auxiliaire infiltré (effet d'événement). */
  insider(action: 'expose' | 'strike' | 'desert', attitude = 0): string | null {
    const s = this.ctx.state;
    const a = Object.values(s.agents).find((x) => x.infiltrator);
    if (!a) return null;
    const name = `${a.rank} ${a.firstName} ${a.lastName}`;
    if (a.origin && attitude) this.adjust(a.origin, attitude);
    if (a.origin && this.village(a.origin)) this.village(a.origin).auxiliaries = Math.max(0, this.village(a.origin).auxiliaries - 1);
    if (a.groupId && s.groups[a.groupId]) s.groups[a.groupId].memberIds = s.groups[a.groupId].memberIds.filter((id) => id !== a.id);
    if (a.activity?.carry) a.activity.carry = null;
    delete s.agents[a.id];
    this.ctx.sim.agents.markHomesDirty();
    this.ctx.bus.emit('agent:removed', { id: a.id });
    if (action === 'strike') this.incident('kia');
    pushLog(this.ctx, action === 'expose' ? 'good' : 'bad', `log.insider.${action}`, { name });
    return name;
  }

  // ------------------------------------------------------------ Conséquences des opérations

  /** Incident aggravant (ou apaisant, valeur négative) la tension régionale. */
  incident(kind: keyof DiplomacyIncidents): void {
    const d = this.ctx.state.diplomacy;
    if (!this.ctx.hasGame || !d) return;
    d.incidents = clamp(d.incidents + this.cfg.incidents[kind], 0, 100);
  }

  /** Village concerné par une mission (cible ou village le plus proche). */
  private nearestVillage(pos: KmPos, maxKm = 6): string | null {
    let best: string | null = null;
    let bestD = maxKm;
    for (const v of this.ctx.content.region.villages) {
      const d = dist(v.pos, pos);
      if (d <= bestD) {
        bestD = d;
        best = v.id;
      }
    }
    return best;
  }

  onMissionResolved(m: MissionInstance): void {
    const stats = this.ctx.state.diplomacy.campaign.stats;
    if (m.result === 'success') {
      stats.missionsSuccess++;
      this.incident('missionSuccess');
    } else if (m.result === 'failure') this.incident('missionFailure');
    for (let i = 0; i < m.casualties.kia.length; i++) this.incident('kia');
    const vid = m.target.kind === 'village' ? m.target.id : m.target.kind === 'contact' ? this.nearestVillage(m.target.pos) : null;
    if (vid && this.village(vid) && m.result !== 'failure') this.village(vid).lastPatrolTick = this.now;
  }

  onContactNeutralized(id: string, kind: string): void {
    const stats = this.ctx.state.diplomacy.campaign.stats;
    stats.contactsNeutralized++;
    if (!stats.neutralized.includes(id)) stats.neutralized.push(id);
    this.incident(kind === 'hq' ? 'hqNeutralized' : 'contactNeutralized');
  }

  // ------------------------------------------------------------ Simulation

  onTick(): void {
    const s = this.ctx.state;
    if (!s.diplomacy.initialized) return;
    for (const p of Object.values(s.diplomacy.projects)) if (this.now >= p.endTick) this.completeProject(p.id);
  }

  private completeProject(id: string): void {
    const s = this.ctx.state;
    const p = s.diplomacy.projects[id];
    const def = this.ctx.content.project(p.projectId);
    delete s.diplomacy.projects[id];
    s.diplomacy.campaign.stats.projectsDone++;
    this.ctx.sim.economy.gainPoints(this.ctx.content.balance.progression.pointsProject ?? 0);
    this.adjust(p.villageId, def.attitude, def.influence);
    pushLog(this.ctx, 'good', 'log.projectDone', { name: def.name, village: this.villageDef(p.villageId).name });
    this.satisfyNeed(p.villageId, def.need);
    this.ctx.bus.emit('diplomacy:project', { villageId: p.villageId, projectId: def.id });
  }

  /** Promesse tenue (besoin satisfait) ou rompue (délai dépassé). */
  private checkPromise(villageId: string): void {
    const s = this.ctx.state;
    const v = this.village(villageId);
    if (!v.promise) return;
    const p = this.cfg.promise;
    const name = this.villageDef(villageId).name;
    if (v.satisfied.includes(v.promise.need)) {
      v.promise = null;
      s.diplomacy.campaign.stats.promisesKept++;
      this.adjust(villageId, p.keptAttitude);
      s.progression.reputation = clamp(s.progression.reputation + p.keptReputation, 0, 100);
      pushLog(this.ctx, 'good', 'log.promiseKept', { village: name });
    } else if (this.now > v.promise.deadlineTick) {
      v.promise = null;
      s.diplomacy.campaign.stats.promisesBroken++;
      this.adjust(villageId, p.brokenAttitude, p.brokenInfluence);
      s.progression.reputation = clamp(s.progression.reputation + p.brokenReputation, 0, 100);
      this.incident('brokenPromise');
      pushLog(this.ctx, 'bad', 'log.promiseBroken', { village: name });
    }
  }

  private hourly(): void {
    const s = this.ctx.state;
    if (!s.diplomacy?.initialized) return;
    for (const id of Object.keys(s.diplomacy.villages)) {
      const v = this.village(id);
      if (v.demand && this.now > v.demand.untilTick) v.demand = null; // le chef n'attend pas indéfiniment
      this.checkPromise(id);
    }
    this.checkCampaign();
  }

  private daily(): void {
    const s = this.ctx.state;
    if (!s.diplomacy?.initialized) return;
    this.villageDynamics();
    this.sabotage();
    this.insurgency();
    const d = s.diplomacy;
    d.incidents = Math.max(0, d.incidents * (1 - this.cfg.incidents.decayPerDay));
    const before = s.region.stability;
    const raw = this.computeStability();
    s.region.stability = Math.round(clamp(before + (raw - before) * this.cfg.stability.smoothing, 0, 100));
    d.history.push(s.region.stability);
    if (d.history.length > this.cfg.stability.historyDays) d.history.splice(0, d.history.length - this.cfg.stability.historyDays);
    this.ctx.bus.emit('diplomacy:stability', { value: s.region.stability });
    this.campaignDaily();
  }

  /** Pression insurgée sur un village (groupes à portée, pondérés par la distance). */
  private pressure(pos: KmPos, contacts: { kind: string; pos: KmPos }[]): number {
    const cfg = this.cfg;
    let p = 0;
    for (const c of contacts) {
      const d = dist(c.pos, pos);
      if (d <= cfg.contactInfluenceKm) p += (cfg.contactInfluencePerDay[c.kind] ?? 0) * (1 - d / cfg.contactInfluenceKm);
    }
    return p;
  }

  /** Pression de départ (contacts de region.json) : l'emprise initiale d'un village en est l'équilibre. */
  private basePressure(villageId: string): number {
    if (!this.basePressures) {
      this.basePressures = new Map();
      const initial = this.ctx.content.region.contacts.map((c) => ({ kind: c.kind, pos: c.pos }));
      for (const v of this.ctx.content.region.villages) this.basePressures.set(v.id, this.pressure(v.pos, initial));
    }
    return this.basePressures.get(villageId) ?? 0;
  }

  private villageDynamics(): void {
    const s = this.ctx.state;
    const cfg = this.cfg;
    const intel = this.ctx.sim.intel;
    const contacts = Object.values(s.region.contacts).map((c) => ({ kind: intel.contactDef(c.id).kind, pos: c.truePos }));
    for (const vdef of this.ctx.content.region.villages) {
      const st = s.region.villages[vdef.id];
      const v = this.village(vdef.id);
      if (!st || !v) continue;
      v.prevAttitude = st.attitude;
      v.prevInfluence = st.influence;

      // Emprise insurgée : retour lent vers l'équilibre, déplacé par l'évolution des groupes ennemis
      // à proximité et par la présence de la coalition.
      let inf = (vdef.influence - st.influence) * cfg.influenceMemoryPerDay;
      inf += (this.pressure(vdef.pos, contacts) - this.basePressure(vdef.id)) * cfg.contactPressureMult;
      inf -= cfg.favorableReliefPerDay * Math.max(0, st.attitude);
      if (this.now - v.lastPatrolTick <= cfg.patrolMemoryDays * this.ticksPerDay) inf += cfg.patrolInfluencePerDay;
      if (v.satisfied.some((n) => this.projectFor(n)?.checkpoint)) inf += cfg.checkpointInfluencePerDay;
      st.influence = clamp(st.influence + inf, 0, 100);

      // Attitude : mémoire lente vers l'équilibre (besoins satisfaits, emprise gagnée par les insurgés)
      const target = vdef.attitude + v.satisfied.length * cfg.needBonus - Math.max(0, st.influence - vdef.influence) * cfg.influencePressure;
      let att = (target - st.attitude) * cfg.attitudeMemoryPerDay;
      const above = Math.max(cfg.influenceAttitudeAbove, vdef.influence);
      if (st.influence > above) att -= (st.influence - above) * cfg.influenceAttitudePerDay;
      st.attitude = clamp(st.attitude + att, -100, 100);
    }
    this.ctx.bus.emit('diplomacy:changed', { villageId: '' });
  }

  private sabotage(): void {
    const s = this.ctx.state;
    const cfg = this.cfg.sabotage;
    for (const p of Object.values(s.diplomacy.projects)) {
      const st = s.region.villages[p.villageId];
      if (st.influence <= cfg.influenceAbove || this.ctx.random() >= cfg.chancePerDay) continue;
      p.endTick += this.ticksPerDay * 2;
      this.adjust(p.villageId, cfg.attitude);
      this.incident('sabotage');
      pushLog(this.ctx, 'bad', 'log.sabotage', { name: this.ctx.content.project(p.projectId).name, village: this.villageDef(p.villageId).name });
    }
  }

  /** L'insurrection se reconstitue près des villages où elle est implantée. */
  private insurgency(): void {
    const s = this.ctx.state;
    const cfg = this.cfg.insurgency;
    const villages = this.ctx.content.region.villages;
    const avg = villages.reduce((t0, v) => t0 + (s.region.villages[v.id]?.influence ?? 0), 0) / Math.max(1, villages.length);
    if (Object.keys(s.region.contacts).length >= cfg.maxContacts || avg < cfg.minAverageInfluence) return;
    if (this.ctx.random() >= (cfg.spawnChancePerDay * avg) / 50) return;
    const weights = villages.map((v) => Math.pow(s.region.villages[v.id]?.influence ?? 0, 2));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    let r = this.ctx.random() * total;
    let vdef = villages[villages.length - 1];
    for (let i = 0; i < villages.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        vdef = villages[i];
        break;
      }
    }
    const tw = cfg.templates.reduce((a, b) => a + b.weight, 0);
    let x = this.ctx.random() * tw;
    let tpl = cfg.templates[0];
    for (const tp of cfg.templates) {
      x -= tp.weight;
      if (x <= 0) {
        tpl = tp;
        break;
      }
    }
    const size = this.ctx.content.region.size;
    const a = this.ctx.random() * Math.PI * 2;
    const k = cfg.spawnKm[0] + this.ctx.random() * (cfg.spawnKm[1] - cfg.spawnKm[0]);
    const pos = { x: clamp(vdef.pos.x + Math.cos(a) * k, 0.5, size.width - 0.5), y: clamp(vdef.pos.y + Math.sin(a) * k, 0.5, size.height - 0.5) };
    const id = `dyn_${s.diplomacy.nextDyn++}`;
    s.region.contacts[id] = {
      id,
      truePos: pos,
      estPos: { ...pos },
      error: 0,
      reliability: 0,
      lastSeenTick: this.now,
      known: false,
      source: 'initial',
      dyn: { kind: tpl.kind, label: `${tpl.label} (${vdef.name})`, drift: tpl.drift, home: { ...pos } },
    };
    // Un village favorable prévient la base
    if ((s.region.villages[vdef.id]?.attitude ?? -100) >= this.ctx.content.region.intel.informantAttitude) {
      this.ctx.sim.intel.report(id, 0.4, 'village');
      pushLog(this.ctx, 'warn', 'log.insurgentsArrive', { village: vdef.name });
    }
  }

  /** Stabilité « brute » du jour, d'après la situation réelle (0..100). */
  computeStability(): number {
    const s = this.ctx.state;
    const cfg = this.cfg.stability;
    let wsum = 0;
    let att = 0;
    let inf = 0;
    for (const v of this.ctx.content.region.villages) {
      const st = s.region.villages[v.id];
      if (!st) continue;
      const w = Math.sqrt(v.population);
      wsum += w;
      att += w * st.attitude;
      inf += w * st.influence;
    }
    const attitude = wsum ? (att / wsum + 100) / 2 : 50;
    const influence = wsum ? 100 - inf / wsum : 50;
    const strength = Object.values(s.region.contacts).reduce((t0, c) => t0 + (this.ctx.content.region.contactKinds[this.ctx.sim.intel.contactDef(c.id).kind]?.strength ?? 0), 0);
    const enemy = clamp(100 - strength * cfg.enemyStrengthScale, 0, 100);
    const incidents = clamp(100 - s.diplomacy.incidents, 0, 100);
    s.diplomacy.components = { attitude: Math.round(attitude), influence: Math.round(influence), enemy: Math.round(enemy), incidents: Math.round(incidents) };
    const w = cfg.weights;
    return (w.attitude * attitude + w.influence * influence + w.enemy * enemy + w.incidents * incidents) / (w.attitude + w.influence + w.enemy + w.incidents);
  }

  // ------------------------------------------------------------ Campagne

  private counters(): Record<Counter, number> {
    const st = this.ctx.state.diplomacy.campaign.stats;
    return {
      missionsSuccess: st.missionsSuccess,
      projectsDone: st.projectsDone,
      promisesKept: st.promisesKept,
      contactsNeutralized: st.contactsNeutralized,
      auxiliaries: st.auxiliaries,
    };
  }

  private startPhase(index: number, notice: CampaignNoticeKind): void {
    const c = this.ctx.state.diplomacy.campaign;
    const def = this.ctx.content.campaign.phases[index];
    c.phaseIndex = index;
    c.phaseStartTick = this.now;
    c.deadlineTick = this.now + this.hoursToTicks(def.days * 24);
    c.missed = 0;
    c.base = this.counters();
    this.notify(notice, index);
  }

  private notify(kind: CampaignNoticeKind, phaseIndex: number): void {
    this.ctx.state.diplomacy.campaign.notice = { kind, phaseIndex };
    this.ctx.bus.emit('campaign:notice', { kind });
  }

  currentPhase() {
    const c = this.ctx.state.diplomacy.campaign;
    return this.ctx.content.campaign.phases[Math.min(c.phaseIndex, this.ctx.content.campaign.phases.length - 1)];
  }

  objectiveProgress(o: CampaignObjectiveDef): ObjectiveProgress {
    const s = this.ctx.state;
    const c = s.diplomacy.campaign;
    const since = (k: Counter): number => this.counters()[k] - (c.base?.[k] ?? 0);
    const villages = Object.values(s.region.villages);
    switch (o.type) {
      case 'stability':
        return { value: s.region.stability, target: o.min ?? 0, done: s.region.stability >= (o.min ?? 0) };
      case 'reputation':
        return { value: Math.round(s.progression.reputation), target: o.min ?? 0, done: s.progression.reputation >= (o.min ?? 0) };
      case 'villagesAttitude': {
        const n = villages.filter((v) => v.attitude >= (o.min ?? 0)).length;
        return { value: n, target: o.count ?? 1, done: n >= (o.count ?? 1) };
      }
      case 'villagesInfluence': {
        const n = villages.filter((v) => v.influence <= (o.max ?? 100)).length;
        return { value: n, target: o.count ?? 1, done: n >= (o.count ?? 1) };
      }
      case 'neutralize': {
        const done = Boolean(o.contact) && !s.region.contacts[o.contact!];
        return { value: done ? 1 : 0, target: 1, done };
      }
      default: {
        const key: Counter = o.type === 'projects' ? 'projectsDone' : (o.type as Counter);
        const n = since(key);
        return { value: n, target: o.count ?? 1, done: n >= (o.count ?? 1) };
      }
    }
  }

  private checkCampaign(): void {
    const s = this.ctx.state;
    const c = s.diplomacy.campaign;
    if (c.status !== 'active') return;
    const phases = this.ctx.content.campaign.phases;
    const def = phases[c.phaseIndex];
    if (!def) return;
    if (def.objectives.every((o) => this.objectiveProgress(o).done)) {
      if (def.rewards.funds) gain(s, { funds: def.rewards.funds });
      if (def.rewards.reputation) s.progression.reputation = clamp(s.progression.reputation + def.rewards.reputation, 0, 100);
      if (def.rewards.points) this.ctx.sim.economy.gainPoints(def.rewards.points);
      pushLog(this.ctx, 'good', 'log.phaseDone', { name: def.name });
      if (c.phaseIndex + 1 >= phases.length) {
        c.status = 'won';
        this.notify('victory', c.phaseIndex);
        pushLog(this.ctx, 'good', 'log.campaignWon', {});
      } else {
        this.startPhase(c.phaseIndex + 1, 'phaseDone');
      }
      return;
    }
    if (this.now > c.deadlineTick) {
      c.missed++;
      if (def.penalty.reputation) s.progression.reputation = clamp(s.progression.reputation + def.penalty.reputation, 0, 100);
      c.deadlineTick = this.now + this.hoursToTicks(def.penalty.graceDays * 24);
      this.notify('missed', c.phaseIndex);
      pushLog(this.ctx, 'bad', 'log.phaseMissed', { name: def.name, days: def.penalty.graceDays });
    }
  }

  private campaignDaily(): void {
    const s = this.ctx.state;
    const c = s.diplomacy.campaign;
    if (c.status !== 'active') return;
    const d = this.ctx.content.campaign.defeat;
    if (s.region.stability < d.stabilityBelow) c.lowStabilityDays++;
    else c.lowStabilityDays = 0;
    if (c.lowStabilityDays >= d.days) {
      c.status = 'lost';
      this.notify('defeat', c.phaseIndex);
      pushLog(this.ctx, 'bad', 'log.campaignLost', {});
    } else if (s.region.stability < d.warnBelow) {
      pushLog(this.ctx, 'bad', 'log.stabilityLow', { value: s.region.stability });
    }
  }

  /** Jours restants avant l'échéance de la phase en cours. */
  daysLeft(): number {
    return (this.ctx.state.diplomacy.campaign.deadlineTick - this.now) / this.ticksPerDay;
  }

  // ------------------------------------------------------------ Commandes

  handleCommand(cmd: Command): boolean {
    switch (cmd.type) {
      case 'diplomacyAction':
        this.act(cmd.villageId, cmd.actionId);
        return true;
      case 'startProject':
        this.startProject(cmd.villageId, cmd.projectId);
        return true;
      case 'answerDemand':
        this.answerDemand(cmd.villageId, cmd.accept);
        return true;
      case 'recruitAuxiliaries':
        this.recruit(cmd.villageId, cmd.count);
        return true;
      case 'campaignAck': {
        const c = this.ctx.state.diplomacy.campaign;
        if (cmd.continueSandbox && c.status === 'lost') c.status = 'sandbox';
        c.notice = null;
        return true;
      }
      default:
        return false;
    }
  }
}

type DiplomacyIncidents = Omit<DiplomacyConfig['incidents'], 'decayPerDay' | 'initial'>;
