/**
 * Améliorations installées sur les bâtiments (buildings.json → modules) et équipement individuel :
 * fonctions de calcul partagées par la simulation (confort, électricité, communications,
 * renseignement, soins, protection) et par le rendu.
 */
import type { BuildingDef, BuildingModuleDef, EquipmentItemDef } from '../core/ContentTypes';
import type { ContentRegistry } from '../core/ContentRegistry';
import type { Agent, BuildingInstance, GameState } from '../core/GameState';

const operational = (b: BuildingInstance): boolean => b.state === 'active' || b.state === 'damaged';

/** Définitions des améliorations installées sur un bâtiment. */
export function installedModules(def: BuildingDef, b: BuildingInstance): BuildingModuleDef[] {
  if (!def.modules || !b.modules?.length) return [];
  return def.modules.filter((m) => b.modules!.includes(m.id));
}

/** Améliorations de tous les bâtiments en service d'un type donné. */
export function modulesOfType(content: ContentRegistry, state: GameState, defId: string): BuildingModuleDef[] {
  const out: BuildingModuleDef[] = [];
  for (const b of Object.values(state.fob.buildings)) {
    if (b.defId !== defId || !operational(b)) continue;
    out.push(...installedModules(content.building(defId), b));
  }
  return out;
}

/** Portée radio du TOC (km) et bonus de liaison. */
export function commsOf(content: ContentRegistry, state: GameState): { rangeKm: number; global: boolean; success: number; toc: boolean } {
  const cfg = content.missions.config.comms;
  const toc = Object.values(state.fob.buildings).some((b) => b.defId === 'toc' && operational(b));
  if (!toc) return { rangeKm: cfg.noTocRangeKm, global: false, success: 0, toc: false };
  let rangeKm = cfg.baseRangeKm;
  let global = false;
  let success = 0;
  for (const m of modulesOfType(content, state, 'toc')) {
    rangeKm += m.comms?.rangeKm ?? 0;
    global ||= m.comms?.global === true;
    success += m.comms?.success ?? 0;
  }
  return { rangeKm, global, success, toc: true };
}

/** Pénalité de liaison radio pour une mission à cette distance (0 = liaison correcte). */
export function commsPenalty(content: ContentRegistry, state: GameState, distanceKm: number): number {
  const c = commsOf(content, state);
  if (c.global || distanceKm <= c.rangeKm) return 0;
  const cfg = content.missions.config.comms;
  return Math.min(cfg.maxPenalty, ((distanceKm - c.rangeKm) / 10) * cfg.penaltyPer10Km);
}

/** Effet supplémentaire des améliorations sur un service (ex. sommeil +4/h sous une tente climatisée). */
export function serviceBonus(content: ContentRegistry, b: BuildingInstance, service: string): Partial<Record<keyof Agent['needs'], number>> {
  const out: Partial<Record<keyof Agent['needs'], number>> = {};
  for (const m of installedModules(content.building(b.defId), b)) {
    for (const [need, v] of Object.entries(m.serviceEffects?.[service] ?? {})) {
      const k = need as keyof Agent['needs'];
      out[k] = (out[k] ?? 0) + (v ?? 0);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Bruit

export interface NoiseZone {
  buildingId: string;
  name: string;
  x: number; // centre (grille)
  y: number;
  radius: number;
  sleepMult: number;
  moralePerHour: number;
}

/** Rayon de bruit d'un bâtiment (merlons antibruit compris). */
export function noiseRadius(def: BuildingDef, b: BuildingInstance): number {
  if (!def.noise) return 0;
  return def.noise.radius * installedModules(def, b).reduce((m, x) => m * (x.noiseMult ?? 1), 1);
}

/** Zones de bruit des bâtiments bruyants (tous, ou seulement ceux en cours d'utilisation). */
export function noiseZones(content: ContentRegistry, state: GameState, inUse?: (b: BuildingInstance) => boolean): NoiseZone[] {
  const out: NoiseZone[] = [];
  for (const b of Object.values(state.fob.buildings)) {
    const def = content.building(b.defId);
    if (!def.noise || !operational(b) || (inUse && !inUse(b))) continue;
    const [w, h] = b.rot % 2 === 0 ? def.footprint : [def.footprint[1], def.footprint[0]];
    out.push({ buildingId: b.id, name: def.name, x: b.pos.x + w / 2, y: b.pos.y + h / 2, radius: noiseRadius(def, b), sleepMult: def.noise.sleepMult, moralePerHour: def.noise.moralePerHour });
  }
  return out;
}

/** Distance d'un bâtiment (centre) à une zone de bruit. */
export function distanceToZone(def: BuildingDef, b: BuildingInstance, z: NoiseZone): number {
  const [w, h] = b.rot % 2 === 0 ? def.footprint : [def.footprint[1], def.footprint[0]];
  return Math.hypot(b.pos.x + w / 2 - z.x, b.pos.y + h / 2 - z.y);
}

// ---------------------------------------------------------------- Équipement individuel

export function gearOf(content: ContentRegistry, a: Agent): EquipmentItemDef[] {
  return (a.gear ?? []).map((id) => content.equipment.items.find((i) => i.id === id)).filter((i): i is EquipmentItemDef => Boolean(i));
}

/** Heure de jeu (0..24) correspondant à un tick donné. */
export function hourAt(content: ContentRegistry, tick: number): number {
  const t = content.balance.time;
  return ((t.startHour * 60 + tick * t.minutesPerTick) / 60) % 24;
}

export function isNightHour(content: ContentRegistry, hour: number): boolean {
  const [a, b] = content.equipment.nightHours;
  return a <= b ? hour >= a && hour < b : hour >= a || hour < b;
}

/** Bonus de mission dû à l'équipement de l'équipe (part des membres équipés de chaque article). */
export function gearMissionBonus(content: ContentRegistry, members: Agent[], night: boolean): { success: number; casualty: number; items: { item: EquipmentItemDef; n: number }[] } {
  let success = 0;
  let casualty = 0;
  const items: { item: EquipmentItemDef; n: number }[] = [];
  if (!members.length) return { success, casualty, items };
  for (const item of content.equipment.items) {
    const n = members.filter((a) => a.gear?.includes(item.id)).length;
    if (!n) continue;
    const f = n / members.length;
    success += f * ((item.mission?.success ?? 0) + (night ? (item.mission?.night ?? 0) : 0));
    if (night) casualty += f * (item.mission?.nightCasualty ?? 0);
    items.push({ item, n });
  }
  return { success, casualty, items };
}
