/**
 * Art procédural des véhicules : un mini moteur de volumes isométriques (pavés et cylindres
 * à facettes, élimination des faces cachées, ombrage selon l'orientation, tri des pièces)
 * et les modèles détaillés (camion de palettes, camions-citernes, chariot élévateur, hélicoptère).
 *
 * Coordonnées locales d'un véhicule : u le long du véhicule (0 → L, l'avant en u = L),
 * v en travers (0 → 1), z en pixels au-dessus du sol. Le maillage convertit selon l'axe
 * (a0 : u suit x ; a1 : u suit y) et le sens (flip : avant vers les x/y décroissants).
 */
import type Phaser from 'phaser';
import type { VehicleDef } from '../core/ContentTypes';

type G = Phaser.GameObjects.Graphics;

interface P3 {
  x: number;
  y: number;
  z: number;
}

interface Face {
  pts: P3[];
  n: P3;
  color: number;
}

interface Part {
  faces: Face[];
  key: number;
  outline: boolean;
}

/** Direction vers l'observateur (en grille, z en unités « cellule »). */
const VIEW = { x: 1, y: 1, z: 1.25 };
/** Conversion pixels d'altitude → unités de grille (pour le tri et les normales). */
const Z_UNIT = 1 / 28;

export function shadeColor(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 0xff) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 0xff) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

const hex = (s: string): number => parseInt(s.slice(1), 16);

/** Pneus, vitrages et jantes (le maillage leur applique un traitement particulier). */
const TIRE = 0x1d1c18;
const GLASS = 0x2b3a46;
const RIM = 0x4a4a42;
/** Poussière du désert déposée sur le bas des véhicules. */
const DUST = 0xb8a47c;

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number): number => (c >> s) & 0xff;
  const m = (s: number): number => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** Éclairage venant du haut-gauche : dessus clair, face gauche (+y) moyenne, face droite (+x) sombre. */
function lightOf(n: P3): number {
  const l = Math.hypot(n.x, n.y, n.z) || 1;
  return 0.62 + (0.03 * n.x) / l + (0.22 * n.y) / l + (0.5 * n.z) / l;
}

export class Mesh {
  private readonly parts: Part[] = [];

  constructor(
    private readonly length: number,
    private readonly axis: 0 | 1,
    private readonly flip: boolean,
  ) {}

  /** Point local → grille. */
  private g(u: number, v: number, z: number): P3 {
    const uu = this.flip ? this.length - u : u;
    return this.axis === 0 ? { x: uu, y: v, z } : { x: v, y: uu, z };
  }

  /** Vecteur local (u, v, z) → grille. */
  private dir(nu: number, nv: number, nz: number): P3 {
    const uu = this.flip ? -nu : nu;
    return this.axis === 0 ? { x: uu, y: nv, z: nz } : { x: nv, y: uu, z: nz };
  }

  private push(faces: Face[], outline: boolean, bias: number): void {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    for (const f of faces)
      for (const p of f.pts) {
        sx += p.x;
        sy += p.y;
        sz += p.z;
        n++;
      }
    this.parts.push({ faces, outline, key: (sx + sy + sz * Z_UNIT) / Math.max(1, n) + bias });
  }

