/**
 * Rendu du point de contrôle : civils à pied (interpolés entre deux ticks) avec une étiquette
 * « Fouille… » pendant le contrôle et « Arrêté » quand une menace est démasquée, et équipement
 * visible du poste de garde amélioré :
 *  - niveau 2 : blocs de béton en chicane devant la guérite, herse à clous au sol ;
 *  - niveau 3 : barrière levante rouge et blanche (animée), miroir d'inspection et projecteur.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { BuildingInstance, Id } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { AGENT_FOOT_Y, AGENT_H } from '../assets/spriteKeys';
import { t } from '../utils/i18n';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './TerrainRenderer';
import { objectDepth } from './depth';

/** Durée de levée complète de la barrière (ms). */
const ARM_MS = 900;

interface PostView {
  g: Phaser.GameObjects.Graphics;
  arm: number;
}

export class CheckpointRenderer {
  private readonly sprites = new Map<Id, Phaser.GameObjects.Image>();
  private readonly labels = new Map<Id, Phaser.GameObjects.Text>();
  private readonly posts = new Map<Id, PostView>();
  private last = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {}

  sync(alpha: number, time: number): void {
    const dt = this.last ? Math.min(100, time - this.last) : 16;
    this.last = time;
    this.syncEntrants(alpha);
    this.syncPosts(dt);
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

  // ------------------------------------------------------------ Équipement du poste

  private syncPosts(dt: number): void {
    const s = this.ctx.state;
    const paused = s.time.speed === 0;
    for (const [id, v] of this.posts) {
      if (!s.fob.buildings[id]) {
        v.g.destroy();
        this.posts.delete(id);
      }
    }
    for (const b of Object.values(s.fob.buildings)) {
      const def = this.ctx.content.building(b.defId);
      if (!def.checkpoint) continue;
      let v = this.posts.get(b.id);
      if (!v) {
        v = { g: this.scene.add.graphics(), arm: 0 };
        this.posts.set(b.id, v);
      }
      const want = this.passing(b) ? 1 : 0;
      if (!paused) v.arm += Math.sign(want - v.arm) * Math.min(Math.abs(want - v.arm), dt / ARM_MS);
      this.drawPost(v, b);
    }
  }

  /** Quelqu'un franchit le contrôle : civil autorisé qui entre ou sort, véhicule de la base. */
  private passing(b: BuildingInstance): boolean {
    const cx = b.pos.x + 0.5;
    const cy = b.pos.y + 0.5;
    for (const e of this.ctx.state.checkpoint?.entrants ?? []) {
      if ((e.phase === 'inside' || e.phase === 'leaving') && Math.hypot(e.pos.x - cx, e.pos.y - cy) < 3) return true;
    }
    for (const v of Object.values(this.ctx.state.vehicles)) {
      if (v.altitude > 0 || v.civilian) continue;
      if (Math.hypot(v.pos.x - cx, v.pos.y - cy) < 2.5) return true;
    }
    return false;
  }

  private drawPost(v: PostView, b: BuildingInstance): void {
    const g = v.g;
    g.clear();
    const def = this.ctx.content.building(b.defId);
    g.setDepth(objectDepth(def, b.pos.x, b.pos.y, 1, 1) + 0.6);
    g.setAlpha(b.state === 'construction' ? 0.4 : 1);
    if (b.level < 2) return;
    // Côté extérieur : vers l'entrée de la base (axe dominant)
    const entry = this.ctx.state.fob.entry;
    const ex = entry.x - (b.pos.x + 0.5);
    const ey = entry.y - (b.pos.y + 0.5);
    const alongX = Math.abs(ex) < Math.abs(ey); // la barrière barre la voie le long de x
    const out = alongX ? Math.sign(ey) || -1 : Math.sign(ex) || -1;
    // Repère local : u = le long de la voie barrée, w = vers l'extérieur
    const S = (u: number, w: number, z: number): { x: number; y: number } => {
      const gx = alongX ? b.pos.x + 0.5 + u : b.pos.x + 0.5 + w * out;
      const gy = alongX ? b.pos.y + 0.5 + w * out : b.pos.y + 0.5 + u;
      const p = this.iso.toScreen(gx, gy);
      return { x: p.x, y: p.y - z };
    };
    // Point de la grille (gx, gy) relatif au poste → écran
    const G = (gx: number, gy: number, z: number): { x: number; y: number } => {
      const p = this.iso.toScreen(b.pos.x + gx, b.pos.y + gy);
      return { x: p.x, y: p.y - z };
    };
    const block = (u: number, w: number): void => {
      // Bloc de béton (« jersey ») plein : rectangle de la grille, faces visibles +x / +y et dessus
      const lu = 0.3;
      const lw = 0.12;
      const cx = alongX ? 0.5 + u : 0.5 + w * out;
      const cy = alongX ? 0.5 + w * out : 0.5 + u;
      const hx = alongX ? lu : lw;
      const hy = alongX ? lw : lu;
      const x0 = cx - hx;
      const x1 = cx + hx;
      const y0 = cy - hy;
      const y1 = cy + hy;
      const h = 8;
      g.fillStyle(0xa9a496, 1);
      g.fillPoints([G(x0, y1, 0), G(x1, y1, 0), G(x1, y1, h), G(x0, y1, h)], true);
      g.fillStyle(0x8f8a7d, 1);
      g.fillPoints([G(x1, y0, 0), G(x1, y1, 0), G(x1, y1, h), G(x1, y0, h)], true);
      g.fillStyle(0xd2cdbe, 1);
      g.fillPoints([G(x0, y0, h), G(x1, y0, h), G(x1, y1, h), G(x0, y1, h)], true);
      g.lineStyle(1, 0x5e5b52, 0.7);
      g.strokePoints([G(x0, y1, 0), G(x1, y1, 0), G(x1, y0, 0), G(x1, y0, h), G(x0, y0, h), G(x0, y1, h)], true);
      // Bande réfléchissante orange
      g.lineStyle(1, 0xe0902a, 1);
      const a = G(x0 + 0.04, y1, 4);
      const c = G(x1, y1, 4);
      const d = G(x1, y0 + 0.04, 4);
      g.lineBetween(a.x, a.y, c.x, c.y);
      g.lineBetween(c.x, c.y, d.x, d.y);
    };
    // Chicane : deux blocs décalés devant la guérite, de part et d'autre de la voie
    block(-0.6, 0.85);
    block(0.6, 1.35);
    if (b.level < 3) return;
    // Barrière levante : poteau au coin extérieur de la guérite, bras rouge et blanc
    const post = S(0.45, 0.55, 0);
    const pivot = S(0.45, 0.55, 9);
    g.fillStyle(0x3a3a34, 1);
    g.fillRect(Math.round(post.x) - 2, Math.round(pivot.y), 4, Math.round(post.y - pivot.y));
    g.fillStyle(0xd8d0bc, 1);
    g.fillRect(Math.round(pivot.x) - 3, Math.round(pivot.y) - 2, 6, 4);
    const ang = v.arm * (Math.PI / 2) * 0.9;
    const len = 1.6;
    const tipU = 0.45 - Math.cos(ang) * len;
    const tipZ = 9 + Math.sin(ang) * len * 22;
    const segs = 6;
    for (let k = 0; k < segs; k++) {
      const a0 = k / segs;
      const a1 = (k + 1) / segs;
      const p0 = S(0.45 + (tipU - 0.45) * a0, 0.55, 9 + (tipZ - 9) * a0);
      const p1 = S(0.45 + (tipU - 0.45) * a1, 0.55, 9 + (tipZ - 9) * a1);
      g.lineStyle(2, k % 2 ? 0xf0ece0 : 0xc0302a, 1);
      g.lineBetween(p0.x, p0.y, p1.x, p1.y);
    }
    // Miroir d'inspection posé contre la guérite
    const m0 = S(-0.45, 0.6, 0);
    const m1 = S(-0.45, 0.6, 7);
    g.lineStyle(1, 0x3a3a34, 1);
    g.lineBetween(m0.x, m0.y, m1.x, m1.y);
    g.fillStyle(0x9fc2d0, 1);
    g.fillEllipse(m1.x, m1.y - 1, 5, 3);
    // Projecteur sur mât
    const l0 = S(-0.6, 0.15, 0);
    const l1 = S(-0.6, 0.15, 30);
    g.lineStyle(1, 0x4a4a42, 1);
    g.lineBetween(l0.x, l0.y, l1.x, l1.y);
    g.fillStyle(0x2f2f2a, 1);
    g.fillRect(Math.round(l1.x) - 2, Math.round(l1.y) - 2, 5, 3);
    g.fillStyle(0xfff2b0, 1);
    g.fillRect(Math.round(l1.x) - 1, Math.round(l1.y) - 1, 3, 1);
  }

  destroy(): void {
    for (const s of this.sprites.values()) s.destroy();
    for (const l of this.labels.values()) l.destroy();
    for (const v of this.posts.values()) v.g.destroy();
    this.sprites.clear();
    this.labels.clear();
    this.posts.clear();
  }
}
