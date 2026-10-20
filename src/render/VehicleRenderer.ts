/**
 * Rendu des véhicules : sprites orientés selon le déplacement (4 orientations, interpolés entre
 * deux ticks), léger tressautement en roulant, poussière hors route ; hélicoptère en altitude
 * avec ombre portée, rotor principal et rotor de queue animés ; sélection et survol.
 */
import Phaser from 'phaser';
import type { GameContext } from '../core/GameContext';
import type { VehicleDef } from '../core/ContentTypes';
import { hourAt, isNightHour } from '../systems/modules';
import type { Id, Vehicle } from '../core/GameState';
import { AssetLoader } from '../assets/AssetLoader';
import { vehicleGeometry, vehicleKey } from '../assets/spriteKeys';
import type { IsoMath, Point } from './IsoMath';
import { DEPTH } from './TerrainRenderer';

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  born: number;
  life: number;
  /** Fumée d'échappement (grise, monte) plutôt que poussière (beige). */
  smoke?: boolean;
}

const MAX_PUFFS = 220;
const ROTOR_RADIUS = 1.45; // cases
const HUB_Z = 28; // px au-dessus du fuselage posé
const HUB_U = 1.75; // position du moyeu le long du fuselage
const TAIL_U = 0.12;
const TAIL_Z = 24;