  /** Pavé en coordonnées locales. */
  box(u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, color: number, outline = true, bias = 0): this {
    const a = this.g(u0, v0, z0);
    const b = this.g(u1, v1, z1);
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const p = (x: number, y: number, z: number): P3 => ({ x, y, z });
    this.push(
      [
        { pts: [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)], n: { x: 0, y: 0, z: 1 }, color },
        { pts: [p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0), p(x1, y0, z0)], n: { x: 1, y: 0, z: 0 }, color },
        { pts: [p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0)], n: { x: 0, y: 1, z: 0 }, color },
        { pts: [p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), p(x0, y0, z0)], n: { x: -1, y: 0, z: 0 }, color },
        { pts: [p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0), p(x0, y0, z0)], n: { x: 0, y: -1, z: 0 }, color },
      ],
      outline,
      bias,
    );
    return this;
  }

  /**
   * Cylindre à facettes le long de l'axe local `along` entre a0 et a1, centré en (c, cz) dans
   * le plan transversal ; rayon horizontal rH (grille) et vertical rZ (pixels).
   */
  cyl(along: 'u' | 'v', a0: number, a1: number, c: number, cz: number, rH: number, rZ: number, color: number, sides = 8, outline = true, bias = 0): this {
    const faces: Face[] = [];
    const pt = (a: number, ang: number): P3 => {
      const h = c + Math.cos(ang) * rH;
      const z = cz + Math.sin(ang) * rZ;
      return along === 'u' ? this.g(a, h, z) : this.g(h, a, z);
    };
    const nrm = (ang: number): P3 => {
      const nh = Math.cos(ang) / Math.max(rH, 1e-3);
      const nz = Math.sin(ang) / Math.max(rZ * Z_UNIT, 1e-3);
      return along === 'u' ? this.dir(0, nh, nz) : this.dir(nh, 0, nz);
    };
    for (let i = 0; i < sides; i++) {
      const t0 = (Math.PI * 2 * i) / sides;
      const t1 = (Math.PI * 2 * (i + 1)) / sides;
      faces.push({ pts: [pt(a0, t0), pt(a1, t0), pt(a1, t1), pt(a0, t1)], n: nrm((t0 + t1) / 2), color });
    }
    const cap = (a: number, sign: number): Face => ({
      pts: Array.from({ length: sides }, (_, i) => pt(a, (Math.PI * 2 * i) / sides)),
      n: along === 'u' ? this.dir(sign, 0, 0) : this.dir(0, sign, 0),
      color: shadeColor(color, 0.95),
    });
    faces.push(cap(a0, -1), cap(a1, 1));
    this.push(faces, outline, bias);
    // Roue : jante et moyeu visibles sur les flancs
    if (color === TIRE && along === 'v' && rZ >= 2.2) {
      for (const a of [a0, a1]) {
        const out = a === a1 ? 1 : -1;
        this.cyl('v', a - 0.004 * out, a + 0.012 * out, c, cz, rH * 0.58, rZ * 0.58, RIM, 8, false, bias + 0.01);
        this.cyl('v', a + 0.008 * out, a + 0.02 * out, c, cz, rH * 0.2, rZ * 0.2, 0x2a2a26, 6, false, bias + 0.02);
      }
    }
    return this;
  }

  /** Décor plat (vitre, plaque, phare) posé sur une face ; dessiné après la pièce porteuse. */
  quad(pts: [number, number, number][], color: number, n: [number, number, number], bias = 0.02): this {
    this.push([{ pts: pts.map(([u, v, z]) => this.g(u, v, z)), n: this.dir(n[0], n[1], n[2]), color }], false, bias);
    return this;
  }

  /** Ombre portée au sol (rectangle local), dessinée avant tout le reste. */
  shadow(g: G, P: (x: number, y: number, z: number) => { x: number; y: number }, u0: number, u1: number, v0: number, v1: number): void {
    const pts = [this.g(u0, v0, 0), this.g(u1, v0, 0), this.g(u1, v1, 0), this.g(u0, v1, 0)].map((p) => P(p.x + 0.06, p.y + 0.06, 0));
    g.fillStyle(0x000000, 0.22);
    g.fillPoints(pts, true);
  }

  render(g: G, P: (x: number, y: number, z: number) => { x: number; y: number }): void {
    const visible = (f: Face): boolean => f.n.x * VIEW.x + f.n.y * VIEW.y + f.n.z * Z_UNIT * 28 * VIEW.z > 1e-6;
    const centroid = (f: Face): number => {
      let s = 0;
      for (const p of f.pts) s += p.x + p.y + p.z * Z_UNIT;
      return s / f.pts.length;
    };
    for (const part of [...this.parts].sort((a, b) => a.key - b.key)) {
      const faces = part.faces.filter(visible).sort((a, b) => centroid(a) - centroid(b));
      for (const f of faces) {
        const pts = f.pts.map((p) => P(p.x, p.y, p.z));
        let col = shadeColor(f.color, lightOf(f.n));
        const glass = f.color === GLASS;
        // Patine : poussière sur le bas de caisse et les roues
        const zAvg = f.pts.reduce((s, p) => s + p.z, 0) / f.pts.length;
        if (!glass && zAvg < 9) col = mix(col, shadeColor(DUST, lightOf(f.n)), 0.26 * (1 - zAvg / 9));
        g.fillStyle(col, 1);
        g.fillPoints(pts, true);
        if (part.outline) {
          g.lineStyle(1, shadeColor(f.color, 0.42), 0.55);
          g.strokePoints(pts, true);
          // Arêtes avant des dessus accrochant la lumière (effet de chanfrein)
          if (f.n.z > 0.5 && f.pts.length === 4) {
            const c = f.pts.reduce((s, p) => s + p.x + p.y, 0) / 4;
            g.lineStyle(1, shadeColor(col, 1.28), 0.7);
            for (let i = 0; i < 4; i++) {
              const a = f.pts[i];
              const b = f.pts[(i + 1) % 4];
              if ((a.x + a.y + b.x + b.y) / 2 > c + 1e-6) {
                const pa = P(a.x, a.y, a.z);
                const pb = P(b.x, b.y, b.z);
                g.lineBetween(pa.x, pa.y, pb.x, pb.y);
              }
            }
          }
        }
        // Reflet en biais sur les vitres
        if (glass && pts.length === 4) {
          const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
          const a = lerp(pts[0], pts[1], 0.3);
          const b = lerp(pts[3], pts[2], 0.6);
          g.lineStyle(1, 0x9fb8c8, 0.55);
          g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- Modèles

const STEEL = 0x8a877e;
const WOOD = 0x6b5434;

const OLIVE_CAN = 0x56633a;

/** Panneau d'identification air-sol VS-17 (orange fluo) posé sur un toit. */
function vs17(m: Mesh, u0: number, u1: number, v0: number, v1: number, z: number): void {
  m.quad([[u0, v0, z], [u1, v0, z], [u1, v1, z], [u0, v1, z]], 0xe8805a, [0, 0, 1], 0.05);
}

/** Petit marquage blanc (numéro d'unité au pochoir) sur une face latérale +y. */
function stencil(m: Mesh, u0: number, u1: number, v: number, z0: number, z1: number, side: 1 | -1 = 1): void {
  m.quad([[u0, v, z1], [u1, v, z1], [u1, v, z0], [u0, v, z0]], 0xd8d4c4, [0, side, 0], 0.05);
}

/** Jerrican debout contre la caisse (u, v au sol local, z de base). */
function jerrycan(m: Mesh, u: number, v: number, z: number, color = OLIVE_CAN): void {
  m.box(u - 0.06, u + 0.06, v - 0.035, v + 0.035, z, z + 6, color);
  m.box(u - 0.02, u + 0.02, v - 0.02, v + 0.02, z + 6, z + 7, shadeColor(color, 0.6), false);
}

/** Pot d'échappement vertical derrière la cabine. */
function exhaust(m: Mesh, u: number, v: number, z0: number, z1: number): void {
  m.cyl('v', v - 0.03, v + 0.03, u, z1 - 1, 0.03, 1, 0x2a2926, 6, false);
  m.box(u - 0.025, u + 0.025, v - 0.025, v + 0.025, z0, z1, 0x3a3934);
}

/** Gyrophare orange (chariot élévateur, camions de la base). */
function beacon(m: Mesh, u: number, v: number, z: number): void {
  m.box(u - 0.035, u + 0.035, v - 0.035, v + 0.035, z, z + 2, 0xe8902a);
  m.box(u - 0.02, u + 0.02, v - 0.02, v + 0.02, z + 2, z + 2.6, 0xffd070, false);
}

/** Roues jumelées sur un essieu (deux côtés). */
function axle(m: Mesh, u: number, r: number, color = TIRE): void {
  m.cyl('v', 0.06, 0.22, u, r, r / 26, r, color, 8);
  m.cyl('v', 0.78, 0.94, u, r, r / 26, r, color, 8);
}

/** Cabine avancée commune aux camions (avant en u ≈ 2). */
function cab(m: Mesh, color: number): void {
  const dark = shadeColor(color, 0.55);
  m.box(1.36, 1.78, 0.12, 0.88, 6, 18, color);
  m.box(1.34, 1.8, 0.1, 0.9, 18, 19.5, shadeColor(color, 1.05));
  m.box(1.78, 1.97, 0.2, 0.8, 6, 12.5, color); // capot
  m.box(1.96, 2.0, 0.12, 0.88, 4.5, 7, dark); // pare-chocs
  m.box(1.44, 1.84, 0.06, 0.94, 8.5, 9.5, color); // ailes
  // Pare-brise, vitres latérales, calandre, phares
  m.quad([[1.78, 0.16, 17], [1.78, 0.84, 17], [1.78, 0.84, 13], [1.78, 0.16, 13]], GLASS, [1, 0, 0]);
  m.quad([[1.46, 0.88, 16.5], [1.72, 0.88, 16.5], [1.72, 0.88, 12.5], [1.46, 0.88, 12.5]], GLASS, [0, 1, 0]);
  m.quad([[1.46, 0.12, 16.5], [1.72, 0.12, 16.5], [1.72, 0.12, 12.5], [1.46, 0.12, 12.5]], GLASS, [0, -1, 0]);
  m.quad([[1.97, 0.28, 11], [1.97, 0.72, 11], [1.97, 0.72, 7.5], [1.97, 0.28, 7.5]], dark, [1, 0, 0]);
  m.quad([[1.97, 0.2, 10], [1.97, 0.27, 10], [1.97, 0.27, 8.5], [1.97, 0.2, 8.5]], 0xe8d890, [1, 0, 0], 0.03);
  m.quad([[1.97, 0.73, 10], [1.97, 0.8, 10], [1.97, 0.8, 8.5], [1.97, 0.73, 8.5]], 0xe8d890, [1, 0, 0], 0.03);
  // Rétroviseurs
  m.box(1.7, 1.74, 0.0, 0.08, 12.5, 16, dark);
  m.box(1.7, 1.74, 0.92, 1.0, 12.5, 16, dark);
}

function chassis(m: Mesh, color: number): void {
  m.box(0.12, 1.92, 0.24, 0.76, 3, 6, shadeColor(color, 0.5));
  axle(m, 0.4, 4.5);
  axle(m, 0.8, 4.5);
  axle(m, 1.62, 4.5);
}

/** Camion FMTV M1083 (6×6) : cabine avancée à face plate, plateau bâché sur arceaux. */
function cargoTruck(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.55);
  chassis(m, color);
  m.box(0.1, 1.4, 0.1, 0.9, 6, 8, shadeColor(color, 0.85)); // plateau
  m.box(0.1, 1.4, 0.08, 0.12, 8, 12, color); // ridelles
  m.box(0.1, 1.4, 0.88, 0.92, 8, 12, color);
  // Bâche sur arceaux, toit arrondi
  m.box(0.12, 1.38, 0.1, 0.9, 12, 19, accent);
  m.cyl('u', 0.12, 1.38, 0.5, 19, 0.4, 2.6, shadeColor(accent, 1.05), 10);
  for (const u of [0.42, 0.78, 1.12]) m.box(u - 0.012, u + 0.012, 0.095, 0.905, 12, 19.4, shadeColor(accent, 0.78), false, 0.01);
  m.box(0.14, 1.36, 0.095, 0.905, 15.2, 15.6, shadeColor(accent, 0.7), false, 0.01); // sangle de bâche
  // Arrière ouvert : pénombre et bord de palette
  m.quad([[0.1, 0.16, 18.5], [0.1, 0.84, 18.5], [0.1, 0.84, 8.5], [0.1, 0.16, 8.5]], 0x2a2820, [-1, 0, 0], 0.03);
  m.box(0.1, 0.14, 0.24, 0.76, 8, 10.5, WOOD, false, 0.04);
  // Cabine avancée à face plate
  m.box(1.42, 1.96, 0.1, 0.9, 6, 20, color);
  m.box(1.4, 1.98, 0.08, 0.92, 20, 21.2, shadeColor(color, 1.05)); // toit
  m.cyl('v', 0.38, 0.62, 1.7, 21.8, 0.12, 0.8, dark, 8); // tourelle annulaire
  m.quad([[1.96, 0.14, 19], [1.96, 0.48, 19], [1.96, 0.48, 14.5], [1.96, 0.14, 14.5]], GLASS, [1, 0, 0]);
  m.quad([[1.96, 0.52, 19], [1.96, 0.86, 19], [1.96, 0.86, 14.5], [1.96, 0.52, 14.5]], GLASS, [1, 0, 0]);
  for (const z of [8.4, 9.9, 11.4]) m.quad([[1.96, 0.3, z + 0.7], [1.96, 0.7, z + 0.7], [1.96, 0.7, z], [1.96, 0.3, z]], dark, [1, 0, 0], 0.03); // calandre
  m.quad([[1.96, 0.13, 10.5], [1.96, 0.24, 10.5], [1.96, 0.24, 8.8], [1.96, 0.13, 8.8]], 0xe8d890, [1, 0, 0], 0.03);
  m.quad([[1.96, 0.76, 10.5], [1.96, 0.87, 10.5], [1.96, 0.87, 8.8], [1.96, 0.76, 8.8]], 0xe8d890, [1, 0, 0], 0.03);
  m.box(1.96, 2.02, 0.06, 0.94, 4.5, 7, dark); // pare-chocs
  m.box(2.0, 2.05, 0.2, 0.27, 5, 6.5, 0xa83a2a); // crochets de remorquage rouges
  m.box(2.0, 2.05, 0.73, 0.8, 5, 6.5, 0xa83a2a);
  m.quad([[1.55, 0.9, 18.5], [1.9, 0.9, 18.5], [1.9, 0.9, 14.5], [1.55, 0.9, 14.5]], GLASS, [0, 1, 0]);
  m.quad([[1.55, 0.1, 18.5], [1.9, 0.1, 18.5], [1.9, 0.1, 14.5], [1.55, 0.1, 14.5]], GLASS, [0, -1, 0]);
  m.box(1.5, 1.72, 0.04, 0.1, 6.5, 7.3, dark); // marchepieds
  m.box(1.5, 1.72, 0.9, 0.96, 6.5, 7.3, dark);
  // Rétroviseurs sur bras
  m.box(1.88, 1.92, -0.12, 0.1, 17, 17.6, dark, false);
  m.box(1.88, 1.92, -0.14, -0.08, 13, 18.5, dark);
  m.box(1.88, 1.92, 0.9, 1.12, 17, 17.6, dark, false);
  m.box(1.88, 1.92, 1.08, 1.14, 13, 18.5, dark);
  // Réservoir latéral, roue de secours, coffre, jerrican, échappement, antenne
  m.cyl('u', 1.02, 1.36, 0.06, 6.5, 0.06, 2.2, dark, 8);
  m.cyl('v', 0.86, 0.98, 1.05, 5, 0.12, 3.6, TIRE, 8);
  m.box(0.6, 0.95, 0.02, 0.1, 3.5, 6, dark);
  jerrycan(m, 1.36, 0.94, 8);
  exhaust(m, 1.4, 0.92, 8, 23);
  m.box(1.44, 1.47, 0.14, 0.17, 21, 33, 0x1e1d18);
  m.box(0.1, 0.12, 0.1, 0.24, 3, 6, 0x1e1d18, false); // garde-boue
  m.box(0.1, 0.12, 0.76, 0.9, 3, 6, 0x1e1d18, false);
  m.quad([[0.1, 0.4, 7.5], [0.1, 0.6, 7.5], [0.1, 0.6, 6], [0.1, 0.4, 6]], 0xe8e4d0, [-1, 0, 0], 0.04);
  // Plis de la bâche, feux arrière, catadioptres, panneau VS-17, numéro de convoi
  for (const u of [0.25, 0.6, 0.95, 1.28]) m.box(u - 0.006, u + 0.006, 0.098, 0.902, 12.5, 18.5, shadeColor(accent, 0.86), false, 0.012);
  m.quad([[0.1, 0.12, 7.5], [0.1, 0.2, 7.5], [0.1, 0.2, 6.2], [0.1, 0.12, 6.2]], 0xb03028, [-1, 0, 0], 0.05);
  m.quad([[0.1, 0.8, 7.5], [0.1, 0.88, 7.5], [0.1, 0.88, 6.2], [0.1, 0.8, 6.2]], 0xb03028, [-1, 0, 0], 0.05);
  vs17(m, 1.5, 1.85, 0.2, 0.36, 21.25);
  stencil(m, 1.6, 1.8, 0.905, 9, 10.5);
}

function tankerTruck(m: Mesh, color: number, accent: number, placard: number): void {
  const dark = shadeColor(color, 0.55);
  // Châssis HEMTT 8×8 : deux essieux avant, deux arrière
  m.box(0.12, 1.92, 0.24, 0.76, 3, 6, shadeColor(color, 0.5));
  for (const u of [0.32, 0.64, 1.46, 1.74]) axle(m, u, 4.5);
  m.box(0.44, 0.52, 0.06, 0.94, 8.5, 9.5, color, false); // ailes arrière
  m.box(1.56, 1.64, 0.06, 0.94, 8.5, 9.5, color, false);
  // Passerelle et garde-corps sur la citerne, armoire de pompage et enrouleurs à l'arrière
  m.box(0.3, 1.2, 0.44, 0.56, 21, 21.6, dark, false, 0.02);
  for (const u of [0.32, 0.75, 1.18]) m.box(u - 0.01, u + 0.01, 0.42, 0.44, 21.6, 25, dark, false, 0.03);
  m.box(0.3, 1.2, 0.42, 0.44, 24.6, 25.2, dark, false, 0.03);
  m.box(0.02, 0.12, 0.14, 0.86, 6, 15, color);
  m.cyl('v', 0.2, 0.42, 0.06, 11, 0.05, 2.6, TIRE, 8);
  m.cyl('v', 0.58, 0.8, 0.06, 11, 0.05, 2.6, TIRE, 8);
  m.box(0.1, 1.34, 0.18, 0.82, 6, 7.5, dark); // berceau
  m.cyl('u', 0.12, 1.3, 0.5, 13.5, 0.36, 7, accent, 10); // citerne
  for (const u of [0.32, 0.72, 1.1]) m.cyl('u', u, u + 0.04, 0.5, 13.5, 0.375, 7.4, shadeColor(accent, 0.7), 10, false, 0.01);
  m.box(0.64, 0.8, 0.43, 0.57, 20, 21.6, dark); // trou d'homme
  m.box(0.12, 0.15, 0.4, 0.44, 15, 21, dark); // échelle arrière
  m.box(0.12, 0.15, 0.56, 0.6, 15, 21, dark);
  m.cyl('v', 0.3, 0.7, 0.2, 5, 0.07, 2, STEEL, 6); // flexible
  m.quad([[0.58, 0.87, 12.5], [0.8, 0.87, 12.5], [0.8, 0.87, 9], [0.58, 0.87, 9]], placard, [0, 1, 0], 0.05);
  m.quad([[0.58, 0.13, 12.5], [0.8, 0.13, 12.5], [0.8, 0.13, 9], [0.58, 0.13, 9]], placard, [0, -1, 0], 0.05);
  cab(m, color);
  m.cyl('u', 1.2, 1.3, 0.92, 7.5, 0.04, 1.6, 0xc0302a, 6); // extincteur
  exhaust(m, 1.33, 0.9, 8, 22);
  beacon(m, 1.56, 0.5, 19.5);
  // Bandes de danger sur le pare-chocs arrière, feux, numéro
  for (let i = 0; i < 5; i++) m.quad([[0.02, 0.15 + i * 0.14, 6], [0.02, 0.22 + i * 0.14, 6], [0.02, 0.22 + i * 0.14, 4.6], [0.02, 0.15 + i * 0.14, 4.6]], i % 2 ? 0x1e1d18 : 0xd8c040, [-1, 0, 0], 0.05);
  m.quad([[0.02, 0.15, 9], [0.02, 0.22, 9], [0.02, 0.22, 7.8], [0.02, 0.15, 7.8]], 0xb03028, [-1, 0, 0], 0.05);
  m.quad([[0.02, 0.78, 9], [0.02, 0.85, 9], [0.02, 0.85, 7.8], [0.02, 0.78, 7.8]], 0xb03028, [-1, 0, 0], 0.05);
  stencil(m, 1.5, 1.68, 0.885, 8.5, 10);
}

function forklift(m: Mesh, color: number): void {
  const dark = 0x2e2d28;
  m.cyl('v', 0.22, 0.32, 0.62, 3, 0.12, 3, TIRE, 8);
  m.cyl('v', 0.68, 0.78, 0.62, 3, 0.12, 3, TIRE, 8);
  m.box(0.46, 1.16, 0.3, 0.7, 2, 10, color); // châssis
  m.box(0.42, 0.56, 0.3, 0.7, 3, 11.5, shadeColor(color, 0.8)); // contrepoids
  m.cyl('v', 0.22, 0.32, 1.06, 3.5, 0.14, 3.5, TIRE, 8);
  m.cyl('v', 0.68, 0.78, 1.06, 3.5, 0.14, 3.5, TIRE, 8);
  m.box(0.72, 0.94, 0.38, 0.62, 10, 13, dark); // siège
  m.box(0.76, 0.92, 0.41, 0.59, 13, 19, 0x6b7046); // cariste
  m.box(0.79, 0.89, 0.44, 0.56, 19, 23, 0xc9a07a);
  m.box(0.78, 0.9, 0.43, 0.57, 22.5, 24, 0xd8c47a); // casque
  for (const [u, v] of [
    [0.6, 0.3],
    [0.6, 0.66],
    [1.06, 0.3],
    [1.06, 0.66],
  ] as [number, number][]) {
    m.box(u, u + 0.04, v, v + 0.04, 10, 26, dark); // arceau
  }
  m.box(0.58, 1.12, 0.28, 0.72, 26, 27.5, dark);
  m.box(1.16, 1.22, 0.3, 0.36, 2, 29, dark); // mât
  m.box(1.16, 1.22, 0.64, 0.7, 2, 29, dark);
  m.box(1.16, 1.22, 0.3, 0.7, 13, 15, dark);
  m.box(1.22, 1.26, 0.3, 0.7, 3, 11, shadeColor(dark, 1.3)); // tablier
  m.box(1.26, 1.78, 0.34, 0.4, 2, 3, STEEL); // fourches
  m.box(1.26, 1.78, 0.6, 0.66, 2, 3, STEEL);
  beacon(m, 0.85, 0.5, 27.5);
  m.box(0.42, 0.5, 0.2, 0.3, 4, 9, 0xd8c040, false); // bande de sécurité du contrepoids
  m.box(0.42, 0.5, 0.7, 0.8, 4, 9, 0xd8c040, false);
}

function helicopter(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.6);
  // Train d'atterrissage
  m.cyl('v', 0.14, 0.24, 2.15, 2.6, 0.09, 2.6, TIRE, 6);
  m.cyl('v', 0.76, 0.86, 2.15, 2.6, 0.09, 2.6, TIRE, 6);
  m.box(2.13, 2.17, 0.2, 0.24, 2.5, 9, dark);
  m.box(2.13, 2.17, 0.76, 0.8, 2.5, 9, dark);
  m.cyl('v', 0.46, 0.54, 0.42, 2.2, 0.07, 2.2, TIRE, 6);
  // Queue
  m.cyl('u', 0.06, 0.6, 0.5, 16.5, 0.07, 2.8, color, 6);
  m.cyl('u', 0.55, 1.25, 0.5, 15, 0.15, 4.8, color, 8);
  m.box(0.02, 0.24, 0.47, 0.53, 16, 31, color); // dérive
  m.box(0.1, 0.26, 0.24, 0.76, 18.5, 19.8, color); // stabilisateur
  // Fuselage, nez, verrière
  m.cyl('u', 1.2, 2.32, 0.5, 13, 0.33, 9, color, 10);
  m.box(1.45, 1.95, 0.08, 0.92, 9.5, 11.5, accent); // ailerons d'emport
  m.cyl('u', 2.3, 2.64, 0.5, 12, 0.27, 7, color, 10);
  m.cyl('u', 2.62, 2.78, 0.5, 11, 0.17, 4.5, color, 8);
  m.cyl('u', 2.32, 2.62, 0.5, 15.6, 0.2, 3.6, GLASS, 8, false, 0.02);
  m.quad([[1.92, 0.835, 18], [2.22, 0.835, 18], [2.22, 0.835, 13.5], [1.92, 0.835, 13.5]], GLASS, [0, 1, 0], 0.03);
  m.quad([[1.3, 0.83, 18.5], [1.82, 0.83, 18.5], [1.82, 0.83, 9.5], [1.3, 0.83, 9.5]], dark, [0, 1, 0], 0.025); // porte
  // Capots moteurs et moyeu
  m.box(1.38, 2.05, 0.34, 0.66, 21, 25, shadeColor(color, 0.9));
  m.box(1.25, 1.4, 0.36, 0.64, 21.5, 24, dark);
  m.box(1.7, 1.8, 0.45, 0.55, 25, 28.5, dark);
  m.box(1.0, 1.06, 0.47, 0.53, 19.5, 21, 0xd04030, false); // feu anticollision
  m.box(1.85, 1.95, 0.85, 0.89, 14, 15, 0x1e1d18); // mitrailleuse de porte
  m.box(2.25, 2.28, 0.48, 0.51, 4, 6.5, 0x1e1d18, false); // antenne ventrale
}

/** UH-60 Black Hawk : cabine trapue, verrière ample, moteurs jumeaux, longue poutre, dérive en flèche. */
function blackhawk(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.55);
  // Train principal sur jambes et roulette de queue
  m.cyl('v', 0.04, 0.14, 2.0, 2.6, 0.09, 2.6, TIRE, 6);
  m.cyl('v', 0.86, 0.96, 2.0, 2.6, 0.09, 2.6, TIRE, 6);
  m.box(1.97, 2.03, 0.12, 0.26, 2.5, 9, dark);
  m.box(1.97, 2.03, 0.74, 0.88, 2.5, 9, dark);
  m.cyl('v', 0.47, 0.53, 0.32, 2, 0.06, 2, TIRE, 6);
  m.box(0.3, 0.34, 0.48, 0.52, 2, 13, dark);
  // Poutre de queue, dérive en flèche, stabilateur
  m.cyl('u', 0.12, 1.15, 0.5, 16, 0.1, 3, color, 6);
  m.box(0.02, 0.2, 0.47, 0.53, 15, 29, color);
  m.box(0.0, 0.1, 0.47, 0.53, 29, 33, color);
  m.box(0.04, 0.2, 0.16, 0.84, 15.4, 16.4, color);
  // Cabine, ventre plat, nez
  m.cyl('u', 1.1, 2.35, 0.5, 12.5, 0.31, 8.5, color, 10);
  m.box(1.2, 2.25, 0.22, 0.78, 4.5, 9, shadeColor(color, 0.9));
  m.cyl('u', 2.35, 2.72, 0.5, 11.5, 0.27, 6.5, color, 10);
  m.cyl('u', 2.7, 2.86, 0.5, 10.5, 0.16, 4, color, 8);
  m.cyl('u', 2.38, 2.7, 0.5, 15.6, 0.23, 3.2, GLASS, 8, false, 0.02); // verrière
  m.quad([[2.08, 0.81, 18], [2.32, 0.81, 18], [2.32, 0.81, 13], [2.08, 0.81, 13]], GLASS, [0, 1, 0], 0.03);
  // Porte coulissante de cabine avec hublot, mitrailleuse de sabord
  m.quad([[1.42, 0.81, 18.5], [1.98, 0.81, 18.5], [1.98, 0.81, 8.5], [1.42, 0.81, 8.5]], dark, [0, 1, 0], 0.025);
  m.quad([[1.55, 0.815, 17], [1.85, 0.815, 17], [1.85, 0.815, 13.5], [1.55, 0.815, 13.5]], GLASS, [0, 1, 0], 0.03);
  m.box(1.9, 2.15, 0.84, 0.88, 14, 15, 0x1e1d18);
  // Capots moteurs jumeaux, suppresseurs infrarouges, mât
  m.box(1.35, 2.15, 0.3, 0.7, 20, 23.5, shadeColor(color, 0.92));
  for (const v of [0.3, 0.7]) m.cyl('u', 1.45, 2.08, v, 22.3, 0.1, 2.4, accent, 8);
  m.box(1.2, 1.42, 0.14, 0.28, 20.5, 23, dark);
  m.box(1.2, 1.42, 0.72, 0.86, 20.5, 23, dark);
  m.box(1.72, 1.82, 0.45, 0.55, 23.5, 28.5, dark);
  // Coupe-câbles, feu anticollision, antennes
  m.box(2.52, 2.56, 0.48, 0.52, 18, 21.5, dark);
  m.box(2.7, 2.74, 0.48, 0.52, 3.5, 7, dark);
  m.box(1.0, 1.06, 0.47, 0.53, 19, 20.5, 0xd04030, false);
  m.box(2.25, 2.28, 0.48, 0.51, 3.5, 6, 0x1e1d18, false);
  // Ailes ESSS avec réservoirs externes, boule FLIR sous le nez, numéro de queue, feux de navigation
  m.box(1.5, 1.66, -0.15, 1.15, 17.5, 18.4, shadeColor(color, 0.9), true, 0.05);
  for (const v of [-0.1, 1.1]) m.cyl('u', 1.3, 1.86, v, 15.5, 0.08, 2.2, accent, 8, true, 0.06);
  m.cyl('v', 0.44, 0.56, 2.66, 4.5, 0.06, 1.8, 0x2a3a40, 8);
  stencil(m, 0.4, 0.75, 0.6, 15.2, 16.8);
  m.box(1.5, 1.54, -0.16, -0.12, 17.6, 18.6, 0xd04030, false, 0.07);
  m.box(1.5, 1.54, 1.12, 1.16, 17.6, 18.6, 0x40b050, false, 0.07);
}

/** CH-47 Chinook : long fuselage rectangulaire, deux rotors en tandem, pylône arrière haut, rampe. */
function chinook(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.55);
  // Quatre roues
  for (const u of [0.55, 0.78, 2.3]) {
    m.cyl('v', 0.06, 0.16, u, 2.4, 0.08, 2.4, TIRE, 6);
    m.cyl('v', 0.84, 0.94, u, 2.4, 0.08, 2.4, TIRE, 6);
  }
  // Fuselage à section carrée et toit arrondi, sponsons latéraux
  m.box(0.15, 2.65, 0.16, 0.84, 4.5, 17, color);
  m.cyl('u', 0.15, 2.65, 0.5, 17, 0.34, 3.4, color, 10);
  m.box(0.55, 2.2, 0.05, 0.16, 4.5, 11, shadeColor(color, 0.9));
  m.box(0.55, 2.2, 0.84, 0.95, 4.5, 11, shadeColor(color, 0.9));
  // Nez et poste de pilotage
  m.box(2.65, 2.9, 0.2, 0.8, 5.5, 16, color);
  m.cyl('u', 2.86, 2.98, 0.5, 10.5, 0.27, 5, color, 8);
  m.quad([[2.9, 0.24, 15.5], [2.9, 0.76, 15.5], [2.9, 0.76, 11.5], [2.9, 0.24, 11.5]], GLASS, [1, 0, 0], 0.03);
  m.quad([[2.62, 0.84, 15.5], [2.86, 0.84, 15.5], [2.86, 0.84, 11.5], [2.62, 0.84, 11.5]], GLASS, [0, 1, 0], 0.03);
  // Rangée de hublots
  for (let u = 0.75; u < 2.3; u += 0.3) m.quad([[u, 0.845, 14.5], [u + 0.1, 0.845, 14.5], [u + 0.1, 0.845, 12.5], [u, 0.845, 12.5]], GLASS, [0, 1, 0], 0.03);
  // Pylône avant (rotor avant) et pylône arrière haut (rotor arrière)
  // (dessinés après le fuselage : décalage de tri)
  m.box(2.35, 2.75, 0.36, 0.64, 17, 23.5, color, true, 0.4);
  m.box(2.5, 2.62, 0.45, 0.55, 23.5, 27, dark, true, 0.45);
  m.box(0.12, 0.66, 0.28, 0.72, 17, 30, color, true, 1.6);
  m.box(0.28, 0.4, 0.45, 0.55, 30, 34, dark, true, 1.7);
  // Turbines de part et d'autre du pylône arrière
  for (const v of [0.18, 0.82]) {
    m.cyl('u', 0.2, 0.82, v, 23, 0.11, 3, accent, 8, true, v > 0.5 ? 1.8 : 1.5);
    m.cyl('u', 0.18, 0.2, v, 23, 0.07, 1.8, 0x1a1a18, 8, false, v > 0.5 ? 1.85 : 1.55);
  }
  // Rampe arrière, crochets de charge, feu anticollision
  m.quad([[0.15, 0.24, 14], [0.15, 0.76, 14], [0.15, 0.76, 5], [0.15, 0.24, 5]], dark, [-1, 0, 0], 0.03);
  m.box(1.35, 1.6, 0.42, 0.58, 3.5, 4.5, dark, false);
  m.box(1.4, 1.46, 0.47, 0.53, 20, 21.5, 0xd04030, false);
  // Perche de ravitaillement en vol (MH-47), réservoirs le long des sponsons, numéro de rampe
  m.box(2.9, 3.0, 0.7, 0.76, 9, 10, dark);
  m.box(2.95, 3.0, 0.72, 0.74, 9.2, 9.8, 0x1e1d18, false);
  for (const v of [0.02, 0.98]) m.cyl('u', 0.9, 1.9, v, 8, 0.05, 2.2, shadeColor(color, 0.85), 8, true, 0.05);
  stencil(m, 0.5, 0.8, 0.845, 8, 9.5);
  m.box(1.95, 2.0, 0.84, 0.86, 16, 17, 0x40b050, false, 0.05); // feux de navigation
  m.box(1.95, 2.0, 0.14, 0.16, 16, 17, 0xd04030, false, 0.05);
}

