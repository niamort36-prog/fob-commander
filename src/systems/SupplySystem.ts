/**
 * SupplySystem — ravitaillement de la FOB.
 *
 *  - Commandes au commandement (supply.json) : délai, coût, risque d'embuscade sur la route.
 *  - Véhicules physiques : les camions arrivent par la piste depuis le bord de carte et roulent
 *    jusqu'à leur destination (grille de circulation des véhicules) ; l'hélicoptère vole en ligne droite.
 *  - Camions de palettes / hélicoptère : garés sur une zone de déchargement / hélisurface, ils sont
 *    vidés par le personnel (activité « haul » d'AgentAI) et par les chariots élévateurs.
 *  - Camions-citernes : garés contre une citerne (ou un réservoir) accessible, ils pompent leur
 *    chargement directement dans le stock.
 *  - Renforts : les passagers débarquent à l'arrivée.
 */
import { buildingStats } from '../core/buildingStats';
import type { SupplyOrderDef, VehicleDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { SupplyRejection } from '../core/GameEvents';
import type {
  BuildingInstance,
  GridPos,
  Id,
  Load,
  OrderStatus,
  PassengerRequest,
  ResourceBag,
  ResourceId,
  SupplyOrder,
  Vehicle,
} from '../core/GameState';
import { pushLog } from '../core/Log';
import { bagEntries, gain, spend } from '../core/resources';
import { newId } from '../utils/ids';
import type { Command } from '../core/Commands';
import type { System } from './System';
import { BuildSystem } from './BuildSystem';

const ACTIVE_STATUSES: readonly OrderStatus[] = ['pending', 'en_route', 'unloading', 'leaving'];
const ORDER_HISTORY = 20;
export const AIR_ALTITUDE = 70;
const LANDING_DISTANCE = 5;
/** Durée du contrôle d'un véhicule à une porte gardée (minutes de jeu). */
const GATE_CHECK_MIN = 2;

export function bagTotal(bag: ResourceBag): number {
  return bagEntries(bag).reduce((s, [, v]) => s + v, 0);
}

export class SupplySystem implements System {
  readonly id = 'supply';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('building:removed', ({ id }) => this.onBuildingRemoved(id));
  }

  // ------------------------------------------------------------ Requêtes

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private hoursToTicks(hours: number): number {
    return Math.round((hours * 60) / this.ctx.content.balance.time.minutesPerTick);
  }

  orders(): SupplyOrder[] {
    return Object.values(this.ctx.state.supply.orders).sort((a, b) => b.placedTick - a.placedTick);
  }

  activeOrders(): SupplyOrder[] {
    return this.orders().filter((o) => ACTIVE_STATUSES.includes(o.status));
  }

  vehicles(): Vehicle[] {
    return Object.values(this.ctx.state.vehicles);
  }

  forklifts(): Vehicle[] {
    return this.vehicles().filter((v) => this.ctx.content.vehicle(v.defId).kind === 'base');
  }

  isOperational(b: BuildingInstance): boolean {
    return b.state === 'active' || b.state === 'damaged';
  }

  private operationalOf(defId: string): BuildingInstance[] {
    return Object.values(this.ctx.state.fob.buildings).filter((b) => b.defId === defId && this.isOperational(b));
  }

  recruitLocked(type: string): boolean {
    return this.recruitBlock(type) !== null;
  }

  /** Raison pour laquelle un type de renfort ne peut pas être commandé. */
  recruitBlock(type: string): 'level' | 'requires' | 'max' | null {
    const r = this.ctx.content.supply.recruits.find((x) => x.type === type);
    if (!r || r.reputation > this.ctx.state.progression.reputation) return 'level';
    const agents = Object.values(this.ctx.state.agents);
    if (r.requires && !agents.some((a) => a.defId === r.requires)) return 'requires';
    if (r.max !== undefined) {
      const ordered = this.activeOrders().reduce((n, o) => n + o.passengers.filter((p) => p.type === type).reduce((m, p) => m + p.count, 0), 0);
      if (agents.filter((a) => a.defId === type).length + ordered >= r.max) return 'max';
    }
    return null;
  }

  /** Coût total d'une commande (frais de transport + marchandises + renforts). */
  orderCost(def: SupplyOrderDef, cargo: ResourceBag, passengers: PassengerRequest[], vehicles: string[] = []): number {
    const prices = this.ctx.content.supply.unitPrices;
    let cost = def.fee;
    for (const id of vehicles) cost += this.ctx.content.vehicle(id).price ?? 0;
    if (def.fixed) cost += def.fixedPrice ?? 0;
    else for (const [id, v] of bagEntries(cargo)) cost += (prices[id] ?? 0) * v;
    for (const p of passengers) {
      cost += (this.ctx.content.supply.recruits.find((r) => r.type === p.type)?.price ?? 0) * p.count;
    }
    return Math.round(cost);
  }

  /** Vérifie qu'une commande est possible ; renvoie la raison du refus ou null. */
  check(orderId: string, cargo: ResourceBag, passengers: PassengerRequest[], vehicles: string[] = []): SupplyRejection | null {
    const def = this.ctx.content.supply.orders.find((o) => o.id === orderId);
    if (!def) return 'unknown';
    const vdef = this.ctx.content.vehicle(def.vehicle);
    if (this.operationalOf(def.requires).length === 0) return 'requires';
    if (vdef.kind === 'air' && this.operationalOf(def.requires).every((b) => this.padOccupied(b))) return 'pad';
    if (this.activeOrders().length >= this.ctx.content.supply.maxActiveOrders) return 'limit';
    const cargoTotal = def.cargo ? bagTotal(cargo) : 0;
    if (def.cargo && cargoTotal > (vdef.capacity ?? 0)) return 'capacity';
    const nPass = passengers.reduce((s, p) => s + p.count, 0);
    if (nPass > 0 && (!def.passengers || nPass > (vdef.passengers ?? 0))) return 'passengers';
    if (passengers.some((p) => p.count > 0 && this.recruitLocked(p.type))) return 'locked';
    if (vehicles.length > 0) {
      if (!def.vehicles || vehicles.length > (vdef.vehicleSlots ?? 0)) return 'vehicles';
      const extra = new Map<string, number>();
      for (const id of vehicles) {
        const vd = this.ctx.content.vehicleList.find((x) => x.id === id);
        if (!vd || vd.price === undefined || vd.kind !== 'base') return 'vehicles';
        extra.set(vd.requires ?? '', (extra.get(vd.requires ?? '') ?? 0) + 1);
        if (this.vehicleRoom(vd) < (extra.get(vd.requires ?? '') ?? 0)) return 'vehicles';
      }
    }
    if (!def.fixed && cargoTotal === 0 && nPass === 0 && vehicles.length === 0) return 'empty';
    if (this.ctx.state.resources.stock.funds < this.orderCost(def, cargo, passengers, vehicles)) return 'funds';
    return null;
  }

  // ------------------------------------------------------------ Commandes

  placeOrder(orderId: string, cargo: ResourceBag, passengers: PassengerRequest[], vehicles: string[] = []): SupplyOrder | null {
    const reason = this.check(orderId, cargo, passengers, vehicles);
    if (reason) {
      this.ctx.bus.emit('supply:rejected', { reason });
      return null;
    }
    const def = this.ctx.content.supplyOrder(orderId);
    const clean: ResourceBag = {};
    if (def.fixed) Object.assign(clean, def.fixed);
    else for (const [id, v] of bagEntries(cargo)) if (def.cargo!.includes(id) && v > 0) clean[id] = Math.floor(v);
    const pax = passengers.filter((p) => p.count > 0).map((p) => ({ type: p.type, count: Math.floor(p.count) }));
    const cost = this.orderCost(def, clean, pax, vehicles);
    spend(this.ctx.state, { funds: cost });

    const [minH, maxH] = def.delayHours;
    const hours = minH + this.ctx.random() * (maxH - minH);
    const order: SupplyOrder = {
      id: newId(this.ctx.state, 'ord'),
      orderId,
      cargo: clean,
      passengers: pax,
      cost,
      placedTick: this.now,
      etaTick: this.now + this.hoursToTicks(hours),
      status: 'pending',
      vehicleId: null,
      ambushed: false,
      vehicles: [...vehicles],
    };
    this.ctx.state.supply.orders[order.id] = order;
    this.pruneHistory();
    pushLog(this.ctx, 'info', 'log.orderPlaced', { name: def.name, hours: Math.round(hours), cost });
    this.ctx.bus.emit('supply:ordered', { orderId: order.id });
    return order;
  }

  private pruneHistory(): void {
    const done = this.orders().filter((o) => !ACTIVE_STATUSES.includes(o.status));
    for (const o of done.slice(ORDER_HISTORY)) delete this.ctx.state.supply.orders[o.id];
  }

  // ------------------------------------------------------------ Véhicules achetés (chariots élévateurs)

  /** Places libres pour ce type de véhicule (parc ou zone de rattachement), commandes en cours déduites. */
  vehicleRoom(def: VehicleDef): number {
    if (!def.requires || def.maxPerZone === undefined) return Infinity;
    const homes = this.operationalOf(def.requires).length;
    // Capacité : places de stationnement du bâtiment (parc : 4, hélisurface : 1), partagées entre modèles
    const sameHome = (id: string): boolean => this.ctx.content.vehicle(id).requires === def.requires;
    const owned = this.vehicles().filter((v) => sameHome(v.defId)).length;
    const ordered = this.activeOrders().reduce((n, o) => n + (o.vehicles ?? []).filter(sameHome).length, 0);
    const perHome = this.ctx.content.building(def.requires).services?.parking?.slots ?? def.maxPerZone;
    return Math.min(def.maxPerZone, perHome) * homes - owned - ordered;
  }

  /** Première place libre d'un parc (chaque véhicule garde sa place attitrée). */
  freeSlot(home: BuildingInstance, except?: Vehicle): number {
    const used = new Set(this.vehicles().filter((v) => v.homeId === home.id && v !== except && !v.visit).map((v) => v.slot));
    const slots = buildingStats(this.ctx.content.building(home.defId), home.level).services.parking?.slots ?? 1;
    for (let s = 0; s < slots; s++) if (!used.has(s)) return s;
    return 0;
  }

  /** Hélicoptères de la base présents sur une hélisurface (hors mission). */
  private padOccupied(b: BuildingInstance): boolean {
    return this.vehicles().some((v) => v.homeId === b.id && this.ctx.content.vehicle(v.defId).kind === 'air' && v.state !== 'away');
  }

  canBuyVehicle(defId: string): SupplyRejection | null {
    const def = this.ctx.content.vehicleList.find((v) => v.id === defId);
    if (!def || def.price === undefined) return 'unknown';
    const homes = def.requires ? this.operationalOf(def.requires) : [];
    if (def.requires && homes.length === 0) return 'requires';
    if (this.vehicleRoom(def) <= 0) return 'limit';
    if (this.ctx.state.resources.stock.funds < def.price) return 'funds';
    return null;
  }

  buyVehicle(defId: string): Vehicle | null {
    const reason = this.canBuyVehicle(defId);
    if (reason) {
      this.ctx.bus.emit('supply:rejected', { reason });
      return null;
    }
    const def = this.ctx.content.vehicle(defId);
    const homes = def.requires ? this.operationalOf(def.requires) : [];
    const count = (b: BuildingInstance): number => this.vehicles().filter((v) => v.homeId === b.id).length;
    const home = homes.sort((a, b) => count(a) - count(b))[0] ?? null;
    spend(this.ctx.state, { funds: def.price! });
    const slot = home ? this.freeSlot(home) : 0;
    if (def.kind === 'air' && home) {
      // L'appareil arrive en vol et se pose sur son hélisurface
      const v = this.spawnVehicle(defId, this.ctx.state.fob.entry, null);
      v.homeId = home.id;
      v.slot = slot;
      this.sendHeli(v, 'back');
      pushLog(this.ctx, 'good', 'log.vehicleBought', { name: def.name });
      this.ctx.bus.emit('vehicle:bought', { vehicleId: v.id });
      return v;
    }
    const cell = home
      ? def.role === 'patrol'
        ? this.ctx.sim.agents.nav.parkingCell(home, slot)
        : this.forkliftSpot(home, count(home))
      : this.ctx.state.fob.entry;
    const v = this.spawnVehicle(defId, cell, null);
    v.homeId = home?.id ?? null;
    v.slot = slot;
    v.state = 'idle';
    if (def.role === 'patrol') this.parkHeading(v);
    pushLog(this.ctx, 'good', 'log.vehicleBought', { name: def.name });
    this.ctx.bus.emit('vehicle:bought', { vehicleId: v.id });
    return v;
  }

  private spawnVehicle(defId: string, cell: GridPos, orderId: Id | null): Vehicle {
    const def = this.ctx.content.vehicle(defId);
    const pos = { x: cell.x + 0.5, y: cell.y + 0.5 };
    const v: Vehicle = {
      id: newId(this.ctx.state, 'veh'),
      defId,
      pos,
      prevPos: { ...pos },
      path: [],
      axis: 0,
      flip: false,
      altitude: def.kind === 'air' ? AIR_ALTITUDE : 0,
      state: 'inbound',
      orderId,
      cargo: {},
      passengers: [],
      targetId: null,
      slot: 0,
      timer: this.now,
      homeId: null,
      carry: null,
      warned: false,
    };
    this.ctx.state.vehicles[v.id] = v;
    return v;
  }

  // ------------------------------------------------------------ Simulation

  onTick(): void {
    for (const o of Object.values(this.ctx.state.supply.orders)) {
      if (o.status === 'pending' && this.now >= o.etaTick) this.arrive(o);
    }
    for (const v of this.vehicles()) this.updateVehicle(v);
  }

  handleCommand(cmd: Command): boolean {
    switch (cmd.type) {
      case 'orderSupply':
        this.placeOrder(cmd.orderId, cmd.cargo, cmd.passengers, cmd.vehicles ?? []);
        return true;
      case 'buyVehicle':
        this.buyVehicle(cmd.defId);
        return true;
      case 'buyGear':
        this.buyGear(cmd.itemId, cmd.count);
        return true;
      case 'distributeGear':
        this.distributeGear(cmd.itemId);
        return true;
      case 'recoverGear':
        this.recoverGear(cmd.itemId);
        return true;
      default:
        return false;
    }
  }

  onStateLoaded(): void {
    for (const v of this.vehicles()) v.prevPos = { ...v.pos };
  }

  /** Le convoi atteint la bordure de la carte : embuscade éventuelle, puis entrée du véhicule. */
  private arrive(order: SupplyOrder): void {
    const def = this.ctx.content.supplyOrder(order.orderId);
    const vdef = this.ctx.content.vehicle(def.vehicle);
    const escorted = Number(this.ctx.state.progression.flags.escort_until ?? 0) > this.now;
    const road = vdef.kind === 'road' ? this.ctx.site.roadRisk * this.ctx.sim.diplomacy.roadRiskMult() : 1;
    const risk = def.risk * road * (escorted ? this.ctx.content.missions.config.escortRiskMult : 1);
    if (!order.ambushed && this.ctx.random() < risk) {
      const [lmin, lmax] = this.ctx.content.balance.supply.ambushLoss;
      const loss = lmin + this.ctx.random() * (lmax - lmin);
      for (const [id, v] of bagEntries(order.cargo)) order.cargo[id] = Math.floor(v * (1 - loss));
      order.ambushed = true;
      order.etaTick = this.now + this.hoursToTicks(this.ctx.content.balance.supply.ambushDelayHours);
      const lossPct = Math.round(loss * 100);
      pushLog(this.ctx, 'bad', 'log.ambush', { name: def.name, loss: lossPct });
      this.ctx.bus.emit('supply:ambushed', { orderId: order.id, lossPct });
      return;
    }
    if (vdef.kind === 'plane') return this.planeArrive(order);
    const v = this.spawnVehicle(def.vehicle, this.ctx.state.fob.entry, order.id);
    v.cargo = { ...order.cargo };
    // Engin explosif laissé sur la piste : le premier véhicule routier le déclenche.
    if (vdef.kind === 'road' && this.ctx.state.progression.flags.ied_on_road) {
      delete this.ctx.state.progression.flags.ied_on_road;
      for (const [id, n] of bagEntries(v.cargo)) v.cargo[id] = Math.floor(n * 0.5);
      for (const p of order.passengers) {
        if (p.count > 0 && this.ctx.random() < 0.5) p.count -= 1;
      }
      v.passengers = order.passengers.map((p) => ({ ...p })).filter((p) => p.count > 0);
      pushLog(this.ctx, 'bad', 'log.iedHit', { name: vdef.name });
      this.ctx.bus.emit('combat:impact', { x: v.pos.x, y: v.pos.y - 3, radius: 1.2 });
    }
    v.passengers = order.passengers.map((p) => ({ ...p }));
    order.status = 'en_route';
    order.vehicleId = v.id;
    pushLog(this.ctx, 'info', 'log.convoyArrived', { name: def.name });
    this.ctx.bus.emit('supply:arrived', { orderId: order.id, vehicleId: v.id });
    this.route(v);
  }

  private orderOf(v: Vehicle): SupplyOrder | undefined {
    return v.orderId ? this.ctx.state.supply.orders[v.orderId] : undefined;
  }

  private cellOf(v: Vehicle): GridPos {
    return { x: Math.floor(v.pos.x), y: Math.floor(v.pos.y) };
  }

  private distance(v: Vehicle, b: BuildingInstance): number {
    return Math.abs(b.pos.x - v.pos.x) + Math.abs(b.pos.y - v.pos.y);
  }

  /** Choisit la destination d'un véhicule de commande et calcule son trajet. */
  private route(v: Vehicle): void {
    const order = this.orderOf(v);
    if (!order) return this.depart(v);
    const def = this.ctx.content.supplyOrder(order.orderId);
    const vdef = this.ctx.content.vehicle(v.defId);
    const nav = this.ctx.sim.agents.nav;
    nav.ensure();
    const retry = this.ctx.content.balance.supply.blockedRetryTicks;

    if (this.ctx.content.building(def.requires).services?.parking) {
      const spot = this.pickParking(v, def.requires);
      if (!spot) {
        v.state = 'waiting';
        v.timer = this.now + retry;
        if (!v.warned) {
          pushLog(this.ctx, 'warn', 'log.noParking', { name: vdef.name, building: this.ctx.content.building(def.requires).name });
          v.warned = true;
        }
        return;
      }
      v.targetId = spot.building.id;
      v.slot = spot.slot;
      const goal = nav.parkingCell(spot.building, spot.slot);
      if (vdef.kind === 'air') {
        v.path = [goal];
        v.state = 'inbound';
        return;
      }
      const path = nav.findVehiclePath(this.cellOf(v), [goal]);
      if (path) {
        v.path = path;
        v.state = 'inbound';
        return;
      }
    } else {
      // Camion-citerne : la cuve accessible la plus proche
      const tanks = this.operationalOf(def.requires).sort((a, b) => this.distance(v, a) - this.distance(v, b));
      for (const b of tanks) {
        const cells = nav.vehicleAccessCells(b);
        if (cells.length === 0) continue;
        const path = nav.findVehiclePath(this.cellOf(v), cells);
        if (path) {
          v.targetId = b.id;
          v.path = path;
          v.state = 'inbound';
          return;
        }
      }
    }
    // Aucune destination atteignable
    v.state = 'blocked';
    v.timer = this.now + retry;
    if (!v.warned) {
      v.warned = true;
      pushLog(this.ctx, 'warn', 'log.vehicleBlocked', { name: vdef.name, building: this.ctx.content.building(def.requires).name });
      this.ctx.bus.emit('supply:blocked', { vehicleId: v.id });
    }
  }

  private pickParking(v: Vehicle, defId: string): { building: BuildingInstance; slot: number } | null {
    const zones = this.operationalOf(defId).sort((a, b) => this.distance(v, a) - this.distance(v, b));
    for (const b of zones) {
      if (this.padOccupied(b)) continue;
      const slots = buildingStats(this.ctx.content.building(b.defId), b.level).services.parking?.slots ?? 0;
      const used = new Set(
        this.vehicles()
          .filter((o) => o.id !== v.id && o.targetId === b.id && (o.state === 'inbound' || o.state === 'unloading'))
          .map((o) => o.slot),
      );
      for (let s = 0; s < slots; s++) if (!used.has(s)) return { building: b, slot: s };
    }
    return null;
  }

  private updateVehicle(v: Vehicle): void {
    v.prevPos.x = v.pos.x;
    v.prevPos.y = v.pos.y;
    if (v.visit) return; // véhicule d'une délégation : piloté par VisitSystem
    const vdef = this.ctx.content.vehicle(v.defId);
    if (vdef.kind === 'base') return vdef.role === 'patrol' ? this.updatePatrol(v, vdef) : this.updateForklift(v, vdef);
    if (vdef.role === 'attack' || vdef.role === 'transport') return this.updateHeli(v, vdef);

    const order = this.orderOf(v);
    const deadline = (order?.etaTick ?? v.timer) + this.hoursToTicks(this.ctx.content.balance.supply.maxWaitHours);
    switch (v.state) {
      case 'inbound':
      case 'outbound':
        if (this.move(v, vdef)) this.onArrive(v, vdef);
        break;
      case 'blocked':
      case 'waiting':
        if (this.now >= deadline) {
          if (order) order.status = 'cancelled';
          pushLog(this.ctx, 'bad', 'log.orderAbandoned', { name: vdef.name });
          this.depart(v);
        } else if (this.now >= v.timer) {
          this.route(v);
        }
        break;
      case 'pumping':
        this.pump(v, vdef);
        break;
      case 'unloading':
        if (bagTotal(v.cargo) <= 0) this.depart(v);
        else if (this.now >= v.timer) {
          pushLog(this.ctx, 'warn', 'log.cargoReturned', { name: vdef.name });
          v.cargo = {};
          this.depart(v);
        }
        break;
      default:
        break;
    }
  }

  /** Une sentinelle occupe un poste de garde à moins de 4 cases de cette porte. */
  gateGuarded(gateId: Id): boolean {
    const gate = this.ctx.state.fob.buildings[gateId];
    if (!gate) return false;
    const gc = this.ctx.sim.agents.buildingCenter(gate);
    return Object.values(this.ctx.state.agents).some((a) => {
      const act = a.activity;
      if (act?.id !== 'guard' || act.stage !== 'acting' || !act.targetId) return false;
      const post = this.ctx.state.fob.buildings[act.targetId];
      if (!post || post.defId !== 'guard_post') return false;
      const pc = this.ctx.sim.agents.buildingCenter(post);
      return Math.hypot(pc.x - gc.x, pc.y - gc.y) <= 4;
    });
  }

  /** Avance le long du trajet ; renvoie true à l'arrivée. */
  private move(v: Vehicle, vdef: VehicleDef): boolean {
    const nav = this.ctx.sim.agents.nav;
    let budget = vdef.speed * this.ctx.content.balance.time.minutesPerTick;
    if (vdef.kind === 'plane') return this.movePlane(v);

    if (vdef.kind === 'air') {
      const goal = v.state === 'outbound' ? this.ctx.state.fob.entry : v.path[0];
      if (!goal) return true;
      const tx = goal.x + 0.5;
      const ty = goal.y + 0.5;
      const dx = tx - v.pos.x;
      const dy = ty - v.pos.y;
      const dist = Math.hypot(dx, dy);
      this.setHeading(v, dx, dy);
      if (dist <= budget) {
        v.pos.x = tx;
        v.pos.y = ty;
      } else {
        v.pos.x += (dx / dist) * budget;
        v.pos.y += (dy / dist) * budget;
      }
      const remaining = Math.max(0, dist - budget);
      if (v.state === 'inbound') v.altitude = AIR_ALTITUDE * Math.min(1, remaining / LANDING_DISTANCE);
      else v.altitude = Math.min(AIR_ALTITUDE, v.altitude + 10);
      return remaining === 0;
    }

    while (budget > 0 && v.path.length > 0) {
      const next = v.path[0];
      if (!nav.drivable(next.x, next.y)) {
        // Obstacle apparu (nouveau bâtiment) : nouveau trajet
        v.path = [];
        if (vdef.kind === 'base' && vdef.role === 'patrol') {
          const goal = v.state === 'mission_out' ? this.ctx.state.fob.entry : null;
          v.path = goal ? (nav.findVehiclePath(this.cellOf(v), [goal]) ?? []) : [];
          return v.path.length === 0;
        } else if (vdef.kind === 'base') {
          // Chariot élévateur : il dépose sa charge et cherche une nouvelle tâche.
          this.forkliftDrop(v);
        } else if (v.state === 'outbound') this.depart(v);
        else this.route(v);
        return false;
      }
      // Porte gardée : arrêt pour contrôle avant de la franchir
      const gate = nav.gateAt(next.x, next.y);
      if (gate && !v.civilian && v.gateChecked !== gate && this.gateGuarded(gate)) {
        if (v.gateWaitUntil === undefined) {
          v.gateWaitUntil = this.now + Math.max(1, Math.round(GATE_CHECK_MIN / this.ctx.content.balance.time.minutesPerTick));
          pushLog(this.ctx, 'info', 'log.gateCheck', { vehicle: vdef.name });
        }
        if (this.now < v.gateWaitUntil) return false;
        v.gateChecked = gate;
        v.gateWaitUntil = undefined;
      }
      if (!gate && v.gateChecked) v.gateChecked = null;
      const tx = next.x + 0.5;
      const ty = next.y + 0.5;
      const dx = tx - v.pos.x;
      const dy = ty - v.pos.y;
      const dist = Math.hypot(dx, dy);
      const c = nav.vehicleCostAt(next.x, next.y);
      const step = budget / c;
      if (dist > 0) this.setHeading(v, dx, dy);
      if (step >= dist) {
        v.pos.x = tx;
        v.pos.y = ty;
        v.path.shift();
        budget -= dist * c;
      } else {
        v.pos.x += (dx / dist) * step;
        v.pos.y += (dy / dist) * step;
        budget = 0;
      }
    }
    return v.path.length === 0;
  }

  private setHeading(v: Vehicle, dx: number, dy: number): void {
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    v.axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
    v.flip = v.axis === 0 ? dx < 0 : dy < 0;
  }

  private onArrive(v: Vehicle, vdef: VehicleDef): void {
    const order = this.orderOf(v);
    if (v.state === 'outbound') {
      delete this.ctx.state.vehicles[v.id];
      if (order && order.status !== 'cancelled') {
        order.status = 'delivered';
        this.ctx.bus.emit('supply:delivered', { orderId: order.id });
      }
      return;
    }
    // Arrivée à destination
    const cfg = this.ctx.content.balance.supply;
    v.timer = this.now + this.hoursToTicks(vdef.pumpPerMinute ? cfg.maxWaitHours : cfg.maxUnloadHours);
    if (order) order.status = 'unloading';
    if (vdef.pumpPerMinute) {
      v.state = 'pumping';
    } else {
      v.state = 'unloading';
      v.altitude = 0;
      if (vdef.kind === 'plane') pushLog(this.ctx, 'info', 'log.planeLanded', { name: vdef.name });
      this.disembark(v);
      if (vdef.kind === 'plane' && bagTotal(v.cargo) <= 0) this.depart(v);
    }
  }

  /** Débarquement des renforts (et des véhicules en soute). */
  private disembark(v: Vehicle): void {
    const order = this.orderOf(v);
    const delivered = order?.vehicles ?? [];
    if (delivered.length) {
      for (const id of delivered) this.deliverVehicle(id, this.cellOf(v));
      order!.vehicles = [];
      pushLog(this.ctx, 'good', 'log.vehiclesDelivered', { n: delivered.length });
    }
    const count = v.passengers.reduce((s, p) => s + p.count, 0);
    if (count === 0) return;
    const state = this.ctx.state;
    const types = new Set(v.passengers.map((p) => p.type));
    const kind = types.size === 1 && types.has('infantry') ? 'squad' : types.size === 1 && types.has('contractor') ? 'contractor_team' : types.size === 1 && types.has('sf') ? 'sf_team' : 'support';
    const groupId = newId(state, 'grp');
    state.groups[groupId] = { id: groupId, name: `Renforts J${state.time.day}`, kind, memberIds: [], missionId: null };
    const near = this.cellOf(v);
    for (const p of v.passengers) {
      for (let i = 0; i < p.count; i++) {
        const a = this.ctx.sim.agents.createAgent(p.type, groupId, near);
        state.groups[groupId].memberIds.push(a.id);
      }
    }
    v.passengers = [];
    this.ctx.sim.agents.markHomesDirty();
    pushLog(this.ctx, 'good', 'log.reinforcements', { count });
  }

  private pump(v: Vehicle, vdef: VehicleDef): void {
    const target = v.targetId ? this.ctx.state.fob.buildings[v.targetId] : undefined;
    if (!target || !this.isOperational(target)) return this.route(v);
    const res = this.ctx.state.resources;
    let moved = 0;
    for (const [id, remaining] of bagEntries(v.cargo)) {
      const room = res.capacity[id] - res.stock[id];
      const amount = Math.min(remaining, room, (vdef.pumpPerMinute ?? 0) * this.ctx.content.balance.time.minutesPerTick);
      if (amount <= 0) continue;
      gain(this.ctx.state, { [id]: amount });
      v.cargo[id] = remaining - amount;
      moved += amount;
    }
    if (bagTotal(v.cargo) <= 0.001) {
      v.cargo = {};
      this.depart(v);
    } else if (moved === 0 && this.now >= v.timer) {
      pushLog(this.ctx, 'warn', 'log.tankFull', { name: vdef.name });
      this.depart(v);
    }
  }

  private depart(v: Vehicle): void {
    const order = this.orderOf(v);
    if (order && order.status !== 'cancelled') order.status = 'leaving';
    v.state = 'outbound';
    const strip = v.targetId ? this.ctx.state.fob.buildings[v.targetId] : undefined;
    v.targetId = null;
    if (this.ctx.content.vehicle(v.defId).kind === 'plane') {
      this.planeDepart(v, strip);
      return;
    }
    if (this.ctx.content.vehicle(v.defId).kind === 'air') {
      v.path = [];
      return;
    }
    const nav = this.ctx.sim.agents.nav;
    nav.ensure();
    const path = nav.findVehiclePath(this.cellOf(v), [this.ctx.state.fob.entry]);
    if (path && path.length > 0) v.path = path;
    else {
      // Enfermé ou déjà sur place : le véhicule quitte la carte immédiatement.
      v.path = [];
      this.onArrive(v, this.ctx.content.vehicle(v.defId));
    }
  }

  private onBuildingRemoved(id: Id): void {
    for (const v of this.vehicles()) {
      if (v.homeId === id) v.homeId = null;
      if (v.targetId !== id) continue;
      const kind = this.ctx.content.vehicle(v.defId).kind;
      if (kind === 'base') {
        if (v.carry) gain(this.ctx.state, { [v.carry.resource]: v.carry.amount });
        v.carry = null;
        v.state = 'idle';
        v.path = [];
        v.targetId = null;
      } else if (v.state === 'inbound' || v.state === 'unloading' || v.state === 'pumping') {
        v.targetId = null;
        this.route(v);
      }
    }
  }

  // ------------------------------------------------------------ Déchargement (personnel et chariots)

  /** Quantité de ressource en cours de transport (agents et chariots). */
  inTransit(resource: ResourceId): number {
    let n = 0;
    for (const a of Object.values(this.ctx.state.agents)) if (a.activity?.id === 'haul' && a.activity.carry?.resource === resource) n += a.activity.carry.amount;
    for (const v of this.vehicles()) if (v.carry?.resource === resource) n += v.carry.amount;
    return n;
  }

  /**
   * Lieu de dépôt d'une ressource déchargée : stockage dédié (entrepôt, dépôt…) en priorité,
   * à défaut une aire qui accepte la cargaison (zone de déchargement, hélisurface).
   */
  dropTarget(resource: ResourceId, from: GridPos, forVehicle = false): BuildingInstance | null {
    const nav = this.ctx.sim.agents.nav;
    let best: BuildingInstance | null = null;
    let bestScore = Infinity;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (!this.isOperational(b)) continue;
      const def = this.ctx.content.building(b.defId);
      const stores = (buildingStats(def, b.level).storage[resource] ?? 0) > 0;
      const accepts = def.acceptsCargo?.includes(resource) ?? false;
      if (!stores && !accepts) continue;
      if (forVehicle && def.visual.style !== 'flat' && nav.vehicleAccessCells(b).length === 0) continue;
      const d = Math.abs(b.pos.x - from.x) + Math.abs(b.pos.y - from.y);
      const score = d + (stores ? 0 : 10000); // stockage dédié d'abord
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  private takeableResource(v: Vehicle): ResourceId | null {
    const res = this.ctx.state.resources;
    const entries = bagEntries(v.cargo).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    for (const [id] of entries) {
      if (res.capacity[id] - res.stock[id] - this.inTransit(id) < 1) continue;
      if (!this.dropTarget(id, this.cellOf(v))) continue;
      return id;
    }
    return null;
  }

  /** Véhicules garés dont il reste de la cargaison déchargeable. */
  haulableVehicles(): Vehicle[] {
    return this.vehicles().filter((v) => v.state === 'unloading' && this.takeableResource(v) !== null);
  }

  /** Prélève une charge dans un véhicule garé (null si rien à prendre). */
  takeCargo(vehicleId: Id, max: number): Load | null {
    const v = this.ctx.state.vehicles[vehicleId];
    if (!v || v.state !== 'unloading') return null;
    const id = this.takeableResource(v);
    if (!id) return null;
    const res = this.ctx.state.resources;
    const room = Math.floor(res.capacity[id] - res.stock[id] - this.inTransit(id));
    const amount = Math.min(Math.floor(max), Math.floor(v.cargo[id] ?? 0), room);
    if (amount <= 0) return null;
    v.cargo[id] = (v.cargo[id] ?? 0) - amount;
    return { resource: id, amount };
  }

  /** Remet une charge non déposable dans le véhicule (ou au stock s'il est parti). */
  returnCargo(vehicleId: Id | null | undefined, load: Load): void {
    const v = vehicleId ? this.ctx.state.vehicles[vehicleId] : undefined;
    if (v && v.state === 'unloading') v.cargo[load.resource] = (v.cargo[load.resource] ?? 0) + load.amount;
    else gain(this.ctx.state, { [load.resource]: load.amount });
  }

  private updateForklift(f: Vehicle, vdef: VehicleDef): void {
    const nav = this.ctx.sim.agents.nav;
    if (f.state === 'toPickup' || f.state === 'toDrop' || (f.state === 'idle' && f.path.length > 0)) {
      if (!this.move(f, vdef)) return;
      if (f.state === 'toPickup') {
        const truck = f.targetId ? this.ctx.state.vehicles[f.targetId] : undefined;
        const load = truck ? this.takeCargo(truck.id, vdef.carryCapacity ?? 50) : null;
        const target = load ? this.dropTarget(load.resource, this.cellOf(f), true) : null;
        if (!load || !target) {
          if (load && truck) this.returnCargo(truck.id, load);
          f.state = 'idle';
          f.targetId = null;
          return;
        }
        const def = this.ctx.content.building(target.defId);
        const goals = def.visual.style === 'flat' ? [nav.parkingCell(target, 0)] : nav.vehicleAccessCells(target);
        const path = nav.findVehiclePath(this.cellOf(f), goals);
        f.carry = load;
        if (!path) {
          this.returnCargo(truck!.id, load);
          f.carry = null;
          f.state = 'idle';
          return;
        }
        f.path = path;
        f.targetId = target.id;
        f.state = 'toDrop';
        if (path.length === 0) this.forkliftDrop(f);
      } else if (f.state === 'toDrop') {
        this.forkliftDrop(f);
      }
      return;
    }
    // Au repos : cherche un camion à décharger (carburant requis)
    if (this.ctx.state.resources.stock.fuel <= 0) return;
    const trucks = this.haulableVehicles().sort(
      (a, b) => (a.targetId === f.homeId ? 0 : 1000) + this.dist2(f, a) - ((b.targetId === f.homeId ? 0 : 1000) + this.dist2(f, b)),
    );
    for (const t of trucks) {
      const path = nav.findVehiclePath(this.cellOf(f), [this.cellOf(t)]);
      if (!path) continue;
      f.path = path;
      f.targetId = t.id;
      f.state = 'toPickup';
      return;
    }
    // Rien à faire : retour à la zone de rattachement
    const home = f.homeId ? this.ctx.state.fob.buildings[f.homeId] : undefined;
    if (home && f.path.length === 0) {
      const index = this.vehicles().filter((v) => v.homeId === home.id).indexOf(f);
      const spot = this.forkliftSpot(home, Math.max(0, index));
      const cell = this.cellOf(f);
      if (Math.abs(cell.x - spot.x) + Math.abs(cell.y - spot.y) > 3) {
        const path = nav.findVehiclePath(cell, [spot]);
        if (path) f.path = path;
      }
    }
  }

  /** Emplacement de repos d'un chariot : en bordure de sa zone, hors des places des camions. */
  private forkliftSpot(home: BuildingInstance, index: number): GridPos {
    const nav = this.ctx.sim.agents.nav;
    nav.ensure();
    const cells = nav.vehicleAccessCells(home);
    return cells.length > 0 ? cells[index % cells.length] : nav.parkingCell(home, 0);
  }

  // ------------------------------------------------------------ Véhicules de patrouille (missions)

  /** Envoie un véhicule blindé en mission (vers le bord de carte) ou le ramène à son parc. */
  sendPatrolVehicle(v: Vehicle, dir: 'out' | 'back'): void {
    const nav = this.ctx.sim.agents.nav;
    nav.ensure();
    if (dir === 'back') {
      v.pos = { x: this.ctx.state.fob.entry.x + 0.5, y: this.ctx.state.fob.entry.y + 0.5 };
      v.prevPos = { ...v.pos };
    }
    const home = v.homeId ? this.ctx.state.fob.buildings[v.homeId] : undefined;
    const goal = dir === 'out' ? this.ctx.state.fob.entry : home ? nav.parkingCell(home, v.slot) : this.ctx.state.fob.entry;
    const path = nav.findVehiclePath(this.cellOf(v), [goal]);
    v.state = dir === 'out' ? 'mission_out' : 'mission_back';
    v.path = path ?? [];
    if (!path) {
      // Aucun itinéraire : le véhicule est placé directement à destination
      v.pos = { x: goal.x + 0.5, y: goal.y + 0.5 };
      v.prevPos = { ...v.pos };
      v.state = dir === 'out' ? 'away' : 'idle';
      if (v.state === 'idle') this.parkHeading(v);
    }
  }

  private updatePatrol(v: Vehicle, vdef: VehicleDef): void {
    if (v.state !== 'mission_out' && v.state !== 'mission_back') return;
    if (v.path.length === 0 || this.move(v, vdef)) {
      v.state = v.state === 'mission_out' ? 'away' : 'idle';
      if (v.state === 'idle') this.parkHeading(v);
    }
  }

  /** Véhicule garé : perpendiculaire à la rangée de places du parc (pas d'empiètement sur la voisine). */
  private parkHeading(v: Vehicle): void {
    const home = v.homeId ? this.ctx.state.fob.buildings[v.homeId] : undefined;
    if (!home) return;
    const [w, h] = BuildSystem.footprint(this.ctx.content.building(home.defId), home.rot);
    v.axis = w >= h ? 1 : 0;
    v.flip = false;
  }

  // ------------------------------------------------------------ Avions (piste d'aviation)

  /** Axe de la piste : extrémités de l'axe central et direction unitaire (du début vers la fin). */
  runwayAxis(b: BuildingInstance): { start: { x: number; y: number }; end: { x: number; y: number }; dir: { x: number; y: number } } {
    const [w, h] = BuildSystem.footprint(this.ctx.content.building(b.defId), b.rot);
    if (h >= w) return { start: { x: b.pos.x + w / 2, y: b.pos.y }, end: { x: b.pos.x + w / 2, y: b.pos.y + h }, dir: { x: 0, y: 1 } };
    return { start: { x: b.pos.x, y: b.pos.y + h / 2 }, end: { x: b.pos.x + w, y: b.pos.y + h / 2 }, dir: { x: 1, y: 0 } };
  }

  /** L'avion arrive en finale dans l'axe de la piste, se pose et roule jusqu'à l'aire de déchargement. */
  private planeArrive(order: SupplyOrder): void {
    const def = this.ctx.content.supplyOrder(order.orderId);
    const vdef = this.ctx.content.vehicle(def.vehicle);
    const strip = this.operationalOf(def.requires).find(
      (b) => !this.vehicles().some((o) => o.targetId === b.id && this.ctx.content.vehicle(o.defId).kind === 'plane'),
    );
    if (!strip) {
      // Piste occupée ou hors service : l'avion tourne en attente
      order.etaTick = this.now + this.hoursToTicks(1);
      return;
    }
    const { start, end, dir } = this.runwayAxis(strip);
    const from = { x: start.x - dir.x * 32, y: start.y - dir.y * 32 };
    const v = this.spawnVehicle(def.vehicle, { x: Math.floor(from.x), y: Math.floor(from.y) }, order.id);
    v.pos = { ...from };
    v.prevPos = { ...from };
    v.altitude = 150;
    v.cargo = { ...order.cargo };
    v.passengers = order.passengers.map((p) => ({ ...p }));
    v.targetId = strip.id;
    v.slot = 0;
    v.route = [
      { x: start.x + dir.x * 2.5, y: start.y + dir.y * 2.5, alt: 0, speed: vdef.speed },
      { x: end.x - dir.x * 4, y: end.y - dir.y * 4, alt: 0, speed: vdef.groundSpeed ?? 1.5 },
    ];
    v.state = 'inbound';
    this.setHeading(v, dir.x, dir.y);
    order.status = 'en_route';
    order.vehicleId = v.id;
    pushLog(this.ctx, 'info', 'log.convoyArrived', { name: def.name });
    this.ctx.bus.emit('supply:arrived', { orderId: order.id, vehicleId: v.id });
    this.ctx.bus.emit('aircraft:landing', { vehicleId: v.id });
  }

  /** Demi-tour au roulage jusqu'au seuil, décollage dans l'axe, montée et sortie de carte. */
  private planeDepart(v: Vehicle, strip: BuildingInstance | undefined): void {
    const vdef = this.ctx.content.vehicle(v.defId);
    if (!strip) {
      v.route = [{ x: v.pos.x + 40, y: v.pos.y, alt: 160, speed: vdef.speed }];
      return;
    }
    const { start, end, dir } = this.runwayAxis(strip);
    v.route = [
      { x: start.x + dir.x * 2, y: start.y + dir.y * 2, alt: 0, speed: vdef.taxiSpeed ?? 0.9 },
      { x: end.x - dir.x * 3, y: end.y - dir.y * 3, alt: 0, speed: (vdef.groundSpeed ?? 1.5) * 1.6 },
      { x: end.x + dir.x * 36, y: end.y + dir.y * 36, alt: 170, speed: vdef.speed },
    ];
    this.ctx.bus.emit('aircraft:landing', { vehicleId: v.id });
  }

  /** Avance un avion vers son prochain point de passage ; renvoie true à la fin du trajet. */
  private movePlane(v: Vehicle): boolean {
    let budget = this.ctx.content.balance.time.minutesPerTick;
    while (v.route && v.route.length > 0 && budget > 0) {
      const wp = v.route[0];
      const dx = wp.x - v.pos.x;
      const dy = wp.y - v.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = wp.speed * budget;
      if (dist > 1e-6) this.setHeading(v, dx, dy);
      if (step >= dist) {
        v.pos.x = wp.x;
        v.pos.y = wp.y;
        v.altitude = wp.alt;
        v.route.shift();
        budget -= dist / Math.max(0.01, wp.speed);
      } else {
        const k = step / dist;
        v.pos.x += dx * k;
        v.pos.y += dy * k;
        v.altitude = wp.alt + (v.altitude - wp.alt) * (1 - k);
        budget = 0;
      }
    }
    return !v.route || v.route.length === 0;
  }

  // ------------------------------------------------------------ Équipement individuel

  gearBlock(itemId: string, count: number): 'requires' | 'funds' | 'unknown' | null {
    const item = this.ctx.content.equipment.items.find((i) => i.id === itemId);
    if (!item) return 'unknown';
    if (this.operationalOf(this.ctx.content.equipment.storageBuilding).length === 0) return 'requires';
    if (this.ctx.state.resources.stock.funds < item.price * count) return 'funds';
    return null;
  }

  /** Achat d'équipement, livré au dépôt de munitions. */
  buyGear(itemId: string, count: number): boolean {
    if (count < 1 || this.gearBlock(itemId, count)) return false;
    const item = this.ctx.content.equipment.items.find((i) => i.id === itemId)!;
    spend(this.ctx.state, { funds: item.price * count });
    const st = this.ctx.state.equipment;
    st[itemId] = (st[itemId] ?? 0) + count;
    pushLog(this.ctx, 'good', 'log.gearBought', { n: count, name: item.name });
    this.ctx.bus.emit('gear:changed', {});
    return true;
  }

  /** Articles attribués pas encore perçus au dépôt. */
  gearPendingCount(itemId: string): number {
    return Object.values(this.ctx.state.agents).filter((a) => a.gearPending?.includes(itemId)).length;
  }

  /** Dépôt où percevoir l'équipement (le plus proche). */
  gearStore(from: GridPos): BuildingInstance | null {
    let best: BuildingInstance | null = null;
    let bestD = Infinity;
    for (const b of this.operationalOf(this.ctx.content.equipment.storageBuilding)) {
      const d = Math.abs(b.pos.x - from.x) + Math.abs(b.pos.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** Nombre d'articles distribués (portés par le personnel). */
  gearGiven(itemId: string): number {
    return Object.values(this.ctx.state.agents).filter((a) => a.gear?.includes(itemId)).length;
  }

  /** Distribue le stock aux combattants présents qui n'en ont pas (forces spéciales et plus aguerris d'abord). */
  distributeGear(itemId: string): number {
    const st = this.ctx.state.equipment;
    const eligible = this.ctx.content.equipment.eligible;
    const candidates = Object.values(this.ctx.state.agents)
      .filter((a) => a.status === 'on_base' && eligible.includes(a.defId) && !a.gear?.includes(itemId) && !a.gearPending?.includes(itemId))
      .sort((a, b) => eligible.indexOf(a.defId) - eligible.indexOf(b.defId) || b.xp - a.xp);
    let n = 0;
    for (const a of candidates) {
      if ((st[itemId] ?? 0) <= 0) break;
      // Attribué : le soldat ira le percevoir au dépôt (tout de suite s'il n'est pas de service)
      a.gearPending = [...(a.gearPending ?? []), itemId];
      if (!a.activity || ['idle', 'relax', 'train', 'exercise', 'workout', 'shoot', 'drill', 'cqb'].includes(a.activity.id)) this.ctx.sim.agents.recall(a);
      st[itemId]--;
      n++;
    }
    if (n) {
      const item = this.ctx.content.equipment.items.find((i) => i.id === itemId);
      pushLog(this.ctx, 'info', 'log.gearIssued', { n, name: item?.name ?? itemId });
      this.ctx.bus.emit('gear:changed', {});
    }
    return n;
  }

  /** Récupère l'équipement porté par le personnel présent à la base. */
  recoverGear(itemId: string): number {
    const st = this.ctx.state.equipment;
    let n = 0;
    for (const a of Object.values(this.ctx.state.agents)) {
      if (a.gearPending?.includes(itemId)) {
        a.gearPending = a.gearPending.filter((g) => g !== itemId);
        n++;
      }
      if (a.status !== 'on_base' || !a.gear?.includes(itemId)) continue;
      a.gear = a.gear.filter((g) => g !== itemId);
      n++;
    }
    st[itemId] = (st[itemId] ?? 0) + n;
    if (n) this.ctx.bus.emit('gear:changed', {});
    return n;
  }

  // ------------------------------------------------------------ Hélicoptères de la base

  /** Hélicoptères de la base d'un modèle donné, posés et disponibles. */
  idleHelis(defId: string): Vehicle[] {
    return this.vehicles().filter((v) => v.defId === defId && v.state === 'idle' && v.homeId);
  }

  /** Envoie un hélicoptère de la base hors de la carte (mission) ou le ramène sur son hélisurface. */
  sendHeli(v: Vehicle, dir: 'out' | 'back'): void {
    if (dir === 'out') {
      v.state = 'mission_out';
      v.path = [this.ctx.state.fob.entry];
      return;
    }
    if (v.state === 'away') {
      v.pos = { x: this.ctx.state.fob.entry.x + 0.5, y: this.ctx.state.fob.entry.y + 0.5 };
      v.prevPos = { ...v.pos };
      v.altitude = AIR_ALTITUDE;
    }
    const home = v.homeId ? this.ctx.state.fob.buildings[v.homeId] : undefined;
    v.path = [home ? this.ctx.sim.agents.nav.parkingCell(home, 0) : this.ctx.state.fob.entry];
    v.state = 'mission_back';
  }

  /** Décollage en défense de la base : l'appareil tourne au-dessus du point indiqué. */
  heliSortie(v: Vehicle, target: GridPos): void {
    v.state = 'sortie';
    v.path = [target];
  }

  /** Vol d'un hélicoptère de la base : départ, retour et poser, orbite de défense. */
  private updateHeli(v: Vehicle, vdef: VehicleDef): void {
    if (v.state === 'idle' || v.state === 'away') {
      if (v.state === 'idle') v.altitude = 0;
      return;
    }
    const goal = v.path[0];
    if (!goal) return;
    const tx = goal.x + 0.5;
    const ty = goal.y + 0.5;
    const dx = tx - v.pos.x;
    const dy = ty - v.pos.y;
    const dist = Math.hypot(dx, dy);
    const budget = vdef.speed * this.ctx.content.balance.time.minutesPerTick;
    // Décollage vertical avant de partir
    if (v.state !== 'mission_back' && v.altitude < AIR_ALTITUDE * 0.6) {
      v.altitude = Math.min(AIR_ALTITUDE, v.altitude + 12);
      return;
    }
    if (v.state === 'sortie') {
      // Orbite au-dessus de la zone des combats
      if (dist > 2.5) {
        this.setHeading(v, dx, dy);
        v.pos.x += (dx / dist) * Math.min(budget, dist);
        v.pos.y += (dy / dist) * Math.min(budget, dist);
      } else {
        const a = Math.atan2(v.pos.y - ty, v.pos.x - tx) + 0.25;
        const nx = tx + Math.cos(a) * 2.5;
        const ny = ty + Math.sin(a) * 2.5;
        this.setHeading(v, nx - v.pos.x, ny - v.pos.y);
        v.pos.x = nx;
        v.pos.y = ny;
      }
      v.altitude = Math.min(AIR_ALTITUDE * 0.8, v.altitude + 6);
      return;
    }
    this.setHeading(v, dx, dy);
    if (dist <= budget) {
      v.pos.x = tx;
      v.pos.y = ty;
    } else {
      v.pos.x += (dx / dist) * budget;
      v.pos.y += (dy / dist) * budget;
    }
    const remaining = Math.max(0, dist - budget);
    if (v.state === 'mission_back') {
      v.altitude = AIR_ALTITUDE * Math.min(1, remaining / LANDING_DISTANCE);
      if (remaining === 0) {
        v.state = 'idle';
        v.altitude = 0;
        pushLog(this.ctx, 'info', 'log.heliArrived', { name: vdef.name });
      }
    } else if (v.state === 'mission_out') {
      v.altitude = Math.min(AIR_ALTITUDE, v.altitude + 8);
      if (remaining === 0) v.state = 'away';
    }
  }

  /** Véhicule d'une délégation en visite (charrette, tout-terrain, hélicoptère). */
  spawnVisitVehicle(defId: string, at: GridPos): Vehicle {
    const v = this.spawnVehicle(defId, at, null);
    v.visit = true;
    return v;
  }

  /** Fait avancer un véhicule d'un pas de simulation ; renvoie true à l'arrivée. */
  driveStep(v: Vehicle): boolean {
    return this.move(v, this.ctx.content.vehicle(v.defId));
  }

  /** Passage d'avions d'appui au-dessus de la base (effet visuel et sonore). */
  spawnFlyover(defId: string): Vehicle {
    const s = this.ctx.state;
    const z = s.fob.zone;
    const cy = z.y + z.height / 2 + (this.ctx.random() - 0.5) * z.height * 0.6;
    const fromLeft = this.ctx.random() < 0.5;
    const x0 = fromLeft ? z.x - 40 : z.x + z.width + 40;
    const x1 = fromLeft ? z.x + z.width + 60 : z.x - 60;
    const v = this.spawnVehicle(defId, { x: Math.floor(x0), y: Math.floor(cy) }, null);
    v.pos = { x: x0, y: cy };
    v.prevPos = { ...v.pos };
    v.altitude = 90;
    v.state = 'outbound';
    const speed = this.ctx.content.vehicle(defId).speed;
    v.route = [
      { x: (x0 + x1) / 2, y: cy - 2, alt: 70, speed },
      { x: x1, y: cy - 6, alt: 140, speed },
    ];
    this.setHeading(v, x1 - x0, 0);
    this.ctx.bus.emit('aircraft:flyover', { vehicleId: v.id });
    return v;
  }

  /** Véhicule acheté livré (soute d'avion) : il rejoint son parc ou sa zone de rattachement. */
  deliverVehicle(defId: string, near: GridPos): Vehicle {
    const def = this.ctx.content.vehicle(defId);
    const homes = def.requires ? this.operationalOf(def.requires) : [];
    const count = (b: BuildingInstance): number => this.vehicles().filter((v) => v.homeId === b.id).length;
    const home = homes.sort((a, b) => count(a) - count(b))[0] ?? null;
    const index = home ? this.freeSlot(home) : 0;
    const v = this.spawnVehicle(defId, near, null);
    v.homeId = home?.id ?? null;
    v.slot = index;
    v.state = 'idle';
    if (def.role === 'patrol' && home) {
      const nav = this.ctx.sim.agents.nav;
      nav.ensure();
      const path = nav.findVehiclePath(near, [nav.parkingCell(home, index)]);
      if (path && path.length) {
        v.path = path;
        v.state = 'mission_back';
      }
    }
    this.ctx.bus.emit('vehicle:bought', { vehicleId: v.id });
    return v;
  }

  private forkliftDrop(f: Vehicle): void {
    if (f.carry) gain(this.ctx.state, { [f.carry.resource]: f.carry.amount });
    f.carry = null;
    f.targetId = null;
    f.state = 'idle';
  }

  private dist2(a: Vehicle, b: Vehicle): number {
    return Math.abs(a.pos.x - b.pos.x) + Math.abs(a.pos.y - b.pos.y);
  }
}
