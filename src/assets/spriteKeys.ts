/**
 * Convention de nommage et géométrie des sprites.
 * Les placeholders générés par code ET les futurs vrais sprites suivent exactement ces règles,
 * ce qui permet de remplacer l'un par l'autre sans toucher au rendu.
 *
 *  - Terrain   : « ter.<terrainId>.<variante 0..2> »         — losange (tileW + 2·BLEED) × (tileH + 2·BLEED),
 *                le losange déborde de BLEED px pour masquer les joints entre tuiles
 *  - Agent     : « agent.<personnelId> »                       — 16 × 28, pieds en (8, 26)
 *  - Véhicule  : « veh.<vehicleId>.a<0|1>[f] »                — emprise length × 1 le long de l'axe (4 orientations)
 *  - Bâtiment  : « <visual.key>.r<0|1> »                      — r1 = emprise tournée d'un quart de tour
 *    Canevas : largeur (w + h) × tileW/2, hauteur (w + h) × tileH/2 + visual.height + PAD.
 *    Le sommet nord de l'emprise se trouve à (h × tileW/2, visual.height + PAD) dans le canevas.
 */
import type { BuildingDef } from '../core/ContentTypes';
import type { Rotation } from '../core/GameState';

export const TERRAIN_VARIANTS = 3;
/** Débordement des tuiles de terrain (px) pour recouvrir les joints. */
export const TERRAIN_BLEED = 1;
/** Marge en haut des sprites de bâtiment (contours, antennes…). */
export const SPRITE_PAD = 4;

/** Texture regroupant toutes les tuiles de terrain générées (rendu par Blitter). */
export const TERRAIN_ATLAS = 'ter.atlas';

/** Sprite d'agent : canevas AGENT_W × AGENT_H, pieds au point (AGENT_W / 2, AGENT_FOOT_Y). */
export const AGENT_W = 16;
export const AGENT_H = 28;
export const AGENT_FOOT_Y = 26;

export function agentKey(personnelId: string): string {
  return `agent.${personnelId}`;
}

/** Silhouette d'un type de personnel dans une pose et une teinte de peau. */
export function figureKey(personnelId: string, pose: string, skin: number): string {
  return `fig.${personnelId}.${pose}.${skin}`;
}

/**
 * Véhicules : emprise « length » × 1 case le long de l'axe x (a0) ou y (a1) ; « f » = avant tourné
 * vers les x/y décroissants. Même convention de canevas que les bâtiments (hauteur = visual.height).
 */
export function vehicleKey(defId: string, axis: 0 | 1, flip: boolean): string {
  return `veh.${defId}.a${axis}${flip ? 'f' : ''}`;
}

/** Nombre d'orientations dessinées pour les véhicules (tous les 22,5°) : virages fluides. */
export const VEHICLE_HEADINGS = 16;

/** Sprite d'un véhicule tourné vers l'orientation k (0 = x croissants, sens des aiguilles en grille). */
export function vehicleHeadingKey(defId: string, k: number): string {
  return `veh.${defId}.h${k}`;
}

/** Pas entre deux orientations dessinées : les avions (grands, en ligne droite) n'en ont que 4. */
export function vehicleHeadingStep(def: { kind: string }): number {
  return def.kind === 'plane' ? VEHICLE_HEADINGS / 4 : 1;
}

/** Orientation dessinée la plus proche d'un cap (radians) ; `step` > 1 pour n'utiliser qu'une orientation sur `step`. */
export function headingIndex(angle: number, step = 1): number {
  const n = VEHICLE_HEADINGS / step;
  const k = Math.round((angle / (Math.PI * 2)) * n);
  return ((((k % n) + n) % n) * step) % VEHICLE_HEADINGS;
}

/**
 * Canevas d'un véhicule orientable : emprise carrée S × S (S = plus grande dimension + marge)
 * centrée sur le véhicule, quelle que soit son orientation.
 */