/** Toyota Land Cruiser blindé : caisse haute, vitres teintées, galerie, pare-buffle, snorkel. */
function suv(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.6);
  const tint = 0x1a1e22;
  for (const u of [0.42, 1.52]) {
    m.cyl('v', 0.04, 0.18, u, 4.2, 4.2 / 26, 4.2, TIRE, 8);
    m.cyl('v', 0.82, 0.96, u, 4.2, 4.2 / 26, 4.2, TIRE, 8);
  }
  m.box(0.1, 1.9, 0.14, 0.86, 3.5, 6.5, dark); // bas de caisse
  m.box(0.06, 1.4, 0.08, 0.92, 6.5, 13.5, color); // caisse
  m.box(1.4, 1.94, 0.1, 0.9, 6.5, 12, color); // capot
  m.box(0.1, 1.32, 0.1, 0.9, 13.5, 19, color); // habitacle
  m.box(0.08, 1.34, 0.08, 0.92, 19, 19.8, shadeColor(color, 1.1)); // toit
  m.quad([[1.32, 0.14, 19], [1.32, 0.86, 19], [1.42, 0.86, 13.5], [1.42, 0.14, 13.5]], tint, [1, 0, 0.5]); // pare-brise incliné
  for (const [u0, u1] of [[0.95, 1.28], [0.52, 0.9], [0.14, 0.48]] as [number, number][]) {
    m.quad([[u0, 0.9, 18.6], [u1, 0.9, 18.6], [u1, 0.9, 14], [u0, 0.9, 14]], tint, [0, 1, 0]);
    m.quad([[u0, 0.1, 18.6], [u1, 0.1, 18.6], [u1, 0.1, 14], [u0, 0.1, 14]], tint, [0, -1, 0]);
  }
  m.quad([[0.06, 0.18, 18.4], [0.06, 0.82, 18.4], [0.06, 0.82, 14.5], [0.06, 0.18, 14.5]], tint, [-1, 0, 0]);
  // Galerie de toit, pare-buffle, snorkel, roue de secours sur le hayon
  m.box(0.18, 1.2, 0.14, 0.86, 20.2, 20.8, 0x2a2a26, false, 0.01);
  for (const u of [0.2, 0.7, 1.18]) m.box(u - 0.02, u + 0.02, 0.14, 0.86, 19.8, 21.4, 0x2a2a26, false, 0.02);
  m.box(0.4, 0.9, 0.24, 0.6, 20.8, 22.5, accent, false, 0.02); // bagages
  m.box(1.93, 1.99, 0.14, 0.86, 4, 11, 0x2a2a26);
  for (const v of [0.3, 0.5, 0.7]) m.box(1.96, 2.0, v - 0.02, v + 0.02, 5, 11.5, 0x2a2a26, false, 0.02);
  m.box(1.38, 1.43, 0.88, 0.94, 8, 20, 0x2a2a26); // snorkel
  m.cyl('u', 0.0, 0.06, 0.55, 11, 0.15, 4, TIRE, 8);
  m.quad([[1.94, 0.15, 10.8], [1.94, 0.28, 10.8], [1.94, 0.28, 9.4], [1.94, 0.15, 9.4]], 0xe8e4d0, [1, 0, 0], 0.03);
  m.quad([[1.94, 0.72, 10.8], [1.94, 0.85, 10.8], [1.94, 0.85, 9.4], [1.94, 0.72, 9.4]], 0xe8e4d0, [1, 0, 0], 0.03);
  m.quad([[0.06, 0.12, 12], [0.06, 0.2, 12], [0.06, 0.2, 9.5], [0.06, 0.12, 9.5]], 0xb03028, [-1, 0, 0], 0.03); // feux arrière
  m.quad([[0.06, 0.8, 12], [0.06, 0.88, 12], [0.06, 0.88, 9.5], [0.06, 0.8, 9.5]], 0xb03028, [-1, 0, 0], 0.03);
  m.box(0.3, 0.33, 0.2, 0.23, 19.8, 31, 0x1e1d18); // antennes
  m.box(0.3, 0.33, 0.77, 0.8, 19.8, 28, 0x1e1d18);
  // Feux de pare-buffle, pare-soleil, plaque
  m.box(1.96, 2.0, 0.22, 0.3, 11.5, 12.5, 0xe8e4d0, false, 0.05);
  m.box(1.96, 2.0, 0.7, 0.78, 11.5, 12.5, 0xe8e4d0, false, 0.05);
  m.quad([[1.95, 0.4, 7.5], [1.95, 0.6, 7.5], [1.95, 0.6, 6.4], [1.95, 0.4, 6.4]], 0xe8e4d0, [1, 0, 0], 0.05);
}

