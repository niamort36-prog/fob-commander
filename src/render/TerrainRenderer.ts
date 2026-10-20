/**
 * Rendu du sol, de la grille de construction et de la case survolée.
 *
 * Grande carte : le sol est découpé en blocs de CHUNK × CHUNK cases, chacun rendu par un
 * Blitter (un seul appel de rendu groupé pour toutes ses tuiles). Les blocs hors du champ de
 * la caméra sont masqués à chaque frame : le coût d'affichage ne dépend plus de la taille de la carte.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { GridPos } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { TERRAIN_BLEED, TERRAIN_VARIANTS, terrainKey } from '../assets/spriteKeys';
import { hash2 } from '../utils/Rng';
import type { IsoMath } from './IsoMath';

export { DEPTH } from './depth';
import { DEPTH } from './depth';

const CHUNK = 16;

interface Chunk {
  bounds: Phaser.Geom.Rectangle;
  objects: Phaser.GameObjects.GameObject[];
  visible: boolean;
}

export class TerrainRenderer {
  private readonly chunks: Chunk[] = [];
  private readonly grid: Phaser.GameObjects.Graphics;
  private readonly hover: Phaser.GameObjects.Graphics;
  private gridShown = false;

  constructor(
    scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    const { fob, meta } = ctx.state;
    for (let cy = 0; cy < fob.height; cy += CHUNK) {
      for (let cx = 0; cx < fob.width; cx += CHUNK) {
        this.chunks.push(this.buildChunk(scene, cx, cy, Math.min(fob.width, cx + CHUNK), Math.min(fob.height, cy + CHUNK), meta.seed));
      }
    }

    // Limite de la carte
    const border = scene.add.graphics().setDepth(DEPTH.grid);
    border.lineStyle(2, 0x2b2a20, 0.8);
    border.strokePoints(iso.footprintCorners(0, 0, fob.width, fob.height), true);

    this.grid = scene.add.graphics().setDepth(DEPTH.grid).setVisible(false);
    this.hover = scene.add.graphics().setDepth(DEPTH.hover);
    this.redrawGrid();
  }

  private buildChunk(scene: Phaser.Scene, x0: number, y0: number, x1: number, y1: number, seed: number): Chunk {
    const fob = this.ctx.state.fob;
    const objects: Phaser.GameObjects.GameObject[] = [];
    let blitter: Phaser.GameObjects.Blitter | null = null;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const def = this.ctx.content.terrainAt(fob.terrain[y * fob.width + x]);
        const ref = AssetLoader.resolve(terrainKey(def.id, hash2(x, y, seed) % TERRAIN_VARIANTS));
        const p = this.iso.toScreen(x, y);
        if (!blitter) {
          blitter = scene.add.blitter(0, 0, ref.texture).setDepth(DEPTH.terrain);
          objects.push(blitter);
        }
        if (blitter.texture.key === ref.texture) {
          const frame = blitter.texture.get(ref.frame);
          blitter.create(Math.round(p.x - frame.width / 2), p.y - TERRAIN_BLEED, frame);
        } else {
          // Tuile provenant d'une autre texture (sprite remplacé à part) : image isolée.
          objects.push(scene.add.image(p.x, p.y - TERRAIN_BLEED, ref.texture, ref.frame).setOrigin(0.5, 0).setDepth(DEPTH.terrain));
        }
      }
    }

    const left = this.iso.toScreen(x0, y1).x - this.iso.halfW;
    const right = this.iso.toScreen(x1, y0).x + this.iso.halfW;
    const top = this.iso.toScreen(x0, y0).y - this.iso.tileH;
    const bottom = this.iso.toScreen(x1, y1).y + this.iso.tileH;
    return { bounds: new Phaser.Geom.Rectangle(left, top, right - left, bottom - top), objects, visible: true };
  }

  /** Masque les blocs hors du champ de la caméra. À appeler à chaque frame. */
  cull(view: Phaser.Geom.Rectangle): void {
    for (const c of this.chunks) {
      const visible = Phaser.Geom.Rectangle.Overlaps(view, c.bounds);
      if (visible === c.visible) continue;
      c.visible = visible;
      for (const o of c.objects) (o as Phaser.GameObjects.Blitter).setVisible(visible);
    }
  }

  /** Grille de construction limitée au périmètre possédé. */
  redrawGrid(): void {
    const z = this.ctx.state.fob.zone;
    this.grid.clear();
    this.grid.lineStyle(1, 0x1e1d16, 0.2);
    for (let i = 0; i <= z.width; i++) {
      const a = this.iso.toScreen(z.x + i, z.y);
      const b = this.iso.toScreen(z.x + i, z.y + z.height);
      this.grid.lineBetween(a.x, a.y, b.x, b.y);
    }
    for (let j = 0; j <= z.height; j++) {
      const a = this.iso.toScreen(z.x, z.y + j);
      const b = this.iso.toScreen(z.x + z.width, z.y + j);
      this.grid.lineBetween(a.x, a.y, b.x, b.y);
    }
  }

  setGridVisible(visible: boolean): void {
    this.gridShown = visible;
    this.grid.setVisible(visible);
  }

  get gridVisible(): boolean {
    return this.gridShown;
  }

  setHover(cell: GridPos | null, color = 0xf2e6b0): void {
    this.hover.clear();
    if (!cell) return;
    this.hover.lineStyle(1, color, 0.9);
    this.hover.fillStyle(color, 0.12);
    const pts = this.iso.footprintCorners(cell.x, cell.y, 1, 1);
    this.hover.fillPoints(pts, true);
    this.hover.strokePoints(pts, true);
  }

  destroy(): void {
    for (const c of this.chunks) for (const o of c.objects) o.destroy();
    this.grid.destroy();
    this.hover.destroy();
  }
}
