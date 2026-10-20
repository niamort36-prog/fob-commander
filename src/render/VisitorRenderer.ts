/**
 * Rendu des délégations en visite : silhouettes des visiteurs (interpolées entre deux ticks),
 * masquées tant qu'ils sont à bord de leur véhicule, et nom du chef de délégation au-dessus de lui.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { Id } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { AGENT_FOOT_Y, AGENT_H } from '../assets/spriteKeys';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './TerrainRenderer';

export class VisitorRenderer {
  private readonly sprites = new Map<Id, Phaser.GameObjects.Image>();
  private readonly label: Phaser.GameObjects.Text;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    this.label = scene.add
      .text(0, 0, '', { fontFamily: 'VT323, monospace', fontSize: '15px', color: '#fff3c4', stroke: '#1a1a14', strokeThickness: 3 })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.overlay - 3)
      .setVisible(false);
  }

  sync(alpha: number): void {
    const visit = this.ctx.state.visit;
    const live = new Set(visit ? visit.visitors.map((p) => p.id) : []);
    for (const [id, s] of this.sprites) {
      if (!live.has(id)) {
        s.destroy();
        this.sprites.delete(id);
      }
    }
    this.label.setVisible(false);
    if (!visit) return;
    for (const p of visit.visitors) {
      let sprite = this.sprites.get(p.id);
      if (!sprite) {
        const ref = AssetLoader.resolve(`visitor.${p.visual}`);
        sprite = this.scene.add.image(0, 0, ref.texture, ref.frame).setOrigin(0.5, AGENT_FOOT_Y / AGENT_H);
        this.sprites.set(p.id, sprite);
      }
      const visible = !p.riding && !p.gone;
      sprite.setVisible(visible);
      if (!visible) continue;
      const x = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha;
      const y = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
      const s = this.iso.toScreen(x, y);
      // Petit décalage propre à chaque visiteur : le groupe ne se superpose pas
      let h = 0;
      for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      if (!p.leader) {
        s.x += ((h % 13) - 6) * 1.2;
        s.y += (((h >> 4) % 7) - 3) * 1.2;
      }
      sprite.setPosition(Math.round(s.x), Math.round(s.y)).setDepth(DEPTH.objects + (x + y - 1) * 10 + 6);
      if (p.leader && p.name && visit.phase !== 'leaving') {
        this.label.setText(p.name).setPosition(Math.round(s.x), Math.round(s.y) - AGENT_H - 2).setVisible(true);
      }
    }
  }

  destroy(): void {
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
    this.label.destroy();
  }
}