/** MH-6 Little Bird : fuselage en œuf, grande bulle vitrée, patins, banquettes extérieures, petite queue en T. */
function littleBird(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.6);
  // Patins et traverses
  m.box(0.55, 1.75, 0.08, 0.14, 0.5, 1.6, dark);
  m.box(0.55, 1.75, 0.86, 0.92, 0.5, 1.6, dark);
  m.box(1.68, 1.78, 0.08, 0.14, 1.2, 2.6, dark, false); // pointe relevée des patins
  m.box(1.68, 1.78, 0.86, 0.92, 1.2, 2.6, dark, false);
  for (const u of [0.85, 1.45]) {
    m.box(u - 0.025, u + 0.025, 0.11, 0.2, 1.6, 7, dark);
    m.box(u - 0.025, u + 0.025, 0.8, 0.89, 1.6, 7, dark);
  }
  // Banquettes extérieures des opérateurs, de part et d'autre
  m.box(0.8, 1.5, 0.0, 0.16, 6.5, 7.5, accent);
  m.box(0.8, 1.5, 0.84, 1.0, 6.5, 7.5, accent);
  m.box(0.8, 0.84, 0.0, 0.04, 7.5, 10, dark, false, 0.02); // dosseret
  m.box(0.8, 0.84, 0.96, 1.0, 7.5, 10, dark, false, 0.02);
  // Fuselage en œuf et bulle vitrée
  m.cyl('u', 0.85, 1.55, 0.5, 12, 0.32, 7, color, 10);
  m.cyl('u', 1.5, 1.82, 0.5, 11.5, 0.27, 6, color, 10);
  m.cyl('u', 1.42, 1.9, 0.5, 13.5, 0.26, 5, GLASS, 10, false, 0.02);
  m.cyl('u', 1.85, 1.95, 0.5, 11, 0.16, 3.5, GLASS, 8, false, 0.03);
  m.box(1.1, 1.4, 0.3, 0.7, 17, 19, shadeColor(color, 0.9)); // capot moteur
  m.box(1.08, 1.22, 0.45, 0.55, 19, 21, dark); // mât
  m.box(0.95, 1.05, 0.44, 0.56, 13, 16, 0x1a1a18, false, 0.02); // échappement
  // Poutre de queue fine, empennage en T, rotor de queue
  m.cyl('u', 0.08, 0.9, 0.5, 13.5, 0.06, 1.8, color, 6);
  m.box(0.02, 0.14, 0.47, 0.53, 12, 19, color);
  m.box(0.0, 0.12, 0.3, 0.7, 18.5, 19.5, color);
  m.box(0.02, 0.1, 0.42, 0.45, 15.5, 18.5, dark, false, 0.02);
  // Antennes, feu, sonde de nez (FLIR)
  m.box(1.9, 1.98, 0.46, 0.54, 7, 9, 0x2a3a40);
  m.box(0.6, 0.64, 0.48, 0.52, 15, 15.8, 0xd04030, false);
}

