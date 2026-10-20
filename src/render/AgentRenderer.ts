/**
 * Rendu des habitants : sprites interpolés entre deux ticks, masqués à l'intérieur des
 * bâtiments, placés sur la plate-forme des tours de garde ; anneau et trajet de l'agent
 * sélectionné ; marqueur d'alerte quand un besoin est critique.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { Agent, Id } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { AGENT_FOOT_Y, AGENT_H, AGENT_W, figureKey } from '../assets/spriteKeys';
import type { FigurePose } from '../assets/figureArt';
import { COURSE, WORKOUT } from '../assets/trainingLayout';
import { audio } from '../audio/AudioManager';
import { hexToInt } from '../assets/PlaceholderFactory';
import { BuildSystem } from '../systems/BuildSystem';
import { objectDepth } from './BuildingRenderer';
import type { IsoMath, Point } from './IsoMath';
import { DEPTH } from './TerrainRenderer';

interface Placement {
  visible: boolean;
  screen: Point; // position des pieds
  depth: number;
  /** Pixels masqués en bas du sprite (agent posté derrière un parapet). */
  hide?: number;
  /** Pose dessinée et élévation (tractions, escalade). */
  pose?: FigurePose;
  lift?: number;
  /** Tir au stand : départ du coup et point visé (écran). */
  muzzle?: { tx: number; ty: number; flash: boolean };
}

