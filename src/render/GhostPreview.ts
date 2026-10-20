/**
 * Aperçu fantôme du placement : sprite translucide + emprise verte (valide) ou rouge (invalide),
 * et flèche indiquant le côté de l'entrée des bâtiments à porte (orange si l'accès est bloqué).
 */
import Phaser from 'phaser';
import type { BuildingDef } from '../core/ContentTypes';
import type { GridPos, Rotation } from '../core/GameState';
import { BuildSystem } from '../systems/BuildSystem';
import { makeBuildingSprite, setBuildingSprite } from './BuildingRenderer';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './TerrainRenderer';

const OK_COLOR = 0x7fdc6a;
const BAD_COLOR = 0xe0533f;
const DOOR_COLOR = 0xfff3c4;
const NOISE_COLOR = 0xf0a040;

/** Zone de bruit à afficher pendant le placement (centre et rayon en cases). */
export interface GhostNoise {
  x: number;
  y: number;
  radius: number;
  /** Logements exposés (emprises à surligner). */
  exposed?: { x: number; y: number; w: number; h: number }[];
}
const DOOR_BLOCKED = 0xf0a040;

export class GhostPreview {
  private readonly pool: Phaser.GameObjects.Image[] = [];
  private readonly footprint: Phaser.GameObjects.Graphics;
  /** Flèche d'entrée, au-dessus du sprite (visible même quand la porte est au dos). */
  private readonly arrow: Phaser.GameObjects.Graphics;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly iso: IsoMath,
  ) {
    this.footprint = scene.add.graphics().setDepth(DEPTH.ghost - 1);
    this.arrow = scene.add.graphics().setDepth(DEPTH.overlay - 5); // au-dessus de la teinte jour/nuit
  }

  hide(): void {
    this.footprint.clear();
    this.arrow.clear();
    for (const img of this.pool) img.setVisible(false);
  }

  showSingle(def: BuildingDef, pos: GridPos, rot: Rotation, ok: boolean, entranceClear = true, noise: GhostNoise[] = []): void {
    this.hide();
    const [w, h] = BuildSystem.footprint(def, rot);
    for (const z of noise) this.drawNoise(z);
    this.drawFootprint(pos.x, pos.y, w, h, ok);
    this.place(0, def, pos, rot, ok);
    const side = BuildSystem.entranceSide(def, rot);
    if (side) this.drawEntrance(pos, w, h, side, entranceClear);
  }

  showLine(def: BuildingDef, cells: GridPos[], ok: boolean[]): void {
    this.hide();
    cells.forEach((c, i) => {
      this.drawFootprint(c.x, c.y, 1, 1, ok[i]);
      this.place(i, def, c, 0, ok[i]);
    });
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
    this.footprint.destroy();
    this.arrow.destroy();
  }

  private place(index: number, def: BuildingDef, pos: GridPos, rot: Rotation, ok: boolean): void {
    let img = this.pool[index];
    if (!img) {
      img = makeBuildingSprite(this.scene, this.iso, def, pos.x, pos.y, rot);
      this.pool.push(img);
    } else {
      setBuildingSprite(img, this.iso, def, pos.x, pos.y, rot);
    }
    img
      .setVisible(true)
      .setAlpha(0.6)
      .setTint(ok ? 0xc8ffc0 : 0xff9a8a)
      .setDepth(DEPTH.ghost + img.depth / 1000);
  }

  /** Cercle de bruit au sol (tirets) et logements exposés surlignés. */
  private drawNoise(z: GhostNoise): void {
    const g = this.footprint;
    const pts = [];
    for (let k = 0; k <= 48; k++) {
      const a = (Math.PI * 2 * k) / 48;
      pts.push(this.iso.toScreen(z.x + Math.cos(a) * z.radius, z.y + Math.sin(a) * z.radius));
    }
    g.fillStyle(NOISE_COLOR, 0.07);
    g.fillPoints(pts, true);
    g.lineStyle(2, NOISE_COLOR, 0.85);
    for (let k = 0; k < 48; k += 2) g.lineBetween(pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y);
    for (const e of z.exposed ?? []) {
      const c = this.iso.footprintCorners(e.x, e.y, e.w, e.h);
      g.fillStyle(NOISE_COLOR, 0.3);
      g.fillPoints(c, true);
      g.lineStyle(2, NOISE_COLOR, 1);
      g.strokePoints(c, true);
    }
  }

  /** Flèche posée au sol, du milieu du côté de l'entrée vers l'extérieur. */
  private drawEntrance(pos: GridPos, w: number, h: number, side: GridPos, clear: boolean): void {
    const g = this.arrow;
    // Milieu du bord de l'entrée (coordonnées de grille)
    const bx = side.x > 0 ? pos.x + w : side.x < 0 ? pos.x : pos.x + w / 2;
    const by = side.y > 0 ? pos.y + h : side.y < 0 ? pos.y : pos.y + h / 2;
    const px = -side.y; // perpendiculaire
    const py = side.x;
    const S = (gx: number, gy: number) => this.iso.toScreen(gx, gy);
    const along = (d: number, lat: number) => S(bx + side.x * d + px * lat, by + side.y * d + py * lat);
    // Corps et pointe de la flèche
    const shaft = [along(0.15, -0.16), along(0.95, -0.16), along(0.95, 0.16), along(0.15, 0.16)];
    const head = [along(0.85, -0.42), along(1.55, 0), along(0.85, 0.42)];
    const color = clear ? DOOR_COLOR : DOOR_BLOCKED;
    g.fillStyle(0x000000, 0.35);
    g.fillPoints(shaft.map((p) => ({ x: p.x + 1, y: p.y + 2 })), true);
    g.fillPoints(head.map((p) => ({ x: p.x + 1, y: p.y + 2 })), true);
    g.fillStyle(color, 0.95);
    g.fillPoints(shaft, true);
    g.fillPoints(head, true);
    g.lineStyle(1, 0x2b2a24, 0.9);
    g.strokePoints([shaft[0], shaft[1], head[0], head[1], head[2], shaft[2], shaft[3]], true);
    // Repère de porte sur le bord de l'emprise
    const d0 = along(0, -0.45);
    const d1 = along(0, 0.45);
    g.lineStyle(3, color, 1);
    g.lineBetween(d0.x, d0.y, d1.x, d1.y);
  }

  private drawFootprint(x: number, y: number, w: number, h: number, ok: boolean): void {
    const color = ok ? OK_COLOR : BAD_COLOR;
    const pts = this.iso.footprintCorners(x, y, w, h);
    this.footprint.fillStyle(color, 0.28);
    this.footprint.fillPoints(pts, true);
    this.footprint.lineStyle(1, color, 0.95);
    this.footprint.strokePoints(pts, true);
  }
}
