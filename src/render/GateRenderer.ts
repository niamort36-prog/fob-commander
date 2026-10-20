/**
 * Battants des portes et portails, animés : ils s'ouvrent quand un soldat ou un véhicule ami
 * approche et se referment derrière lui (pendant une attaque, ils restent fermés sauf passage).
 * Une porte piétonne a un battant, un portail deux battants qui s'ouvrent vers l'intérieur.
 */
import Phaser from 'phaser';
import type { BuildingDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { BuildingInstance, Id } from '../core/GameState';
import { gateAlongX, hexToInt, shade } from '../assets/PlaceholderFactory';
import { BuildSystem } from '../systems/BuildSystem';
import type { IsoMath } from './IsoMath';
import { objectDepth } from './depth';

/** Durée d'ouverture complète (ms). */
const OPEN_MS = 700;

interface GateView {
  g: Phaser.GameObjects.Graphics;
  open: number;
}

export class GateRenderer {
  private readonly views = new Map<Id, GateView>();
  private last = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {}

  /** Quelqu'un d'ami à proximité de la porte (soldat dehors, véhicule au sol). */
  private someoneNear(b: BuildingInstance, def: BuildingDef): boolean {
    const [w, h] = BuildSystem.footprint(def, b.rot);
    const cx = b.pos.x + w / 2;
    const cy = b.pos.y + h / 2;
    for (const a of Object.values(this.ctx.state.agents)) {
      if (a.status !== 'on_base' || (a.activity?.stage === 'acting' && a.activity.targetId)) continue;
      if (Math.hypot(a.pos.x - cx, a.pos.y - cy) <= 1.4) return true;
    }
    if (def.gate?.vehicles) {
      for (const v of Object.values(this.ctx.state.vehicles)) {
        if (v.altitude > 0 || v.state === 'away') continue;
        if (Math.hypot(v.pos.x - cx, v.pos.y - cy) <= 2.4) return true;
      }
    }
    return false;
  }

  sync(time: number): void {
    const dt = this.last ? Math.min(100, time - this.last) : 16;
    this.last = time;
    const paused = this.ctx.state.time.speed === 0;
    const buildings = this.ctx.state.fob.buildings;
    for (const [id, v] of this.views) {
      if (!buildings[id]) {
        v.g.destroy();
        this.views.delete(id);
      }
    }
    for (const b of Object.values(buildings)) {
      const def = this.ctx.content.building(b.defId);
      if (!def.gate) continue;
      let v = this.views.get(b.id);
      if (!v) {
        v = { g: this.scene.add.graphics(), open: 0 };
        this.views.set(b.id, v);
      }
      const want = b.state !== 'construction' && this.someoneNear(b, def) ? 1 : 0;
      if (!paused) v.open += Math.sign(want - v.open) * Math.min(Math.abs(want - v.open), dt / OPEN_MS);
      this.draw(v, b, def);
    }
  }

  private draw(v: GateView, b: BuildingInstance, def: BuildingDef): void {
    const g = v.g;
    g.clear();
    const [w, h] = BuildSystem.footprint(def, b.rot);
    g.setDepth(objectDepth(def, b.pos.x, b.pos.y, w, h) + 0.5);
    if (b.state === 'construction') g.setAlpha(0.35 + 0.45 * b.buildProgress);
    else g.setAlpha(1);
    const alongX = gateAlongX(def, b.rot);
    const H = def.visual.height * 0.78;
    const p = 0.24;
    const L = (alongX ? w : h) - 2 * p; // largeur du passage
    const leaves = def.gate!.leaves;
    const leafLen = L / leaves;
    const ang = v.open * (Math.PI / 2) * 0.92; // ouverture vers l'intérieur (côté +y / +x)
    const metal = hexToInt(def.visual.accent ?? '#5f6152');
    const damaged = b.wear > 0.5;
    // Point (le long du mur u, en travers t, altitude z) → écran
    const S = (u: number, t: number, z: number): { x: number; y: number } => {
      const gx = alongX ? b.pos.x + u : b.pos.x + 0.5 + t;
      const gy = alongX ? b.pos.y + 0.5 + t : b.pos.y + u;
      const s = this.iso.toScreen(gx, gy);
      return { x: s.x, y: s.y - z };
    };
    const leaf = (hingeU: number, dir: 1 | -1): void => {
      // Battant : du gond vers le centre du passage, pivotant de « ang »
      const endU = hingeU + dir * Math.cos(ang) * leafLen;
      const endT = Math.sin(ang) * leafLen;
      const pts = [S(hingeU, 0, 1), S(endU, endT, 1), S(endU, endT, H), S(hingeU, 0, H)];
      g.fillStyle(shade(metal, damaged ? 0.7 : 1), 0.95);
      g.fillPoints(pts, true);
      g.lineStyle(1, shade(metal, 0.5), 1);
      g.strokePoints(pts, true);
      // Grillage et renforts en Z
      g.lineStyle(1, shade(metal, 1.35), 0.55);
      const mid = (k: number): { x: number; y: number } => S(hingeU + dir * Math.cos(ang) * leafLen * k, Math.sin(ang) * leafLen * k, 1);
      for (const k of [0.33, 0.66]) {
        const a = mid(k);
        g.lineBetween(a.x, a.y, a.x, a.y - (H - 1));
      }
      g.lineStyle(1, shade(metal, 0.65), 0.9);
      const a = S(hingeU, 0, H * 0.15);
      const c = S(endU, endT, H * 0.85);
      g.lineBetween(a.x, a.y, c.x, c.y);
      // Bosses et traces de coups si la porte a été attaquée
      if (damaged) {
        const d = S(hingeU + dir * Math.cos(ang) * leafLen * 0.5, Math.sin(ang) * leafLen * 0.5, H * 0.5);
        g.fillStyle(0x2a2a26, 0.9);
        g.fillRect(Math.round(d.x) - 1, Math.round(d.y) - 1, 3, 2);
      }
    };
    if (leaves === 1) leaf(p, 1);
    else {
      leaf(p, 1);
      leaf(p + L, -1);
    }
  }

  destroy(): void {
    for (const v of this.views.values()) v.g.destroy();
    this.views.clear();
  }
}