/** Hélicoptère d'attaque : fuselage étroit, verrières en tandem, ailerons à roquettes, canon sous le nez. */
function attackHelo(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.55);
  // Train à roues
  m.cyl('v', 0.26, 0.34, 2.05, 2.4, 0.08, 2.4, TIRE, 6);
  m.cyl('v', 0.66, 0.74, 2.05, 2.4, 0.08, 2.4, TIRE, 6);
  m.box(2.03, 2.07, 0.28, 0.32, 2.3, 7, dark);
  m.box(2.03, 2.07, 0.68, 0.72, 2.3, 7, dark);
  m.cyl('v', 0.47, 0.53, 0.3, 2, 0.06, 2, TIRE, 6);
  // Poutre de queue, dérive, stabilisateur
  m.cyl('u', 0.05, 1.2, 0.5, 14, 0.09, 3.2, color, 6);
  m.box(0.0, 0.22, 0.47, 0.53, 13, 27, color);
  m.box(0.05, 0.22, 0.3, 0.7, 13, 14.2, color);
  // Fuselage étroit et nez
  m.cyl('u', 1.15, 2.55, 0.5, 11.5, 0.22, 7, color, 10);
  m.cyl('u', 2.55, 2.85, 0.5, 10.5, 0.15, 4.5, color, 8);
  // Verrières en tandem
  m.cyl('u', 2.15, 2.5, 0.5, 15.5, 0.15, 3.4, GLASS, 8, false, 0.02);
  m.cyl('u', 1.75, 2.1, 0.5, 16.5, 0.15, 3.6, GLASS, 8, false, 0.02);
  // Nacelles moteurs
  m.cyl('u', 1.45, 1.95, 0.32, 16, 0.08, 2.6, accent, 6);
  m.cyl('u', 1.45, 1.95, 0.68, 16, 0.08, 2.6, accent, 6);
  // Ailerons d'emport : paniers de roquettes à l'intérieur, rails de missiles Hellfire à l'extérieur
  m.box(1.6, 1.85, 0.0, 1.0, 10.5, 11.5, color);
  for (const v of [0.2, 0.8]) m.cyl('u', 1.45, 1.95, v, 8.6, 0.07, 2, dark, 6, false, 0.02);
  for (const v of [0.03, 0.97]) {
    m.box(1.58, 1.88, v - 0.04, v + 0.04, 9.6, 10.5, dark, false, 0.02);
    for (const dz of [8.2, 9.4]) for (const dv of [-0.025, 0.025]) m.cyl('u', 1.52, 1.92, v + dv, dz, 0.018, 0.55, 0x8c8a78, 6, false, 0.03);
  }
  // Tourelle de visée (TADS/PNVS) au nez, canon de 30 mm sous le menton
  m.box(2.8, 2.96, 0.38, 0.62, 6, 9.5, dark);
  m.quad([[2.96, 0.42, 9], [2.96, 0.58, 9], [2.96, 0.58, 6.5], [2.96, 0.42, 6.5]], 0x30404a, [1, 0, 0], 0.03);
  m.box(2.36, 2.5, 0.42, 0.58, 3.5, 7, dark);
  m.box(2.5, 2.85, 0.485, 0.515, 4.3, 5.2, 0x1e1d18);
  // Échappements « trou noir » des moteurs, roulette de queue
  m.box(1.36, 1.46, 0.2, 0.28, 14.5, 17, 0x1a1a18);
  m.box(1.36, 1.46, 0.72, 0.8, 14.5, 17, 0x1a1a18);
  m.cyl('v', 0.47, 0.53, 0.12, 1.8, 0.06, 1.8, TIRE, 6);
  m.box(0.1, 0.14, 0.48, 0.52, 2, 12, dark);
  // Mât du rotor et radôme Longbow
  m.box(1.7, 1.8, 0.45, 0.55, 18.5, 22, dark);
  m.cyl('u', 1.67, 1.83, 0.5, 31, 0.1, 2, shadeColor(color, 0.85), 10);
  // Feux de navigation en bout d'ailerons, numéro de queue, tubes de leurres
  m.box(1.7, 1.75, -0.02, 0.02, 10.5, 11.6, 0xd04030, false, 0.07);
  m.box(1.7, 1.75, 0.98, 1.02, 10.5, 11.6, 0x40b050, false, 0.07);
  stencil(m, 0.35, 0.65, 0.59, 13, 14.5);
  m.box(1.2, 1.3, 0.28, 0.34, 12, 13.5, 0x2a2a26, false, 0.03);
}

