/**
 * NavGrid — grilles de coûts de déplacement dérivées du terrain et des bâtiments.
 * Non sauvegardées : reconstruites au chargement et à chaque modification des bâtiments.
 *
 * Piétons : terrain 1, rochers coûteux, bâtiments en volume infranchissables, routes plus rapides.
 * Véhicules : rochers et bâtiments en volume infranchissables ; routes et aires (zone de
 * déchargement, hélisurface) très rapides ; piste rapide ; hors piste lent.
 */
import type { GameContext } from '../core/GameContext';
import type { BuildingInstance, GridPos } from '../core/GameState';
import { AStar, type CostGrid } from '../utils/AStar';
import { BuildSystem } from './BuildSystem';

const ROCK_COST = 4;
const VEHICLE_FLAT_COST = 0.5;
const VEHICLE_TRACK_COST = 0.6;
const VEHICLE_OFFROAD_COST = 1.5;
/** Un piéton ralentit un peu pour passer une porte. */
const GATE_WALK_COST = 1.3;
/** Coût d'itinéraire d'une porte ou d'un mur à forcer pour un assaillant. */
const GATE_BREACH_COST = 25;
const WALL_BREACH_COST = 70;

export class NavGrid implements CostGrid {
  width = 0;
  height = 0;
  /** Coûts piétons. */
  cost = new Float32Array(0);
  /** Coûts véhicules. */
  readonly vehicles: { width: number; height: number; cost: Float32Array } = { width: 0, height: 0, cost: new Float32Array(0) };
  /**
   * Coûts des assaillants : comme les piétons, mais portes et murs ne s'ouvrent pas devant eux.
   * Ils restent « franchissables » à un coût élevé (il faut les forcer) : l'itinéraire préfère une
   * ouverture existante, puis une porte, et en dernier recours un mur à souffler.
   */
  readonly enemy: { width: number; height: number; cost: Float32Array } = { width: 0, height: 0, cost: new Float32Array(0) };
  /** Civils (visiteurs, arrivants fouillés) : les portes fermées aux civils leur sont infranchissables. */
  readonly civilWalk: { width: number; height: number; cost: Float32Array } = { width: 0, height: 0, cost: new Float32Array(0) };
  readonly civilDrive: { width: number; height: number; cost: Float32Array } = { width: 0, height: 0, cost: new Float32Array(0) };
  /** Cases accessibles aux civils depuis l'entrée de la carte (zones autorisées). */
  private civilZone = new Uint8Array(0);
  /** Case → porte ou tronçon de mur à forcer. */
  private breach = new Map<number, string>();
  private dirty = true;
  private readonly astar = new AStar();

  constructor(private readonly ctx: GameContext) {
    const mark = (): void => {
      this.dirty = true;
    };
    ctx.bus.on('building:placed', mark);
    ctx.bus.on('building:completed', mark);
    ctx.bus.on('building:removed', mark);
  }

  markDirty(): void {
    this.dirty = true;
  }

  ensure(): void {
    if (this.dirty) this.rebuild();
  }

