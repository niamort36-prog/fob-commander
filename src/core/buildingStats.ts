/**
 * Caractéristiques effectives d'un bâtiment selon son niveau d'amélioration.
 * Chaque niveau de `levels` remplace les champs qu'il définit (services, stockage, production…).
 */
import type { BuildingDef, BuildingLevelDef, CheckpointDef, ServiceDef } from './ContentTypes';
import type { ResourceBag } from './GameState';

export interface BuildingStats {
  services: Record<string, ServiceDef>;
  storage: ResourceBag;
  productionPerDay: ResourceBag;
  consumptionPerDay: ResourceBag;
  upkeepPerDay: ResourceBag;
  powerSupply: number;
  powerDemand: number;
  checkpoint: CheckpointDef | null;
}

const cache = new WeakMap<BuildingDef, BuildingStats[]>();

export function buildingStats(def: BuildingDef, level: number): BuildingStats {
  let perLevel = cache.get(def);
  if (!perLevel) {
    perLevel = [];
    cache.set(def, perLevel);
  }
  const index = Math.max(1, Math.min(level, (def.levels?.length ?? 0) + 1));
  const cached = perLevel[index];
  if (cached) return cached;

  const stats: BuildingStats = {
    services: def.services ?? {},
    storage: def.storage ?? {},
    productionPerDay: def.productionPerDay ?? {},
    consumptionPerDay: def.consumptionPerDay ?? {},
    upkeepPerDay: def.upkeepPerDay ?? {},
    powerSupply: def.powerSupply ?? 0,
    powerDemand: def.powerDemand ?? 0,
    checkpoint: def.checkpoint ?? null,
  };
  for (let i = 0; i < index - 1; i++) {
    const lv = def.levels![i];
    if (lv.services) stats.services = lv.services;
    if (lv.storage) stats.storage = lv.storage;
    if (lv.productionPerDay) stats.productionPerDay = lv.productionPerDay;
    if (lv.consumptionPerDay) stats.consumptionPerDay = lv.consumptionPerDay;
    if (lv.upkeepPerDay) stats.upkeepPerDay = lv.upkeepPerDay;
    if (lv.powerSupply !== undefined) stats.powerSupply = lv.powerSupply;
    if (lv.powerDemand !== undefined) stats.powerDemand = lv.powerDemand;
    if (lv.checkpoint) stats.checkpoint = lv.checkpoint;
  }
  perLevel[index] = stats;
  return stats;
}

/** Amélioration disponible depuis ce niveau, ou null si niveau maximal. */
export function nextLevel(def: BuildingDef, level: number): BuildingLevelDef | null {
  return def.levels?.[level - 1] ?? null;
}

export function levelName(def: BuildingDef, level: number): string {
  return level <= 1 ? def.name : (def.levels?.[level - 2]?.name ?? `${def.name} (niv. ${level})`);
}
