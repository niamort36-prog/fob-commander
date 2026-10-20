/**
 * Rendu du point de contrôle : civils à pied (interpolés entre deux ticks) avec une étiquette
 * « Fouille… » pendant le contrôle et « Arrêté » quand une menace est démasquée.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { Id } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { AGENT_FOOT_Y, AGENT_H } from '../assets/spriteKeys';
import { t } from '../utils/i18n';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './TerrainRenderer';


export class CheckpointRenderer {
  private readonly sprites = new Map<Id, Phaser.GameObjects.Image>();
  private readonly labels = new Map<Id, Phaser.GameObjects.Text>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {}

  sync(alpha: number): void {
    this.syncEntrants(alpha);
  }

  // ------------------------------------------------------------ Civils

  private syncEntrants(alpha: number): void {
    const entrants = this.ctx.state.checkpoint?.entrants ?? [];
    const live = new Set(entrants.map((e) => e.id));
    for (const [id, s] of this.sprites) {
      if (!live.has(id)) {
        s.destroy();
        this.sprites.delete(id);
      }
    }
    for (const [id, l] of this.labels) {
      if (!live.has(id)) {
        l.destroy();
        this.labels.delete(id);
      }
    }
    const placed: { x: number; y: number }[] = [];
    for (const e of entrants) {
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha;
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha;
      const s = this.iso.toScreen(x, y);
      // Petit décalage propre à chacun : la file d'attente au poste ne se superpose pas
      if (!e.vehicleId) {
        let h = 0;
        for (const c of e.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        s.x += ((h % 11) - 5) * 1.6;
        s.y += (((h >> 4) % 5) - 2) * 1.2;
      }
      // À pied : silhouette ; en véhicule : le conducteur reste à bord
      let topY = s.y - 26;
      if (!e.vehicleId) {
        let sprite = this.sprites.get(e.id);
        if (!sprite) {
          const ref = AssetLoader.resolve(`visitor.${e.visual}`);
          sprite = this.scene.add.image(0, 0, ref.texture, ref.frame).setOrigin(0.5, AGENT_FOOT_Y / AGENT_H);
          this.sprites.set(e.id, sprite);
        }
        sprite.setPosition(Math.round(s.x), Math.round(s.y)).setDepth(DEPTH.objects + (x + y - 1) * 10 + 6);
        // Arrêté : à genoux, mains sur la tête (silhouette tassée)
        sprite.setScale(1, e.phase === 'detained' ? 0.72 : 1);
        topY = s.y - AGENT_H * (e.phase === 'detained' ? 0.72 : 1);
      }
      const text = e.phase === 'search' ? t('cp.searching') : e.phase === 'detained' ? t('cp.detained') : '';
      let label = this.labels.get(e.id);
      if (!text) {
        label?.setVisible(false);
        continue;
      }
      if (!label) {
        label = this.scene.add
          .text(0, 0, '', { fontFamily: 'VT323, monospace', fontSize: '13px', color: '#fff3c4', stroke: '#1a1a14', strokeThickness: 3 })
          .setOrigin(0.5, 1)
          .setDepth(DEPTH.overlay - 3);
        this.labels.set(e.id, label);
      }
      // Étiquettes empilées quand plusieurs personnes attendent au même endroit
      let ly = Math.round(topY) - 2;
      while (placed.some((q) => Math.abs(q.x - s.x) < 30 && Math.abs(q.y - ly) < 12)) ly -= 12;
      placed.push({ x: s.x, y: ly });
      label
        .setText(text)
        .setColor(e.phase === 'detained' ? '#ff8a6a' : '#fff3c4')
        .setPosition(Math.round(s.x), ly)
        .setVisible(true);
    }
  }

  destroy(): void {
    for (const s of this.sprites.values()) s.destroy();
    for (const l of this.labels.values()) l.destroy();
    this.sprites.clear();
    this.labels.clear();
  }
}
