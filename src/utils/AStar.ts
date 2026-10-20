/**
 * A* sur grille 8-directionnelle, multi-objectifs.
 * - Coût d'entrée d'une case = cost[i] (× √2 en diagonale) ; Infinity = infranchissable.
 * - Pas de coupe d'angle : une diagonale exige que les deux cases orthogonales soient franchissables.
 * - La case de départ peut être bloquée (agent pris dans un nouveau bâtiment).
 * Les tampons sont réutilisés d'une recherche à l'autre (marquage par génération).
 */
import type { GridPos } from '../core/GameState';

export interface CostGrid {
  readonly width: number;
  readonly height: number;
  readonly cost: Float32Array;
}

const SQRT2 = Math.SQRT2;
const DIRS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

/** Tas binaire minimal d'indices, ordonné par f. */
class MinHeap {
  private items: number[] = [];
  constructor(private readonly f: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  clear(): void {
    this.items.length = 0;
  }
  push(i: number): void {
    const a = this.items;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.f[a[p]] <= this.f[a[c]]) break;
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l;
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m], a[p]];
        p = m;
      }
    }
    return top;
  }
}

export class AStar {
  private size = 0;
  private g = new Float64Array(0);
  private f = new Float64Array(0);
  private parent = new Int32Array(0);
  private seen = new Uint32Array(0); // génération où g/parent sont valides
  private closed = new Uint32Array(0);
  private goalMark = new Uint32Array(0);
  private generation = 0;
  private heap = new MinHeap(this.f);

  private ensure(n: number): void {
    if (n === this.size) return;
    this.size = n;
    this.g = new Float64Array(n);
    this.f = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.goalMark = new Uint32Array(n);
    this.heap = new MinHeap(this.f);
    this.generation = 0;
  }

  /**
   * Chemin de `start` vers la plus proche des cases `goals` (départ exclu, arrivée incluse),
   * [] si le départ est déjà un objectif, null si aucun chemin (ou budget de nœuds épuisé).
   */
  find(grid: CostGrid, start: GridPos, goals: readonly GridPos[], maxNodes = 30000): GridPos[] | null {
    const { width, height, cost } = grid;
    this.ensure(width * height);
    if (goals.length === 0) return null;
    this.generation++;
    const gen = this.generation;
    const startIdx = start.y * width + start.x;

    const validGoals: GridPos[] = [];
    for (const goal of goals) {
      if (goal.x < 0 || goal.y < 0 || goal.x >= width || goal.y >= height) continue;
      const gi = goal.y * width + goal.x;
      if (gi === startIdx) return [];
      if (!Number.isFinite(cost[gi])) continue;
      this.goalMark[gi] = gen;
      validGoals.push(goal);
    }
    if (validGoals.length === 0) return null;

    const h = (x: number, y: number): number => {
      let best = Infinity;
      for (const goal of validGoals) {
        const dx = Math.abs(goal.x - x);
        const dy = Math.abs(goal.y - y);
        const d = Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
        if (d < best) best = d;
      }
      return best;
    };

    const heap = this.heap;
    heap.clear();
    this.g[startIdx] = 0;
    this.f[startIdx] = h(start.x, start.y);
    this.parent[startIdx] = -1;
    this.seen[startIdx] = gen;
    heap.push(startIdx);

    let expanded = 0;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (this.goalMark[cur] === gen) return this.rebuild(cur, width);
      if (++expanded > maxNodes) return null;

      const cx = cur % width;
      const cy = (cur - cx) / width;
      for (const [dx, dy, mult] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        const c = cost[ni];
        if (!Number.isFinite(c) || this.closed[ni] === gen) continue;
        if (dx !== 0 && dy !== 0) {
          // Pas de coupe d'angle
          if (!Number.isFinite(cost[cy * width + nx]) || !Number.isFinite(cost[ny * width + cx])) continue;
        }
        const ng = this.g[cur] + c * mult;
        if (this.seen[ni] === gen && ng >= this.g[ni]) continue;
        this.seen[ni] = gen;
        this.g[ni] = ng;
        this.parent[ni] = cur;
        this.f[ni] = ng + h(nx, ny);
        heap.push(ni);
      }
    }
    return null;
  }

  private rebuild(end: number, width: number): GridPos[] {
    const out: GridPos[] = [];
    let i = end;
    while (this.parent[i] !== -1) {
      out.push({ x: i % width, y: Math.floor(i / width) });
      i = this.parent[i];
    }
    return out.reverse();
  }
}