export class VehicleRenderer {
  private readonly sprites = new Map<Id, Phaser.GameObjects.Image>();
  private readonly shadows: Phaser.GameObjects.Graphics;
  private readonly dust: Phaser.GameObjects.Graphics;
  private readonly overlay: Phaser.GameObjects.Graphics;
  private readonly puffs: Puff[] = [];
  private readonly lastPuff = new Map<Id, number>();
  private selectedId: Id | null = null;
  private hoverId: Id | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    this.shadows = scene.add.graphics().setDepth(DEPTH.zone + 1);
    this.dust = scene.add.graphics().setDepth(DEPTH.objects + 100000);
    this.overlay = scene.add.graphics().setDepth(DEPTH.overlay - 2);
  }

  setSelected(id: Id | null): void {
    this.selectedId = id;
  }

  setHover(id: Id | null): void {
    this.hoverId = id;
  }

  /** Point local du véhicule (u le long, depuis l'arrière) → coordonnées de grille. */
  private localToGrid(v: Vehicle, x: number, y: number, u: number, length: number): { gx: number; gy: number } {
    const along = (v.flip ? length - u : u) - length / 2;
    return v.axis === 0 ? { gx: x + along, gy: y } : { gx: x, gy: y + along };
  }

  sync(alpha: number, timeMs: number): void {
    const vehicles = this.ctx.state.vehicles;
    for (const [id, s] of this.sprites) {
      if (!vehicles[id]) {
        s.destroy();
        this.sprites.delete(id);
        this.lastPuff.delete(id);
      }
    }
    this.shadows.clear();
    this.overlay.clear();
    const paused = this.ctx.state.time.speed === 0;

    for (const v of Object.values(vehicles)) {
      const def = this.ctx.content.vehicle(v.defId);
      const air = def.kind === 'air' || def.kind === 'plane';
      const length = def.visual.length ?? 2;
      const ref = AssetLoader.resolve(vehicleKey(v.defId, v.axis, v.flip));
      let sprite = this.sprites.get(v.id);
      if (!sprite) {
        sprite = this.scene.add.image(0, 0, ref.texture, ref.frame);
        this.sprites.set(v.id, sprite);
      } else if (sprite.texture.key !== ref.texture || (ref.frame !== undefined && sprite.frame.name !== ref.frame)) {
        sprite.setTexture(ref.texture, ref.frame);
      }

      sprite.setVisible(v.state !== 'away');
      if (v.state === 'away') continue;
      const x = v.prevPos.x + (v.pos.x - v.prevPos.x) * alpha;
      const y = v.prevPos.y + (v.pos.y - v.prevPos.y) * alpha;
      const moving = !paused && (v.pos.x !== v.prevPos.x || v.pos.y !== v.prevPos.y);
      const geo = vehicleGeometry(v.axis, length, def.visual.height ?? 24, this.iso.tileW, this.iso.tileH, def.visual.width ?? 1);
      const corner = this.iso.toScreen(x - geo.w / 2, y - geo.h / 2);
      const depth = DEPTH.objects + (x + y - 1) * 10 + 7;
      // Tressautement d'un pixel en roulant (pas pour l'hélicoptère en vol)
      const bob = moving && !air && Math.floor(timeMs / 110) % 2 === 0 ? -1 : 0;
      sprite.setOrigin(geo.originX, geo.originY).setPosition(Math.round(corner.x), Math.round(corner.y - v.altitude + bob));
      sprite.setDepth(air && v.altitude > 4 ? DEPTH.overlay - 3 : depth);

      if (def.kind === 'air') this.drawHelicopterExtras(v, def, x, y, length, timeMs, paused);
      else if (def.kind === 'plane') this.drawPlaneExtras(v, x, y, length, def.visual.width ?? 1, timeMs, paused);
      if (moving && !air) this.emitDust(v, x, y, length, timeMs);
      if (!air && !paused) this.emitExhaust(v, def, x, y, length, timeMs, moving);
      this.drawLights(v, def, x, y, length, timeMs, moving);

      if (v.id === this.hoverId && v.id !== this.selectedId) sprite.setTint(0xfff6d0);
      else sprite.clearTint();
      if (v.id === this.selectedId) {
        const c = this.iso.toScreen(x, y);
        this.overlay.lineStyle(1, 0xfff0a8, 1);
        this.overlay.strokeEllipse(c.x, c.y, 34 * length + 14, 16 * length + 10);
      }
    }
    this.drawDust(timeMs);
  }

  private drawHelicopterExtras(v: Vehicle, def: VehicleDef, x: number, y: number, length: number, timeMs: number, paused: boolean): void {
    const iso = this.iso;
    // Ombre : empreinte du fuselage projetée au sol, plus petite et pâle en altitude
    const k = 1 - Math.min(0.45, v.altitude / 180);
    const half = (length / 2) * k;
    const w = 0.32 * k;
    const corners: Point[] = (v.axis === 0
      ? [[x - half, y - w], [x + half, y - w], [x + half, y + w], [x - half, y + w]]
      : [[x - w, y - half], [x + w, y - half], [x + w, y + half], [x - w, y + half]]
    ).map(([gx, gy]) => iso.toScreen(gx, gy));
    this.shadows.fillStyle(0x000000, 0.28 * k);
    this.shadows.fillPoints(corners, true);
    const rc = iso.toScreen(x, y);
    // Rotor arrêté quand l'appareil de la base est posé sur son hélisurface
    const spin = paused || v.state === 'idle' ? 0 : v.altitude > 0 || v.state !== 'unloading' ? 1 : 0.35;
    const rotors = def.visual.rotors ?? [{ u: HUB_U, z: HUB_Z, radius: ROTOR_RADIUS, blades: 4 }];
    rotors.forEach((r, ri) => {
      const hub = this.localToGrid(v, x, y, r.u, length);
      const hubScreen = iso.toScreen(hub.gx, hub.gy);
      this.shadows.fillStyle(0x000000, 0.08 * k);
      this.shadows.fillEllipse(hubScreen.x, hubScreen.y, r.radius * 2 * 45 * k, r.radius * 2 * 22 * k);
      // Pales dans le plan horizontal, projetées en isométrique ; rotors en tandem contrarotatifs
      const dir = ri % 2 === 0 ? 1 : -1;
      const angle = ((dir * timeMs) / 45) * spin + ri * 0.6;
      const hz = hubScreen.y - v.altitude - r.z;
      this.overlay.lineStyle(2, 0x2b2a24, spin > 0 ? 0.55 : 0.85);
      for (let b = 0; b < r.blades; b++) {
        const a = angle + (b * Math.PI * 2) / r.blades;
        const tip = iso.toScreen(hub.gx + Math.cos(a) * r.radius, hub.gy + Math.sin(a) * r.radius);
        this.overlay.lineBetween(hubScreen.x, hz, tip.x, tip.y - v.altitude - r.z);
      }
      if (spin > 0) {
        // Disque flou du rotor
        this.overlay.lineStyle(1, 0x2b2a24, 0.18);
        const ring: Point[] = [];
        for (let i = 0; i <= 20; i++) {
          const a = (Math.PI * 2 * i) / 20;
          const p = iso.toScreen(hub.gx + Math.cos(a) * r.radius, hub.gy + Math.sin(a) * r.radius);
          ring.push({ x: p.x, y: p.y - v.altitude - r.z });
        }
        this.overlay.strokePoints(ring, false);
      }
    });
    if (def.visual.tailRotor === false) {
      this.heliDust(v, rc, timeMs, paused);
      return;
    }
    // Rotor de queue : petite hélice dans le plan vertical du fuselage
    const tailPos = def.visual.tailRotorPos ?? { u: TAIL_U, z: TAIL_Z };
    const tail = this.localToGrid(v, x, y, tailPos.u, length);
    const ta = ((timeMs / 25) * spin) % (Math.PI * 2);
    const r = 0.22;
    const dx = Math.cos(ta) * r;
    const along = v.axis === 0 ? { gx: dx, gy: 0 } : { gx: 0, gy: dx };
    const p1 = iso.toScreen(tail.gx + along.gx, tail.gy + along.gy);
    const p2 = iso.toScreen(tail.gx - along.gx, tail.gy - along.gy);
    const dz = Math.sin(ta) * 7;
    this.overlay.lineStyle(1, 0x2b2a24, 0.8);
    this.overlay.lineBetween(p1.x, p1.y - v.altitude - tailPos.z - dz, p2.x, p2.y - v.altitude - tailPos.z + dz);

    this.heliDust(v, rc, timeMs, paused);
  }

  /** Poussière soulevée près du sol par le souffle des rotors. */
  private heliDust(v: Vehicle, rc: Point, timeMs: number, paused: boolean): void {
    if (!paused && v.altitude > 0 && v.altitude < 30 && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2;
      this.addPuff(rc.x + Math.cos(a) * 30, rc.y + Math.sin(a) * 14, Math.cos(a) * 0.04, Math.sin(a) * 0.02, timeMs, 900);
    }
  }

  /** Avion : ombre en croix (fuselage + aile) au sol, hélices qui tournent, poussière au roulage. */
  private drawPlaneExtras(v: Vehicle, x: number, y: number, length: number, width: number, timeMs: number, paused: boolean): void {
    const iso = this.iso;
    const k = 1 - Math.min(0.5, v.altitude / 260);
    const off = v.altitude / 40; // l'ombre glisse avec le soleil
    const rect = (u0: number, u1: number, w0: number, w1: number): Point[] => {
      const half = length / 2;
      const pts: [number, number][] = [
        [u0 - half, w0],
        [u1 - half, w0],
        [u1 - half, w1],
        [u0 - half, w1],
      ];
      return pts.map(([a, b]) => {
        const along = v.flip ? -a : a;
        const gx = v.axis === 0 ? x + along * k + off : x + b * k + off;
        const gy = v.axis === 0 ? y + b * k + off : y + along * k + off;
        return iso.toScreen(gx, gy);
      });
    };
    this.shadows.fillStyle(0x000000, 0.25 * k);
    this.shadows.fillPoints(rect(length * 0.05, length * 0.97, -0.3, 0.3), true);
    this.shadows.fillPoints(rect(length * 0.5, length * 0.66, -width / 2 + 0.1, width / 2 - 0.1), true);
    this.shadows.fillPoints(rect(0, length * 0.14, -width * 0.24, width * 0.24), true);
    // Hélices : disques flous des turbopropulseurs (C-130)
    const def = this.ctx.content.vehicle(v.defId);
    if (def.visual.style === 'c130' && !paused) {
      const spin = v.state === 'unloading' ? 0.3 : 1;
      this.overlay.lineStyle(1, 0x2b2a24, 0.35 * spin);
      for (const dv of [-2.4, -1.25, 1.25, 2.4]) {
        const p = this.localToGrid(v, x, y, length * 0.76, length);
        const gx = v.axis === 0 ? p.gx : p.gx + dv;
        const gy = v.axis === 0 ? p.gy + dv : p.gy;
        const c = iso.toScreen(gx, gy);
        const a = (timeMs / 30) * spin;
        const r = 12;
        this.overlay.lineBetween(c.x - Math.cos(a) * 3, c.y - v.altitude - 23 - Math.sin(a) * r, c.x + Math.cos(a) * 3, c.y - v.altitude - 23 + Math.sin(a) * r);
      }
    }
    // Poussière au roulage sur la piste
    if (!paused && v.altitude < 2 && (v.pos.x !== v.prevPos.x || v.pos.y !== v.prevPos.y) && Math.random() < 0.6) {
      const rear = this.localToGrid(v, x, y, 0, length);
      const p = iso.toScreen(rear.gx, rear.gy);
      this.addPuff(p.x + (Math.random() - 0.5) * 30, p.y, (Math.random() - 0.5) * 0.03, -0.01, timeMs, 1400);
    }
  }

  private emitDust(v: Vehicle, x: number, y: number, length: number, timeMs: number): void {
    // Pas de poussière sur route ou aire en dur
    const nav = this.ctx.sim.agents.nav;
    if (nav.vehicleCostAt(Math.floor(x), Math.floor(y)) <= 0.5) return;
    const last = this.lastPuff.get(v.id) ?? 0;
    if (timeMs - last < 70) return;
    this.lastPuff.set(v.id, timeMs);
    const rear = this.localToGrid(v, x, y, 0.05, length);
    const p = this.iso.toScreen(rear.gx, rear.gy);
    this.addPuff(p.x + (Math.random() - 0.5) * 8, p.y - 2, (Math.random() - 0.5) * 0.02, -0.01, timeMs, 1100);
  }

  private addPuff(x: number, y: number, vx: number, vy: number, now: number, life: number, smoke = false): void {
    if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
    this.puffs.push({ x, y, vx, vy, r: smoke ? 1.5 + Math.random() * 1.5 : 3 + Math.random() * 3, born: now, life, smoke });
  }

  /** Fumée d'échappement des moteurs diesel (en roulant, ou au ralenti pendant un déchargement). */
  private emitExhaust(v: Vehicle, def: VehicleDef, x: number, y: number, length: number, timeMs: number, moving: boolean): void {
    if (def.visual.style === 'cart' || def.kind === 'plane') return;
    const running = moving || v.state === 'unloading' || v.state === 'pumping';
    if (!running) return;
    const key = `${v.id}:x`;
    const last = this.lastPuff.get(key) ?? 0;
    if (timeMs - last < (moving ? 140 : 420)) return;
    this.lastPuff.set(key, timeMs);
    // Pot vertical derrière la cabine des camions, sinon à l'arrière
    const truck = def.visual.style === 'truck' || def.visual.style === 'tanker';
    const p0 = this.localToGrid(v, x, y, truck ? 1.38 : 0.1, length);
    const p = this.iso.toScreen(p0.gx, p0.gy);
    const z = truck ? 23 : 7;
    this.addPuff(p.x + (Math.random() - 0.5) * 2, p.y - z, (Math.random() - 0.5) * 0.008, -0.012, timeMs, 900, true);
  }

  /** Feux : gyrophares, feux anticollision et de navigation des hélicoptères, feux arrière la nuit. */
  private drawLights(v: Vehicle, def: VehicleDef, x: number, y: number, length: number, timeMs: number, moving: boolean): void {
    const g = this.overlay;
    const at = (u: number, z: number, side = 0): { x: number; y: number } => {
      const c = this.localToGrid(v, x, y, u, length);
      const off = side * 0.42;
      const p = this.iso.toScreen(c.gx + (v.axis === 1 ? off : 0), c.gy + (v.axis === 0 ? off : 0));
      return { x: p.x, y: p.y - z - v.altitude };
    };
    const hour = hourAt(this.ctx.content, this.ctx.state.time.tick);
    const night = isNightHour(this.ctx.content, hour);
    const dot = (p: { x: number; y: number }, color: number, r: number, alpha = 1): void => {
      // Halo lumineux la nuit, puis le point du feu
      if (night) {
        g.fillStyle(color, 0.22 * alpha);
        g.fillCircle(p.x, p.y, r * 3.2);
      }
      g.fillStyle(color, alpha);
      g.fillCircle(p.x, p.y, r * 1.3);
    };
    if (def.kind === 'air') {
      const flying = v.altitude > 0 || v.state !== 'idle';
      if (!flying) return;
      // Feu anticollision rouge clignotant, feux de navigation
      if (Math.floor(timeMs / 600) % 2 === 0) dot(at(length * 0.36, 22), 0xff3a2a, 1.6);
      if (night) {
        dot(at(length * 0.5, 14, -1), 0xff4030, 1.1, 0.9);
        dot(at(length * 0.5, 14, 1), 0x40ff60, 1.1, 0.9);
        if (Math.floor(timeMs / 1100) % 3 === 0) dot(at(0.05, 20), 0xffffff, 1.4);
      }
      return;
    }
    // Gyrophare orange : chariot élévateur au travail, citerne qui pompe
    if ((def.role === 'forklift' && (moving || v.state !== 'idle')) || v.state === 'pumping') {
      const on = Math.floor(timeMs / 250) % 2 === 0;
      if (on) {
        const z = def.role === 'forklift' ? 29 : 21;
        const u = def.role === 'forklift' ? 0.85 : 1.56;
        dot(at(u, z), 0xffa030, 1.8);
        g.fillStyle(0xffa030, 0.18);
        const p = at(u, z);
        g.fillCircle(p.x, p.y, 5);
      }
    }
    // Feux arrière rouges la nuit, phares avant
    if (night && def.kind !== 'plane' && def.visual.style !== 'cart' && (moving || v.state === 'unloading' || v.state === 'pumping')) {
      dot(at(0.04, 7, -1), 0xff3020, 1.1, 0.95);
      dot(at(0.04, 7, 1), 0xff3020, 1.1, 0.95);
      dot(at(length - 0.03, 9, -0.75), 0xfff2c0, 1.3);
      dot(at(length - 0.03, 9, 0.75), 0xfff2c0, 1.3);
    }
  }

  private drawDust(now: number): void {
    const g = this.dust;
    g.clear();
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      const t = (now - p.born) / p.life;
      if (t >= 1 || t < 0) {
        this.puffs.splice(i, 1);
        continue;
      }
      const age = now - p.born;
      g.fillStyle(p.smoke ? 0x5a5852 : 0xc8b48a, (p.smoke ? 0.3 : 0.35) * (1 - t));
      g.fillCircle(p.x + p.vx * age, p.y + p.vy * age, p.r * (1 + t * (p.smoke ? 2.4 : 1.8)));
    }
  }

  /** Véhicule sous un point du monde, ou null. */
  pick(worldX: number, worldY: number): Id | null {
    let best: Id | null = null;
    let bestDepth = -Infinity;
    for (const [id, s] of this.sprites) {
      if (!s.visible) continue;
      const b = s.getBounds();
      // Zone utile : la moitié centrale du canevas (les coins sont transparents)
      const inner = new Phaser.Geom.Rectangle(b.x + b.width * 0.2, b.y + b.height * 0.15, b.width * 0.6, b.height * 0.75);
      if (inner.contains(worldX, worldY) && s.depth > bestDepth) {
        best = id;
        bestDepth = s.depth;
      }
    }
    return best;
  }

  destroy(): void {
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
    this.shadows.destroy();
    this.dust.destroy();
    this.overlay.destroy();
  }
}
