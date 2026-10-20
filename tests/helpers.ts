import { loadDefaultContent } from '../src/core/ContentRegistry';
import { GameContext } from '../src/core/GameContext';
import type { BuildingInstance, GridPos, Rotation } from '../src/core/GameState';
import type { StorageLike } from '../src/systems/SaveSystem';

export class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/**
 * Partie déterministe sur la plaine de Dasht-e Gol (périmètre 48×48 centré, zone centrale en terre battue).
 * Par défaut le personnel est retiré, pour tester bâtiments et économie de façon isolée.
 */
export function makeGame(storage: StorageLike | null = new MemoryStorage(), opts: { agents?: boolean } = {}): GameContext {
  const ctx = new GameContext(loadDefaultContent(), storage);
  ctx.newGame('dasht', 12345);
  if (!opts.agents) {
    ctx.state.agents = {};
    ctx.state.groups = {};
  }
  return ctx;
}

export function stepTicks(ctx: GameContext, n: number): void {
  for (let i = 0; i < n; i++) ctx.sim.step();
}

/** Avance jusqu'à ce que la condition soit vraie (ou échoue après `max` ticks). */
export function stepUntil(ctx: GameContext, cond: () => boolean, max: number): number {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    ctx.sim.step();
  }
  if (cond()) return max;
  throw new Error(`condition non atteinte en ${max} ticks`);
}

/** Durée d'un chantier sans ouvrier, en ticks. */
export function ticksToBuild(ctx: GameContext, defId: string): number {
  const { baseCrewRate } = ctx.content.balance.build;
  return Math.ceil(ctx.content.building(defId).buildTimeMin / ctx.content.balance.time.minutesPerTick / baseCrewRate);
}

/** Pose un bâtiment et le termine immédiatement (débloqué si besoin). */
export function buildNow(ctx: GameContext, defId: string, pos: GridPos, rot: Rotation = 0): BuildingInstance {
  const def = ctx.content.building(defId);
  ctx.state.progression.reputation = Math.max(ctx.state.progression.reputation, def.unlock.reputation);
  if (!ctx.state.progression.unlocked.includes(defId)) ctx.state.progression.unlocked.push(defId);
  ctx.state.resources.stock.funds += 100000;
  const b = ctx.sim.build.place(defId, pos, rot);
  if (!b) throw new Error(`pose impossible : ${defId} en ${pos.x},${pos.y}`);
  b.state = 'active';
  b.buildProgress = 1;
  ctx.bus.emit('building:completed', { id: b.id, defId });
  ctx.state.resources.stock.funds -= 100000;
  return b;
}

/** Près du centre de la carte 160×160 : toujours constructible (zone aplanie, dans le périmètre). */
export const CENTER = { x: 78, y: 78 };
