/**
 * Périmètre possédé : assombrit le terrain hors périmètre et trace la limite
 * (pointillés façon concertina). Redessiné à chaque agrandissement.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { IsoMath, Point } from './IsoMath';
import { DEPTH } from './TerrainRenderer';

const DIM_COLOR = 0x0d0c08;
const DIM_ALPHA = 0.38;
const LINE_COLOR = 0xe8dca0;

export class ZoneRenderer {
  private readonly g: Phaser.GameObjects.Graphics;

  constructor(
    scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    this.g = scene.add.graphics().setDepth(DEPTH.zone);
    this.redraw();
  }

  redraw(): void {
    const { zone, width, height } = this.ctx.state.fob;
    const g = this.g;
    g.clear();
    g.fillStyle(DIM_COLOR, DIM_ALPHA);
    const rect = (x: number, y: number, w: number, h: number): void => {
      if (w <= 0 || h <= 0) return;
      g.fillPoints(this.iso.footprintCorners(x, y, w, h), true);
    };
    // Quatre bandes autour du périmètre
    rect(0, 0, width, zone.y);
    rect(0, zone.y + zone.height, width, height - zone.y - zone.height);
    rect(0, zone.y, zone.x, zone.height);
    rect(zone.x + zone.width, zone.y, width - zone.x - zone.width, zone.height);

    // Limite en pointillés
    const corners = this.iso.footprintCorners(zone.x, zone.y, zone.width, zone.height);
    g.lineStyle(2, LINE_COLOR, 0.55);
    for (let i = 0; i < 4; i++) this.dashed(corners[i], corners[(i + 1) % 4], 10, 6);
  }

  private dashed(a: Point, b: Point, dash: number, gap: number): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(len, d + dash);
      this.g.lineBetween(a.x + ux * d, a.y + uy * d, a.x + ux * e, a.y + uy * e);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
