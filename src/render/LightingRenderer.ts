/**
 * Cycle jour/nuit de la vue FOB : une texture plein écran teinte la scène par multiplication
 * (lumière chaude le jour, orangée au crépuscule, bleutée la nuit, d'après ambience.json), avec un
 * léger vignettage la nuit. Les sources de lumière y « percent » un halo : bâtiments éclairés
 * (éteints sans électricité, vacillants si elle manque), lampes au-dessus des portes, mâts
 * d'éclairage, faisceaux balayants des projecteurs des tours de garde occupées, faisceaux des
 * phares des véhicules, explosions et départs de coups. Un halo additif s'y ajoute, ainsi que le
 * point brillant des lampes elles-mêmes (ampoules en hauteur).
 */
import Phaser from 'phaser';
import type { LightFx } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import { BuildSystem } from '../systems/BuildSystem';
import { ambientAt, buildingLight, powerRatio } from '../systems/lighting';
import { hexToInt } from '../assets/PlaceholderFactory';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './TerrainRenderer';

const LIGHT_TEX = 'fx.light';
const CONE_TEX = 'fx.cone';
const VIGNETTE_TEX = 'fx.vignette';
const TEX_SIZE = 128;
const MAX_FLASHES = 40;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Flash {
  x: number; // grille
  y: number;
  fx: LightFx;
  born: number;
}

interface Light {
  wx: number; // monde
  wy: number;
  radius: number; // cases
  color: number;
  strength: number; // 0..1
  /** Faisceau : angle à l'écran, longueur et largeur en pixels du monde (origine = la source). */
  cone?: { angle: number; len: number; width: number };
  /** Ampoule : petit point brillant en hauteur, additif seulement (ne perce pas la nuit au sol). */
  bulb?: boolean;
}

const mix = (a: Rgb, b: Rgb, k: number): Rgb => ({ r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k });
const rgbInt = (c: Rgb): number => (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b);
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

