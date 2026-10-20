/**
 * LogisticsSystem — logistique interne de la base :
 * - stocks locaux des bâtiments consommateurs (réfectoire, tours, artillerie, stand de tir,
 *   groupes électrogènes, infirmerie), approvisionnés depuis l'entrepôt ou le dépôt par le soutien ;
 * - cuisine : les cuisiniers transforment les rations du réfectoire en repas chauds ;
 * - propreté des sanitaires et du réfectoire, rétablie par les corvées de nettoyage ;
 * - matériaux de chantier (construction, amélioration, module) portés jusqu'aux chantiers.
 *
 * Les stocks locaux font partie du stock global affiché (ils en sont une affectation) :
 * livrer ne change pas le total, consommer le diminue aux deux endroits.
 */
import type { BuildingDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { Agent, BuildingInstance, GridPos, Id, ResourceBag, ResourceId } from '../core/GameState';
import { spend } from '../core/resources';
import type { System } from './System';

/** Clé des repas préparés dans l'inventaire du réfectoire. */
export const MEALS = 'meals';

/** Livraison à effectuer : bâtiment, ressource et quantité à porter. */
export interface Delivery {
  building: BuildingInstance;
  resource: ResourceId;
  amount: number;
}

export class LogisticsSystem implements System {
  readonly id = 'logistics';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('building:completed', ({ id }) => this.onCompleted(id));
    ctx.bus.on('time:hour', () => this.hourly());
  }

  private get cfg() {
    return this.ctx.content.balance.logistics;
  }

  private isOperational(b: BuildingInstance): boolean {
    return b.state === 'active' || b.state === 'damaged';
  }

  private def(b: BuildingInstance): BuildingDef {
    return this.ctx.content.building(b.defId);
  }

  private buildings(): BuildingInstance[] {
    return Object.values(this.ctx.state.fob.buildings);
  }

  // ------------------------------------------------------------ Stocks locaux

  /** Quantité en stock local (ressource ou repas). */
  stock(b: BuildingInstance, key: string): number {
    return b.inventory?.[key] ?? 0;
  }

  private setStock(b: BuildingInstance, key: string, value: number): void {
    b.inventory ??= {};
    b.inventory[key] = Math.max(0, value);
  }

  /** Ressources tenues en stock local par ce bâtiment. */
  supplied(b: BuildingInstance): ResourceId[] {
    return Object.keys(this.def(b).supplies ?? {}) as ResourceId[];
  }

  capacity(b: BuildingInstance, res: ResourceId): number {
    return this.def(b).supplies?.[res]?.capacity ?? 0;
  }

  /** Quantité affectée aux bâtiments (stocks locaux + ravitaillements en cours de transport). */
  allocated(res: ResourceId): number {
    let n = 0;
    for (const b of this.buildings()) n += this.stock(b, res);
    for (const a of Object.values(this.ctx.state.agents)) {
      const act = a.activity;
      if (act?.id === 'supply' && act.carry?.resource === res) n += act.carry.amount;
    }
    return n;
  }

  /** Stock global encore disponible pour de nouvelles livraisons. */
  free(res: ResourceId): number {
    return Math.max(0, this.ctx.state.resources.stock[res] - this.allocated(res));
  }

  /** Quantité déjà en route vers ce bâtiment (prévue ou portée). */
  incoming(b: BuildingInstance, res: ResourceId): number {
    let n = 0;
    for (const a of Object.values(this.ctx.state.agents)) {
      const act = a.activity;
      if (act?.id === 'supply' && act.targetId === b.id && act.supply?.resource === res) n += act.carry?.amount ?? act.supply.amount;
    }
    return n;
  }

  /** Bâtiment à court : son stock local est vide (tour sans munitions, groupe sans carburant…). */
  starved(b: BuildingInstance, res: ResourceId): boolean {
    return (this.def(b).supplies?.[res] !== undefined) && this.stock(b, res) < 0.01;
  }

  /**
   * Consomme une ressource pour un bâtiment : dans son stock local s'il en tient un,
   * sinon directement dans le stock global. Renvoie false si la quantité manque.
   */
  consume(b: BuildingInstance | null | undefined, res: ResourceId, amount: number): boolean {
    const state = this.ctx.state;
    if (state.resources.stock[res] < amount - 1e-9) return false;
    if (b && this.def(b).supplies?.[res]) {
      if (this.stock(b, res) < amount - 1e-9) return false;
      this.setStock(b, res, this.stock(b, res) - amount);
    }
    spend(state, { [res]: amount } as ResourceBag);
    return true;
  }

  /** Dépose une livraison dans le stock local (plafonné à la capacité). */
  deliver(b: BuildingInstance, res: ResourceId, amount: number): void {
    this.setStock(b, res, Math.min(this.capacity(b, res), this.stock(b, res) + amount));
    if (res === 'fuel') this.ctx.sim.economy.recomputePower();
  }

  /**
   * Livraison la plus utile pour un agent : bâtiment dont le stock (livraisons en cours comprises)
   * passe sous son seuil, le plus vide d'abord puis le plus proche.
   */
  pickDelivery(from: GridPos): Delivery | null {
    let best: Delivery | null = null;
    let bestScore = Infinity;
    const free = new Map<ResourceId, number>();
    for (const b of this.buildings()) {
      if (!this.isOperational(b)) continue;
      for (const [res, s] of Object.entries(this.def(b).supplies ?? {}) as [ResourceId, { capacity: number; refillBelow: number }][]) {
        const have = this.stock(b, res) + this.incoming(b, res);
        if (have >= s.refillBelow) continue;
        if (!free.has(res)) free.set(res, this.free(res));
        const avail = Math.floor(free.get(res)!);
        const amount = Math.min(Math.floor(s.capacity - have), this.cfg.carryCapacity, avail);
        if (amount < 1) continue;
        const c = this.center(b);
        const score = (have / s.capacity) * 200 + Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
        if (score < bestScore) {
          bestScore = score;
          best = { building: b, resource: res, amount };
        }
      }
    }
    return best;
  }

  /** Lieu de retrait d'une ressource (dépôt, entrepôt, citerne ; à défaut une aire de déchargement). */
  sourceFor(res: ResourceId, from: GridPos): BuildingInstance | null {
    return this.ctx.sim.supply.dropTarget(res, from);
  }

  /** Dotation initiale d'un bâtiment terminé : stock local rempli sur le disponible, repas prêts. */
  private onCompleted(id: Id): void {
    const b = this.ctx.state.fob.buildings[id];
    if (!b) return;
    const def = this.def(b);
    for (const [res, s] of Object.entries(def.supplies ?? {}) as [ResourceId, { capacity: number }][]) {
      if (this.stock(b, res) > 0) continue;
      this.setStock(b, res, Math.min(s.capacity, Math.floor(this.free(res))));
    }
    if (def.cleaning && b.cleanliness === undefined) b.cleanliness = 1;
    if (def.kitchen && this.stock(b, MEALS) === 0) {
      const meals = Math.min(Math.floor(def.kitchen.mealCapacity / 2), Math.floor(this.free('food') / this.cfg.foodPerMeal));
      if (meals > 0) {
        spend(this.ctx.state, { food: meals * this.cfg.foodPerMeal });
        this.setStock(b, MEALS, meals);
      }
    }
    if (def.supplies?.fuel) this.ctx.sim.economy.recomputePower();
  }

  // ------------------------------------------------------------ Cuisine

  /** Repas chauds prêts au réfectoire. */
  meals(b: BuildingInstance): number {
    return this.stock(b, MEALS);
  }

  /** Qualité moyenne des repas prêts (1 = cuisinier, moins pour une cuisine de fortune). */
  mealQuality(b: BuildingInstance): number {
    return b.inventory?.mealQ ?? 1;
  }

  /** Prend un repas préparé : sa qualité, ou null s'il n'y en a plus (ration froide). */
  takeMeal(b: BuildingInstance): number | null {
    if (this.meals(b) < 1) return null;
    this.setStock(b, MEALS, this.meals(b) - 1);
    return this.mealQuality(b);
  }

  /** Agent dont la cuisine est le métier (sinon cuisine de fortune). */
  isCook(a: Agent): boolean {
    return this.ctx.content.personnel(a.defId).routine === 'kitchen';
  }

  /** Lieu où recompléter ses munitions : dépôt de munitions d'abord, sinon une aire de déchargement. */
  ammoSource(from: GridPos): BuildingInstance | null {
    return this.ctx.sim.supply.dropTarget('ammo', from);
  }

  /** La cuisine a besoin d'un cuisinier : repas sous le seuil et rations en réserve. */
  cookingNeeded(b: BuildingInstance): boolean {
    const k = this.def(b).kitchen;
    if (!k || !this.isOperational(b)) return false;
    return this.meals(b) < k.mealCapacity * this.cfg.cookBelow && this.stock(b, 'food') >= this.cfg.foodPerMeal;
  }

  // ------------------------------------------------------------ Propreté

  cleanliness(b: BuildingInstance): number {
    return this.def(b).cleaning ? (b.cleanliness ?? 1) : 1;
  }

  /** Multiplicateur des bienfaits d'un service selon la propreté. */
  cleanFactor(b: BuildingInstance): number {
    return 0.7 + 0.3 * this.cleanliness(b);
  }

  /** Un usage salit le bâtiment. */
  soil(b: BuildingInstance): void {
    const c = this.def(b).cleaning;
    if (c) b.cleanliness = Math.max(0, this.cleanliness(b) - c.dirtPerUse);
  }

  needsCleaning(b: BuildingInstance): boolean {
    return !!this.def(b).cleaning && this.isOperational(b) && this.cleanliness(b) < this.cfg.cleanBelow;
  }

  dirty(b: BuildingInstance): boolean {
    return !!this.def(b).cleaning && this.cleanliness(b) < this.cfg.dirtyBelow;
  }

  // ------------------------------------------------------------ Matériaux de chantier

  /** Unités de matériaux d'un chantier selon son coût (rien pour les ouvrages en ligne). */
  materialsFor(def: BuildingDef, cost: ResourceBag): number {
    if (def.placement.line) return 0;
    const m = this.cfg.materials;
    const units = Math.ceil((cost.funds ?? 0) / m.fundsPerUnit + (cost.parts ?? 0) / 10);
    return Math.max(1, Math.min(m.maxUnits, units));
  }

  /** Ouvre le suivi des matériaux d'un nouveau chantier. */
  startMaterials(b: BuildingInstance, cost: ResourceBag): void {
    const needed = this.materialsFor(this.def(b), cost);
    b.materials = needed > 0 ? { needed, delivered: 0 } : null;
  }

  /** Avancement du chantier en cours (0..1). */
  workProgress(b: BuildingInstance): number {
    if (b.state === 'construction') return b.buildProgress;
    if (b.moduleWork) return b.moduleWork.progress;
    if (b.upgrade) return b.upgrade.progress;
    return 1;
  }

  /** Avancement maximal permis par les matériaux livrés. */
  materialCap(b: BuildingInstance): number {
    const m = b.materials;
    return m && m.needed > 0 ? Math.min(1, m.delivered / m.needed) : 1;
  }

  /** L'équipe de chantier locale apporte elle-même les matériaux de sa part de travail. */
  crewDeliver(b: BuildingInstance, progressDelta: number): void {
    const m = b.materials;
    if (m) m.delivered = Math.min(m.needed, m.delivered + m.needed * progressDelta);
  }

  /** Matériaux sur place pas encore montés (unités). */
  onSite(b: BuildingInstance): number {
    const m = b.materials;
    return m ? Math.max(0, m.delivered - this.workProgress(b) * m.needed) : 0;
  }

  /** Matériaux en route vers ce chantier. */
  incomingMaterials(b: BuildingInstance): number {
    let n = 0;
    for (const a of Object.values(this.ctx.state.agents)) {
      const act = a.activity;
      if (act?.id === 'fetch_materials' && act.targetId === b.id) n += act.materials || this.cfg.materials.perTrip;
    }
    return n;
  }

  fetchers(b: BuildingInstance): number {
    let n = 0;
    for (const a of Object.values(this.ctx.state.agents)) if (a.activity?.id === 'fetch_materials' && a.activity.targetId === b.id) n++;
    return n;
  }

  /** Le chantier manque de matériaux sur place : un ouvrier doit aller en chercher. */
  siteNeedsMaterials(b: BuildingInstance): boolean {
    const m = b.materials;
    if (!m || m.delivered >= m.needed - 1e-6) return false;
    const cfg = this.cfg.materials;
    if (m.delivered + this.incomingMaterials(b) >= m.needed - 1e-6) return false;
    if (this.fetchers(b) >= cfg.maxFetchersPerSite) return false;
    return this.onSite(b) + this.incomingMaterials(b) < cfg.perTrip * 2;
  }

  /** Livraison de matériaux sur le chantier. */
  deliverMaterials(b: BuildingInstance, units: number): void {
    const m = b.materials;
    if (m) m.delivered = Math.min(m.needed, m.delivered + units);
  }

  /** Point de retrait des matériaux le plus proche (entrepôt, zone de déchargement…). */
  materialSource(from: GridPos): BuildingInstance | null {
    let best: BuildingInstance | null = null;
    let bestD = Infinity;
    for (const b of this.buildings()) {
      if (!this.isOperational(b) || !this.def(b).materialDepot) continue;
      const c = this.center(b);
      const d = Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ Simulation

  onTick(): void {
    const minutes = this.ctx.content.balance.time.minutesPerTick;
    const cfg = this.cfg;
    const fob = this.ctx.state.fob.buildings;
    for (const a of Object.values(this.ctx.state.agents)) {
      const act = a.activity;
      if (!act || act.stage !== 'acting' || !act.targetId) continue;
      const b = fob[act.targetId];
      if (!b || !this.isOperational(b)) continue;
      if (act.id === 'cook') this.cook(a, b, minutes);
      else if (act.id === 'clean' && this.def(b).cleaning) {
        b.cleanliness = Math.min(1, this.cleanliness(b) + (cfg.cleanPerHour * a.efficiency * minutes) / 60);
      }
    }
  }

  private cook(a: Agent, b: BuildingInstance, minutes: number): void {
    const k = this.def(b).kitchen;
    if (!k) return;
    const cfg = this.cfg;
    const rate = (cfg.mealsPerCookHour * a.efficiency * this.ctx.sim.economy.buildingEfficiency(b) * minutes) / 60;
    const food = Math.min(this.stock(b, 'food'), this.ctx.state.resources.stock.food);
    const n = Math.min(rate, k.mealCapacity - this.meals(b), food / cfg.foodPerMeal);
    if (n <= 0) return;
    this.setStock(b, 'food', this.stock(b, 'food') - n * cfg.foodPerMeal);
    spend(this.ctx.state, { food: n * cfg.foodPerMeal });
    // Qualité moyenne du stock de repas : un soldat qui dépanne cuisine moins bien
    const q = this.isCook(a) ? 1 : cfg.amateurMealQuality;
    const have = this.meals(b);
    this.setStock(b, 'mealQ', (have * this.mealQuality(b) + n * q) / (have + n));
    this.setStock(b, MEALS, have + n);
  }

  /** Consommation horaire des bâtiments puisée dans leur stock local ; cohérence avec le stock global. */
  private hourly(): void {
    for (const b of this.buildings()) {
      if (!this.isOperational(b)) continue;
      const def = this.def(b);
      if (!def.supplies) continue;
      for (const [res, v] of Object.entries(def.consumptionPerDay ?? {}) as [ResourceId, number][]) {
        if (def.supplies[res]) this.setStock(b, res, this.stock(b, res) - v / 24);
      }
    }
    // Un stock global entamé par ailleurs (pillage, incident…) réduit d'autant les stocks locaux.
    const stock = this.ctx.state.resources.stock;
    const totals = new Map<ResourceId, number>();
    for (const b of this.buildings()) {
      for (const res of this.supplied(b)) totals.set(res, (totals.get(res) ?? 0) + this.stock(b, res));
    }
    for (const [res, total] of totals) {
      if (total <= stock[res] + 1e-6 || total <= 0) continue;
      const k = stock[res] / total;
      for (const b of this.buildings()) if (this.def(b).supplies?.[res]) this.setStock(b, res, this.stock(b, res) * k);
    }
    this.ctx.sim.economy.recomputePower();
  }

  private center(b: BuildingInstance): GridPos {
    return this.ctx.sim.agents.buildingCenter(b);
  }
}