/** Hachage stable d'un identifiant (teinte de peau, décalages d'animation). */
function hashId(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export class AgentRenderer {
  private readonly sprites = new Map<Id, Phaser.GameObjects.Image>();
  private readonly overlay: Phaser.GameObjects.Graphics;
  private selectedId: Id | null = null;
  private hoverId: Id | null = null;
  /** Agents en exercice par bâtiment (ordre stable), recalculé à chaque image. */
  private exercising = new Map<Id, Id[]>();
  private readonly lastShot = new Map<Id, number>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    this.overlay = scene.add.graphics().setDepth(DEPTH.overlay - 1);
  }

  setSelected(id: Id | null): void {
    this.selectedId = id;
  }

  setHover(id: Id | null): void {
    this.hoverId = id;
  }

  /** Où et comment afficher l'agent (alpha = fraction du tick écoulée). */
  placement(a: Agent, alpha: number): Placement {
    const content = this.ctx.content;
    const act = a.activity;
    if (a.status !== 'on_base') return { visible: false, screen: { x: 0, y: 0 }, depth: 0 };
    if (act?.stage === 'acting') {
      const def = content.activity(act.id);
      const target = act.targetId ? this.ctx.state.fob.buildings[act.targetId] : undefined;
      if (def.inside && target) return { visible: false, screen: { x: 0, y: 0 }, depth: 0 };
      const svc = target && def.service ? content.building(target.defId).services?.[def.service] : undefined;
      const standZ = svc?.standZ;
      if (target && standZ !== undefined) {
        const bdef = content.building(target.defId);
        const [w, h] = BuildSystem.footprint(bdef, target.rot);
        const p = this.iso.toScreen(target.pos.x + w / 2, target.pos.y + h / 2);
        return { visible: true, screen: { x: p.x, y: p.y - standZ }, depth: objectDepth(bdef, target.pos.x, target.pos.y, w, h) + 1, hide: svc?.hidePx ?? 0 };
      }
    }
    if (act?.stage === 'acting' && act.targetId) {
      const ex = this.exercise(a, act.id, act.targetId);
      if (ex) return ex;
    }
    const x = a.prevPos.x + (a.pos.x - a.prevPos.x) * alpha;
    const y = a.prevPos.y + (a.pos.y - a.prevPos.y) * alpha;
    const p = this.iso.toScreen(x, y);
    const moving = a.pos.x !== a.prevPos.x || a.pos.y !== a.prevPos.y;
    const step = moving && this.ctx.state.time.speed > 0 && Math.floor((this.scene.time.now + (hashId(a.id) % 300)) / 170) % 2 === 0;
    return { visible: true, screen: p, depth: DEPTH.objects + (x + y - 1) * 10 + 6, pose: step ? 'walk' : 'stand' };
  }

  /**
   * Exercice visible sur une structure d'entraînement en plein air : tir couché sur le pas de
   * tir, course et escalade sur le parcours, tractions / pompes / squats à l'aire de musculation.
   */
  private exercise(a: Agent, activity: string, buildingId: Id): Placement | null {
    if (activity !== 'shoot' && activity !== 'drill' && activity !== 'workout') return null;
    const b = this.ctx.state.fob.buildings[buildingId];
    if (!b) return null;
    const def = this.ctx.content.building(b.defId);
    const [w, h] = BuildSystem.footprint(def, b.rot);
    const list = this.exercising.get(buildingId) ?? [a.id];
    const idx = Math.max(0, list.indexOf(a.id));
    const now = this.ctx.state.time.speed > 0 ? this.scene.time.now : 0;
    const phase = (hashId(a.id) % 1000) / 1000;
    const depth = objectDepth(def, b.pos.x, b.pos.y, w, h) + 1;
    const at = (gx: number, gy: number, pose: FigurePose, lift = 0): Placement => {
      const p = this.iso.toScreen(gx, gy);
      return { visible: true, screen: { x: p.x, y: p.y - lift }, depth: depth + (gx + gy) * 0.001, pose, lift };
    };
    if (activity === 'shoot') {
      // Couché sur le pas de tir, un couloir par tireur, face aux cibles
      const long = w >= h;
      const L = long ? w : h;
      const W = long ? h : w;
      const lane = (W * ((idx % 4) + 0.5)) / 4;
      const Q = (u: number, v: number) => (long ? { x: b.pos.x + u, y: b.pos.y + v } : { x: b.pos.x + v, y: b.pos.y + u });
      const me = Q(1.55, lane);
      const target = this.iso.toScreen(Q(L - 1.5, lane).x, Q(L - 1.5, lane).y);
      const cycle = (now / 1000) * 1.2 + phase * 3;
      const flash = cycle % 1 < 0.09;
      const pl = at(me.x, me.y, 'prone');
      pl.muzzle = { tx: target.x, ty: target.y - 9, flash };
      if (flash) {
        const n = Math.floor(cycle);
        if (this.lastShot.get(a.id) !== n) {
          this.lastShot.set(a.id, n);
          audio()?.play('shotFriendly', me.x, me.y, 0.35);
        }
      }
      return pl;
    }
    if (activity === 'drill') return this.drill(b, w, h, now, phase, idx, at);
    return this.workout(b, w, h, now, phase, idx, at);
  }

  /**
   * Parcours du combattant : le soldat suit l'itinéraire à travers les obstacles (trainingLayout) —
   * course, escalade du mur, équilibre sur la poutre, ramping sous le filet, saut de la fosse,
   * pas chassés dans les pneus — à son rythme, décalé de ses camarades.
   */
  private drill(b: { pos: { x: number; y: number } }, w: number, h: number, now: number, phase: number, idx: number, at: (gx: number, gy: number, pose: FigurePose, lift?: number) => Placement): Placement {
    const route = COURSE.route;
    const slow: Record<string, number> = { run: 1, climb: 0.3, beam: 0.55, crawl: 0.3, jump: 0.9, hop: 0.6 };
    const legs: { len: number; dur: number }[] = [];
    let total = 0;
    for (let k = 1; k < route.length; k++) {
      const len = Math.hypot((route[k].x - route[k - 1].x) * w, (route[k].y - route[k - 1].y) * h);
      const dur = len / (1.4 * slow[route[k].move]); // secondes
      legs.push({ len, dur });
      total += dur;
    }
    let t = ((now / 1000 + phase * total + idx * (total / 5)) % total + total) % total;
    let k = 0;
    while (k < legs.length - 1 && t > legs[k].dur) t -= legs[k++].dur;
    const u = Math.min(1, t / Math.max(0.001, legs[k].dur));
    const a = route[k];
    const z = route[k + 1];
    const gx = b.pos.x + (a.x + (z.x - a.x) * u) * w;
    const gy = b.pos.y + (a.y + (z.y - a.y) * u) * h;
    const stride = Math.floor(now / 150 + idx) % 2 === 0;
    switch (z.move) {
      case 'climb':
        // Monte jusqu'au sommet du mur puis redescend de l'autre côté
        return at(gx, gy, 'climb', COURSE.wall.z * Math.sin(u * Math.PI));
      case 'beam':
        return at(gx, gy, stride ? 'run' : 'run2', COURSE.beam.z);
      case 'crawl':
        return at(gx, gy, Math.floor(now / 260 + idx) % 2 === 0 ? 'pushdown' : 'pushup');
      case 'jump':
        return at(gx, gy, 'run', 7 * Math.sin(u * Math.PI));
      case 'hop':
        return at(gx, gy, stride ? 'run' : 'run2', 3 * Math.abs(Math.sin(u * Math.PI * 6)));
      default:
        return at(gx, gy, stride ? 'run' : 'run2');
    }
  }

  /**
   * Aire de musculation : chaque soldat prend un poste (tractions ×2, développé couché, squat,
   * pompes) ; les suivants font un footing autour de l'aire. Les mouvements alternent deux poses
   * dessinées pour l'exercice, sans faire flotter ni enfoncer le soldat dans le sol.
   */
  private workout(b: { pos: { x: number; y: number } }, w: number, h: number, now: number, phase: number, idx: number, at: (gx: number, gy: number, pose: FigurePose, lift?: number) => Placement): Placement {
    const L = WORKOUT;
    const X = (fx: number): number => b.pos.x + fx * w;
    const Y = (fy: number): number => b.pos.y + fy * h;
    const rep = (period: number): boolean => ((now / period + phase * 3) % 2 + 2) % 2 < 1;
    // Mains sur la barre : main gauche 2 px plus haut que le point d'ancrage (barre en diagonale)
    const hangLift = L.pullBar.z - 24;
    switch (idx) {
      case 0:
      case 1: {
        // Tractions : suspendu bras tendus, puis menton au-dessus de la barre (mains fixes)
        const up = rep(900);
        return at(X(L.pull[idx]), Y(L.pullBar.y) + 0.01, up ? 'pull' : 'hang', up ? hangLift + 4 : hangLift);
      }
      case 2:
        // Développé couché, allongé sur le banc
        return at(X((L.bench.x0 + L.bench.x1) / 2), Y(L.bench.y), rep(1100) ? 'bench' : 'benchdown', L.bench.seat - 2);
      case 3:
        return at(X(L.squat.x), Y(L.squat.y), rep(1200) ? 'squatup' : 'squat');
      case 4:
        return at(X(L.mat.x), Y(L.mat.y), rep(700) ? 'pushup' : 'pushdown');
      default: {
        // Footing autour de l'aire
        const t = (now / 9000 + phase + idx * 0.21) % 1;
        const ang = t * Math.PI * 2;
        const gx = b.pos.x + w / 2 + Math.cos(ang) * (w / 2 + 0.35);
        const gy = b.pos.y + h / 2 + Math.sin(ang) * (h / 2 + 0.35);
        return at(gx, gy, Math.floor(now / 150 + idx) % 2 === 0 ? 'run' : 'run2');
      }
    }
  }

  sync(alpha: number): void {
    const agents = this.ctx.state.agents;
    for (const [id, s] of this.sprites) {
      if (!agents[id]) {
        s.destroy();
        this.sprites.delete(id);
      }
    }
    const g = this.overlay;
    g.clear();
    // Qui s'exerce où (couloir de tir, poste de musculation…)
    this.exercising.clear();
    for (const a of Object.values(agents)) {
      const act = a.activity;
      if (!act || act.stage !== 'acting' || !act.targetId || (act.id !== 'shoot' && act.id !== 'drill' && act.id !== 'workout')) continue;
      const list = this.exercising.get(act.targetId) ?? [];
      list.push(a.id);
      this.exercising.set(act.targetId, list);
    }
    for (const list of this.exercising.values()) list.sort();
    const zoom = this.scene.cameras.main.zoom;
    for (const a of Object.values(agents)) {
      let sprite = this.sprites.get(a.id);
      const skin = a.defId === 'auxiliary' ? 1 + (hashId(a.id) % 2) : hashId(a.id) % 3;
      if (!sprite) {
        const ref = AssetLoader.resolve(figureKey(a.defId, 'stand', skin));
        sprite = this.scene.add.image(0, 0, ref.texture, ref.frame).setOrigin(0.5, AGENT_FOOT_Y / AGENT_H);
        this.sprites.set(a.id, sprite);
      }
      const pl = this.placement(a, alpha);
      sprite.setVisible(pl.visible);
      if (!pl.visible) continue;
      const ref = AssetLoader.resolve(figureKey(a.defId, pl.pose ?? 'stand', skin));
      if (sprite.texture.key !== ref.texture || (ref.frame !== undefined && sprite.frame.name !== ref.frame)) sprite.setTexture(ref.texture, ref.frame);
      sprite.setPosition(Math.round(pl.screen.x), Math.round(pl.screen.y)).setDepth(pl.depth);
      // Tireur couché tourné vers ses cibles (la silhouette regarde vers la gauche)
      const faceRight = pl.muzzle ? pl.muzzle.tx > pl.screen.x : false;
      sprite.setFlipX(faceRight);
      if (pl.muzzle) {
        // Départ du coup et traceuse vers la cible
        const mx = pl.screen.x + (faceRight ? 8 : -8);
        const my = pl.screen.y - 4;
        if (pl.muzzle.flash) {
          g.fillStyle(0xffe08a, 1);
          g.fillRect(mx - 1, my - 1, 3, 3);
          g.lineStyle(1, 0xffe8a0, 0.55);
          g.lineBetween(mx, my, pl.muzzle.tx, pl.muzzle.ty);
        }
      }
      // Insigne de rôle (couleur propre à chaque spécialité) au-dessus de la tête
      const badge = this.ctx.content.personnel(a.defId).visual.badge;
      if (badge && zoom >= 0.7 && !['prone', 'pushup', 'pushdown', 'bench', 'benchdown'].includes(pl.pose ?? '')) {
        const bx = pl.screen.x + 6;
        const by = pl.screen.y - AGENT_FOOT_Y - 1;
        g.fillStyle(0x1a1a14, 0.9);
        g.fillRect(bx - 2, by - 2, 5, 5);
        g.fillStyle(hexToInt(badge), 1);
        g.fillRect(bx - 1, by - 1, 3, 3);
      }
      // Posté derrière un parapet : seul le haut du corps dépasse des sacs de sable
      if (pl.hide) sprite.setCrop(0, 0, AGENT_W, AGENT_FOOT_Y - pl.hide);
      else if (sprite.isCropped) sprite.setCrop();
      if (a.id === this.hoverId && a.id !== this.selectedId) sprite.setTint(0xfff6d0);
      else sprite.clearTint();

      if (a.id === this.selectedId) {
        g.lineStyle(1, 0xfff0a8, 1);
        g.strokeEllipse(pl.screen.x, pl.screen.y, 18, 8);
        this.drawPath(a);
      }
      if (a.activity?.carry) this.drawLoad(g, pl.screen.x, pl.screen.y, a.activity.carry.resource);
      else if (a.activity?.id === 'fetch_materials' && (a.activity.materials ?? 0) > 0) {
        // Planches portées sur l'épaule
        g.lineStyle(3, 0x8a6a3a, 1);
        g.lineBetween(pl.screen.x - 9, pl.screen.y - 25, pl.screen.x + 8, pl.screen.y - 19);
        g.lineStyle(1, 0xc49a5c, 1);
        g.lineBetween(pl.screen.x - 9, pl.screen.y - 26, pl.screen.x + 8, pl.screen.y - 20);
      }
      if (this.ctx.sim.agents.criticalNeeds(a).length > 0) {
        // Losange rouge au-dessus de la tête
        const hx = pl.screen.x;
        const hy = pl.screen.y - AGENT_FOOT_Y - 4;
        g.fillStyle(0xd0644a, 1);
        g.fillPoints([{ x: hx, y: hy - 4 }, { x: hx + 3, y: hy }, { x: hx, y: hy + 4 }, { x: hx - 3, y: hy }], true);
      }
    }
  }

  /** Charge portée devant le torse, selon son contenu. */
  private drawLoad(g: Phaser.GameObjects.Graphics, x: number, y: number, resource: string): void {
    const bx = x - 4;
    const by = y - 17;
    switch (resource) {
      case 'ammo':
        // Caisse à munitions vert olive, poignée
        g.fillStyle(0x56603a, 1).fillRect(bx, by + 1, 8, 5);
        g.fillStyle(0x2c3020, 1).fillRect(bx + 3, by, 2, 1);
        g.fillStyle(0xd8c04a, 1).fillRect(bx + 1, by + 3, 3, 1);
        break;
      case 'fuel':
        // Un jerrican à chaque main, au bout des bras
        for (const jx of [x - 9, x + 5]) {
          g.fillStyle(0x2c3020, 1).fillRect(jx, y - 14, 4, 8);
          g.fillStyle(0x6a7a44, 1).fillRect(jx + 1, y - 13, 2, 6);
        }
        break;
      case 'medical':
        g.fillStyle(0xe4e0d4, 1).fillRect(bx, by, 8, 6);
        g.fillStyle(0xc0302a, 1).fillRect(bx + 3, by + 1, 2, 4).fillRect(bx + 2, by + 2, 4, 2);
        break;
      case 'water':
        g.fillStyle(0x4f7ea0, 1).fillRect(bx + 1, by - 1, 6, 7);
        g.fillStyle(0x2a4a60, 1).fillRect(bx + 3, by - 2, 2, 1);
        break;
      case 'parts':
        g.fillStyle(0x7a7a72, 1).fillRect(bx, by + 1, 8, 5);
        g.fillStyle(0x4a4a44, 1).fillRect(bx + 1, by + 2, 6, 1);
        break;
      default:
        // Caisse de rations en carton
        g.fillStyle(0x9c7e4e, 1).fillRect(bx, by, 8, 6);
        g.lineStyle(1, 0x5a4628, 1).strokeRect(bx, by, 8, 6);
        g.fillStyle(0x5a4628, 1).fillRect(bx, by + 2, 8, 1);
    }
  }

  private drawPath(a: Agent): void {
    if (a.path.length === 0) return;
    const g = this.overlay;
    g.lineStyle(1, 0xfff0a8, 0.5);
    let prev = this.iso.toScreen(a.pos.x, a.pos.y);
    for (const c of a.path) {
      const p = this.iso.toScreen(c.x + 0.5, c.y + 0.5);
      g.lineBetween(prev.x, prev.y, p.x, p.y);
      prev = p;
    }
    g.fillStyle(0xfff0a8, 0.8);
    g.fillCircle(prev.x, prev.y, 2);
  }

  /** Agent visible sous un point du monde (le plus en avant), ou null. */
  pick(worldX: number, worldY: number): Id | null {
    let best: Id | null = null;
    let bestDepth = -Infinity;
    for (const [id, s] of this.sprites) {
      if (!s.visible) continue;
      const left = s.x - AGENT_W / 2 - 2;
      const top = s.y - AGENT_FOOT_Y - 2;
      if (worldX >= left && worldX <= left + AGENT_W + 4 && worldY >= top && worldY <= top + AGENT_H + 2 && s.depth > bestDepth) {
        best = id;
        bestDepth = s.depth;
      }
    }
    return best;
  }

  destroy(): void {
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
    this.overlay.destroy();
  }
}