export class LightingRenderer {
  private readonly rt: Phaser.GameObjects.RenderTexture;
  private readonly brush: Phaser.GameObjects.Image;
  private readonly glows: Phaser.GameObjects.Image[] = [];
  private readonly coneBrush: Phaser.GameObjects.Image;
  private readonly vignette: Phaser.GameObjects.Image;
  private readonly flashes: Flash[] = [];
  private readonly unsubs: (() => void)[] = [];
  private lastMuzzle = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    LightingRenderer.ensureTexture(scene);
    const cam = scene.cameras.main;
    this.rt = scene.add
      .renderTexture(0, 0, Math.max(1, cam.width), Math.max(1, cam.height))
      .setOrigin(0, 0)
      .setDepth(DEPTH.overlay - 10)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false);
    this.brush = scene.make.image({ key: LIGHT_TEX, add: false }).setOrigin(0.5, 0.5);
    this.coneBrush = scene.make.image({ key: CONE_TEX, add: false }).setOrigin(0, 0.5);
    this.vignette = scene.make.image({ key: VIGNETTE_TEX, add: false }).setOrigin(0, 0);

    const amb = ctx.content.ambience;
    this.unsubs.push(
      ctx.bus.on('combat:impact', ({ x, y }) => this.flash(x, y, amb.explosion)),
      ctx.bus.on('artillery:fire', ({ x, y }) => this.flash(x, y, amb.cannon)),
      ctx.bus.on('combat:shot', ({ fromX, fromY }) => {
        const now = scene.time.now;
        if (now - this.lastMuzzle < 40) return;
        this.lastMuzzle = now;
        this.flash(fromX, fromY, amb.muzzle);
      }),
    );
  }

  /** Dégradé radial blanc → transparent (pinceau des halos), faisceau conique et vignette. */
  static ensureTexture(scene: Phaser.Scene): void {
    if (!scene.textures.exists(CONE_TEX)) {
      // Faisceau : cône adouci partant du bord gauche, intense près de la source
      const W = 256;
      const H = 128;
      const tex = scene.textures.createCanvas(CONE_TEX, W, H);
      if (tex) {
        const g = tex.getContext();
        g.filter = 'blur(7px)';
        const grad = g.createRadialGradient(0, H / 2, 0, 0, H / 2, W);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.45, 'rgba(255,255,255,0.7)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(6, H / 2 - 4);
        g.lineTo(W - 10, 12);
        g.lineTo(W - 10, H - 12);
        g.lineTo(6, H / 2 + 4);
        g.closePath();
        g.fill();
        tex.refresh();
      }
    }
    if (!scene.textures.exists(VIGNETTE_TEX)) {
      const S = 256;
      const tex = scene.textures.createCanvas(VIGNETTE_TEX, S, S);
      if (tex) {
        const g = tex.getContext();
        const grad = g.createRadialGradient(S / 2, S / 2, S * 0.28, S / 2, S / 2, S * 0.72);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,1)');
        g.fillStyle = grad;
        g.fillRect(0, 0, S, S);
        tex.refresh();
      }
    }
    if (scene.textures.exists(LIGHT_TEX)) return;
    const tex = scene.textures.createCanvas(LIGHT_TEX, TEX_SIZE, TEX_SIZE);
    if (!tex) return;
    const g = tex.getContext();
    const grad = g.createRadialGradient(TEX_SIZE / 2, TEX_SIZE / 2, 0, TEX_SIZE / 2, TEX_SIZE / 2, TEX_SIZE / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.3)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
    tex.refresh();
  }

  private flash(x: number, y: number, fx: LightFx): void {
    if (this.flashes.length >= MAX_FLASHES) this.flashes.shift();
    this.flashes.push({ x, y, fx, born: this.scene.time.now });
  }

  /** Teinte et part de nuit à une heure donnée (minutes depuis minuit). */
  ambient(minuteOfDay: number): { color: Rgb; night: number } {
    const a = ambientAt(this.ctx.content.ambience.keyframes, minuteOfDay);
    return { color: { r: a.r, g: a.g, b: a.b }, night: a.night };
  }

  private collectLights(view: Phaser.Geom.Rectangle, night: number, alpha: number): Light[] {
    const out: Light[] = [];
    const s = this.ctx.state;
    const content = this.ctx.content;
    const margin = 8 * this.iso.tileW;
    const inView = (wx: number, wy: number): boolean => wx > view.x - margin && wx < view.right + margin && wy > view.y - margin && wy < view.bottom + margin;
    const now = this.scene.time.now;
    const amb = content.ambience;

    if (night > 0.01) {
      const ratio = powerRatio(s);
      for (const b of Object.values(s.fob.buildings)) {
        const def = content.building(b.defId);
        if (!def.light) continue;
        let k = buildingLight(content, s, b, ratio);
        if (k <= 0) continue;
        const [w, h] = BuildSystem.footprint(def, b.rot);
        const color = hexToInt(def.light.color);
        if (def.light.spacing) {
          // Balisage : feux le long des deux bords du grand axe
          const long = h >= w;
          const L = long ? h : w;
          for (let a = 0.5; a < L; a += def.light.spacing) {
            for (const side of [0.25, (long ? w : h) - 0.25]) {
              const p = long ? this.iso.toScreen(b.pos.x + side, b.pos.y + a) : this.iso.toScreen(b.pos.x + a, b.pos.y + side);
              if (inView(p.x, p.y)) out.push({ wx: p.x, wy: p.y, radius: def.light.radius, color, strength: k * night });
            }
          }
          continue;
        }
        const p = this.iso.toScreen(b.pos.x + w / 2, b.pos.y + h / 2);
        if (!inView(p.x, p.y)) continue;
        // Courant insuffisant : les lampes vacillent
        if (def.light.power && ratio < 1) k *= 0.75 + 0.25 * Math.sin(now / 90 + b.pos.x * 7.3 + b.pos.y * 3.1);
        else k *= 1 - this.ctx.content.ambience.flicker * (0.5 + 0.5 * Math.sin(now / 160 + b.pos.x * 3.7));
        out.push({ wx: p.x, wy: p.y, radius: def.light.radius, color: hexToInt(def.light.color), strength: k * night });
        // Lampe au-dessus de la porte : petite flaque de lumière devant l'entrée et ampoule au mur
        const door = BuildSystem.entranceCells(def, b.pos, b.rot);
        const side = BuildSystem.entranceSide(def, b.rot);
        if (door.length && side && amb.doorLamp) {
          const mid = door[Math.floor(door.length / 2)];
          const gx = mid.x + 0.5 - side.x * 0.35;
          const gy = mid.y + 0.5 - side.y * 0.35;
          const q = this.iso.toScreen(gx, gy);
          out.push({ wx: q.x, wy: q.y, radius: amb.doorLamp.radius, color: hexToInt(amb.doorLamp.color), strength: k * night * 0.95 });
          const wall = this.iso.toScreen(mid.x + 0.5 - side.x * 0.5, mid.y + 0.5 - side.y * 0.5);
          out.push({ wx: wall.x, wy: wall.y - def.visual.height * 0.62, radius: 0.32, color: hexToInt(amb.doorLamp.color), strength: k * night, bulb: true });
        }
        // Mâts d'éclairage : têtes de lampes visibles en haut du mât
        if (def.visual.style === 'pole') out.push({ wx: p.x, wy: p.y - def.visual.height + 4, radius: 0.55, color: hexToInt(def.light.color), strength: k * night, bulb: true });
        // Tour de garde occupée : projecteur qui balaie les abords
        const svc = def.services?.guard;
        if (svc && amb.searchlight && this.ctx.sim.agents.occupancy(b.id, 'guard') > 0) {
          const z = s.fob.zone;
          const out0 = Math.atan2(b.pos.y + 0.5 - (z.y + z.height / 2), b.pos.x + 0.5 - (z.x + z.width / 2));
          const seed = (b.pos.x * 13 + b.pos.y * 7) % 10;
          const ang = out0 + Math.sin(now / 2600 + seed) * amb.searchlight.sweep;
          const top = this.iso.toScreen(b.pos.x + 0.5, b.pos.y + 0.5);
          const lampY = top.y - (svc.standZ ?? 30) - 10;
          out.push({ wx: top.x, wy: lampY, radius: 0.45, color: hexToInt(amb.searchlight.color), strength: k * night, bulb: true });
          // Faisceau : part de la lampe en haut de la tour et descend vers le sol balayé
          const reach = amb.searchlight.length;
          const ground = this.iso.toScreen(b.pos.x + 0.5 + Math.cos(ang) * reach, b.pos.y + 0.5 + Math.sin(ang) * reach);
          const bx = ground.x - top.x;
          const by = ground.y - lampY;
          const len = Math.hypot(bx, by);
          const groundLen = Math.hypot(ground.x - top.x, ground.y - top.y);
          out.push({ wx: top.x, wy: lampY, radius: reach, color: hexToInt(amb.searchlight.color), strength: k * night, cone: { angle: Math.atan2(by, bx), len, width: groundLen * 0.36 } });
          // Tache éclairée au sol, au bout du faisceau
          const spot = this.iso.toScreen(b.pos.x + 0.5 + Math.cos(ang) * reach * 0.82, b.pos.y + 0.5 + Math.sin(ang) * reach * 0.82);
          out.push({ wx: spot.x, wy: spot.y, radius: reach * 0.22, color: hexToInt(amb.searchlight.color), strength: k * night * 0.9 });
        }
      }
      // Phares des véhicules en mouvement : faisceau devant le véhicule et petite flaque au capot
      const hl = content.ambience.headlights;
      for (const v of Object.values(s.vehicles)) {
        if (v.state === 'away' || v.altitude > 4) continue;
        const dx = v.pos.x - v.prevPos.x;
        const dy = v.pos.y - v.prevPos.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;
        const ux = dx / len;
        const uy = dy / len;
        const half = (content.vehicle(v.defId).visual.length ?? 2) / 2;
        const fx = v.prevPos.x + dx * alpha + ux * half;
        const fy = v.prevPos.y + dy * alpha + uy * half;
        const p = this.iso.toScreen(fx, fy);
        if (!inView(p.x, p.y)) continue;
        const sx = (ux - uy) * this.iso.halfW;
        const sy = (ux + uy) * this.iso.halfH;
        const beam = (hl.ahead ?? 1) * 3.2 * Math.hypot(sx, sy);
        out.push({ wx: p.x, wy: p.y, radius: hl.radius * 0.7, color: hexToInt(hl.color), strength: night * 0.8 });
        out.push({ wx: p.x, wy: p.y, radius: hl.radius, color: hexToInt(hl.color), strength: night, cone: { angle: Math.atan2(sy, sx), len: beam, width: beam * 0.55 } });
      }
    }
    // Explosions et départs de coups (de jour, seul le halo additif se voit)
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const life = f.fx.durationMs ?? 300;
      const t = (now - f.born) / life;
      if (t >= 1) {
        this.flashes.splice(i, 1);
        continue;
      }
      const p = this.iso.toScreen(f.x, f.y);
      if (inView(p.x, p.y)) out.push({ wx: p.x, wy: p.y, radius: f.fx.radius * (0.7 + 0.3 * t), color: hexToInt(f.fx.color), strength: (1 - t) * (0.4 + 0.6 * Math.max(night, 0.3)) });
    }
    return out;
  }

  sync(alpha: number): void {
    const s = this.ctx.state;
    const intensity = this.ctx.settings.num('nightEffects');
    const amb = this.ambient(s.time.minuteOfDay + (s.time.speed > 0 ? alpha : 0));
    const color = mix(WHITE, amb.color, intensity);
    const night = amb.night * intensity;
    const cam = this.scene.cameras.main;
    const view = cam.worldView;
    const lights = this.collectLights(view, night, alpha);
    const tinted = color.r < 253 || color.g < 253 || color.b < 253;

    // Teinte plein écran (inutile en plein jour sans halo)
    if (tinted) {
      if (this.rt.width !== cam.width || this.rt.height !== cam.height) this.rt.resize(cam.width, cam.height);
      this.rt.setPosition(view.x, view.y).setScale(1 / cam.zoom).setVisible(true);
      this.rt.clear();
      this.rt.fill(rgbInt(color), 1);
      // Vignettage nocturne : bords de l'écran plus sombres
      const vig = (this.ctx.content.ambience.vignette ?? 0) * night;
      if (vig > 0.01) {
        this.vignette.setDisplaySize(cam.width, cam.height).setAlpha(vig);
        this.rt.draw(this.vignette, 0, 0);
      }
      for (const l of lights) {
        if (l.bulb) continue;
        const x = (l.wx - view.x) * cam.zoom;
        const y = (l.wy - view.y) * cam.zoom;
        if (l.cone) {
          this.coneBrush
            .setPosition(x, y)
            .setRotation(l.cone.angle)
            .setDisplaySize(l.cone.len * cam.zoom, l.cone.width * cam.zoom)
            .setAlpha(Math.min(1, l.strength));
          this.rt.erase(this.coneBrush);
          continue;
        }
        const rx = l.radius * this.iso.halfW * 1.25 * cam.zoom;
        this.brush.setPosition(x, y).setDisplaySize(rx * 2, rx * 1.1).setAlpha(Math.min(1, l.strength * 1.1));
        this.rt.erase(this.brush);
      }
    } else {
      this.rt.setVisible(false);
    }

    // Halos additifs
    const glowAlpha = this.ctx.content.ambience.glowAlpha;
    let n = 0;
    for (const l of lights) {
      let img = this.glows[n];
      if (!img) {
        img = this.scene.add.image(0, 0, LIGHT_TEX).setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.overlay - 9);
        this.glows.push(img);
      }
      const key = l.cone ? CONE_TEX : LIGHT_TEX;
      if (img.texture.key !== key) img.setTexture(key);
      if (l.cone) {
        img.setOrigin(0, 0.5).setRotation(l.cone.angle).setVisible(true).setPosition(l.wx, l.wy).setDisplaySize(l.cone.len, l.cone.width).setTint(l.color).setAlpha(Math.min(1, glowAlpha * 1.8 * l.strength));
      } else if (l.bulb) {
        // Ampoule : cœur blanc très lumineux et halo serré
        const rx = l.radius * this.iso.halfW;
        img.setOrigin(0.5, 0.5).setRotation(0).setVisible(true).setPosition(l.wx, l.wy).setDisplaySize(rx * 2, rx * 2).setTint(l.color).setAlpha(Math.min(1, 0.95 * l.strength));
      } else {
        const rx = l.radius * this.iso.halfW * 0.9;
        img.setOrigin(0.5, 0.5).setRotation(0).setVisible(true).setPosition(l.wx, l.wy).setDisplaySize(rx * 2, rx * 1.05).setTint(l.color).setAlpha(glowAlpha * l.strength);
      }
      n++;
    }
    for (let i = n; i < this.glows.length; i++) this.glows[i].setVisible(false);
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.rt.destroy();
    this.brush.destroy();
    this.coneBrush.destroy();
    this.vignette.destroy();
    for (const g of this.glows) g.destroy();
  }
}
