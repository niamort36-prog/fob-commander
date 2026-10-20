/**
 * EconomySystem — capacités de stockage, flux horaires (production, consommation, entretien,
 * salaires), électricité, rendement des bâtiments, pénuries, projections du tableau de bord,
 * et évaluation quotidienne du commandement (réputation, budget, déblocages).
 */
import { buildingStats } from '../core/buildingStats';
import type { GameContext } from '../core/GameContext';
import { RESOURCE_IDS, emptyResourceRecord, type BuildingInstance, type ResourceBag, type ResourceId } from '../core/GameState';
import { pushLog } from '../core/Log';
import { bagEntries, gain } from '../core/resources';
import type { System } from './System';
import { installedModules } from './modules';

/** Capacité « illimitée » sérialisable en JSON (Infinity ne l'est pas). */
export const UNCAPPED = Number.MAX_SAFE_INTEGER;

export interface ResourceProjection {
  perDay: number;
  /** Jours avant épuisement si le flux est négatif, sinon null. */
  daysLeft: number | null;
}

/** Détail de l'évaluation du commandement (chaque critère entre 0 et 1). */
export interface Evaluation {
  morale: number;
  housing: number;
  guard: number;
  supply: number;
  rating: number;
}

export class EconomySystem implements System {
  readonly id = 'economy';
  private readonly pendingShortages = new Set<ResourceId>();

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('time:hour', () => this.hourly());
    ctx.bus.on('time:newDay', ({ day }) => this.newDay(day));
    const refresh = (): void => {
      this.recomputeCapacity();
      this.recomputePower();
    };
    ctx.bus.on('building:completed', refresh);
    ctx.bus.on('building:removed', refresh);
    ctx.bus.on('building:upgraded', refresh);
  }

  onStateLoaded(): void {
    this.recomputeCapacity();
    this.recomputePower();
  }

  private isOperational(b: BuildingInstance): boolean {
    return b.state === 'active' || b.state === 'damaged';
  }

  /** Caractéristiques du niveau, augmentées des améliorations installées (électricité, entretien). */
  private stats(b: BuildingInstance) {
    const def = this.ctx.content.building(b.defId);
    const base = buildingStats(def, b.level);
    const mods = installedModules(def, b);
    if (!mods.length) return base;
    const upkeep: ResourceBag = { ...base.upkeepPerDay };
    for (const m of mods) for (const [id, v] of bagEntries(m.upkeepPerDay)) upkeep[id] = (upkeep[id] ?? 0) + v;
    return { ...base, powerDemand: base.powerDemand + mods.reduce((s, m) => s + (m.powerDemand ?? 0), 0), upkeepPerDay: upkeep };
  }

  // ------------------------------------------------------------ Électricité et rendement

  /** Production des groupes (s'il reste du carburant) et demande des bâtiments en service. */
  recomputePower(): void {
    const res = this.ctx.state.resources;
    const fuel = res.stock.fuel > 0;
    let supply = 0;
    let demand = 0;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (!this.isOperational(b)) continue;
      const st = this.stats(b);
      // Groupe électrogène : carburant en stock et livré dans sa cuve
      const fed = fuel && !this.ctx.sim.logistics?.starved(b, 'fuel');
      if (st.powerSupply && fed) supply += st.powerSupply * (b.state === 'damaged' ? 0.6 : 1);
      demand += st.powerDemand;
    }
    res.power = { supply: Math.round(supply), demand: Math.round(demand) };
  }

  /** Part de la demande électrique satisfaite (1 = tout est alimenté). */
  powerRatio(): number {
    const { supply, demand } = this.ctx.state.resources.power;
    return demand > 0 ? Math.min(1, supply / demand) : 1;
  }

  /**
   * Rendement d'un bâtiment (0..1) : état (endommagé, hors service) et alimentation électrique.
   * S'applique à la production et à l'efficacité des services rendus aux agents.
   */
  buildingEfficiency(b: BuildingInstance): number {
    if (!this.isOperational(b)) return 0;
    let eff = b.state === 'damaged' ? 0.6 : 1;
    if (this.stats(b).powerDemand > 0) {
      const f = this.ctx.content.balance.power.unpoweredServiceFactor;
      eff *= f + (1 - f) * this.powerRatio();
    }
    return eff;
  }

  // ------------------------------------------------------------ Flux

  /** Ajoute des points de réputation (dépensés pour débloquer des bâtiments). */
  gainPoints(n: number): void {
    if (n > 0) this.ctx.state.progression.points += n;
  }

  /** Budget quotidien versé par le commandement, modulé par la dernière évaluation. */
  dailyBudget(rating = this.ctx.state.progression.lastRating ?? 0.5): number {
    const cmd = this.ctx.content.balance.command;
    const mult = cmd.budgetMin + (cmd.budgetMax - cmd.budgetMin) * rating;
    return Math.round(this.ctx.content.balance.economy.dailyBudget * this.ctx.site.budgetMult * mult * this.ctx.sim.diplomacy.budgetMult());
  }

  /** Salaires journaliers du personnel présent. */
  dailySalaries(): number {
    let total = 0;
    for (const a of Object.values(this.ctx.state.agents)) {
      if (a.status !== 'kia') total += this.ctx.content.personnel(a.defId).salaryPerDay;
    }
    return total;
  }

  /** Flux journalier lié aux bâtiments, aux salaires et aux véhicules de la base. */
  dailyFlow(): Record<ResourceId, number> {
    const flow = emptyResourceRecord();
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (b.state === 'construction') continue;
      const st = this.stats(b);
      for (const [id, v] of bagEntries(st.upkeepPerDay)) flow[id] -= v;
      if (!this.isOperational(b)) continue;
      const eff = this.buildingEfficiency(b);
      for (const [id, v] of bagEntries(st.productionPerDay)) flow[id] += v * eff;
      for (const [id, v] of bagEntries(st.consumptionPerDay)) {
        if (!this.ctx.sim.logistics?.starved(b, id)) flow[id] -= v; // stock local vide : rien à consommer
      }
    }
    flow.funds -= this.dailySalaries();
    for (const v of Object.values(this.ctx.state.vehicles)) {
      for (const [id, n] of bagEntries(this.ctx.content.vehicle(v.defId).upkeepPerDay)) flow[id] -= n;
    }
    flow.power = 0; // l'électricité est un flux instantané, pas un stock
    return flow;
  }

  projections(): Record<ResourceId, ResourceProjection> {
    const flow = this.dailyFlow();
    flow.funds += this.dailyBudget();
    for (const [id, v] of bagEntries(this.ctx.sim.needs.dailyConsumptionEstimate())) flow[id] -= v;
    const out = {} as Record<ResourceId, ResourceProjection>;
    for (const id of RESOURCE_IDS) {
      const perDay = flow[id];
      const stock = this.ctx.state.resources.stock[id];
      out[id] = { perDay, daysLeft: perDay < 0 ? stock / -perDay : null };
    }
    return out;
  }

  recomputeCapacity(): void {
    const res = this.ctx.state.resources;
    const base = this.ctx.content.balance.economy.baseCapacity;
    const cap = emptyResourceRecord();
    for (const id of RESOURCE_IDS) {
      cap[id] = this.ctx.content.resource(id).capped ? (base[id] ?? 0) : UNCAPPED;
    }
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (b.state === 'construction') continue;
      for (const [id, v] of bagEntries(this.stats(b).storage)) {
        if (cap[id] !== UNCAPPED) cap[id] += v;
      }
    }
    res.capacity = cap;
    // Une capacité réduite (démolition d'une citerne…) fait perdre l'excédent.
    for (const id of RESOURCE_IDS) if (id !== 'power') res.stock[id] = Math.min(res.stock[id], cap[id]);
  }

  // ------------------------------------------------------------ Pénuries

  /**
   * Signale une demande non satisfaite par un autre système (personnel qui ne peut pas boire
   * ou manger…). La pénurie est annoncée immédiatement et maintenue jusqu'à l'heure suivante.
   */
  flagShortage(id: ResourceId): void {
    this.pendingShortages.add(id);
    this.announceShortage(id);
  }

  private announceShortage(id: ResourceId): void {
    const res = this.ctx.state.resources;
    if (res.shortages.includes(id)) return;
    res.shortages.push(id);
    this.ctx.bus.emit('resource:shortage', { resource: id });
    if (id === 'power') pushLog(this.ctx, 'warn', 'log.powerShortage', { supply: res.power.supply, demand: res.power.demand });
    else pushLog(this.ctx, 'bad', 'log.shortage', { resource: this.ctx.content.resource(id).name });
  }

  private hourly(): void {
    const res = this.ctx.state.resources;
    this.recomputePower();
    const flow = this.dailyFlow();
    const short = new Set<ResourceId>(this.pendingShortages);
    this.pendingShortages.clear();
    for (const id of RESOURCE_IDS) {
      if (id === 'power') continue;
      const delta = flow[id] / 24;
      if (delta === 0) continue;
      const wanted = res.stock[id] + delta;
      if (wanted < 0) short.add(id);
      const after = Math.min(res.capacity[id], Math.max(0, wanted));
      res.todayDelta[id] = (res.todayDelta[id] ?? 0) + (after - res.stock[id]);
      res.stock[id] = after;
    }
    // Bâtiment à sec sans rien à lui livrer : pénurie de la ressource
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (!this.isOperational(b)) continue;
      for (const id of this.ctx.sim.logistics.supplied(b)) {
        if (this.ctx.sim.logistics.starved(b, id) && this.ctx.sim.logistics.free(id) < 1) short.add(id);
      }
    }
    // Panne d'électricité : signalée comme une pénurie
    if (res.power.demand > 0 && res.power.supply < res.power.demand) short.add('power');
    res.shortages = res.shortages.filter((id) => short.has(id));
    for (const id of short) this.announceShortage(id);
  }

  // ------------------------------------------------------------ Évaluation du commandement

  /** Évaluation instantanée de la base selon les critères du commandement. */
  evaluate(): Evaluation {
    const cmd = this.ctx.content.balance.command;
    const agents = Object.values(this.ctx.state.agents).filter((a) => a.status !== 'kia');
    const morale = agents.length ? agents.reduce((s, a) => s + a.needs.morale, 0) / agents.length / 100 : 0.5;
    const housing = agents.length ? agents.filter((a) => a.homeId).length / agents.length : 1;
    let posts = 0;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (this.isOperational(b)) posts += this.stats(b).services.guard?.slots ?? 0;
    }
    const guard = Math.min(1, posts / Math.max(1, cmd.guardPostsWanted));
    const supply = Math.max(0, 1 - this.ctx.state.resources.shortages.length / 2);
    const w = cmd.weights;
    const total = w.morale + w.housing + w.guard + w.supply;
    const rating = (w.morale * morale + w.housing * housing + w.guard * guard + w.supply * supply) / total;
    return { morale, housing, guard, supply, rating };
  }

  private newDay(day: number): void {
    const state = this.ctx.state;
    const res = state.resources;
    res.lastDayDelta = res.todayDelta;
    res.todayDelta = {};

    // Évaluation → réputation → budget
    const cmd = this.ctx.content.balance.command;
    const { rating } = this.evaluate();
    const before = state.progression.reputation;
    const after = Math.max(0, Math.min(100, before + (rating - 0.5) * cmd.reputationPerPoint));
    state.progression.reputation = after;
    state.progression.lastRating = rating;
    const budget = this.dailyBudget(rating);
    gain(state, { funds: budget });
    pushLog(this.ctx, rating >= 0.5 ? 'good' : 'warn', 'log.evaluation', {
      day,
      rating: Math.round(rating * 100),
      reputation: Math.round(after),
      amount: budget,
    });
    this.ctx.bus.emit('progression:evaluated', { rating, reputation: after, budget });
    // Points de réputation du jour, selon l'évaluation
    this.gainPoints(Math.round(rating * (this.ctx.content.balance.progression.pointsPerDay ?? 0)));

    // Déblocages franchis (gratuits) ou désormais achetables
    for (const b of this.ctx.content.buildingList) {
      if (b.unlock.reputation > before && b.unlock.reputation <= after) {
        if ((b.unlock.points ?? 0) > 0) {
          pushLog(this.ctx, 'info', 'log.unlockLevel', { name: b.name });
        } else {
          pushLog(this.ctx, 'good', 'log.unlocked', { name: b.name });
          this.ctx.bus.emit('progression:unlocked', { defId: b.id });
        }
      }
    }
    for (const r of this.ctx.content.supply.recruits) {
      if (r.reputation > before && r.reputation <= after) {
        pushLog(this.ctx, 'good', 'log.recruitUnlocked', { name: this.ctx.content.personnel(r.type).name });
      }
    }
  }
}
