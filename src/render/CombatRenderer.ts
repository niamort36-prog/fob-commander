/**
 * Rendu des combats : insurgés (interpolés), traçantes et flashs de départ, explosions d'obus
 * (flash, boule de feu, débris, fumée persistante, cratère), chutes ; tremblement de caméra.
 * Tous les effets sont éphémères et pilotés par les événements « combat:* » du bus.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { Id } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { AGENT_FOOT_Y, AGENT_H } from '../assets/spriteKeys';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './TerrainRenderer';

interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  born: number;
  friendly: boolean;
}

interface Blast {
  x: number;
  y: number;
  born: number;
  r: number;
}

interface Smoke {
  x: number;
  y: number;
  vx: number;
  born: number;
  life: number;
  r: number;
  dark: boolean;
}

interface Mark {
  x: number;
  y: number;
  born: number;
  life: number;
  kind: 'crater' | 'body';
  friendly: boolean;
}

const TRACER_MS = 140;
const BLAST_MS = 450;

export class CombatRenderer {
  private readonly enemies = new Map<Id, Phaser.GameObjects.Image>();
  private readonly fx: Phaser.GameObjects.Graphics;
  private readonly smokeG: Phaser.GameObjects.Graphics;
  private readonly marksG: Phaser.GameObjects.Graphics;
  private tracers: Tracer[] = [];
  private blasts: Blast[] = [];
  private smoke: Smoke[] = [];
  private marks: Mark[] = [];
  private readonly unsubs: (() => void)[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    this.marksG = scene.add.graphics().setDepth(DEPTH.zone + 2);
    this.smokeG = scene.add.graphics().setDepth(DEPTH.objects + 100001);
    this.fx = scene.add.graphics().setDepth(DEPTH.overlay - 4);
    const bus = ctx.bus;
    this.unsubs.push(
      bus.on('combat:shot', (e) => this.onShot(e)),
      bus.on('combat:impact', (e) => this.onImpact(e.x, e.y, e.radius)),
      bus.on('combat:death', (e) => this.marks.push({ x: e.x, y: e.y, born: performance.now(), life: 25000, kind: 'body', friendly: e.friendly })),
    );
  }

  private screen(x: number, y: number, z = 0): { x: number; y: number } {
    const p = this.iso.toScreen(x, y);
    return { x: p.x, y: p.y - z };
  }

  private onShot(e: { fromX: number; fromY: number; fromZ: number; toX: number; toY: number; toZ: number; hit: boolean; friendly: boolean }): void {
    const a = this.screen(e.fromX, e.fromY, e.fromZ);
    // Tir manqué : la traçante passe à côté et va plus loin
    const jx = e.hit ? 0 : (Math.random() - 0.5) * 1.6;
    const jy = e.hit ? 0 : (Math.random() - 0.5) * 1.6;
    const b = this.screen(e.toX + jx, e.toY + jy, e.toZ);
    if (this.tracers.length > 120) this.tracers.shift();
    this.tracers.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, born: performance.now(), friendly: e.friendly });
  }

  private onImpact(x: number, y: number, radius: number): void {
    const now = performance.now();
    const p = this.screen(x, y);
    this.blasts.push({ x: p.x, y: p.y, born: now, r: radius });
    for (let i = 0; i < 9; i++) {
      this.smoke.push({ x: p.x + (Math.random() - 0.5) * 30, y: p.y - Math.random() * 12, vx: (Math.random() - 0.3) * 0.012, born: now + i * 60, life: 3500 + Math.random() * 2500, r: 6 + Math.random() * 8, dark: i < 4 });
    }
    this.marks.push({ x, y, born: now, life: 60000, kind: 'crater', friendly: false });
    // Tremblement si l'impact est à l'écran
    const cam = this.scene.cameras.main;
    if (cam.worldView.contains(p.x, p.y)) cam.shake(220, 0.006 / Math.max(0.5, cam.zoom));
  }

  sync(alpha: number): void {
    const now = performance.now();
    this.syncEnemies(alpha);

    // Marques au sol : cratères et corps
    const m = this.marksG;
    m.clear();
    this.marks = this.marks.filter((k) => now - k.born < k.life);
    for (const k of this.marks) {
      const t = (now - k.born) / k.life;
      const p = this.screen(k.x, k.y);
      if (k.kind === 'crater') {
        m.fillStyle(0x2a241c, 0.55 * (1 - t));
        m.fillEllipse(p.x, p.y, 34, 15);
        m.fillStyle(0x15120d, 0.5 * (1 - t));
        m.fillEllipse(p.x, p.y, 16, 7);
      } else {
        m.fillStyle(k.friendly ? 0x4a5a32 : 0x3a3026, 0.9 * (1 - t));
        m.fillRect(p.x - 7, p.y - 3, 14, 5);
        m.fillStyle(0x6a1a12, 0.5 * (1 - t));
        m.fillEllipse(p.x + 3, p.y + 2, 14, 6);
      }
    }

    // Fumée
    const s = this.smokeG;
    s.clear();
    this.smoke = this.smoke.filter((p) => now - p.born < p.life);
    for (const p of this.smoke) {
      const age = now - p.born;
      if (age < 0) continue;
      const t = age / p.life;
      s.fillStyle(p.dark ? 0x3a3630 : 0x8a8478, 0.45 * (1 - t));
      s.fillCircle(p.x + p.vx * age, p.y - age * 0.012, p.r * (1 + t * 2.2));
    }

    // Traçantes, flashs, explosions
    const g = this.fx;
    g.clear();
    this.tracers = this.tracers.filter((tr) => now - tr.born < TRACER_MS);
    for (const tr of this.tracers) {
      const t = (now - tr.born) / TRACER_MS;
      const color = tr.friendly ? 0xffe08a : 0xff7a4a;
      // Segment lumineux qui se déplace du tireur vers la cible
      const h0 = Math.max(0, t - 0.35);
      const h1 = Math.min(1, t + 0.15);
      g.lineStyle(2, color, 0.9);
      g.lineBetween(tr.x0 + (tr.x1 - tr.x0) * h0, tr.y0 + (tr.y1 - tr.y0) * h0, tr.x0 + (tr.x1 - tr.x0) * h1, tr.y0 + (tr.y1 - tr.y0) * h1);
      if (t < 0.4) {
        g.fillStyle(0xfff2b0, 1 - t * 2.5);
        g.fillCircle(tr.x0, tr.y0, 3);
      }
    }
    this.blasts = this.blasts.filter((b) => now - b.born < BLAST_MS);
    for (const b of this.blasts) {
      const t = (now - b.born) / BLAST_MS;
      const r = 8 + t * 34 * b.r;
      g.fillStyle(0xfff4c0, Math.max(0, 0.9 - t * 2));
      g.fillCircle(b.x, b.y - 6, r * 0.6);
      g.fillStyle(0xff9a3a, Math.max(0, 0.8 - t));
      g.fillCircle(b.x, b.y - 10, r * 0.45);
      g.lineStyle(2, 0xffd27a, Math.max(0, 0.7 - t));
      g.strokeEllipse(b.x, b.y, r * 2, r);
      // Débris projetés
      g.fillStyle(0x2a241c, Math.max(0, 1 - t));
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8 + b.born;
        g.fillRect(b.x + Math.cos(a) * r * 1.1, b.y - 6 + Math.sin(a) * r * 0.5 - (1 - (2 * t - 1) ** 2) * 18, 2, 2);
      }
    }
  }

  private syncEnemies(alpha: number): void {
    const enemies = this.ctx.state.combat.enemies;
    for (const [id, s] of this.enemies) {
      if (!enemies[id]) {
        s.destroy();
        this.enemies.delete(id);
      }
    }
    for (const e of Object.values(enemies)) {
      let s = this.enemies.get(e.id);
      if (!s) {
        const ref = AssetLoader.resolve(`enemy.${e.defId}`);
        s = this.scene.add.image(0, 0, ref.texture, ref.frame).setOrigin(0.5, AGENT_FOOT_Y / AGENT_H);
        this.enemies.set(e.id, s);
      }
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha;
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha;
      const p = this.screen(x, y);
      s.setPosition(Math.round(p.x), Math.round(p.y)).setDepth(DEPTH.objects + (x + y - 1) * 10 + 6);
      s.setFlipX(e.state === 'retreat');
    }
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    for (const s of this.enemies.values()) s.destroy();
    this.enemies.clear();
    this.fx.destroy();
    this.smokeG.destroy();
    this.marksG.destroy();
  }
}
