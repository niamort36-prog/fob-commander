/**
 * Rendu des bâtiments : synchronise des sprites avec state.fob.buildings à chaque frame
 * (création, suppression, transparence des chantiers, sélection, barres de progression).
 */
import Phaser from 'phaser';
import type { BuildingDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { BuildingInstance, Id, Rotation } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { MODULE_ART, buildingGeometry, buildingKey, moduleKey, sandbagGeometry, sandbagKey } from '../assets/spriteKeys';
import { BuildSystem } from '../systems/BuildSystem';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './TerrainRenderer';
import { objectDepth } from './depth';
import { moduleAnchor } from './moduleAnchors';

export { objectDepth } from './depth';

/** Crée un sprite de bâtiment positionné (utilisé aussi par l'aperçu fantôme). */
export function makeBuildingSprite(
  scene: Phaser.Scene,
  iso: IsoMath,
  def: BuildingDef,
  x: number,
  y: number,
  rot: Rotation,
): Phaser.GameObjects.Image {
  const img = scene.add.image(0, 0, '__DEFAULT');
  setBuildingSprite(img, iso, def, x, y, rot);
  return img;
}

export function setBuildingSprite(
  img: Phaser.GameObjects.Image,
  iso: IsoMath,
  def: BuildingDef,
  x: number,
  y: number,
  rot: Rotation,
): void {
  const geo = buildingGeometry(def, rot, iso.tileW, iso.tileH);
  const ref = AssetLoader.resolve(buildingKey(def, rot));
  if (img.texture.key !== ref.texture || (ref.frame && img.frame.name !== ref.frame)) img.setTexture(ref.texture, ref.frame);
  const p = iso.toScreen(x, y);
  img.setOrigin(geo.originX, geo.originY).setPosition(p.x, p.y).setDepth(objectDepth(def, x, y, geo.w, geo.h));
}

export class BuildingRenderer {
  private readonly sprites = new Map<Id, Phaser.GameObjects.Image>();
  /** Éléments visibles des améliorations, par bâtiment (clé = visuel). */
  private readonly extras = new Map<Id, Map<string, Phaser.GameObjects.Image>>();
  private readonly bars: Phaser.GameObjects.Graphics;
  private selectedId: Id | null = null;
  private hoverId: Id | null = null;
  private hoverColor = 0xffffff;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    this.bars = scene.add.graphics().setDepth(DEPTH.overlay);
  }

  setSelected(id: Id | null): void {
    this.selectedId = id;
  }

  /** Surbrillance au survol (ex. rouge en mode démolition). */
  setHover(id: Id | null, color = 0xffffff): void {
    this.hoverId = id;
    this.hoverColor = color;
  }

  sync(): void {
    const buildings = this.ctx.state.fob.buildings;
    for (const [id, sprite] of this.sprites) {
      if (!buildings[id]) {
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
    for (const [id, list] of this.extras) {
      if (!buildings[id]) {
        for (const img of list.values()) img.destroy();
        this.extras.delete(id);
      }
    }

    this.bars.clear();
    for (const b of Object.values(buildings)) {
      let sprite = this.sprites.get(b.id);
      const def = this.ctx.content.building(b.defId);
      if (!sprite) {
        sprite = makeBuildingSprite(this.scene, this.iso, def, b.pos.x, b.pos.y, b.rot);
        this.sprites.set(b.id, sprite);
      }
      this.styleSprite(sprite, b);
      if (def.modules) this.syncExtras(b, def, sprite);
      if (b.state === 'construction' && !def.placement.line) this.drawProgress(b, def, b.buildProgress, 0xb9c36b);
      else if (b.upgrade) this.drawProgress(b, def, b.upgrade.progress, 0x7fb3c9);
      else if (b.moduleWork) this.drawProgress(b, def, b.moduleWork.progress, 0xd8c47a);
    }
  }

  /** Pose (ou retire) les éléments visibles des améliorations installées. */
  private syncExtras(b: BuildingInstance, def: BuildingDef, sprite: Phaser.GameObjects.Image): void {
    let list = this.extras.get(b.id);
    const wanted = new Set<string>((def.modules ?? []).filter((m) => m.visual && b.modules?.includes(m.id)).map((m) => m.visual!));
    if (!list) {
      if (wanted.size === 0) return;
      list = new Map();
      this.extras.set(b.id, list);
    }
    for (const [visual, img] of list) {
      if (!wanted.has(visual)) {
        img.destroy();
        list.delete(visual);
      }
    }
    for (const visual of wanted) {
      let img = list.get(visual);
      if (visual === 'sandbags') {
        const key = sandbagKey(def.id, b.rot);
        if (!img) {
          const ref = AssetLoader.resolve(key);
          img = this.scene.add.image(0, 0, ref.texture, ref.frame);
          list.set(visual, img);
        }
        const [w, h] = BuildSystem.footprint(def, b.rot);
        const geo = sandbagGeometry(w, h, this.iso.tileW, this.iso.tileH);
        const p = this.iso.toScreen(b.pos.x - 0.5, b.pos.y - 0.5);
        img.setOrigin(geo.anchorX / geo.width, geo.anchorY / geo.height).setPosition(p.x, p.y).setDepth(sprite.depth + 1);
      } else {
        if (!img) {
          const ref = AssetLoader.resolve(moduleKey(visual));
          img = this.scene.add.image(0, 0, ref.texture, ref.frame);
          list.set(visual, img);
        }
        const art = MODULE_ART[visual];
        const a = moduleAnchor(def, b, visual);
        const p = this.iso.toScreen(a.gx, a.gy);
        // Au sol : profondeur selon sa position (devant le muret de sacs de sable s'il est dehors)
        const depth = a.front ? Math.max(sprite.depth + 1, DEPTH.objects + (a.gx + a.gy - 1) * 10 + 1) : sprite.depth + 0.5;
        img.setOrigin(art.ax / art.w, art.ay / art.h).setPosition(Math.round(p.x), Math.round(p.y - a.z)).setDepth(depth);
      }
      img.setAlpha(sprite.alpha);
      if (sprite.isTinted) img.setTint(sprite.tintTopLeft);
      else img.clearTint();
    }
  }

  private styleSprite(sprite: Phaser.GameObjects.Image, b: BuildingInstance): void {
    sprite.setAlpha(b.state === 'construction' ? 0.35 + 0.45 * b.buildProgress : 1);
    if (b.id === this.hoverId) sprite.setTint(this.hoverColor);
    else if (b.id === this.selectedId) sprite.setTint(0xfff0a8);
    else if (b.state === 'damaged') sprite.setTint(0xd08a70);
    else if (b.state === 'disabled') sprite.setTint(0x7a6a62);
    else if (b.state === 'construction') sprite.setTint(0xc8d0e0);
    else sprite.clearTint();
  }

  private drawProgress(b: BuildingInstance, def: BuildingDef, progress: number, color: number): void {
    const geo = buildingGeometry(def, b.rot, this.iso.tileW, this.iso.tileH);
    const center = this.iso.toScreen(b.pos.x + geo.w / 2, b.pos.y + geo.h / 2);
    const top = this.iso.toScreen(b.pos.x, b.pos.y).y - def.visual.height - 10;
    const width = 34;
    const x = Math.round(center.x - width / 2);
    const y = Math.round(top);
    this.bars.fillStyle(0x14150f, 0.85);
    this.bars.fillRect(x - 1, y - 1, width + 2, 6);
    this.bars.fillStyle(color, 1);
    this.bars.fillRect(x, y, Math.round(width * progress), 4);
  }

  destroy(): void {
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
    for (const list of this.extras.values()) for (const img of list.values()) img.destroy();
    this.extras.clear();
    this.bars.destroy();
  }
}
