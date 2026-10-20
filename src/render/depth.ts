/** Couches et profondeurs de tri de la vue isométrique (sans dépendance à Phaser : testable). */
import type { BuildingDef } from '../core/ContentTypes';

export const DEPTH = {
  terrain: 0,
  grid: 5,
  zone: 6,
  flat: 10, // routes, dalles : 10 + (x + y) × 0,01
  hover: 900,
  objects: 1000, // bâtiments en volume et agents : 1000 + profondeur × 10
  ghost: 900_000,
  overlay: 1_000_000,
} as const;

/**
 * Profondeur de tri d'un objet occupant un rectangle de cases : centre de l'emprise (x + y).
 * Le coin avant favorisait les grands bâtiments, qui recouvraient alors les murs, soldats et
 * véhicules placés contre leurs façades visibles ; le centre classe correctement ces voisins.
 * Échelle commune aux agents et véhicules : DEPTH.objects + (x + y - 1) × 10 pour un point (x, y).
 */
export function objectDepth(def: BuildingDef, x: number, y: number, w: number, h: number): number {
  const center = x + w / 2 + (y + h / 2);
  return def.visual.style === 'flat' ? DEPTH.flat + center * 0.01 : DEPTH.objects + (center - 1) * 10;
}