export function vehicleGeometry(length: number, heightPx: number, tileW: number, tileH: number, span = 1): BuildingGeometry {
  const s = Math.max(length, span) + 0.3;
  const top = heightPx + SPRITE_PAD;
  const width = s * tileW;
  const height = s * tileH + top;
  const anchorX = (s * tileW) / 2;
  return { w: s, h: s, top, width, height, anchorX, anchorY: top, originX: anchorX / width, originY: top / height };
}

/** Éléments visibles des améliorations : taille du canevas et point de pose (base) dans le canevas. */
export const MODULE_ART: Record<string, { w: number; h: number; ax: number; ay: number }> = {
  ac: { w: 22, h: 20, ax: 11, ay: 18 },
  mast: { w: 30, h: 76, ax: 15, ay: 72 },
  dish: { w: 28, h: 28, ax: 14, ay: 25 },
  servers: { w: 24, h: 18, ax: 12, ay: 15 },
  chimney: { w: 14, h: 26, ax: 7, ay: 23 },
  roof_tank: { w: 26, h: 22, ax: 13, ay: 19 },
  redcross: { w: 36, h: 20, ax: 18, ay: 10 },
};

export function moduleKey(visual: string): string {
  return `mod.${visual}`;
}

/** Murets de sacs de sable : texture propre au bâtiment et à son orientation. */
export function sandbagKey(defId: string, rot: number): string {
  return `mod.sandbags.${defId}.r${rot}`;
}

/** Géométrie du canevas des murets : emprise élargie d'une demi-case de chaque côté. */
export function sandbagGeometry(w: number, h: number, tileW: number, tileH: number): { width: number; height: number; anchorX: number; anchorY: number } {
  const W = w + 1;
  const H = h + 1;
  const top = 14;
  return { width: ((W + H) * tileW) / 2, height: ((W + H) * tileH) / 2 + top, anchorX: (H * tileW) / 2, anchorY: top };
}

export function terrainKey(terrainId: string, variant: number): string {
  return `ter.${terrainId}.${variant}`;
}

/** Bâtiments carrés dont le dessin dépend de l'orientation (porte, guérite, pièces d'artillerie, barbecue). */
const ORIENTED_SQUARE = new Set(['gate', 'booth', 'howitzer', 'bbq']);

/** Orientation de sprite utilisée pour un bâtiment tourné de « rot » quarts de tour. */
function spriteRotation(def: BuildingDef, rot: Rotation): Rotation {
  if (def.entrance) return rot;
  const square = def.footprint[0] === def.footprint[1];
  if (!square) return (rot % 2) as Rotation;
  if (!def.rotatable || !ORIENTED_SQUARE.has(def.visual.style)) return 0;
  return (def.visual.style === 'gate' ? rot % 2 : rot) as Rotation;
}

export function buildingKey(def: BuildingDef, rot: Rotation): string {
  return `${def.visual.key}.r${spriteRotation(def, rot)}`;
}

/** Orientations de sprite à générer pour ce bâtiment. */
export function buildingRotations(def: BuildingDef): Rotation[] {
  return [...new Set(([0, 1, 2, 3] as Rotation[]).map((r) => spriteRotation(def, r)))];
}

export interface BuildingGeometry {
  /** Emprise après rotation. */
  w: number;
  h: number;
  /** Hauteur du volume + marge. */
  top: number;
  width: number;
  height: number;
  /** Position du sommet nord de l'emprise dans le canevas. */
  anchorX: number;
  anchorY: number;
  originX: number;
  originY: number;
}

export function buildingGeometry(def: BuildingDef, rot: Rotation, tileW: number, tileH: number): BuildingGeometry {
  const [fw, fh] = def.footprint;
  const [w, h] = rot % 2 === 0 ? [fw, fh] : [fh, fw];
  const top = def.visual.height + SPRITE_PAD;
  const width = ((w + h) * tileW) / 2;
  const height = ((w + h) * tileH) / 2 + top;
  const anchorX = (h * tileW) / 2;
  const anchorY = top;
  return { w, h, top, width, height, anchorX, anchorY, originX: anchorX / width, originY: anchorY / height };
}