  rebuild(): void {
    const { fob } = this.ctx.state;
    const content = this.ctx.content;
    const n = fob.width * fob.height;
    this.width = fob.width;
    this.height = fob.height;
    if (this.cost.length !== n) this.cost = new Float32Array(n);
    const v = this.vehicles;
    v.width = fob.width;
    v.height = fob.height;
    if (v.cost.length !== n) v.cost = new Float32Array(n);

    const e = this.enemy;
    e.width = fob.width;
    e.height = fob.height;
    if (e.cost.length !== n) e.cost = new Float32Array(n);
    this.breach.clear();

    for (let i = 0; i < n; i++) {
      const t = content.terrainAt(fob.terrain[i]);
      this.cost[i] = t.buildable ? 1 : ROCK_COST;
      v.cost[i] = !t.buildable ? Infinity : t.id === 'track' ? VEHICLE_TRACK_COST : VEHICLE_OFFROAD_COST;
    }
    for (const b of Object.values(fob.buildings)) {
      const def = content.building(b.defId);
      const flat = def.visual.style === 'flat';
      let walk = flat ? (b.state === 'construction' ? 1 : 1 / (def.walkSpeedMult ?? 1)) : Infinity;
      let drive = flat ? (b.state === 'construction' ? VEHICLE_OFFROAD_COST : VEHICLE_FLAT_COST) : Infinity;
      // Porte : le personnel passe (et les véhicules s'il s'agit d'un portail)
      if (def.gate) {
        walk = GATE_WALK_COST;
        drive = def.gate.vehicles ? VEHICLE_FLAT_COST : Infinity;
      }
      const breachable = !!def.gate || (def.placement.line && def.breachMin !== undefined);
      for (const c of BuildSystem.cells(def, b.pos, b.rot)) {
        if (c.x < 0 || c.y < 0 || c.x >= fob.width || c.y >= fob.height) continue;
        const i = c.y * fob.width + c.x;
        this.cost[i] = walk;
        v.cost[i] = drive;
        if (breachable) this.breach.set(i, b.id);
      }
    }
    for (let i = 0; i < n; i++) e.cost[i] = this.cost[i];
    for (const [i, id] of this.breach) e.cost[i] = content.building(fob.buildings[id].defId).gate ? GATE_BREACH_COST : WALL_BREACH_COST;
    // Grilles des civils : portes fermées aux civils infranchissables
    const cw = this.civilWalk;
    const cd = this.civilDrive;
    for (const g of [cw, cd]) {
      g.width = fob.width;
      g.height = fob.height;
      if (g.cost.length !== n) g.cost = new Float32Array(n);
    }
    cw.cost.set(this.cost);
    cd.cost.set(v.cost);
    for (const [i, id] of this.breach) {
      const b = fob.buildings[id];
      if (content.building(b.defId).gate && b.civilAccess === false) {
        cw.cost[i] = Infinity;
        cd.cost[i] = Infinity;
      }
    }
    this.computeCivilZone();
    this.dirty = false;
  }

