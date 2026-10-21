/**
 * Vignettes des bâtiments pour l'interface (menu de construction, bandeau du bas) : image du
 * sprite du bâtiment, extraite une fois des textures Phaser puis mise en cache.
 */
import type Phaser from 'phaser';
import type { BuildingDef } from '../core/ContentTypes';
import { AssetLoader } from './AssetLoader';
import { buildingKey, vehicleHeadingKey } from './spriteKeys';

let textures: Phaser.Textures.TextureManager | null = null;
const cache = new Map<string, string>();

/** À appeler une fois les textures générées (BootScene). */
export function setThumbnailTextures(manager: Phaser.Textures.TextureManager): void {
  textures = manager;
  cache.clear();
}

/** Image (data URL) d'un véhicule vu de trois quarts, ou chaîne vide. */
export function vehicleThumb(defId: string): string {
  const key = `veh:${defId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!textures) return '';
  let url = '';
  for (const k of [1, 0]) {
    try {
      const ref = AssetLoader.resolve(vehicleHeadingKey(defId, k));
      if (!textures.exists(ref.texture)) continue;
      url = textures.getBase64(ref.texture, ref.frame) as string;
      break;
    } catch {
      url = '';
    }
  }
  cache.set(key, url);
  return url;
}

/** Image (data URL) du bâtiment, ou chaîne vide si les textures ne sont pas prêtes. */
export function buildingThumb(def: BuildingDef): string {
  const hit = cache.get(def.id);
  if (hit !== undefined) return hit;
  if (!textures) return '';
  let url = '';
  try {
    const ref = AssetLoader.resolve(buildingKey(def, 0));
    url = textures.getBase64(ref.texture, ref.frame) as string;
  } catch {
    url = '';
  }
  cache.set(def.id, url);
  return url;
}