/** Véhicule blindé résistant aux mines : coque en V, capot incliné, tourelle avec tireur. */
function mrap(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.5);
  // Quatre grandes roues
  m.cyl('v', 0.04, 0.2, 0.45, 5.5, 5.5 / 26, 5.5, TIRE, 8);
  m.cyl('v', 0.8, 0.96, 0.45, 5.5, 5.5 / 26, 5.5, TIRE, 8);
  m.cyl('v', 0.04, 0.2, 1.5, 5.5, 5.5 / 26, 5.5, TIRE, 8);
  m.cyl('v', 0.8, 0.96, 1.5, 5.5, 5.5 / 26, 5.5, TIRE, 8);
  // Coque en V et caisse
  m.box(0.15, 1.85, 0.25, 0.75, 3, 7, dark);
  m.box(0.08, 1.62, 0.1, 0.9, 7, 20, color);
  m.box(1.62, 1.95, 0.14, 0.86, 7, 14, color); // capot
  m.box(1.62, 1.8, 0.14, 0.86, 14, 17, shadeColor(color, 0.92)); // pare-brise incliné (épaisseur)
  m.box(1.92, 1.98, 0.12, 0.88, 5, 9, dark); // pare-buffle
  // Vitres blindées
  m.quad([[1.62, 0.18, 19], [1.62, 0.82, 19], [1.62, 0.82, 15], [1.62, 0.18, 15]], GLASS, [1, 0, 0]);
  m.quad([[1.15, 0.9, 18.5], [1.5, 0.9, 18.5], [1.5, 0.9, 14.5], [1.15, 0.9, 14.5]], GLASS, [0, 1, 0]);
  m.quad([[0.6, 0.9, 18.5], [1.05, 0.9, 18.5], [1.05, 0.9, 14.5], [0.6, 0.9, 14.5]], GLASS, [0, 1, 0]);
  m.quad([[1.15, 0.1, 18.5], [1.5, 0.1, 18.5], [1.5, 0.1, 14.5], [1.15, 0.1, 14.5]], GLASS, [0, -1, 0]);
  m.quad([[1.94, 0.2, 11.5], [1.94, 0.3, 11.5], [1.94, 0.3, 10], [1.94, 0.2, 10]], 0xe8d890, [1, 0, 0], 0.03);
  m.quad([[1.94, 0.7, 11.5], [1.94, 0.8, 11.5], [1.94, 0.8, 10], [1.94, 0.7, 10]], 0xe8d890, [1, 0, 0], 0.03);
  // Portes et marchepieds
  m.box(0.55, 1.5, 0.06, 0.1, 8, 9, dark);
  m.box(0.55, 1.5, 0.9, 0.94, 8, 9, dark);
  // Roue de secours à l'arrière
  m.cyl('u', 0.0, 0.08, 0.5, 13, 0.16, 4.5, TIRE, 8);
  // Tourelle et mitrailleuse
  m.cyl('v', 0.3, 0.7, 0.9, 21, 0.2, 1.5, accent, 8);
  m.box(0.82, 1.0, 0.3, 0.7, 21, 26, accent); // bouclier
  m.box(0.86, 0.96, 0.44, 0.56, 22, 27.5, 0x6b7046); // tireur
  m.box(0.87, 0.95, 0.45, 0.55, 27.5, 29.5, shadeColor(0x6b7046, 0.85)); // casque
  m.box(1.0, 1.45, 0.48, 0.52, 24, 25, 0x1e1d18); // canon
  m.box(0.1, 0.16, 0.2, 0.8, 20, 22, dark); // antennes (pied)
  m.box(0.12, 0.14, 0.24, 0.26, 22, 30, 0x1e1d18);
  m.box(0.12, 0.14, 0.74, 0.76, 22, 34, 0x1e1d18);
  m.box(0.2, 0.5, 0.02, 0.1, 9, 13, shadeColor(color, 0.8)); // coffres latéraux
  m.box(0.2, 0.5, 0.9, 0.98, 9, 13, shadeColor(color, 0.8));
  jerrycan(m, 0.3, 0.97, 13);
  m.box(1.55, 1.6, -0.04, 0.06, 16, 19, dark); // rétroviseurs
  m.box(1.55, 1.6, 0.94, 1.04, 16, 19, dark);
  m.box(0.05, 0.08, 0.62, 0.66, 4, 18, dark); // échelle arrière
  m.box(0.05, 0.08, 0.74, 0.78, 4, 18, dark);
  // Grande porte arrière à hublot blindé, antennes du brouilleur, feux ambrés, buffle
  m.quad([[0.08, 0.2, 18.5], [0.08, 0.58, 18.5], [0.08, 0.58, 8], [0.08, 0.2, 8]], shadeColor(color, 0.82), [-1, 0, 0], 0.025);
  m.quad([[0.08, 0.3, 17], [0.08, 0.48, 17], [0.08, 0.48, 14.5], [0.08, 0.3, 14.5]], GLASS, [-1, 0, 0], 0.03);
  for (const [u, v] of [[0.2, 0.14], [0.2, 0.86], [0.45, 0.86]] as [number, number][]) m.box(u - 0.015, u + 0.015, v - 0.015, v + 0.015, 20, 38, 0x1e1d18, false, 0.03);
  m.box(1.5, 1.56, 0.12, 0.18, 20, 21.5, 0xe8902a, false);
  m.box(1.5, 1.56, 0.82, 0.88, 20, 21.5, 0xe8902a, false);
  m.box(1.98, 2.04, 0.16, 0.84, 4.5, 6, dark);
  for (const v of [0.25, 0.5, 0.75]) m.box(1.98, 2.04, v - 0.03, v + 0.03, 4.5, 10, dark, false, 0.02);
  // Grilles de protection des vitres, panneau VS-17, numéro, feux arrière
  for (const [u0, u1] of [[0.6, 1.05], [1.15, 1.5]] as [number, number][]) {
    for (let i = 1; i < 4; i++) {
      const u = u0 + ((u1 - u0) * i) / 4;
      m.quad([[u - 0.006, 0.905, 18.5], [u + 0.006, 0.905, 18.5], [u + 0.006, 0.905, 14.5], [u - 0.006, 0.905, 14.5]], 0x1e1d18, [0, 1, 0], 0.05);
    }
  }
  vs17(m, 0.25, 0.6, 0.62, 0.86, 20.05);
  stencil(m, 0.2, 0.45, 0.905, 9.5, 11.5);
  m.quad([[0.08, 0.12, 12], [0.08, 0.18, 12], [0.08, 0.18, 10.5], [0.08, 0.12, 10.5]], 0xb03028, [-1, 0, 0], 0.05);
  m.quad([[0.08, 0.82, 12], [0.08, 0.88, 12], [0.08, 0.88, 10.5], [0.08, 0.82, 10.5]], 0xb03028, [-1, 0, 0], 0.05);
}