  /** Zone autorisée aux civils : cases atteignables à pied depuis l'entrée sans passer une porte fermée. */
  private computeCivilZone(): void {
    const { width, height } = this;
    const n = width * height;
    if (this.civilZone.length !== n) this.civilZone = new Uint8Array(n);
    else this.civilZone.fill(0);
    const entry = this.ctx.state.fob.entry;
    if (!this.inBounds(entry.x, entry.y)) return;
    const queue = [entry.y * width + entry.x];
    this.civilZone[queue[0]] = 1;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (this.civilZone[j] || !Number.isFinite(this.civilWalk.cost[j])) continue;
        this.civilZone[j] = 1;
        queue.push(j);
      }
    }
  }

  /** Case autorisée aux civils (atteignable sans franchir une porte qui leur est fermée). */
  civilAllowed(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.civilZone[y * this.width + x] === 1;
  }

  /** Itinéraire d'un civil, à pied ou en véhicule, en respectant les portes fermées aux civils. */
  findCivilPath(start: GridPos, goals: readonly GridPos[], vehicle = false): GridPos[] | null {
    return this.astar.find(vehicle ? this.civilDrive : this.civilWalk, start, goals, this.ctx.content.balance.agents.maxPathNodes);
  }

  /** Case autorisée aux civils, dégagée, au hasard dans un rayon (promenade). */
  randomCivilCellNear(center: GridPos, radius: number, random: () => number): GridPos | null {
    for (let i = 0; i < 20; i++) {
      const x = Math.round(center.x + (random() * 2 - 1) * radius);
      const y = Math.round(center.y + (random() * 2 - 1) * radius);
      if (this.civilAllowed(x, y) && this.cost[y * this.width + x] <= 1) return { x, y };
    }
    return null;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  walkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && Number.isFinite(this.cost[y * this.width + x]);
  }

  drivable(x: number, y: number): boolean {
    return this.inBounds(x, y) && Number.isFinite(this.vehicles.cost[y * this.width + x]);
  }

  costAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.cost[y * this.width + x] : Infinity;
  }

  vehicleCostAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.vehicles.cost[y * this.width + x] : Infinity;
  }

  /** Cases bordant l'emprise d'un bâtiment (accès orthogonal), filtrées par un prédicat. */
  private border(b: BuildingInstance, ok: (x: number, y: number) => boolean): GridPos[] {
    const def = this.ctx.content.building(b.defId);
    const [w, h] = BuildSystem.footprint(def, b.rot);
    const out: GridPos[] = [];
    const push = (x: number, y: number): void => {
      if (ok(x, y)) out.push({ x, y });
    };
    for (let x = b.pos.x; x < b.pos.x + w; x++) {
      push(x, b.pos.y - 1);
      push(x, b.pos.y + h);
    }
    for (let y = b.pos.y; y < b.pos.y + h; y++) {
      push(b.pos.x - 1, y);
      push(b.pos.x + w, y);
    }
    return out;
  }

  /** Cases d'accès piéton. */
  accessCells(b: BuildingInstance): GridPos[] {
    const def = this.ctx.content.building(b.defId);
    if (def.entrance) {
      const door = BuildSystem.entranceCells(def, b.pos, b.rot).filter((c) => this.walkable(c.x, c.y));
      if (door.length) return door;
    }
    return this.border(b, (x, y) => this.walkable(x, y));
  }

  /** Cases où un véhicule peut se garer à côté du bâtiment (ex. camion-citerne contre la cuve). */
  vehicleAccessCells(b: BuildingInstance): GridPos[] {
    return this.border(b, (x, y) => this.drivable(x, y));
  }

  /** Place de stationnement n° `slot` sur une aire plate (le long de son grand axe). */
  parkingCell(b: BuildingInstance, slot: number): GridPos {
    const def = this.ctx.content.building(b.defId);
    const [w, h] = BuildSystem.footprint(def, b.rot);
    const slots = def.services?.parking?.slots ?? 1;
    if (w >= h) {
      const step = w / slots;
      return { x: b.pos.x + Math.floor(step * slot + step / 2), y: b.pos.y + Math.floor(h / 2) };
    }
    const step = h / slots;
    return { x: b.pos.x + Math.floor(w / 2), y: b.pos.y + Math.floor(step * slot + step / 2) };
  }

  findPath(start: GridPos, goals: readonly GridPos[]): GridPos[] | null {
    return this.astar.find(this, start, goals, this.ctx.content.balance.agents.maxPathNodes);
  }

  findVehiclePath(start: GridPos, goals: readonly GridPos[]): GridPos[] | null {
    return this.astar.find(this.vehicles, start, goals, this.ctx.content.balance.agents.maxPathNodes);
  }

  /** Itinéraire d'un assaillant (passe par les ouvertures, sinon par une porte ou un mur à forcer). */
  findEnemyPath(start: GridPos, goals: readonly GridPos[]): GridPos[] | null {
    return this.astar.find(this.enemy, start, goals, this.ctx.content.balance.agents.maxPathNodes * 2);
  }

  /** Porte ou tronçon de mur à forcer sur cette case (null si aucun). */
  breachAt(x: number, y: number): string | null {
    return this.inBounds(x, y) ? (this.breach.get(y * this.width + x) ?? null) : null;
  }

  /** Case que l'assaillant peut traverser sans rien forcer. */
  enemyPassable(x: number, y: number): boolean {
    return this.walkable(x, y) && !this.breach.has(y * this.width + x);
  }

  /** Porte (bâtiment avec `gate`) sur cette case, ou null. */
  gateAt(x: number, y: number): string | null {
    const id = this.breachAt(x, y);
    return id && this.ctx.content.building(this.ctx.state.fob.buildings[id]?.defId ?? 'hesco').gate ? id : null;
  }

  /** Case franchissable aléatoire dans un rayon donné (null si aucune trouvée). */
  randomWalkableNear(center: GridPos, radius: number, random: () => number): GridPos | null {
    for (let i = 0; i < 16; i++) {
      const x = Math.round(center.x + (random() * 2 - 1) * radius);
      const y = Math.round(center.y + (random() * 2 - 1) * radius);
      if (this.walkable(x, y) && this.cost[y * this.width + x] <= 1) return { x, y };
    }
    return null;
  }
}
