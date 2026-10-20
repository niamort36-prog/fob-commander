/**
 * Génération du terrain de la FOB à partir des paramètres du site (sites.json).
 * Bruit + rochers renforcés vers les bords + zone centrale aplanie (terre battue).
 */
import type { SiteTerrainParams } from '../core/ContentTypes';
import type { GridPos } from '../core/GameState';
import { valueNoise } from './noise';
import { Rng } from './Rng';

export type EntrySide = 'north' | 'south' | 'east' | 'west';

/** Case d'arrivée des convois : milieu du bord de carte indiqué. */
export function entryCell(side: EntrySide, width: number, height: number): GridPos {
  switch (side) {
    case 'north':
      return { x: Math.floor(width / 2), y: 0 };
    case 'south':
      return { x: Math.floor(width / 2), y: height - 1 };
    case 'east':
      return { x: width - 1, y: Math.floor(height / 2) };
    case 'west':
      return { x: 0, y: Math.floor(height / 2) };
  }
}

/**
 * Trace une piste (2 cases de large, légèrement sinueuse) depuis la bordure de carte jusqu'à
 * quelques cases à l'intérieur du périmètre. Les rochers sur le tracé sont remplacés.
 */
export function carveTrack(
  terrain: number[],
  width: number,
  height: number,
  from: GridPos,
  zone: { x: number; y: number; width: number; height: number },
  seed: number,
  trackIndex: number,
): void {
  const rng = new Rng(seed ^ 0x7a3c9);
  const target = { x: Math.floor(zone.x + zone.width / 2), y: Math.floor(zone.y + zone.height / 2) };
  const inZone = (x: number, y: number): boolean => x >= zone.x && y >= zone.y && x < zone.x + zone.width && y < zone.y + zone.height;
  const mark = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < width && y < height) terrain[y * width + x] = trackIndex;
  };
  let x = from.x;
  let y = from.y;
  let inside = 0;
  for (let guard = 0; guard < width * height && inside < 4; guard++) {
    const dx = target.x - x;
    const dy = target.y - y;
    if (dx === 0 && dy === 0) break;
    const mainX = Math.abs(dx) >= Math.abs(dy);
    // Écart aléatoire vers l'axe secondaire pour un tracé moins rectiligne
    const wobble = rng.chance(0.25) && (mainX ? dy !== 0 : dx !== 0);
    if (mainX !== wobble) x += Math.sign(dx);
    else y += Math.sign(dy);
    mark(x, y);
    if (mainX) mark(x, y + 1);
    else mark(x + 1, y);
    if (inZone(x, y)) inside++;
  }
  mark(from.x, from.y);
}

export function generateTerrain(
  width: number,
  height: number,
  seed: number,
  params: SiteTerrainParams,
  terrainIndex: ReadonlyMap<string, number>,
): number[] {
  const rng = new Rng(seed ^ 0x5eed1234);
  const noise = valueNoise(width, height, params.noiseScale, rng, 3);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const maxDist = Math.hypot(cx, cy);
  const clearValue = params.bands[0].max * 0.8;
  const bandIndex = params.bands.map((b) => terrainIndex.get(b.terrain) ?? 0);

  const out = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const d = Math.hypot(x - cx, y - cy);
      let v = noise[i] + params.edgeRock * (d / maxDist) ** 2;
      if (d <= params.clearRadius) v = Math.min(v, clearValue);
      v = Math.min(1, Math.max(0, v));
      let band = params.bands.findIndex((b) => v <= b.max);
      if (band < 0) band = params.bands.length - 1;
      out[i] = bandIndex[band];
    }
  }
  return out;
}
