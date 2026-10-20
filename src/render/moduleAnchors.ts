/**
 * Points de pose des éléments visibles des améliorations (climatiseur, mât, parabole…), partagés
 * par le rendu des bâtiments et celui du décor (qui évite d'empiler des caisses sur un climatiseur).
 */
import type { BuildingDef } from '../core/ContentTypes';
import type { BuildingInstance } from '../core/GameState';
import { BuildSystem } from '../systems/BuildSystem';

export interface ModuleAnchor {
  gx: number;
  gy: number;
  /** Altitude en pixels (toit) ; 0 = posé au sol contre une façade. */
  z: number;
  /** Au sol devant une façade (profondeur selon sa position) plutôt que sur le toit. */
  front: boolean;
}

/** Le bâtiment est entouré d'un muret de sacs de sable (module « sandbags » installé). */
export function hasSandbags(def: BuildingDef, b: BuildingInstance): boolean {
  return (def.modules ?? []).some((m) => m.visual === 'sandbags' && b.modules?.includes(m.id));
}

/** Distance du décor posé au pied d'une façade : au-delà du muret de sacs de sable s'il y en a un. */
export function frontOffset(def: BuildingDef, b: BuildingInstance): number {
  return hasSandbags(def, b) ? 0.78 : 0.2;
}

export function moduleAnchor(def: BuildingDef, b: BuildingInstance, visual: string): ModuleAnchor {
  const [w, h] = BuildSystem.footprint(def, b.rot);
  const roof = def.visual.style === 'building' && def.visual.antenna ? Math.round(def.visual.height * 0.62) : def.visual.height;
  const x = b.pos.x;
  const y = b.pos.y;
  switch (visual) {
    case 'ac': {
      // Contre une façade visible sans porte, à l'extérieur du muret de sacs de sable
      const off = hasSandbags(def, b) ? 0.8 : 0.12;
      const side = BuildSystem.entranceSide(def, b.rot);
      if (side && side.x > 0) return { gx: x + w * 0.3, gy: y + h + off, z: 0, front: true };
      return { gx: x + w + off, gy: y + h * 0.7, z: 0, front: true };
    }
    case 'mast':
      return { gx: x + w * 0.85, gy: y + h * 0.18, z: roof, front: false };
    case 'dish':
      return { gx: x + w * 0.25, gy: y + h * 0.28, z: roof, front: false };
    case 'servers':
      return { gx: x + w * 0.62, gy: y + h * 0.72, z: roof, front: false };
    case 'chimney':
      return { gx: x + w * 0.72, gy: y + h * 0.3, z: roof, front: false };
    case 'roof_tank':
      return { gx: x + w * 0.5, gy: y + h * 0.45, z: roof, front: false };
    default:
      return { gx: x + w / 2, gy: y + h / 2, z: roof, front: false };
  }
}

/** Éléments d'amélioration installés posés au sol (pour que le décor les évite). */
export function groundModules(def: BuildingDef, b: BuildingInstance): ModuleAnchor[] {
  return (def.modules ?? [])
    .filter((m) => m.visual && m.visual !== 'sandbags' && b.modules?.includes(m.id))
    .map((m) => moduleAnchor(def, b, m.visual!))
    .filter((a) => a.front);
}
