/** Opérations utilitaires sur les ressources et les « sacs » de ressources. */
import type { GameState, ResourceBag, ResourceId } from './GameState';

export function bagEntries(bag: ResourceBag | undefined): [ResourceId, number][] {
  if (!bag) return [];
  return (Object.entries(bag) as [ResourceId, number | undefined][])
    .filter((e): e is [ResourceId, number] => typeof e[1] === 'number' && e[1] !== 0);
}

export function scaleBag(bag: ResourceBag, factor: number, round = Math.floor): ResourceBag {
  const out: ResourceBag = {};
  for (const [id, v] of bagEntries(bag)) out[id] = round(v * factor);
  return out;
}

export function addBags(a: ResourceBag, b: ResourceBag): ResourceBag {
  const out: ResourceBag = { ...a };
  for (const [id, v] of bagEntries(b)) out[id] = (out[id] ?? 0) + v;
  return out;
}

export function canAfford(state: GameState, cost: ResourceBag): boolean {
  return bagEntries(cost).every(([id, v]) => state.resources.stock[id] >= v);
}

/** Débite sans contrôle (appeler canAfford avant). */
export function spend(state: GameState, cost: ResourceBag): void {
  const res = state.resources;
  for (const [id, v] of bagEntries(cost)) {
    res.stock[id] -= v;
    res.todayDelta[id] = (res.todayDelta[id] ?? 0) - v;
  }
}

/** Crédite dans la limite des capacités ; renvoie ce qui a effectivement été ajouté. */
export function gain(state: GameState, bag: ResourceBag): ResourceBag {
  const res = state.resources;
  const added: ResourceBag = {};
  for (const [id, v] of bagEntries(bag)) {
    const before = res.stock[id];
    const after = Math.max(0, Math.min(res.capacity[id], before + v));
    res.stock[id] = after;
    added[id] = after - before;
    res.todayDelta[id] = (res.todayDelta[id] ?? 0) + (after - before);
  }
  return added;
}
