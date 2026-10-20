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

export class NavGrid implements CostGrid {
  width = 0;
  height = 0;
  /** Coûts piétons. */
  cost = new Float32Array(0);
  /** Coûts véhicules. */
  readonly vehicles: { width: number; height: number; cost: Float32Array } = { width: 0, height: 0, cost: new Float32Array(0) };
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

    for (let i = 0; i < n; i++) {
      const t = content.terrainAt(fob.terrain[i]);
      this.cost[i] = t.buildable ? 1 : ROCK_COST;
      v.cost[i] = !t.buildable ? Infinity : t.id === 'track' ? VEHICLE_TRACK_COST : VEHICLE_OFFROAD_COST;
    }
    for (const b of Object.values(fob.buildings)) {
      const def = content.building(b.defId);
      const flat = def.visual.style === 'flat';
      const walk = flat ? (b.state === 'construction' ? 1 : 1 / (def.walkSpeedMult ?? 1)) : Infinity;
      const drive = flat ? (b.state === 'construction' ? VEHICLE_OFFROAD_COST : VEHICLE_FLAT_COST) : Infinity;
      for (const c of BuildSystem.cells(def, b.pos, b.rot)) {
        if (c.x < 0 || c.y < 0 || c.x >= fob.width || c.y >= fob.height) continue;
        const i = c.y * fob.width + c.x;
        this.cost[i] = walk;
        v.cost[i] = drive;
      }
    }
    this.dirty = false;
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