/** Charrette à deux grandes roues tirée par un âne, chargée de sacs. Avant (âne) en u = 2. */
function cart(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.6);
  // Roues en bois cerclées
  m.cyl('v', 0.08, 0.16, 0.55, 5.5, 5.5 / 26, 5.5, dark, 10);
  m.cyl('v', 0.84, 0.92, 0.55, 5.5, 5.5 / 26, 5.5, dark, 10);
  // Plateau et ridelles
  m.box(0.1, 1.05, 0.18, 0.82, 6, 8, color);
  m.box(0.1, 1.05, 0.16, 0.2, 8, 11, dark);
  m.box(0.1, 1.05, 0.8, 0.84, 8, 11, dark);
  m.box(0.08, 0.12, 0.18, 0.82, 8, 11, dark);
  // Sacs de grain
  m.box(0.2, 0.55, 0.25, 0.75, 8, 12, accent);
  m.box(0.6, 0.95, 0.3, 0.7, 8, 11.5, shadeColor(accent, 0.9));
  // Brancards
  m.box(1.05, 1.55, 0.3, 0.34, 7, 8, dark);
  m.box(1.05, 1.55, 0.66, 0.7, 7, 8, dark);
  // Âne : pattes, corps, cou, tête, oreilles
  const fur = 0x7d7468;
  for (const [u, v] of [[1.38, 0.4], [1.38, 0.6], [1.82, 0.4], [1.82, 0.6]] as [number, number][]) m.box(u - 0.03, u + 0.03, v - 0.03, v + 0.03, 0, 7, shadeColor(fur, 0.8), false);
  m.box(1.32, 1.88, 0.38, 0.62, 7, 12, fur);
  m.box(1.84, 1.96, 0.42, 0.58, 10, 15, fur);
  m.box(1.9, 2.0, 0.43, 0.57, 13, 16, shadeColor(fur, 0.9));
  m.box(1.88, 1.91, 0.44, 0.47, 16, 19, shadeColor(fur, 0.7), false);
  m.box(1.88, 1.91, 0.53, 0.56, 16, 19, shadeColor(fur, 0.7), false);
  // Couverture sur le dos
  m.box(1.45, 1.75, 0.36, 0.64, 12, 12.6, 0x8a3a2a, false, 0.02);
}

/** Véhicule léger tout-terrain : caisse basse et large, capot plat, tourelle légère. */
function humvee(m: Mesh, color: number, accent: number): void {
  const dark = shadeColor(color, 0.5);
  for (const u of [0.42, 1.55]) {
    m.cyl('v', 0.02, 0.18, u, 4.5, 4.5 / 26, 4.5, TIRE, 8);
    m.cyl('v', 0.82, 0.98, u, 4.5, 4.5 / 26, 4.5, TIRE, 8);
  }
  m.box(0.1, 1.9, 0.12, 0.88, 4, 8, dark); // châssis
  m.box(0.08, 1.2, 0.06, 0.94, 8, 16, color); // habitacle
  m.box(1.2, 1.95, 0.06, 0.94, 8, 12.5, color); // capot plat
  m.box(1.18, 1.26, 0.08, 0.92, 12.5, 16, shadeColor(color, 0.9)); // montant de pare-brise
  m.box(0.08, 1.24, 0.06, 0.94, 16, 17, shadeColor(color, 1.05)); // toit
  m.quad([[1.18, 0.12, 15.5], [1.18, 0.88, 15.5], [1.18, 0.88, 12.8], [1.18, 0.12, 12.8]], GLASS, [1, 0, 0]);
  m.quad([[0.75, 0.94, 15.5], [1.12, 0.94, 15.5], [1.12, 0.94, 12], [0.75, 0.94, 12]], GLASS, [0, 1, 0]);
  m.quad([[0.25, 0.94, 15.5], [0.68, 0.94, 15.5], [0.68, 0.94, 12], [0.25, 0.94, 12]], GLASS, [0, 1, 0]);
  m.quad([[1.94, 0.15, 11], [1.94, 0.27, 11], [1.94, 0.27, 9.5], [1.94, 0.15, 9.5]], 0xe8d890, [1, 0, 0], 0.03);
  m.quad([[1.94, 0.73, 11], [1.94, 0.85, 11], [1.94, 0.85, 9.5], [1.94, 0.73, 9.5]], 0xe8d890, [1, 0, 0], 0.03);
  m.box(1.92, 1.98, 0.1, 0.9, 5, 9, dark); // pare-chocs
  // Tourelle avec tireur
  m.cyl('v', 0.32, 0.68, 0.65, 17.5, 0.18, 1.2, accent, 8);
  m.box(0.57, 0.73, 0.33, 0.67, 17.5, 21.5, accent);
  m.box(0.6, 0.7, 0.44, 0.56, 18, 23, 0x6b7046);
  m.box(0.61, 0.69, 0.45, 0.55, 23, 25, shadeColor(0x6b7046, 0.85));
  m.box(0.73, 1.15, 0.48, 0.52, 20.5, 21.5, 0x1e1d18);
  m.box(0.1, 0.13, 0.2, 0.23, 16, 26, 0x1e1d18); // antenne
  m.cyl('u', 0.02, 0.09, 0.72, 12, 0.14, 4, TIRE, 8); // roue de secours
  jerrycan(m, 0.06, 0.3, 8);
  m.box(0.2, 0.55, 0.15, 0.4, 17, 19, 0x6a6040, false, 0.01); // sacs sur le toit
  m.box(1.1, 1.14, -0.05, 0.06, 12, 14.5, dark); // rétroviseurs
  m.box(1.1, 1.14, 0.94, 1.05, 12, 14.5, dark);
  // Calandre à fentes verticales, ouïes du capot, montant central du pare-brise
  for (let i = 0; i < 7; i++) {
    const v = 0.33 + i * 0.056;
    m.quad([[1.955, v, 11.8], [1.955, v + 0.025, 11.8], [1.955, v + 0.025, 8.6], [1.955, v, 8.6]], 0x1e1d18, [1, 0, 0], 0.04);
  }
  m.quad([[1.45, 0.3, 12.55], [1.75, 0.3, 12.55], [1.75, 0.36, 12.55], [1.45, 0.36, 12.55]], dark, [0, 0, 1], 0.03);
  m.quad([[1.45, 0.64, 12.55], [1.75, 0.64, 12.55], [1.75, 0.7, 12.55], [1.45, 0.7, 12.55]], dark, [0, 0, 1], 0.03);
  m.box(1.17, 1.19, 0.48, 0.52, 12.5, 16, shadeColor(color, 0.8), false, 0.03);
  // Pare-buffle, feux arrière, crochets
  m.box(1.98, 2.03, 0.14, 0.86, 9, 10, 0x2a2a26, false);
  for (const v of [0.18, 0.82]) m.box(1.98, 2.03, v - 0.025, v + 0.025, 5, 10, 0x2a2a26, false, 0.02);
  m.quad([[0.08, 0.1, 13], [0.08, 0.18, 13], [0.08, 0.18, 11], [0.08, 0.1, 11]], 0xb03028, [-1, 0, 0], 0.03);
  m.quad([[0.08, 0.82, 13], [0.08, 0.9, 13], [0.08, 0.9, 11], [0.08, 0.82, 11]], 0xb03028, [-1, 0, 0], 0.03);
  // Vitres blindées du bouclier de tourelle, panneau VS-17 sur le capot, numéro de pare-chocs
  m.quad([[0.735, 0.38, 21], [0.735, 0.46, 21], [0.735, 0.46, 19.5], [0.735, 0.38, 19.5]], GLASS, [1, 0, 0], 0.05);
  m.quad([[0.735, 0.54, 21], [0.735, 0.62, 21], [0.735, 0.62, 19.5], [0.735, 0.54, 19.5]], GLASS, [1, 0, 0], 0.05);
  vs17(m, 1.4, 1.8, 0.4, 0.6, 12.53);
  m.quad([[1.985, 0.6, 8.6], [1.985, 0.8, 8.6], [1.985, 0.8, 7.4], [1.985, 0.6, 7.4]], 0xd8d4c4, [1, 0, 0], 0.05);
}

