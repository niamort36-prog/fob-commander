/**
 * AssetLoader — charge les atlas déclarés dans data/assets.json et indexe leurs frames.
 * Toute clé de sprite est résolue ici : frame d'atlas si elle existe, sinon texture
 * autonome (placeholder généré par PlaceholderFactory).
 */
import type Phaser from 'phaser';
import manifestJson from '../data/assets.json';

interface AtlasEntry {
  key: string;
  texture: string;
  atlas: string;
}

interface AssetManifest {
  atlases: AtlasEntry[];
}

export interface SpriteRef {
  texture: string;
  frame?: string;
}

const manifest = manifestJson as unknown as AssetManifest;
const frameIndex = new Map<string, SpriteRef>();

export const AssetLoader = {
  /** À appeler dans BootScene.preload. */
  preload(scene: Phaser.Scene): void {
    for (const a of manifest.atlases) scene.load.atlas(a.key, a.texture, a.atlas);
  },

  /** À appeler dans BootScene.create, une fois les atlas chargés. */
  indexAtlases(scene: Phaser.Scene): void {
    frameIndex.clear();
    for (const a of manifest.atlases) {
      if (!scene.textures.exists(a.key)) {
        console.warn(`[AssetLoader] atlas « ${a.key} » introuvable : placeholders utilisés`);
        continue;
      }
      for (const name of scene.textures.get(a.key).getFrameNames()) {
        frameIndex.set(name, { texture: a.key, frame: name });
      }
    }
  },

  /** Déclare une frame produite à l'exécution (ex. atlas de terrain généré). */
  registerFrame(key: string, ref: SpriteRef): void {
    frameIndex.set(key, ref);
  },

  /** Vrai si un sprite (atlas ou texture) existe déjà pour cette clé. */
  has(scene: Phaser.Scene, key: string): boolean {
    return frameIndex.has(key) || scene.textures.exists(key);
  },

  resolve(key: string): SpriteRef {
    return frameIndex.get(key) ?? { texture: key };
  },
};
