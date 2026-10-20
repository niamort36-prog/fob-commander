/**
 * AgentAI — vie des habitants : déploiement initial, attribution des couchages,
 * choix d'activité (emploi du temps + besoins urgents), réservation des services,
 * déchargement des véhicules (allers-retours véhicule ↔ stockage), corvées du soutien
 * (ravitaillement des bâtiments depuis l'entrepôt, cuisine, nettoyage), chantiers
 * (matériaux portés depuis le dépôt puis montés), calcul des chemins (A*) et déplacements.
 */
import { buildingStats } from '../core/buildingStats';
import type { ActivityDef, PersonnelDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { Agent, AgentActivity, BuildingInstance, GridPos, Id, NeedId } from '../core/GameState';
import { NEED_IDS } from '../core/GameState';
import { pushLog } from '../core/Log';
import { bagEntries, canAfford, gain, spend } from '../core/resources';
import { newId } from '../utils/ids';
import { BuildSystem } from './BuildSystem';
import { NavGrid } from './NavGrid';
import type { System } from './System';

/** Clés de réservation hors services de bâtiment. */
const BUILD_KEY = '__build';
const HAUL_KEY = '__haul';
const MAT_KEY = '__mat';
const CLEAN_KEY = '__clean';

export class AgentAI implements System {
  readonly id = 'agents';
  readonly nav: NavGrid;

  /** Agents en attente de calcul de chemin → cases objectifs. */
  private readonly pathQueue = new Map<Id, GridPos[]>();
  /** Réservations : bâtiment ou véhicule → clé → nombre d'agents (en route ou sur place). */
  private reservations = new Map<Id, Map<string, number>>();
  /** Puissance de travail présente sur chaque chantier. */
  private builderPowers = new Map<Id, number>();
  private homesDirty = true;

  constructor(private readonly ctx: GameContext) {
    this.nav = new NavGrid(ctx);
    const homes = (): void => {
      this.homesDirty = true;
    };
    ctx.bus.on('building:completed', homes);
    ctx.bus.on('building:removed', homes);
    ctx.bus.on('building:upgraded', homes);
  }

  // ------------------------------------------------------------ Cycle de vie

  onStateLoaded(): void {
    this.pathQueue.clear();
    this.nav.rebuild();
    const state = this.ctx.state;
    if (!state.progression.flags.forceDeployed) this.deployStartingForce();
    this.assignHomes();
    this.rebuildReservations();
    // Les chemins ne sont pas sauvegardés finement : on relance les trajets interrompus.
    for (const a of Object.values(state.agents)) {
      a.prevPos = { ...a.pos };
      if (a.activity?.stage === 'moving' && a.path.length === 0) this.endActivity(a);
    }
  }

  onTick(): void {
    this.nav.ensure();
    if (this.homesDirty) this.assignHomes();
    this.rebuildReservations();
    this.processPathQueue();
    for (const a of Object.values(this.ctx.state.agents)) this.updateAgent(a);
  }

  markHomesDirty(): void {
    this.homesDirty = true;
  }

  /** Cases de sortie de la carte, au bout de la piste (arrivée des convois). */
  private mapExitCells(): GridPos[] {
    const e = this.ctx.state.fob.entry;
    const cells = [e, { x: e.x + 1, y: e.y }, { x: e.x - 1, y: e.y }, { x: e.x, y: e.y + 1 }, { x: e.x, y: e.y - 1 }].filter((c) => this.nav.walkable(c.x, c.y));
    if (cells.length) return cells;
    const near = this.nav.randomWalkableNear(e, 4, () => this.ctx.random());
    return near ? [near] : [];
  }

  /** Départ en mission à pied : l'agent marche jusqu'au bord de la carte avant de disparaître. */
  marchOut(a: Agent): void {
    const goals = this.mapExitCells();
    a.path = [];
    this.pathQueue.delete(a.id);
    const now = this.ctx.state.time.tick;
    a.activity = { id: 'march_out', targetId: null, stage: 'moving', urgent: true, startTick: now, endTick: now };
    if (goals.length === 0) return this.leaveMap(a);
    this.goTo(a, goals);
  }

  /** Retour de mission à pied : l'unité réapparaît en bord de carte et rejoint la base. */
  marchIn(a: Agent, goal: GridPos): void {
    const start = this.mapExitCells()[0] ?? goal;
    a.pos = { x: start.x + 0.5, y: start.y + 0.5 };
    a.prevPos = { ...a.pos };
    a.status = 'on_base';
    a.path = [];
    const now = this.ctx.state.time.tick;
    a.activity = { id: 'march_in', targetId: null, stage: 'moving', urgent: true, startTick: now, endTick: now };
    const goals = [goal, { x: goal.x + 1, y: goal.y }, { x: goal.x, y: goal.y + 1 }].filter((c) => this.nav.walkable(c.x, c.y));
    this.goTo(a, goals.length ? goals : null);
  }

  /** Hors de la carte : l'agent part réellement en mission. */
  private leaveMap(a: Agent): void {
    a.activity = null;
    a.path = [];
    this.pathQueue.delete(a.id);
    a.status = 'on_mission';
  }

  /** Rappel d'un agent désigné pour une mission : il abandonne son activité. */
  recall(a: Agent): void {
    this.endActivity(a);
  }

  /** Alerte : chacun quitte son activité pour s'abriter ou prendre position (les gardes restent). */
  alertAll(): void {
    for (const a of this.agentList()) {
      if (a.status !== 'on_base' || a.activity?.id === 'guard' || a.missionId) continue;
      this.endActivity(a);
    }
  }

  /** Fin d'alerte : retour aux activités normales. */
  standDown(): void {
    for (const a of this.agentList()) {
      if (a.activity && this.ctx.content.activity(a.activity.id).combat) this.endActivity(a);
    }
  }

  // ------------------------------------------------------------ Requêtes (UI, autres systèmes)

  agentList(): Agent[] {
    return Object.values(this.ctx.state.agents);
  }

  private isOperational(b: BuildingInstance): boolean {
    return b.state === 'active' || b.state === 'damaged';
  }

  private stats(b: BuildingInstance) {
    return buildingStats(this.ctx.content.building(b.defId), b.level);
  }

  /** Nombre d'agents utilisant (ou rejoignant) un service d'un bâtiment. */
  occupancy(buildingId: Id, service: string): number {
    return this.reservations.get(buildingId)?.get(service) ?? 0;
  }

  builders(buildingId: Id): number {
    return this.occupancy(buildingId, BUILD_KEY);
  }

  /** Agents affectés au déchargement d'un véhicule. */
  haulers(vehicleId: Id): number {
    return this.occupancy(vehicleId, HAUL_KEY);
  }

  /** Somme des contributions des ouvriers présents (plafonnée par balance.build.maxWorkersPerSite). */
  builderPower(buildingId: Id): number {
    return this.builderPowers.get(buildingId) ?? 0;
  }

  residents(buildingId: Id): Agent[] {
    return this.agentList().filter((a) => a.homeId === buildingId);
  }

  beds(): { total: number; assigned: number } {
    let total = 0;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (this.isOperational(b)) total += this.stats(b).services.sleep?.slots ?? 0;
    }
    return { total, assigned: this.agentList().filter((a) => a.homeId).length };
  }

  /** Heure de l'emploi du temps personnel (décalée selon le quart). */
  localHour(a: Agent): number {
    const routine = this.ctx.content.routine(this.ctx.content.personnel(a.defId).routine);
    const hour = Math.floor(this.ctx.state.time.minuteOfDay / 60);
    return (((hour - a.shift * (24 / routine.shifts)) % 24) + 24) % 24;
  }

  fullName(a: Agent): string {
    return `${a.rank} ${a.firstName} ${a.lastName}`;
  }

  // ------------------------------------------------------------ Déploiement

  private deployStartingForce(): void {
    const state = this.ctx.state;
    const zone = state.fob.zone;
    const center = { x: Math.floor(zone.x + zone.width / 2), y: Math.floor(zone.y + zone.height / 2) };
    let count = 0;
    for (const g of this.ctx.content.balance.startingForce) {
      const groupId = newId(state, 'grp');
      state.groups[groupId] = { id: groupId, name: g.group, kind: g.kind, memberIds: [], missionId: null };
      for (const m of g.members) {
        for (let i = 0; i < m.count; i++) {
          const a = this.createAgent(m.type, groupId, center);
          state.groups[groupId].memberIds.push(a.id);
          count++;
        }
      }
    }
    state.progression.flags.forceDeployed = true;
    pushLog(this.ctx, 'info', 'log.forceArrived', { count });
  }

  /** Crée un agent aléatoire (nom, grade, compétences, traits) près d'un point. */
  createAgent(type: string, groupId: Id | null, near: GridPos): Agent {
    const state = this.ctx.state;
    const content = this.ctx.content;
    const def = content.personnel(type);
    const rnd = (): number => this.ctx.random();
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
    const range = (min: number, max: number): number => Math.round(min + rnd() * (max - min));

    const traits: string[] = [];
    const nTraits = range(def.traitCount[0], def.traitCount[1]);
    for (let i = 0; i < nTraits * 4 && traits.length < nTraits; i++) {
      const t = pick(content.traitList).id;
      if (!traits.includes(t)) traits.push(t);
    }
    const skills: Record<string, number> = {};
    for (const [k, [min, max]] of Object.entries(def.skills)) skills[k] = range(min, max);
    for (const t of traits) {
      for (const [k, v] of Object.entries(content.trait(t).skills ?? {})) skills[k] = Math.min(100, (skills[k] ?? 0) + v);
    }

    // Quarts répartis équitablement entre les agents de même emploi du temps.
    const routine = content.routine(def.routine);
    const sameRoutine = this.agentList().filter((a) => content.personnel(a.defId).routine === routine.id).length;

    const spot = this.nav.randomWalkableNear(near, content.balance.agents.spawnSpread, rnd) ?? near;
    const pos = { x: spot.x + 0.5, y: spot.y + 0.5 };
    const agent: Agent = {
      id: newId(state, 'agt'),
      defId: type,
      firstName: pick(def.names === 'afghan' && content.names.afghanFirst?.length ? content.names.afghanFirst : content.names.first),
      lastName: pick(def.names === 'afghan' && content.names.afghanLast?.length ? content.names.afghanLast : content.names.last),
      rank: pick(def.ranks),
      skills,
      traits,
      needs: { food: range(75, 100), water: 100, sleep: range(85, 100), hygiene: range(70, 100), toilet: range(60, 100), fun: range(60, 90), morale: range(60, 75) },
      health: 100,
      xp: 0,
      efficiency: 1,
      groupId,
      homeId: null,
      missionId: null,
      shift: sameRoutine % routine.shifts,
      pos,
      prevPos: { ...pos },
      path: [],
      activity: null,
      status: 'on_base',
      gearPending: [],
      ammo: def.ammoCapacity ?? 0,
    };
    state.agents[agent.id] = agent;
    this.ctx.bus.emit('agent:spawned', { id: agent.id });
    return agent;
  }

  // ------------------------------------------------------------ Logement

  /** Attribue un couchage aux agents sans logement, en gardant les groupes ensemble. */
  assignHomes(): void {
    this.homesDirty = false;
    const { fob, groups } = this.ctx.state;
    const slotsOf = (b: BuildingInstance): number => this.stats(b).services.sleep?.slots ?? 0;
    const tents = Object.values(fob.buildings).filter((b) => this.isOperational(b) && slotsOf(b) > 0);
    const residents = new Map<Id, number>();
    const agents = this.agentList();
    for (const a of agents) {
      const home = a.homeId ? fob.buildings[a.homeId] : undefined;
      const count = home ? (residents.get(home.id) ?? 0) : 0;
      if (!home || !tents.includes(home) || count >= slotsOf(home)) a.homeId = null;
      else residents.set(home.id, count + 1);
    }
    // Ordre des groupes pour loger les escouades ensemble.
    const order = new Map(Object.keys(groups).map((g, i) => [g, i]));
    const homeless = agents.filter((a) => !a.homeId).sort((a, b) => (order.get(a.groupId ?? '') ?? 99) - (order.get(b.groupId ?? '') ?? 99));
    for (const a of homeless) {
      const tent = tents.find((t) => (residents.get(t.id) ?? 0) < slotsOf(t));
      if (!tent) break;
      a.homeId = tent.id;
      residents.set(tent.id, (residents.get(tent.id) ?? 0) + 1);
    }
  }

  // ------------------------------------------------------------ Réservations

  private serviceKey(def: ActivityDef): string | null {
    if (def.work === 'build') return BUILD_KEY;
    if (def.work === 'haul') return HAUL_KEY;
    if (def.work === 'materials') return MAT_KEY;
    if (def.work === 'clean') return CLEAN_KEY;
    if (def.work === 'supply' || def.work === 'rearm' || def.work === 'gear') return null;
    return def.service ?? null;
  }

  private rebuildReservations(): void {
    const res = new Map<Id, Map<string, number>>();
    const powers = new Map<Id, number>();
    const counts = new Map<Id, number>();
    const max = this.ctx.content.balance.build.maxWorkersPerSite;
    const add = (id: Id, key: string): void => {
      let m = res.get(id);
      if (!m) res.set(id, (m = new Map()));
      m.set(key, (m.get(key) ?? 0) + 1);
    };
    for (const a of Object.values(this.ctx.state.agents)) {
      const act = a.activity;
      if (!act) continue;
      const key = this.serviceKey(this.ctx.content.activity(act.id));
      if (key === HAUL_KEY) {
        if (act.vehicleId) add(act.vehicleId, HAUL_KEY);
        continue;
      }
      if (!key || !act.targetId) continue;
      add(act.targetId, key);
      if (key === BUILD_KEY && act.stage === 'acting') {
        const n = (counts.get(act.targetId) ?? 0) + 1;
        counts.set(act.targetId, n);
        if (n <= max) {
          const mech = a.skills.mechanics ?? 30;
          powers.set(act.targetId, (powers.get(act.targetId) ?? 0) + a.efficiency * (0.6 + (0.8 * mech) / 100));
        }
      }
    }
    this.reservations = res;
    this.builderPowers = powers;
  }

  private reserve(id: Id, key: string): void {
    let m = this.reservations.get(id);
    if (!m) this.reservations.set(id, (m = new Map()));
    m.set(key, (m.get(key) ?? 0) + 1);
  }

  // ------------------------------------------------------------ Décision

  private updateAgent(a: Agent): void {
    a.prevPos.x = a.pos.x;
    a.prevPos.y = a.pos.y;
    if (a.status !== 'on_base') return;
    const act = a.activity;
    if (!act) {
      this.decide(a);
      return;
    }
    // Un besoin devenu critique interrompt toute activité planifiée qui ne le satisfait pas.
    if (!act.urgent && this.hasUnmetCriticalNeed(a, act.id)) {
      this.endActivity(a);
      return;
    }
    if (act.id === 'haul' && act.phase === 'pickup' && !this.ctx.state.vehicles[act.vehicleId ?? '']) {
      this.endActivity(a); // le véhicule est reparti
      return;
    }
    if (act.stage === 'moving') {
      if (a.path.length > 0) this.move(a);
      return; // sinon : chemin en attente de calcul
    }
    // Sur place : fin de l'étape ou de l'activité ?
    const def = this.ctx.content.activity(act.id);
    if (act.id === 'haul') {
      if (this.ctx.state.time.tick >= act.endTick) this.haulStep(a, act);
      return;
    }
    if (act.id === 'supply' || act.id === 'fetch_materials') {
      const target = act.targetId ? this.ctx.state.fob.buildings[act.targetId] : undefined;
      const valid = target && (act.id === 'supply' ? this.isOperational(target) : this.ctx.sim.build.needsWork(target, true));
      if (!valid) return this.endActivity(a);
      if (this.ctx.state.time.tick >= act.endTick) (act.id === 'supply' ? this.supplyStep(a, act) : this.fetchStep(a, act));
      return;
    }
    if (act.id === 'rearm' || act.id === 'collect_gear') {
      if (this.ctx.state.time.tick >= act.endTick) {
        if (act.id === 'rearm') this.refillAmmo(a);
        else this.receiveGear(a);
        this.endActivity(a);
      }
      return;
    }
    if (act.id === 'queue') return this.queueStep(a, act);
    // Défenseur à court de munitions : il quitte sa position pour aller se rééquiper
    if (act.id === 'defend' && this.lowAmmo(a, true)) return this.endActivity(a);
    if (act.id === 'clean' && act.targetId) {
      const target = this.ctx.state.fob.buildings[act.targetId];
      if (!target || this.ctx.sim.logistics.cleanliness(target) >= 0.995) return this.endActivity(a);
    }
    // Pendant une attaque, les gardes restent à leur poste jusqu'à la fin de l'alerte.
    if (act.id === 'guard' && this.ctx.state.combat.active && act.targetId && this.ctx.state.fob.buildings[act.targetId]) return;
    const target = act.targetId ? this.ctx.state.fob.buildings[act.targetId] : undefined;
    const targetGone =
      act.targetId !== null && (!target || (def.work === 'build' ? !this.ctx.sim.build.needsWork(target, true) : !this.isOperational(target)));
    const full = act.urgent && def.endWhenFull && a.needs[def.endWhenFull] >= 99;
    if (targetGone || full || this.ctx.state.time.tick >= act.endTick) this.endActivity(a);
  }

  private hasUnmetCriticalNeed(a: Agent, currentActivity: string): boolean {
    const content = this.ctx.content;
    for (const [need, actId] of Object.entries(content.needs.needActivities) as [NeedId, string][]) {
      if (actId && actId !== currentActivity && a.needs[need] < content.need(need).critical && this.canSatisfy(a, need, actId)) {
        // Une activité de repli de ce besoin (ex. ration froide pour « manger ») le satisfait aussi.
        if ((content.activity(currentActivity).effectsPerHour[need] ?? 0) > 0) continue;
        return true;
      }
    }
    return false;
  }

  private endActivity(a: Agent): void {
    // Une cargaison déchargée n'est jamais perdue : elle rejoint le stock (un ravitaillement interne
    // en fait déjà partie et retourne simplement au dépôt).
    const carry = a.activity?.id === 'haul' ? a.activity.carry : null;
    if (carry) gain(this.ctx.state, { [carry.resource]: carry.amount });
    a.activity = null;
    a.path = [];
    this.pathQueue.delete(a.id);
    this.decide(a);
  }

  /** Choisit l'activité suivante : besoin critique, sinon emploi du temps (avec opportunisme). */
  private decide(a: Agent): void {
    const content = this.ctx.content;
    // Désigné pour une mission : rejoindre le point de départ
    if (a.missionId) {
      const m = this.ctx.state.missions[a.missionId];
      if (m && m.phase === 'assembling') return this.start(a, 'deploy', true, 1);
      if (!m || m.phase === 'done') a.missionId = null;
    }
    const combat = this.ctx.state.combat;
    if (combat.active) {
      // Fantassins en position si le commandant ordonne la riposte ; tous les autres à l'abri.
      const fighter = content.personnel(a.defId).routine === 'infantry';
      const scheduledGuard = this.scheduledActivity(a) === 'guard';
      if (scheduledGuard) return this.start(a, 'guard', true, 1);
      if (fighter && combat.mode === 'engage' && this.lowAmmo(a, true) && this.startRearm(a, true)) return;
      return this.start(a, fighter && combat.mode === 'engage' ? 'defend' : 'take_cover', true, 1);
    }
    const scheduled = this.scheduledActivity(a);
    let chosen = scheduled;
    let urgent = false;

    let worst: { need: NeedId; ratio: number } | null = null;
    for (const [need, actId] of Object.entries(content.needs.needActivities) as [NeedId, string][]) {
      if (!actId) continue;
      const nd = content.need(need);
      const value = a.needs[need];
      const ratio = value / Math.max(1, nd.critical);
      const relaxed = ['relax', 'idle', 'train'].includes(scheduled);
      // Besoin impossible à satisfaire ici (pas de douches…) : il ne doit pas bloquer les autres
      if (!this.canSatisfy(a, need, actId)) continue;
      if (value < nd.critical || (relaxed && value < nd.low)) {
        if (!worst || ratio < worst.ratio) worst = { need, ratio };
      }
    }
    if (worst && content.needs.needActivities[worst.need] !== scheduled) {
      chosen = content.needs.needActivities[worst.need]!;
      urgent = true;
    }
    if (!urgent && scheduled !== 'sleep') {
      if (a.gearPending?.length && this.startCollectGear(a)) return;
      if (this.lowAmmo(a, false) && this.startRearm(a, false)) return;
    }
    this.start(a, chosen, urgent, 0);
  }

  // ------------------------------------------------------------ Munitions et équipement individuels

  private ammoCap(a: Agent): number {
    return this.ctx.content.personnel(a.defId).ammoCapacity ?? 0;
  }

  /** À court de munitions (en combat : plus de quoi tirer ; sinon sous le seuil) et de quoi recompléter. */
  lowAmmo(a: Agent, combat: boolean): boolean {
    const cap = this.ammoCap(a);
    if (cap <= 0) return false;
    const ammo = a.ammo ?? cap;
    const low = combat ? ammo < this.ctx.content.combat.config.ammoPerShot : ammo < cap * this.ctx.content.balance.logistics.rearmBelow;
    return low && this.ctx.sim.logistics.free('ammo') >= 1;
  }

  /** Aller recompléter ses munitions au dépôt (ou sur l'aire de déchargement). */
  private startRearm(a: Agent, urgent: boolean): boolean {
    const src = this.ctx.sim.logistics.ammoSource(this.cellOf(a));
    const goals = src ? this.nav.accessCells(src) : [];
    const now = this.ctx.state.time.tick;
    a.activity = { id: 'rearm', targetId: src?.id ?? null, stage: 'moving', urgent, startTick: now, endTick: now };
    this.goTo(a, goals.length ? goals : null);
    return true;
  }

  private refillAmmo(a: Agent): void {
    const cap = this.ammoCap(a);
    const need = cap - (a.ammo ?? 0);
    const take = Math.min(need, Math.floor(this.ctx.sim.logistics.free('ammo') * 10) / 10);
    if (take > 0) {
      spend(this.ctx.state, { ammo: take });
      a.ammo = (a.ammo ?? 0) + take;
    }
    if (take < need) this.ctx.sim.economy.flagShortage('ammo');
  }

  /** Aller percevoir au dépôt l'équipement attribué. */
  private startCollectGear(a: Agent): boolean {
    const store = this.ctx.sim.supply.gearStore(this.cellOf(a));
    const goals = store ? this.nav.accessCells(store) : [];
    if (!store || goals.length === 0) return false;
    const now = this.ctx.state.time.tick;
    a.activity = { id: 'collect_gear', targetId: store.id, stage: 'moving', urgent: false, startTick: now, endTick: now };
    this.goTo(a, goals);
    return true;
  }

  private receiveGear(a: Agent): void {
    if (!a.gearPending?.length) return;
    a.gear = [...(a.gear ?? []), ...a.gearPending.filter((g) => !a.gear?.includes(g))];
    a.gearPending = [];
    this.ctx.bus.emit('gear:changed', {});
  }

  /** Une activité (ou l'une de ses activités de repli) peut-elle combler ce besoin maintenant ? */
  private canSatisfy(a: Agent, need: NeedId, actId: string): boolean {
    const content = this.ctx.content;
    let id: string | undefined = actId;
    for (let depth = 0; id && depth < 4; depth++) {
      const def = content.activity(id);
      if ((def.effectsPerHour[need] ?? 0) > 0) {
        if (!def.service) return true;
        if (def.service === 'sleep' ? !!a.homeId : this.hasService(def.service)) return true;
      }
      id = def.fallback;
    }
    return false;
  }

  private hasService(service: string): boolean {
    return Object.values(this.ctx.state.fob.buildings).some((b) => this.isOperational(b) && (this.stats(b).services[service]?.slots ?? 0) > 0);
  }

  private scheduledActivity(a: Agent): string {
    const content = this.ctx.content;
    return content.routine(content.personnel(a.defId).routine).hours[this.localHour(a)];
  }

  private start(a: Agent, actId: string, urgent: boolean, depth: number): void {
    const content = this.ctx.content;
    const def = content.activity(actId);
    // Hors des heures permises (bar fermé le jour…) : solution de repli
    if (def.hours && !this.activityAllowed(def) && def.fallback && depth < 4) return this.start(a, def.fallback, urgent, depth + 1);

    // Corvée de déchargement : un véhicule attend, on prête main-forte.
    if (def.helpUnload && depth === 0 && !urgent && this.pickHaulVehicle(a)) return this.start(a, 'haul', false, depth + 1);
    if (def.work === 'haul') return this.startHaul(a, def, urgent, depth);

    // Heures de travail du soutien : corvées de la spécialité, par ordre de priorité
    if (def.chores && depth === 0 && !urgent) {
      for (const duty of content.personnel(a.defId).duties ?? []) {
        if (duty === 'supply' && this.trySupply(a)) return;
        if (duty === 'cook' && this.tryCook(a)) return;
        if (duty === 'clean' && this.tryClean(a)) return;
      }
    }

    // Entraînement : stand de tir, parcours, maison de combat… si l'une est libre
    if (def.options && depth === 0 && !urgent) {
      const opts = [...def.options];
      for (let i = opts.length - 1; i > 0; i--) {
        const j = Math.floor(this.ctx.random() * (i + 1));
        [opts[i], opts[j]] = [opts[j], opts[i]];
      }
      for (const id of opts) {
        const o = content.activity(id);
        if (!this.activityAllowed(o)) continue;
        if (o.service && this.pickService(a, o.service, o)) return this.start(a, id, urgent, depth + 1);
      }
    }

    if (def.work === 'deploy') {
      const now = this.ctx.state.time.tick;
      a.activity = { id: actId, targetId: null, stage: 'moving', urgent, startTick: now, endTick: now };
      const spot = this.ctx.sim.missions.departurePoint();
      const goals = [spot, { x: spot.x + 1, y: spot.y }, { x: spot.x, y: spot.y + 1 }, { x: spot.x - 1, y: spot.y }, { x: spot.x, y: spot.y - 1 }].filter((c) => this.nav.walkable(c.x, c.y));
      return this.goTo(a, goals.length ? goals : [spot]);
    }
    if (def.work === 'defend') {
      const spot = this.ctx.sim.attacks.defensivePosition(a);
      if (!spot) return this.start(a, def.fallback ?? 'prone', urgent, depth + 1);
      const now = this.ctx.state.time.tick;
      a.activity = { id: actId, targetId: null, stage: 'moving', urgent, startTick: now, endTick: now };
      return this.goTo(a, [spot]);
    }

    let target: BuildingInstance | null = null;
    if (def.work === 'build') {
      target = this.pickWorkSite(a);
      // Chantier à court de matériaux : on va d'abord en chercher au dépôt
      if (target && this.ctx.sim.logistics.siteNeedsMaterials(target) && this.startFetch(a, target)) return;
    } else if (def.service) target = this.pickService(a, def.service, def);

    const needsTarget = def.work === 'build' || def.service !== undefined;
    let goals: GridPos[] | null = null;
    if (target) {
      goals = this.nav.accessCells(target);
      if (goals.length === 0) target = null;
    }
    // Service saturé (réfectoire, douches, latrines pleins) : on fait la queue devant la porte
    if (needsTarget && !target && def.queue && def.service && this.startQueue(a, actId, def.service, urgent)) return;
    if (needsTarget && !target) {
      if (def.fallback && depth < 4) return this.start(a, def.fallback, urgent, depth + 1);
      if (actId !== 'idle') return this.start(a, 'idle', urgent, depth + 1);
    }

    const now = this.ctx.state.time.tick;
    a.activity = { id: actId, targetId: target?.id ?? null, stage: 'moving', urgent, startTick: now, endTick: now };
    if (target) {
      const key = this.serviceKey(def);
      if (key) this.reserve(target.id, key);
    } else if (def.wander) {
      const spot = this.nav.randomWalkableNear(this.wanderAnchor(a, actId), this.ctx.content.balance.agents.wanderRadius, () => this.ctx.random());
      goals = spot ? [spot] : null;
    }
    this.goTo(a, goals);
  }

  /** Bâtiment le plus proche offrant ce service, même plein (pour y faire la queue). */
  private queueTarget(a: Agent, service: string, def: ActivityDef): BuildingInstance | null {
    let best: BuildingInstance | null = null;
    let bestDist = Infinity;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (!this.isOperational(b) || !(this.stats(b).services[service]?.slots ?? 0)) continue;
      // Réfectoire sans repas prêt : inutile d'attendre, ration froide
      if (def.usesMeals && this.ctx.content.building(b.defId).kitchen && this.ctx.sim.logistics.meals(b) < 1) continue;
      const d = this.distanceTo(a, b);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  }

  /** Va faire la queue devant un service saturé ; renvoie false s'il n'en existe aucun. */
  private startQueue(a: Agent, actId: string, service: string, urgent: boolean): boolean {
    const b = this.queueTarget(a, service, this.ctx.content.activity(actId));
    if (!b) return false;
    const access = this.nav.accessCells(b);
    if (access.length === 0) return false;
    // Places dans la file : devant les portes et juste à côté, pour ne pas s'entasser
    const spots: GridPos[] = [];
    for (const c of access) {
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (this.nav.walkable(x, y) && !this.ctx.sim.build.buildingAt({ x, y }) && !spots.some((s) => s.x === x && s.y === y)) spots.push({ x, y });
      }
    }
    const spot = spots.length ? spots[Math.floor(this.ctx.random() * spots.length)] : access[0];
    const now = this.ctx.state.time.tick;
    a.activity = { id: 'queue', targetId: b.id, stage: 'moving', urgent, startTick: now, endTick: now, queueFor: actId };
    this.goTo(a, [spot]);
    return true;
  }

  /** Dans la file : une place se libère → on entre ; trop d'attente → solution de repli. */
  private queueStep(a: Agent, act: AgentActivity): void {
    const want = this.ctx.content.activity(act.queueFor ?? 'idle');
    const minutes = (this.ctx.state.time.tick - act.startTick) * this.ctx.content.balance.time.minutesPerTick;
    const free = want.service ? this.pickService(a, want.service, want) : null;
    if (free) {
      this.ctx.sim.requirements.recordWait(want.service!, minutes, false);
      a.activity = null;
      return this.start(a, want.id, act.urgent, 1);
    }
    if (this.ctx.state.time.tick >= act.endTick) {
      this.ctx.sim.requirements.recordWait(want.service ?? '', minutes, true);
      a.activity = null;
      return this.start(a, want.fallback ?? 'idle', act.urgent, 1);
    }
  }

  /** Activité possible maintenant : plage horaire et ressources consommées disponibles. */
  activityAllowed(def: ActivityDef): boolean {
    if (def.hours) {
      const h = Math.floor(this.ctx.state.time.minuteOfDay / 60);
      const [a, b] = def.hours;
      if (!(a <= b ? h >= a && h < b : h >= a || h < b)) return false;
    }
    if (def.consumesPerHour && !canAfford(this.ctx.state, def.consumesPerHour)) return false;
    return true;
  }

  /** Lance le déplacement vers des cases objectifs (ou l'arrivée immédiate si déjà sur place). */
  private goTo(a: Agent, goals: GridPos[] | null): void {
    const cell = this.cellOf(a);
    if (!goals || goals.some((g) => g.x === cell.x && g.y === cell.y)) this.arrive(a);
    else this.pathQueue.set(a.id, goals);
  }

  private wanderAnchor(a: Agent, actId: string): GridPos {
    const home = a.homeId ? this.ctx.state.fob.buildings[a.homeId] : undefined;
    if (home && (actId === 'relax' || actId === 'sleep_rough')) return this.buildingCenter(home);
    if (actId === 'train') {
      const z = this.ctx.state.fob.zone;
      return { x: Math.floor(z.x + z.width / 2), y: Math.floor(z.y + z.height / 2) };
    }
    return this.cellOf(a);
  }

  private pickService(a: Agent, service: string, def?: ActivityDef): BuildingInstance | null {
    const { fob } = this.ctx.state;
    if (service === 'sleep') {
      const home = a.homeId ? fob.buildings[a.homeId] : undefined;
      return home && this.isOperational(home) ? home : null; // sans couchage attribué : à même le sol
    }
    const logistics = this.ctx.sim.logistics;
    let best: BuildingInstance | null = null;
    let bestDist = Infinity;
    for (const b of Object.values(fob.buildings)) {
      if (!this.isOperational(b)) continue;
      const svc = this.stats(b).services[service];
      if (!svc || this.occupancy(b.id, service) >= svc.slots) continue;
      // Réfectoire sans repas chaud prêt : ration froide
      if (def?.usesMeals && this.ctx.content.building(b.defId).kitchen && logistics.meals(b) < 1) continue;
      // Stand de tir ou maison de combat sans munitions livrées
      if (def?.consumesPerHour && bagEntries(def.consumesPerHour).some(([id]) => logistics.supplied(b).includes(id) && logistics.stock(b, id) < 1)) continue;
      const d = this.distanceTo(a, b);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  }

  /** Chantier le plus utile : construction, puis amélioration, puis réparation ; le plus proche à priorité égale. */
  private pickWorkSite(a: Agent): BuildingInstance | null {
    const max = this.ctx.content.balance.build.maxWorkersPerSite;
    const build = this.ctx.sim.build;
    let best: BuildingInstance | null = null;
    let bestScore = Infinity;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      const priority = b.state === 'construction' ? 0 : b.upgrade ? 1 : build.needsWork(b, false) ? 2 : -1;
      if (priority < 0 || this.builders(b.id) >= max) continue;
      const score = priority * 10000 + this.distanceTo(a, b);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ Déchargement

  private pickHaulVehicle(a: Agent): Id | null {
    const base = this.ctx.content.balance.supply.maxHaulersPerVehicle;
    let best: Id | null = null;
    let bestDist = Infinity;
    for (const v of this.ctx.sim.supply.haulableVehicles()) {
      const max = this.ctx.content.vehicle(v.defId).haulers ?? base;
      if (this.haulers(v.id) >= max) continue;
      const d = Math.abs(v.pos.x - a.pos.x) + Math.abs(v.pos.y - a.pos.y);
      if (d < bestDist) {
        bestDist = d;
        best = v.id;
      }
    }
    return best;
  }

  /** Cases où un agent peut se tenir pour charger depuis un véhicule. */
  private vehicleGoals(vehicleId: Id): GridPos[] {
    const v = this.ctx.state.vehicles[vehicleId];
    if (!v) return [];
    const cx = Math.floor(v.pos.x);
    const cy = Math.floor(v.pos.y);
    return [
      { x: cx, y: cy },
      { x: cx + 1, y: cy },
      { x: cx - 1, y: cy },
      { x: cx, y: cy + 1 },
      { x: cx, y: cy - 1 },
    ].filter((c) => this.nav.walkable(c.x, c.y));
  }

  private startHaul(a: Agent, def: ActivityDef, urgent: boolean, depth: number): void {
    const vehicleId = this.pickHaulVehicle(a);
    const goals = vehicleId ? this.vehicleGoals(vehicleId) : [];
    if (!vehicleId || goals.length === 0) {
      if (def.fallback && depth < 4) return this.start(a, def.fallback, urgent, depth + 1);
      return this.start(a, 'idle', urgent, depth + 1);
    }
    const now = this.ctx.state.time.tick;
    a.activity = { id: 'haul', targetId: null, stage: 'moving', urgent: false, startTick: now, endTick: now, vehicleId, phase: 'pickup', carry: null };
    this.reserve(vehicleId, HAUL_KEY);
    this.goTo(a, goals);
  }

  /** Fin d'une étape de déchargement : prise de charge au véhicule, ou dépôt au stockage. */
  private haulStep(a: Agent, act: AgentActivity): void {
    const supply = this.ctx.sim.supply;
    if (act.phase === 'pickup') {
      const capacity = Math.max(5, Math.round(this.ctx.content.balance.supply.carryCapacity * a.efficiency));
      const load = act.vehicleId ? supply.takeCargo(act.vehicleId, capacity) : null;
      if (!load) return this.endActivity(a);
      const target = supply.dropTarget(load.resource, this.cellOf(a));
      const goals = target ? this.nav.accessCells(target) : [];
      if (!target || goals.length === 0) {
        supply.returnCargo(act.vehicleId, load);
        return this.endActivity(a);
      }
      act.carry = load;
      act.phase = 'drop';
      act.targetId = target.id;
      act.stage = 'moving';
      return this.goTo(a, goals);
    }
    // Dépôt
    if (act.carry) gain(this.ctx.state, { [act.carry.resource]: act.carry.amount });
    act.carry = null;
    act.targetId = null;
    const stillOnDuty = this.ctx.content.activity(this.scheduledActivity(a)).helpUnload === true;
    const vehicle = act.vehicleId ? this.ctx.state.vehicles[act.vehicleId] : undefined;
    const goals = vehicle && stillOnDuty && supply.haulableVehicles().includes(vehicle) ? this.vehicleGoals(vehicle.id) : [];
    if (goals.length === 0) return this.endActivity(a);
    act.phase = 'pickup';
    act.stage = 'moving';
    this.goTo(a, goals);
  }

  // ------------------------------------------------------------ Corvées du soutien

  private beginTask(a: Agent, id: string, targetId: Id, extra: Partial<AgentActivity> = {}): AgentActivity {
    const now = this.ctx.state.time.tick;
    const act: AgentActivity = { id, targetId, stage: 'moving', urgent: false, startTick: now, endTick: now, ...extra };
    a.activity = act;
    return act;
  }

  /** Ravitaillement : prendre au dépôt ce qui manque à un bâtiment et le lui livrer. */
  private trySupply(a: Agent): boolean {
    const logistics = this.ctx.sim.logistics;
    const cell = this.cellOf(a);
    const d = logistics.pickDelivery(cell);
    if (!d || this.nav.accessCells(d.building).length === 0) return false;
    const src = logistics.sourceFor(d.resource, cell);
    const goals = src ? this.nav.accessCells(src) : [];
    this.beginTask(a, 'supply', d.building.id, { phase: 'pickup', supply: { resource: d.resource, amount: d.amount }, carry: null, sourceId: src?.id ?? null });
    this.goTo(a, goals.length ? goals : null); // sans dépôt dédié : le stock est pris sur place
    return true;
  }

  private supplyStep(a: Agent, act: AgentActivity): void {
    const logistics = this.ctx.sim.logistics;
    const target = this.ctx.state.fob.buildings[act.targetId ?? ''];
    if (!target || !act.supply) return this.endActivity(a);
    if (act.phase === 'pickup') {
      const amount = Math.min(act.supply.amount, Math.floor(logistics.free(act.supply.resource)));
      const goals = this.nav.accessCells(target);
      if (amount < 1 || goals.length === 0) return this.endActivity(a);
      act.carry = { resource: act.supply.resource, amount };
      act.phase = 'drop';
      act.stage = 'moving';
      return this.goTo(a, goals);
    }
    if (act.carry) logistics.deliver(target, act.carry.resource, act.carry.amount);
    act.carry = null;
    this.endActivity(a);
  }

  /** Cuisine du réfectoire à tenir : le cuisinier y va dès qu'il manque des repas. */
  private tryCook(a: Agent): boolean {
    const logistics = this.ctx.sim.logistics;
    const isCook = logistics.isCook(a);
    let best: BuildingInstance | null = null;
    let bestDist = Infinity;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (!logistics.cookingNeeded(b)) continue;
      const slots = this.stats(b).services.kitchen?.slots ?? 0;
      const used = this.occupancy(b.id, 'kitchen');
      // Le soutien ne dépanne en cuisine que si personne n'y est
      if (used >= slots || (!isCook && used > 0)) continue;
      const d = this.distanceTo(a, b);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    if (!best) return false;
    const goals = this.nav.accessCells(best);
    if (goals.length === 0) return false;
    this.beginTask(a, 'cook', best.id);
    this.reserve(best.id, 'kitchen');
    this.goTo(a, goals);
    return true;
  }

  /** Sanitaires ou réfectoire sales : un agent va les nettoyer (un seul par bâtiment). */
  private tryClean(a: Agent): boolean {
    const logistics = this.ctx.sim.logistics;
    let best: BuildingInstance | null = null;
    let bestScore = Infinity;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (!logistics.needsCleaning(b) || this.occupancy(b.id, CLEAN_KEY) > 0) continue;
      const score = logistics.cleanliness(b) * 100 + this.distanceTo(a, b);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (!best) return false;
    const goals = this.nav.accessCells(best);
    if (goals.length === 0) return false;
    this.beginTask(a, 'clean', best.id);
    this.reserve(best.id, CLEAN_KEY);
    this.goTo(a, goals);
    return true;
  }

  /** Aller chercher des matériaux au dépôt (ou au point d'arrivée des convois) pour un chantier. */
  private startFetch(a: Agent, site: BuildingInstance): boolean {
    const logistics = this.ctx.sim.logistics;
    const src = logistics.materialSource(this.cellOf(a));
    let goals = src ? this.nav.accessCells(src) : [];
    if (goals.length === 0) {
      const spot = this.ctx.sim.missions.departurePoint();
      goals = [spot, { x: spot.x + 1, y: spot.y }, { x: spot.x, y: spot.y + 1 }].filter((c) => this.nav.walkable(c.x, c.y));
    }
    if (goals.length === 0 || this.nav.accessCells(site).length === 0) return false;
    this.beginTask(a, 'fetch_materials', site.id, { phase: 'pickup', materials: 0, sourceId: src?.id ?? null });
    this.reserve(site.id, MAT_KEY);
    this.goTo(a, goals);
    return true;
  }

  private fetchStep(a: Agent, act: AgentActivity): void {
    const logistics = this.ctx.sim.logistics;
    const site = this.ctx.state.fob.buildings[act.targetId ?? ''];
    if (!site) return this.endActivity(a);
    if (act.phase === 'pickup') {
      const m = site.materials;
      const left = m ? m.needed - m.delivered : 0;
      const goals = this.nav.accessCells(site);
      if (left <= 0 || goals.length === 0) return this.endActivity(a);
      act.materials = Math.min(left, this.ctx.content.balance.logistics.materials.perTrip);
      act.phase = 'drop';
      act.stage = 'moving';
      return this.goTo(a, goals);
    }
    logistics.deliverMaterials(site, act.materials ?? 0);
    act.materials = 0;
    this.endActivity(a); // puis retour au chantier : montage ou nouvel aller-retour
  }

  // ------------------------------------------------------------ Arrivée et durée

  /** Durée de l'activité : fixe pour un besoin, jusqu'au changement d'emploi du temps sinon. */
  private duration(a: Agent, def: ActivityDef, urgent: boolean): number {
    if (def.mode === 'need' || urgent) return def.durationMin;
    const routine = this.ctx.content.routine(this.ctx.content.personnel(a.defId).routine);
    const h = this.localHour(a);
    let blocks = 0;
    while (blocks < 24 && routine.hours[(h + blocks) % 24] === def.id) blocks++;
    if (blocks === 0) return Math.min(def.durationMin, 60); // activité de repli
    const minutes = blocks * 60 - (this.ctx.state.time.minuteOfDay % 60);
    return Math.max(15, Math.min(def.durationMin, minutes));
  }

  /** Arrivée sur place : début de l'activité et consommation éventuelle. */
  private arrive(a: Agent): void {
    const act = a.activity as AgentActivity;
    const def = this.ctx.content.activity(act.id);
    const state = this.ctx.state;
    const minutesPerTick = this.ctx.content.balance.time.minutesPerTick;
    a.path = [];
    if (act.id === 'haul') {
      const cfg = this.ctx.content.balance.supply;
      act.stage = 'acting';
      act.startTick = state.time.tick;
      act.endTick = state.time.tick + Math.ceil((act.phase === 'pickup' ? cfg.pickupMinutes : cfg.dropMinutes) / minutesPerTick);
      return;
    }
    if (act.id === 'rearm' || act.id === 'collect_gear') {
      const cfg = this.ctx.content.balance.logistics;
      act.stage = 'acting';
      act.startTick = state.time.tick;
      act.endTick = state.time.tick + Math.ceil((act.id === 'rearm' ? cfg.rearmMinutes : cfg.gearMinutes) / minutesPerTick);
      return;
    }
    if (act.id === 'march_out') return this.leaveMap(a);
    if (act.id === 'supply' || act.id === 'fetch_materials') {
      const cfg = this.ctx.content.balance.logistics;
      act.stage = 'acting';
      act.startTick = state.time.tick;
      act.endTick = state.time.tick + Math.ceil((act.phase === 'pickup' ? cfg.pickupMinutes : cfg.dropMinutes) / minutesPerTick);
      return;
    }
    const target = act.targetId ? state.fob.buildings[act.targetId] : undefined;
    // Repas chaud préparé par les cuisiniers ; s'il n'y en a plus, ration froide
    let mealServed = false;
    if (def.usesMeals && target && this.ctx.content.building(target.defId).kitchen) {
      const quality = this.ctx.sim.logistics.takeMeal(target);
      if (quality === null) {
        a.activity = null;
        return this.start(a, def.fallback ?? 'eat_mre', act.urgent, 1);
      }
      act.quality = quality;
      mealServed = true;
    }
    if (target && def.service) this.ctx.sim.logistics.soil(target);
    if (def.consumes && !mealServed) {
      if (!canAfford(state, def.consumes)) {
        for (const [id, v] of bagEntries(def.consumes)) {
          if (state.resources.stock[id] < v) this.ctx.sim.economy.flagShortage(id);
        }
        // Rien à consommer : l'agent patiente avant de réessayer.
        const now = state.time.tick;
        a.activity = { id: 'idle', targetId: null, stage: 'acting', urgent: false, startTick: now, endTick: now + 30 };
        return;
      }
      spend(state, def.consumes);
    }
    act.stage = 'acting';
    act.startTick = state.time.tick;
    act.endTick = state.time.tick + Math.ceil(this.duration(a, def, act.urgent) / minutesPerTick);
  }

  // ------------------------------------------------------------ Déplacements

  private processPathQueue(): void {
    let budget = this.ctx.content.balance.agents.pathRequestsPerTick;
    for (const [id, goals] of this.pathQueue) {
      if (budget-- <= 0) break;
      this.pathQueue.delete(id);
      const a = this.ctx.state.agents[id];
      if (!a?.activity || a.activity.stage !== 'moving') continue;
      const path = this.nav.findPath(this.cellOf(a), goals);
      if (!path) {
        this.failActivity(a);
      } else if (path.length === 0) {
        this.arrive(a);
      } else {
        a.path = path;
      }
    }
  }

  /** Destination inaccessible : on se rabat sur l'activité de repli. */
  private failActivity(a: Agent): void {
    if (a.activity?.id === 'march_out') return this.leaveMap(a);
    const def = a.activity ? this.ctx.content.activity(a.activity.id) : null;
    const urgent = a.activity?.urgent ?? false;
    const carry = a.activity?.id === 'haul' ? a.activity.carry : null;
    if (carry) gain(this.ctx.state, { [carry.resource]: carry.amount });
    a.activity = null;
    a.path = [];
    if (def?.fallback) this.start(a, def.fallback, urgent, 1);
    else if (def?.id !== 'idle') this.start(a, 'idle', false, 1);
    else {
      const now = this.ctx.state.time.tick;
      a.activity = { id: 'idle', targetId: null, stage: 'acting', urgent: false, startTick: now, endTick: now + 30 };
    }
  }

  private move(a: Agent): void {
    const def: PersonnelDef = this.ctx.content.personnel(a.defId);
    const cfg = this.ctx.content.balance;
    let budget = def.walkSpeed * Math.max(cfg.agents.minWalkSpeedFactor, a.efficiency) * cfg.time.minutesPerTick;
    while (budget > 0 && a.path.length > 0) {
      const next = a.path[0];
      if (!this.nav.walkable(next.x, next.y)) {
        // Un bâtiment a été posé sur le trajet : on recalcule vers la même destination.
        const goal = a.path[a.path.length - 1];
        a.path = [];
        if (this.nav.walkable(goal.x, goal.y)) this.pathQueue.set(a.id, [goal]);
        else this.endActivity(a);
        return;
      }
      const tx = next.x + 0.5;
      const ty = next.y + 0.5;
      const dx = tx - a.pos.x;
      const dy = ty - a.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = budget / this.nav.costAt(next.x, next.y);
      if (step >= dist) {
        a.pos.x = tx;
        a.pos.y = ty;
        a.path.shift();
        budget -= dist * this.nav.costAt(next.x, next.y);
      } else {
        a.pos.x += (dx / dist) * step;
        a.pos.y += (dy / dist) * step;
        budget = 0;
      }
    }
    if (a.path.length === 0 && a.activity?.stage === 'moving') this.arrive(a);
  }

  // ------------------------------------------------------------ Utilitaires

  cellOf(a: Agent): GridPos {
    return { x: Math.floor(a.pos.x), y: Math.floor(a.pos.y) };
  }

  buildingCenter(b: BuildingInstance): GridPos {
    const [w, h] = BuildSystem.footprint(this.ctx.content.building(b.defId), b.rot);
    return { x: Math.floor(b.pos.x + w / 2), y: Math.floor(b.pos.y + h / 2) };
  }

  private distanceTo(a: Agent, b: BuildingInstance): number {
    const c = this.buildingCenter(b);
    return Math.abs(c.x - a.pos.x) + Math.abs(c.y - a.pos.y);
  }

  /** Besoins sous le seuil critique (pour les alertes visuelles). */
  criticalNeeds(a: Agent): NeedId[] {
    return NEED_IDS.filter((n) => a.needs[n] < this.ctx.content.need(n).critical);
  }
}