/** C-130 Hercules : aile haute, quatre turbopropulseurs, porte cargo arrière relevée. Longueur L, envergure W. */
function c130(m: Mesh, color: number, accent: number, L: number, W: number): void {
  const vc = W / 2;
  const dark = shadeColor(color, 0.55);
  // Train d'atterrissage (carénages latéraux et roues)
  m.box(L * 0.4, L * 0.58, vc - 0.62, vc - 0.42, 3, 9, dark);
  m.box(L * 0.4, L * 0.58, vc + 0.42, vc + 0.62, 3, 9, dark);
  for (const u of [L * 0.44, L * 0.54]) {
    m.cyl('v', vc - 0.6, vc - 0.45, u, 3, 0.12, 3, TIRE, 8);
    m.cyl('v', vc + 0.45, vc + 0.6, u, 3, 0.12, 3, TIRE, 8);
  }
  m.cyl('v', vc - 0.08, vc + 0.08, L * 0.86, 3, 0.1, 3, TIRE, 8); // roulette de nez
  // Fuselage, nez, cône arrière relevé
  m.cyl('u', L * 0.2, L * 0.84, vc, 15, 0.55, 11, color, 12);
  m.cyl('u', L * 0.84, L * 0.93, vc, 14, 0.46, 9, color, 12);
  m.cyl('u', L * 0.93, L * 0.98, vc, 13, 0.3, 6, shadeColor(color, 0.9), 10); // radôme
  m.cyl('u', L * 0.04, L * 0.2, vc, 20, 0.32, 6, color, 10);
  m.cyl('u', L * 0.86, L * 0.92, vc, 21, 0.3, 3.2, GLASS, 8, false, 0.02); // poste de pilotage
  // Dérive et empennage horizontal
  m.box(L * 0.0, L * 0.14, vc - 0.07, vc + 0.07, 24, 50, color);
  m.box(L * 0.02, L * 0.12, vc - 1.6, vc + 1.6, 22, 23.5, color);
  // Aile haute
  m.box(L * 0.5, L * 0.66, 0.1, W - 0.1, 25, 27.5, color);
  m.box(L * 0.5, L * 0.52, 0.12, W - 0.12, 25.2, 27.2, shadeColor(color, 0.8)); // bord de fuite
  // Quatre moteurs et hélices (pales arrêtées en croix)
  for (const dv of [-2.4, -1.25, 1.25, 2.4]) {
    const v = vc + dv;
    m.cyl('u', L * 0.54, L * 0.74, v, 23, 0.18, 4, accent, 8);
    m.cyl('u', L * 0.74, L * 0.76, v, 23, 0.07, 1.5, dark, 6, false, 0.03);
    m.box(L * 0.755, L * 0.765, v - 0.04, v + 0.04, 16, 30, dark, false, 0.04);
    m.box(L * 0.755, L * 0.765, v - 0.42, v + 0.42, 22.3, 23.7, dark, false, 0.04);
  }
  // Réservoirs externes entre les moteurs, porte latérale et rampe
  for (const dv of [-1.82, 1.82]) m.cyl('u', L * 0.5, L * 0.74, vc + dv, 21, 0.11, 2.2, accent, 8);
  m.quad([[L * 0.25, vc + 0.555, 15], [L * 0.29, vc + 0.555, 15], [L * 0.29, vc + 0.555, 8], [L * 0.25, vc + 0.555, 8]], dark, [0, 1, 0], 0.03);
  for (let i = 0; i < 4; i++) {
    const u = L * (0.36 + i * 0.07);
    m.quad([[u, vc + 0.555, 17], [u + 0.08, vc + 0.555, 17], [u + 0.08, vc + 0.555, 15.6], [u, vc + 0.555, 15.6]], GLASS, [0, 1, 0], 0.03);
  }
  // Marquages : cocarde discrète et numéro
  m.quad([[L * 0.3, vc + 0.55, 18], [L * 0.38, vc + 0.55, 18], [L * 0.38, vc + 0.55, 13], [L * 0.3, vc + 0.55, 13]], shadeColor(color, 0.7), [0, 1, 0], 0.03);
}

/** A-10 Thunderbolt II : aile droite basse, réacteurs en nacelles arrière, double dérive. */
function a10(m: Mesh, color: number, accent: number, L: number, W: number): void {
  const vc = W / 2;
  const dark = shadeColor(color, 0.55);
  m.cyl('u', L * 0.18, L * 0.86, vc, 12, 0.24, 6, color, 10);
  m.cyl('u', L * 0.86, L * 0.98, vc, 11.5, 0.16, 4, color, 8);
  m.box(L * 0.97, L * 1.0, vc - 0.02, vc + 0.02, 10.5, 12, 0x1e1d18); // canon
  m.cyl('u', L * 0.7, L * 0.82, vc, 16, 0.14, 3, GLASS, 8, false, 0.02); // verrière
  m.box(L * 0.42, L * 0.58, 0.05, W - 0.05, 10, 11.5, color); // aile droite
  // Charges sous voilure
  for (const dv of [-1.1, -0.6, 0.6, 1.1]) m.cyl('u', L * 0.45, L * 0.62, vc + dv, 8.5, 0.05, 1.2, dark, 6, false, 0.03);
  // Nacelles des réacteurs au-dessus du fuselage arrière
  for (const dv of [-0.38, 0.38]) m.cyl('u', L * 0.2, L * 0.42, vc + dv, 17, 0.14, 3.2, accent, 8);
  // Carénages du train sous l'aile, entrées d'air des réacteurs, canon rotatif à plusieurs tubes
  for (const dv of [-0.55, 0.55]) m.box(L * 0.55, L * 0.68, vc + dv - 0.08, vc + dv + 0.08, 7.5, 10.5, color);
  for (const dv of [-0.38, 0.38]) m.cyl('u', L * 0.415, L * 0.425, vc + dv, 17, 0.11, 2.4, 0x1a1a18, 8, false, 0.02);
  m.box(L * 0.95, L * 1.02, vc - 0.04, vc + 0.04, 9.8, 11.4, 0x2a2a26);
  // Empennage : stabilisateur et deux dérives
  m.box(L * 0.02, L * 0.14, vc - 0.85, vc + 0.85, 13, 14, color);
  for (const dv of [-0.82, 0.82]) m.box(L * 0.02, L * 0.12, vc + dv - 0.04, vc + dv + 0.04, 9, 22, color);
}

/** Dessine un véhicule au sol ou un hélicoptère dans le canevas (ancre = sommet nord de l'emprise). */
export function drawVehicleArt(
  g: G,
  def: VehicleDef,
  axis: 0 | 1,
  flip: boolean,
  P: (x: number, y: number, z: number) => { x: number; y: number },
): void {
  const length = def.visual.length ?? 2;
  const m = new Mesh(length, axis, flip);
  const color = hex(def.visual.color);
  const accent = def.visual.accent ? hex(def.visual.accent) : shadeColor(color, 1.2);
  switch (def.visual.style) {
    case 'truck':
      m.shadow(g, P, 0.1, 2.0, 0.08, 0.92);
      cargoTruck(m, color, accent);
      break;
    case 'tanker':
      m.shadow(g, P, 0.1, 2.0, 0.08, 0.92);
      tankerTruck(m, color, accent, def.visual.placard ? hex(def.visual.placard) : 0xd07a2a);
      break;
    case 'forklift':
      m.shadow(g, P, 0.4, 1.8, 0.22, 0.78);
      forklift(m, color);
      break;
    case 'helicopter':
      helicopter(m, color, accent); // ombre dessinée au sol par le rendu (altitude)
      break;
    case 'blackhawk':
      blackhawk(m, color, accent);
      break;
    case 'chinook':
      chinook(m, color, accent);
      break;
    case 'littlebird':
      littleBird(m, color, accent);
      break;
    case 'suv':
      m.shadow(g, P, 0.05, 2.0, 0.04, 0.96);
      suv(m, color, accent);
      break;
    case 'attack_helo':
      attackHelo(m, color, accent);
      break;
    case 'mrap':
      m.shadow(g, P, 0.05, 2.0, 0.05, 0.95);
      mrap(m, color, accent);
      break;
    case 'humvee':
      m.shadow(g, P, 0.05, 2.0, 0.02, 0.98);
      humvee(m, color, accent);
      break;
    case 'cart':
      m.shadow(g, P, 0.1, 2.0, 0.15, 0.85);
      cart(m, color, accent);
      break;
    case 'c130':
      c130(m, color, accent, length, def.visual.width ?? 6); // ombre dessinée par le rendu (altitude)
      break;
    case 'a10':
      a10(m, color, accent, length, def.visual.width ?? 3);
      break;
  }
  m.render(g, P);
}
