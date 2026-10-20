/**
 * Décor logistique visible autour des bâtiments, synchronisé avec la simulation :
 * - piles de matériaux (planches, parpaings) sur les chantiers, selon ce qui a été livré et pas encore monté ;
 * - stocks locaux livrés par le soutien : caisses de rations au réfectoire, caisses de munitions
 *   au pied des tours, du stand de tir et des obusiers, jerricans des groupes électrogènes,
 *   caisses médicales de l'infirmerie ;
 * - palettes devant l'entrepôt et caisses devant le dépôt de munitions selon le stock de la base ;
 * - sacs poubelle et flaques devant des sanitaires sales ; vapeur de la cuisine quand on y cuisine.
 */
import Phaser from 'phaser';
import type { BuildingDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { BuildingInstance, Id } from '../core/GameState';
import { BuildSystem } from '../systems/BuildSystem';
import type { IsoMath } from './IsoMath';
import { DEPTH } from './depth';
import { frontOffset, groundModules, moduleAnchor } from './moduleAnchors';

type G = Phaser.GameObjects.Graphics;

/** Taille des textures de décor et point d'ancrage (centre de la base au sol). */
const TEX = 40;
const AX = 20;
const AY = 30;

interface Wanted {
  key: string;
  gx: number;
  gy: number;
  flat?: boolean;
}

function shade(c: number, f: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((c & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

/** Point local (x, y en fractions de case, z en pixels) → pixel de la texture. */
function S(x: number, y: number, z: number): { x: number; y: number } {
  return { x: AX + (x - y) * 32, y: AY + (x + y) * 16 - z };
}

/** Pavé isométrique centré en (cx, cy) au sol (fractions de case), posé à l'altitude z0. */
function box(g: G, cx: number, cy: number, fx: number, fy: number, h: number, color: number, z0 = 0): void {
  const x0 = cx - fx / 2;
  const x1 = cx + fx / 2;
  const y0 = cy - fy / 2;
  const y1 = cy + fy / 2;
  const z1 = z0 + h;
  // Face +y (gauche à l'écran), face +x (droite), dessus
  g.fillStyle(shade(color, 0.92), 1);
  g.fillPoints([S(x0, y1, z1), S(x1, y1, z1), S(x1, y1, z0), S(x0, y1, z0)], true);
  g.fillStyle(shade(color, 0.72), 1);
  g.fillPoints([S(x1, y0, z1), S(x1, y1, z1), S(x1, y1, z0), S(x1, y0, z0)], true);
  g.fillStyle(shade(color, 1.12), 1);
  g.fillPoints([S(x0, y0, z1), S(x1, y0, z1), S(x1, y1, z1), S(x0, y1, z1)], true);
  g.lineStyle(1, shade(color, 0.45), 0.6);
  g.strokePoints([S(x0, y1, z1), S(x1, y1, z1), S(x1, y1, z0), S(x0, y1, z0)], true);
  g.strokePoints([S(x1, y0, z1), S(x1, y1, z1), S(x1, y1, z0), S(x1, y0, z0)], true);
}

/** Recettes des textures de décor. */
const RECIPES: Record<string, (g: G) => void> = {
  // Deux caisses de rations empilées, cerclées
  'prop.crates': (g) => {
    box(g, 0, 0, 0.3, 0.3, 8, 0x9c7e4e);
    box(g, 0.02, -0.02, 0.24, 0.24, 7, 0xa88a58, 8);
    g.fillStyle(0x5a4628, 1);
    const a = S(0.15, 0.15, 4);
    g.fillRect(a.x - 9, a.y - 1, 9, 1);
  },
  // Caisses de munitions vert olive, marquage jaune
  'prop.ammo': (g) => {
    box(g, 0.05, 0.05, 0.26, 0.14, 6, 0x56603a);
    box(g, -0.08, -0.06, 0.26, 0.14, 6, 0x5d6840);
    box(g, 0.0, 0.0, 0.24, 0.13, 5, 0x525c36, 6);
    const p = S(0.0, 0.06, 9);
    g.fillStyle(0xd8c04a, 1);
    g.fillRect(p.x - 4, p.y, 4, 1);
  },
  // Jerricans (deux debout)
  'prop.jerry': (g) => {
    for (const [x, y] of [[0.08, -0.06], [-0.06, 0.08]] as [number, number][]) {
      box(g, x, y, 0.08, 0.18, 10, 0x56633a);
      const t = S(x, y, 10);
      g.fillStyle(0x2c3020, 1);
      g.fillRect(t.x - 1, t.y - 2, 3, 2); // poignée
    }
  },
  // Caisses médicales blanches à croix rouge
  'prop.med': (g) => {
    box(g, 0, 0, 0.26, 0.22, 7, 0xdcd8cc);
    box(g, 0.0, 0.0, 0.2, 0.18, 5, 0xe4e0d4, 7);
    const p = S(-0.02, 0.11, 4);
    g.fillStyle(0xc0302a, 1);
    g.fillRect(p.x - 1, p.y - 2, 2, 5);
    g.fillRect(p.x - 3, p.y, 6, 1);
  },
  // Caisses d'obus longues, ogives laiton
  'prop.shells': (g) => {
    box(g, 0, 0.06, 0.34, 0.12, 5, 0x4e5634);
    box(g, 0, -0.08, 0.34, 0.12, 5, 0x4a5232);
    box(g, 0, 0, 0.34, 0.12, 5, 0x525a38, 5);
    const p = S(0.17, 0, 8);
    g.fillStyle(0xc8a050, 1);
    g.fillRect(p.x - 1, p.y - 1, 3, 2);
  },
  // Pile de planches
  'prop.planks': (g) => {
    box(g, 0, 0, 0.44, 0.2, 3, 0xa07a46);
    box(g, 0.02, 0.01, 0.42, 0.17, 3, 0xb48a52, 3);
    box(g, -0.01, 0, 0.4, 0.15, 2, 0xa98248, 6);
    g.lineStyle(1, 0x6a4c26, 0.8);
    const a = S(-0.2, 0.1, 3);
    const b = S(0.22, 0.1, 3);
    g.lineBetween(a.x, a.y, b.x, b.y);
  },
  // Parpaings / gabions pliés sur palette
  'prop.blocks': (g) => {
    box(g, 0, 0, 0.32, 0.32, 2, 0x6b5434);
    box(g, 0, 0, 0.28, 0.28, 7, 0x9a968a, 2);
    g.lineStyle(1, 0x6a675e, 0.9);
    const a = S(-0.14, 0.14, 5.5);
    const b = S(0.14, 0.14, 5.5);
    g.lineBetween(a.x, a.y, b.x, b.y);
  },
  // Palette filmée sur base bois
  'prop.pallet': (g) => {
    box(g, 0, 0, 0.36, 0.36, 2, 0x6b5434);
    box(g, 0, 0, 0.32, 0.32, 10, 0xc8c4b4, 2);
    g.lineStyle(1, 0x8a8678, 0.8);
    const a = S(-0.16, 0.16, 7);
    const b = S(0.16, 0.16, 7);
    g.lineBetween(a.x, a.y, b.x, b.y);
  },
  // Sacs poubelle noirs
  'prop.trash': (g) => {
    g.fillStyle(0x222220, 1);
    g.fillEllipse(AX - 3, AY - 4, 9, 8);
    g.fillEllipse(AX + 4, AY - 3, 8, 7);
    g.fillStyle(0x3a3a36, 1);
    g.fillRect(AX - 4, AY - 9, 2, 2);
    g.fillRect(AX + 3, AY - 7, 2, 2);
  },
  // Flaque d'eau sale au sol
  'prop.puddle': (g) => {
    g.fillStyle(0x3d4a4c, 0.55);
    g.fillEllipse(AX, AY - 1, 22, 9);
    g.fillStyle(0x5a6a6c, 0.4);
    g.fillEllipse(AX - 3, AY - 2, 8, 3);
  },
};

export class PropRenderer {
  private readonly images = new Map<Id, Phaser.GameObjects.Image[]>();
  private readonly steam: Phaser.GameObjects.Graphics;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ctx: GameContext,
    private readonly iso: IsoMath,
  ) {
    const g = scene.add.graphics();
    for (const [key, draw] of Object.entries(RECIPES)) {
      if (scene.textures.exists(key)) continue;
      g.clear();
      draw(g);
      g.generateTexture(key, TEX, TEX);
    }
    g.destroy();
    this.steam = scene.add.graphics().setDepth(DEPTH.overlay - 10);
  }

  sync(): void {
    const buildings = this.ctx.state.fob.buildings;
    for (const [id, list] of this.images) {
      if (!buildings[id]) {
        for (const img of list) img.destroy();
        this.images.delete(id);
      }
    }
    this.steam.clear();
    const cooking = new Set<Id>();
    for (const a of Object.values(this.ctx.state.agents)) {
      if (a.activity?.id === 'cook' && a.activity.stage === 'acting' && a.activity.targetId) cooking.add(a.activity.targetId);
    }
    for (const b of Object.values(buildings)) {
      const def = this.ctx.content.building(b.defId);
      const wanted = this.wanted(b, def);
      let list = this.images.get(b.id);
      if (!list) {
        if (wanted.length === 0) continue;
        list = [];
        this.images.set(b.id, list);
      }
      while (list.length > wanted.length) list.pop()!.destroy();
      wanted.forEach((w, i) => {
        let img = list![i];
        if (!img) {
          img = this.scene.add.image(0, 0, w.key).setOrigin(AX / TEX, AY / TEX);
          list!.push(img);
        }
        if (img.texture.key !== w.key) img.setTexture(w.key);
        const p = this.iso.toScreen(w.gx, w.gy);
        img.setPosition(Math.round(p.x), Math.round(p.y));
        img.setDepth(w.flat ? DEPTH.flat + 5 : DEPTH.objects + (w.gx + w.gy - 1) * 10 + 2);
      });
      if (cooking.has(b.id)) this.drawSteam(b, def);
    }
  }

  /** Décor voulu pour un bâtiment (texture et position au sol). */
  private wanted(b: BuildingInstance, def: BuildingDef): Wanted[] {
    const out: Wanted[] = [];
    const logistics = this.ctx.sim.logistics;
    const [w, h] = BuildSystem.footprint(def, b.rot);
    // Chantier : matériaux livrés pas encore montés, à l'avant de l'emprise
    if (b.materials) {
      const n = Math.min(6, Math.ceil(logistics.onSite(b) / 2));
      for (let i = 0; i < n; i++) {
        const along = 0.38 + i * 0.42;
        out.push({ key: i % 2 === 0 ? 'prop.planks' : 'prop.blocks', gx: b.pos.x + Math.max(0.35, w - along), gy: b.pos.y + h - 0.32 - (along > w - 0.2 ? 0.45 : 0) });
      }
    }
    if (b.state === 'construction') return out;
    // Stocks locaux livrés (proportionnels au remplissage)
    const slots = this.frontSlots(b, def, w, h);
    let s = 0;
    const put = (key: string, count: number): void => {
      for (let i = 0; i < count && s < slots.length; i++, s++) out.push({ key, ...slots[s] });
    };
    for (const res of logistics.supplied(b)) {
      const fill = logistics.stock(b, res) / Math.max(1, logistics.capacity(b, res));
      const max = w * h <= 1 ? 1 : 3;
      const count = fill <= 0.01 ? 0 : Math.max(1, Math.round(fill * max));
      const key = res === 'food' ? 'prop.crates' : res === 'fuel' ? 'prop.jerry' : res === 'medical' ? 'prop.med' : def.id === 'artillery' ? 'prop.shells' : 'prop.ammo';
      put(key, count);
    }
    // Entrepôt et dépôt : palettes selon le remplissage des stocks de la base
    const st = this.ctx.state.resources;
    const ratio = (id: 'food' | 'ammo'): number => (st.capacity[id] > 0 ? st.stock[id] / st.capacity[id] : 0);
    if (def.id === 'warehouse') put('prop.pallet', Math.round(ratio('food') * 4));
    if (def.id === 'ammo_depot') put('prop.ammo', Math.round(ratio('ammo') * 3));
    // Sanitaires sales : sacs poubelle et, dessous, une flaque
    if (logistics.dirty(b) && s < slots.length) {
      const sl = slots[s];
      put('prop.trash', 1);
      out.push({ key: 'prop.puddle', gx: sl.gx, gy: sl.gy, flat: true });
    }
    return out;
  }

  /**
   * Emplacements devant les façades visibles (+x, +y), à l'extérieur du mur : d'abord la façade
   * sans porte. Une case voisine occupée (bâtiment, mur, hesco…) ou devant l'entrée n'en reçoit
   * pas ; sans place libre, rien n'est posé (le décor serait sinon dessiné à travers un mur).
   */
  private frontSlots(b: BuildingInstance, def: BuildingDef, w: number, h: number): { gx: number; gy: number }[] {
    const side = BuildSystem.entranceSide(def, b.rot);
    // Seule la porte (au milieu de la façade d'entrée) reste dégagée
    const front = BuildSystem.entranceCells(def, b.pos, b.rot);
    const mid = front.length ? [front[Math.floor(front.length / 2)], ...(front.length % 2 === 0 ? [front[front.length / 2 - 1]] : [])] : [];
    const doors = new Set(mid.map((c) => `${c.x},${c.y}`));
    const build = this.ctx.sim.build;
    // Éléments d'amélioration posés au sol (climatiseur) : on ne pose rien dessus
    const mods = groundModules(def, b);
    const off = frontOffset(def, b);
    const free = (gx: number, gy: number): boolean => {
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      if (doors.has(`${cx},${cy}`)) return false;
      if (mods.some((m) => Math.hypot(m.gx - gx, m.gy - gy) < 0.62)) return false;
      const other = build.buildingAt({ x: cx, y: cy });
      return !other || (other.id !== b.id && this.ctx.content.building(other.defId).visual.style === 'flat');
    };
    const faceX = (): { gx: number; gy: number }[] => {
      const out: { gx: number; gy: number }[] = [];
      for (let i = 0; i < Math.max(1, Math.floor(h / 0.4)); i++) {
        const p = { gx: b.pos.x + w + off, gy: b.pos.y + h - 0.3 - i * 0.4 };
        if (free(p.gx, p.gy)) out.push(p);
      }
      return out;
    };
    const faceY = (): { gx: number; gy: number }[] => {
      const out: { gx: number; gy: number }[] = [];
      for (let i = 0; i < Math.max(1, Math.floor(w / 0.4)); i++) {
        const p = { gx: b.pos.x + w - 0.3 - i * 0.4, gy: b.pos.y + h + off };
        if (free(p.gx, p.gy)) out.push(p);
      }
      return out;
    };
    const preferX = side ? side.y > 0 : w < h; // porte sur la façade +y : décor d'abord sur la façade +x
    return preferX ? [...faceX(), ...faceY()] : [...faceY(), ...faceX()];
  }

  /** Volutes de vapeur au-dessus de la cuisine. */
  private drawSteam(b: BuildingInstance, def: BuildingDef): void {
    const a = moduleAnchor(def, b, 'chimney');
    const p = this.iso.toScreen(a.gx, a.gy);
    const top = p.y - a.z - 12;
    const now = this.ctx.state.time.speed > 0 ? this.scene.time.now : 0;
    for (let i = 0; i < 3; i++) {
      const t = ((now / 1800 + i / 3) % 1 + 1) % 1;
      this.steam.fillStyle(0xe8e8e0, 0.45 * (1 - t));
      this.steam.fillCircle(p.x + Math.sin(t * 6 + i) * 3, top - t * 16, 2 + t * 4);
    }
  }

  destroy(): void {
    for (const list of this.images.values()) for (const img of list) img.destroy();
    this.images.clear();
    this.steam.destroy();
  }
}
