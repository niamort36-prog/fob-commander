/**
 * PlaceholderFactory — génère par code les textures manquantes (terrain, bâtiments),
 * en respectant la géométrie de spriteKeys.ts. Une texture n'est générée que si
 * aucun vrai sprite n'a été chargé pour sa clé.
 */
import Phaser from 'phaser';
import type { BuildingDef, TerrainDef } from '../core/ContentTypes';
import type { ContentRegistry } from '../core/ContentRegistry';
import type { Rotation } from '../core/GameState';
import { Rng, hashString } from '../utils/Rng';
import { AssetLoader } from './AssetLoader';
import { BuildSystem } from '../systems/BuildSystem';
import { drawVehicleArt } from './vehicleArt';
import { COURSE, WORKOUT } from './trainingLayout';
import { FIGURE_POSES, SKIN_TONES, drawFigure, type FigureSpec } from './figureArt';
import {
  AGENT_H,
  AGENT_W,
  TERRAIN_ATLAS,
  TERRAIN_BLEED,
  TERRAIN_VARIANTS,
  agentKey,
  figureKey,
  buildingGeometry,
  buildingKey,
  MODULE_ART,
  moduleKey,
  sandbagGeometry,
  sandbagKey,
  terrainKey,
  vehicleGeometry,
  vehicleKey,
  type BuildingGeometry,
} from './spriteKeys';

type G = Phaser.GameObjects.Graphics;
interface Pt {
  x: number;
  y: number;
}
/** Projection (x grille, y grille, altitude px) → pixel du canevas. */
type Proj = (gx: number, gy: number, z: number) => Pt;

// ---------------------------------------------------------------- Couleurs

export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 0xff) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 0xff) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------- Primitives

function poly(g: G, pts: Pt[], color: number, alpha = 1): void {
  g.fillStyle(color, alpha);
  g.fillPoints(pts, true);
}

function outline(g: G, pts: Pt[], color: number, alpha = 0.9): void {
  g.lineStyle(1, color, alpha);
  g.strokePoints(pts, true);
}

/** Pavé isométrique de (x0, y0) à (x1, y1) en grille, de l'altitude z0 à z1. */
function prism(g: G, P: Proj, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color: number): void {
  const left = [P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)];
  const right = [P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), P(x1, y0, z0)];
  const top = [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
  poly(g, left, shade(color, 0.82));
  poly(g, right, shade(color, 0.64));
  poly(g, top, shade(color, 1.12));
  const edge = shade(color, 0.42);
  outline(g, [P(x0, y0, z1), P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1)], edge);
  g.lineStyle(1, shade(color, 1.3), 0.6);
  g.lineBetween(P(x0, y1, z1).x, P(x0, y1, z1).y, P(x1, y1, z1).x, P(x1, y1, z1).y);
  g.lineBetween(P(x1, y1, z1).x, P(x1, y1, z1).y, P(x1, y0, z1).x, P(x1, y0, z1).y);
}

// ---------------------------------------------------------------- Terrain

/**
 * Tuile de terrain : losange élargi de TERRAIN_BLEED px de chaque côté pour recouvrir
 * les joints entre tuiles voisines (sinon le fond apparaît en fines lignes sombres).
 */
function drawTerrainTile(g: G, def: TerrainDef, variant: number, tw: number, th: number): void {
  const rng = new Rng(hashString(`${def.id}:${variant}`));
  const base = hexToInt(def.color);
  const tone = shade(base, 1 + (variant - 1) * def.variance);
  const b = TERRAIN_BLEED;
  const hw = tw / 2 + b;
  const hh = th / 2 + b;
  poly(g, [{ x: hw, y: 0 }, { x: hw * 2, y: hh }, { x: hw, y: hh * 2 }, { x: 0, y: hh }], tone);

  const inside = (x: number, y: number): boolean => Math.abs(x - hw) / hw + Math.abs(y - hh) / hh <= 0.85;
  const randomPoint = (): Pt => {
    for (let i = 0; i < 20; i++) {
      const p = { x: rng.range(2, hw * 2 - 2), y: rng.range(1, hh * 2 - 1) };
      if (inside(p.x, p.y)) return p;
    }
    return { x: hw, y: hh };
  };

  // Grain du sol
  for (let i = 0; i < 18; i++) {
    const p = randomPoint();
    g.fillStyle(shade(tone, rng.chance(0.5) ? 1.1 : 0.88), 1);
    g.fillRect(Math.round(p.x), Math.round(p.y), rng.chance(0.3) ? 2 : 1, 1);
  }

  if (def.decor === 'pebbles') {
    for (let i = 0; i < 6; i++) {
      const p = randomPoint();
      g.fillStyle(shade(tone, 0.7), 1);
      g.fillRect(Math.round(p.x), Math.round(p.y) + 1, 2, 1);
      g.fillStyle(shade(tone, 1.25), 1);
      g.fillRect(Math.round(p.x), Math.round(p.y), 2, 1);
    }
  } else if (def.decor === 'ruts') {
    // Ornières parallèles à un axe de la grille
    const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const top = { x: hw, y: 0 };
    const right = { x: hw * 2, y: hh };
    const bottom = { x: hw, y: hh * 2 };
    const left = { x: 0, y: hh };
    g.lineStyle(2, shade(tone, 0.82), 0.7);
    for (const t of [0.3, 0.7]) {
      const [a, b] = variant % 2 === 0 ? [lerp(top, left, t), lerp(right, bottom, t)] : [lerp(top, right, t), lerp(left, bottom, t)];
      g.lineBetween(a.x, a.y, b.x, b.y);
    }
  } else if (def.decor === 'rocks') {
    const count = rng.int(2, 3);
    for (let i = 0; i < count; i++) {
      const p = randomPoint();
      const r = rng.int(4, 7);
      g.fillStyle(shade(tone, 0.55), 1);
      g.fillEllipse(p.x + 1, p.y + 1, r * 2, r);
      g.fillStyle(shade(tone, 0.9), 1);
      g.fillEllipse(p.x, p.y - 1, r * 2 - 1, r);
      g.fillStyle(shade(tone, 1.2), 1);
      g.fillEllipse(p.x - r / 3, p.y - r / 3, r * 0.8, r * 0.4);
    }
  }
}

// ---------------------------------------------------------------- Bâtiments

function drawFlat(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, markings?: 'parking' | 'helipad' | 'runway'): void {
  const { w, h } = geo;
  const ground = [P(0, 0, 0), P(w, 0, 0), P(w, h, 0), P(0, h, 0)];
  poly(g, ground, color);
  if (markings) {
    drawMarkings(g, P, w, h, accent, markings);
    outline(g, ground, shade(color, 0.7), 0.7);
    return;
  }
  const rng = new Rng(hashString(`flat:${color}`));
  for (let i = 0; i < 14; i++) {
    const p = P(rng.range(0.1, w - 0.1), rng.range(0.1, h - 0.1), 0);
    g.fillStyle(rng.chance(0.5) ? accent : shade(color, 0.8), 1);
    g.fillRect(Math.round(p.x), Math.round(p.y), 2, 1);
  }
  outline(g, ground, shade(color, 0.7), 0.7);
}

/** Marquages au sol : places de stationnement ou cercle « H » d'hélisurface. */
function drawMarkings(g: G, P: Proj, w: number, h: number, paint: number, kind: 'parking' | 'helipad' | 'runway'): void {
  const line = (a: Pt, b: Pt): void => {
    g.lineBetween(a.x, a.y, b.x, b.y);
  };
  if (kind === 'runway') return drawRunway(g, P, w, h, paint);
  g.lineStyle(2, paint, 0.85);
  const i = 0.15;
  line(P(i, i, 0), P(w - i, i, 0));
  line(P(w - i, i, 0), P(w - i, h - i, 0));
  line(P(w - i, h - i, 0), P(i, h - i, 0));
  line(P(i, h - i, 0), P(i, i, 0));
  if (kind === 'parking') {
    // Séparation des places le long du grand axe
    g.lineStyle(1, paint, 0.6);
    if (w >= h) for (let x = 1; x < w; x++) line(P(x, i, 0), P(x, h - i, 0));
    else for (let y = 1; y < h; y++) line(P(i, y, 0), P(w - i, y, 0));
    return;
  }
  // Cercle et lettre H
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.38;
  const ring: Pt[] = [];
  for (let k = 0; k <= 24; k++) {
    const a = (Math.PI * 2 * k) / 24;
    ring.push(P(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
  }
  g.lineStyle(2, paint, 0.9);
  g.strokePoints(ring, false);
  const s = r * 0.5;
  line(P(cx - s, cy - s, 0), P(cx - s, cy + s, 0));
  line(P(cx + s, cy - s, 0), P(cx + s, cy + s, 0));
  line(P(cx - s, cy, 0), P(cx + s, cy, 0));
}

/** Piste d'aviation : plaques PSP, bords, seuils, numéros stylisés, axe en tirets, zones de toucher. */
function drawRunway(g: G, P: Proj, w: number, h: number, paint: number): void {
  const long = h >= w;
  const L = long ? h : w;
  const W = long ? w : h;
  // (a = le long de la piste, b = en travers) → grille
  const Q = (a: number, b: number): Pt => (long ? P(b, a, 0) : P(a, b, 0));
  const line = (a0: number, b0: number, a1: number, b1: number): void => {
    const p = Q(a0, b0);
    const q = Q(a1, b1);
    g.lineBetween(p.x, p.y, q.x, q.y);
  };
  const quad = (a0: number, b0: number, a1: number, b1: number, color: number, alpha = 1): void => {
    g.fillStyle(color, alpha);
    g.fillPoints([Q(a0, b0), Q(a1, b0), Q(a1, b1), Q(a0, b1)], true);
  };
  // Plaques perforées (PSP) : quadrillage discret
  g.lineStyle(1, 0x000000, 0.12);
  for (let a = 0.5; a < L; a += 0.5) line(a, 0.3, a, W - 0.3);
  // Accotements plus sombres
  quad(0, 0, L, 0.3, 0x000000, 0.12);
  quad(0, W - 0.3, L, W, 0x000000, 0.12);
  // Bords
  g.lineStyle(2, paint, 0.85);
  line(0.4, 0.35, L - 0.4, 0.35);
  line(0.4, W - 0.35, L - 0.4, W - 0.35);
  // Seuils (barres « piano ») aux deux extrémités
  for (const a0 of [0.5, L - 1.5]) {
    for (let k = 0; k < 6; k++) {
      const b0 = 0.6 + (k * (W - 1.2)) / 6;
      quad(a0, b0 + 0.06, a0 + 1, b0 + (W - 1.2) / 6 - 0.08, paint, 0.85);
    }
  }
  // Axe central en tirets
  g.lineStyle(2, paint, 0.8);
  for (let a = 2.6; a < L - 2.6; a += 1.4) line(a, W / 2, Math.min(a + 0.8, L - 2.6), W / 2);
  // Zones de toucher
  for (const a0 of [3.2, L - 4.2]) {
    quad(a0, W / 2 - 1.1, a0 + 1, W / 2 - 0.55, paint, 0.75);
    quad(a0, W / 2 + 0.55, a0 + 1, W / 2 + 1.1, paint, 0.75);
  }
}

/**
 * Stand de tir (le long du grand axe) : pas de tir couvert à une extrémité, couloirs balisés,
 * cibles sur poteaux et merlon de terre pare-balles à l'autre extrémité.
 */
function drawRange(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number): void {
  const { w, h } = geo;
  const long = w >= h;
  const L = long ? w : h;
  const W = long ? h : w;
  // (a le long du stand, b en travers, z) → projection
  const Q = (a: number, b: number, z: number): Pt => (long ? P(a, b, z) : P(b, a, z));
  const box = (a0: number, b0: number, a1: number, b1: number, z0: number, z1: number, c: number): void => {
    if (long) prism(g, P, a0, b0, a1, b1, z0, z1, c);
    else prism(g, P, b0, a0, b1, a1, z0, z1, c);
  };
  // Sol damé et couloirs
  poly(g, [Q(0, 0, 0), Q(L, 0, 0), Q(L, W, 0), Q(0, W, 0)], shade(color, 1.08));
  g.lineStyle(1, 0xe8e2d0, 0.6);
  for (let k = 1; k < 4; k++) {
    const b = (W * k) / 4;
    const p0 = Q(1.6, b, 0);
    const p1 = Q(L - 1.2, b, 0);
    g.lineBetween(p0.x, p0.y, p1.x, p1.y);
  }
  // Merlon pare-balles au fond (a = L)
  box(L - 1.0, 0.1, L - 0.1, W - 0.1, 0, height * 0.8, shade(color, 0.85));
  // Cibles (silhouettes sur poteaux) devant le merlon
  for (let k = 0; k < 4; k++) {
    const b = (W * (k + 0.5)) / 4;
    const base = Q(L - 1.5, b, 0);
    const top = Q(L - 1.5, b, 14);
    g.lineStyle(1, 0x3a3a34, 1);
    g.lineBetween(base.x, base.y, top.x, top.y);
    g.fillStyle(0xe8e2d0, 1);
    g.fillRect(Math.round(top.x) - 3, Math.round(top.y) - 9, 6, 9);
    g.fillStyle(0x2b2a24, 1);
    g.fillRect(Math.round(top.x) - 1, Math.round(top.y) - 8, 2, 2);
  }
  // Pas de tir couvert : auvent sur poteaux, tables de tir
  for (const b of [0.2, W - 0.2]) for (const a of [0.2, 1.3]) {
    const p0 = Q(a, b, 0);
    const p1 = Q(a, b, height - 2);
    g.lineStyle(2, shade(accent, 0.6), 1);
    g.lineBetween(p0.x, p0.y, p1.x, p1.y);
  }
  for (let k = 0; k < 4; k++) box(0.9, (W * k) / 4 + 0.15, 1.2, (W * (k + 1)) / 4 - 0.15, 0, 6, 0x6b5434);
  box(0.05, 0.05, 1.45, W - 0.05, height - 2, height, accent);
}

/** Parcours du combattant : mur d'escalade, poutre, pneus, fosse et filet de ramping (cf. trainingLayout). */
function drawCourse(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number): void {
  const { w, h } = geo;
  const C = COURSE;
  poly(g, [P(0, 0, 0), P(w, 0, 0), P(w, h, 0), P(0, h, 0)], shade(color, 1.05));
  // Piste de sable tracée par l'itinéraire
  g.lineStyle(3, shade(color, 0.86), 0.7);
  g.strokePoints(C.route.map((r) => P(r.x * w, r.y * h, 0)), false);
  const wood = 0x7a5a38;
  // Fosse
  poly(g, [P(w * C.pit.x0, h * C.pit.y0, 0), P(w * C.pit.x1, h * C.pit.y0, 0), P(w * C.pit.x1, h * C.pit.y1, 0), P(w * C.pit.x0, h * C.pit.y1, 0)], shade(color, 0.6));
  // Poutre d'équilibre sur chevalets
  for (const x of [C.beam.x0 + 0.02, C.beam.x1 - 0.02]) prism(g, P, w * x - 0.04, h * C.beam.y0, w * x + 0.04, h * C.beam.y1, 0, C.beam.z - 2, shade(wood, 0.8));
  prism(g, P, w * C.beam.x0, h * C.beam.y0, w * C.beam.x1, h * C.beam.y1, C.beam.z - 2, C.beam.z, shade(wood, 1.1));
  // Mur d'escalade en planches, avec contrefort
  prism(g, P, w * C.wall.x0, h * C.wall.y0, w * C.wall.x1, h * C.wall.y1, 0, C.wall.z, wood);
  g.lineStyle(1, shade(wood, 0.6), 0.8);
  for (let z = 4; z < C.wall.z; z += 4) {
    const a = P(w * C.wall.x1, h * C.wall.y0, z);
    const b = P(w * C.wall.x1, h * C.wall.y1, z);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  // Pneus couchés
  for (let r = 0; r < 2; r++)
    for (let k = 0; k < 3; k++) {
      const c = P(w * (C.tires.x0 + k * C.tires.dx), h * (C.tires.y0 + r * C.tires.dy), 0);
      g.fillStyle(0x1d1c18, 1);
      g.fillEllipse(c.x, c.y - 1, 12, 6);
      g.fillStyle(shade(color, 1.05), 1);
      g.fillEllipse(c.x, c.y - 1, 6, 3);
    }
  // Filet de ramping sur piquets
  for (const [x, y] of [[C.net.x0, C.net.y0], [C.net.x1, C.net.y0], [C.net.x1, C.net.y1], [C.net.x0, C.net.y1]] as [number, number][]) {
    const a = P(w * x, h * y, 0);
    const b = P(w * x, h * y, C.net.z);
    g.lineStyle(1, shade(wood, 0.7), 1);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  const n = [P(w * C.net.x0, h * C.net.y0, C.net.z), P(w * C.net.x1, h * C.net.y0, C.net.z), P(w * C.net.x1, h * C.net.y1, C.net.z), P(w * C.net.x0, h * C.net.y1, C.net.z)];
  g.fillStyle(accent, 0.35);
  g.fillPoints(n, true);
  g.lineStyle(1, shade(accent, 0.6), 0.7);
  for (let k = 0; k <= 5; k++) {
    const x = C.net.x0 + ((C.net.x1 - C.net.x0) * k) / 5;
    const y = C.net.y0 + ((C.net.y1 - C.net.y0) * k) / 5;
    const a = P(w * x, h * C.net.y0, C.net.z);
    const b = P(w * x, h * C.net.y1, C.net.z);
    g.lineBetween(a.x, a.y, b.x, b.y);
    const c = P(w * C.net.x0, h * y, C.net.z);
    const d = P(w * C.net.x1, h * y, C.net.z);
    g.lineBetween(c.x, c.y, d.x, d.y);
  }
}

/** Maison de combat : murs de contreplaqué sans toit formant des pièces et un couloir. */
function drawKillhouse(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number): void {
  const { w, h } = geo;
  poly(g, [P(0, 0, 0), P(w, 0, 0), P(w, h, 0), P(0, h, 0)], shade(accent, 0.9));
  const t = 0.12;
  const wall = (x0: number, y0: number, x1: number, y1: number): void => prism(g, P, x0, y0, x1, y1, 0, height, color);
  // Murs du fond d'abord (tri du peintre), ouvertures pour les portes
  wall(0, 0, w, t);
  wall(0, 0, t, h);
  wall(w * 0.5 - t / 2, 0, w * 0.5 + t / 2, h * 0.35);
  wall(w * 0.5 - t / 2, h * 0.55, w * 0.5 + t / 2, h);
  wall(t, h * 0.5 - t / 2, w * 0.3, h * 0.5 + t / 2);
  wall(w * 0.62, h * 0.5 - t / 2, w - t, h * 0.5 + t / 2);
  wall(w - t, 0, w, h * 0.7);
  wall(0, h - t, w * 0.4, h);
  wall(w * 0.6, h - t, w, h);
  // Traces d'impacts et numéros de pièces
  g.fillStyle(0x2b2a24, 0.7);
  for (const [x, y] of [[w * 0.25, h - t], [w * 0.8, h - t]] as [number, number][]) {
    const p = P(x, y, height * 0.6);
    g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    g.fillRect(Math.round(p.x) + 3, Math.round(p.y) - 2, 1, 1);
  }
}

/**
 * Aire de musculation en plein air (cf. trainingLayout) : sol en dalles de caoutchouc, portique de
 * traction, banc de développé couché, cage à squat, arbre à disques, tapis de pompes, kettlebells, pneu.
 */
function drawWorkout(g: G, P: Proj, geo: BuildingGeometry, _color: number, accent: number): void {
  const { w, h } = geo;
  const L = WORKOUT;
  const steel = 0x4a4c48;
  const steelHi = 0x8a8c84;
  const rubber = 0x34342f;
  // Dalles de caoutchouc : bordure, joints
  poly(g, [P(0, 0, 0), P(w, 0, 0), P(w, h, 0), P(0, h, 0)], shade(accent, 1.05));
  poly(g, [P(0.12, 0.12, 0), P(w - 0.12, 0.12, 0), P(w - 0.12, h - 0.12, 0), P(0.12, h - 0.12, 0)], rubber);
  g.lineStyle(1, shade(rubber, 1.35), 0.6);
  for (let t = 0.12 + 0.5; t < w - 0.12; t += 0.5) {
    const a = P(t, 0.12, 0);
    const b = P(t, h - 0.12, 0);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  for (let t = 0.12 + 0.5; t < h - 0.12; t += 0.5) {
    const a = P(0.12, t, 0);
    const b = P(w - 0.12, t, 0);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  const post = (x: number, y: number, z1: number, c = steel, t = 0.035): void => prism(g, P, x - t, y - t, x + t, y + t, 0, z1, c);
  // Portique de traction : montants, contreventements, barre
  const by = h * L.pullBar.y;
  const bx0 = w * L.pullBar.x0;
  const bx1 = w * L.pullBar.x1;
  for (const x of [bx0, bx1]) {
    const foot = P(x, by - 0.3, 0);
    const top = P(x, by, L.pullBar.z - 6);
    g.lineStyle(1, steel, 1);
    g.lineBetween(foot.x, foot.y, top.x, top.y);
    post(x, by, L.pullBar.z + 2);
  }
  const t0 = P(bx0, by, L.pullBar.z);
  const t1 = P(bx1, by, L.pullBar.z);
  g.lineStyle(2, steelHi, 1);
  g.lineBetween(t0.x, t0.y, t1.x, t1.y);
  // Banc de développé couché : pieds, assise rembourrée, supports de barre côté tête
  const bn = L.bench;
  const y0 = h * bn.y - 0.1;
  const y1 = h * bn.y + 0.1;
  for (const x of [w * bn.x0 + 0.06, w * bn.x1 - 0.06]) prism(g, P, x - 0.04, y0 + 0.02, x + 0.04, y1 - 0.02, 0, bn.seat - 1, steel);
  prism(g, P, w * bn.x0, y0, w * bn.x1, y1, bn.seat - 1, bn.seat + 1, 0x6a2a24);
  for (const y of [y0 - 0.05, y1 + 0.05]) post(w * bn.x0 + 0.04, y, bn.seat + 9);
  // Cage à squat : quatre montants et cadre
  const sq = L.squat;
  const sx = w * sq.x;
  const sy = h * sq.y;
  for (const [dx, dy] of [[-0.12, -0.16], [0.12, -0.16], [-0.12, 0.16], [0.12, 0.16]] as [number, number][]) post(sx + dx, sy + dy, sq.z);
  g.lineStyle(1, steelHi, 1);
  for (const [a, b] of [[[-0.12, -0.16], [0.12, -0.16]], [[0.12, -0.16], [0.12, 0.16]], [[-0.12, -0.16], [-0.12, 0.16]], [[-0.12, 0.16], [0.12, 0.16]]] as [number, number][][]) {
    const p0 = P(sx + a[0], sy + a[1], sq.z);
    const p1 = P(sx + b[0], sy + b[1], sq.z);
    g.lineBetween(p0.x, p0.y, p1.x, p1.y);
  }
  // Arbre à disques
  const pt = P(w * L.plates.x, h * L.plates.y, 0);
  post(w * L.plates.x, h * L.plates.y, 11, steelHi, 0.025);
  for (const [z, r] of [[3, 5], [6, 4], [9, 3]] as [number, number][]) {
    g.fillStyle(0x1e1d18, 1);
    g.fillEllipse(pt.x, pt.y - z, r * 1.2, r * 2);
  }
  // Kettlebells
  for (let k = 0; k < 3; k++) {
    const c = P(w * L.bells.x + k * 0.16, h * L.bells.y, 0);
    g.fillStyle(0x1e1d18, 1);
    g.fillCircle(c.x, c.y - 2, 2.5);
    g.lineStyle(1, 0x1e1d18, 1);
    g.strokeEllipse(c.x, c.y - 5, 3, 2);
  }
  // Tapis de pompes
  const m = L.mat;
  poly(g, [P(w * m.x - 0.32, h * m.y - 0.13, 0.5), P(w * m.x + 0.32, h * m.y - 0.13, 0.5), P(w * m.x + 0.32, h * m.y + 0.13, 0.5), P(w * m.x - 0.32, h * m.y + 0.13, 0.5)], 0x3a5a4a);
  // Pneu de tracteur
  const c = P(w * L.tire.x, h * L.tire.y, 0);
  g.fillStyle(0x1d1c18, 1);
  g.fillEllipse(c.x, c.y - 3, 20, 10);
  g.fillStyle(rubber, 1);
  g.fillEllipse(c.x, c.y - 3, 9, 4);
}

/** Batterie d'obusiers : merlons de sacs de sable, deux pièces de 155 mm, caisses d'obus. */
function drawHowitzer(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number): void {
  const { w, h } = geo;
  // Sol de la position
  poly(g, [P(0, 0, 0), P(w, 0, 0), P(w, h, 0), P(0, h, 0)], shade(accent, 0.7));
  // Merlon périphérique (sacs de sable)
  const t = 0.35;
  const berm = 6;
  prism(g, P, 0, 0, w, t, 0, berm, accent);
  prism(g, P, 0, 0, t, h, 0, berm, accent);
  prism(g, P, 0, h - t, w * 0.42, h, 0, berm, accent);
  prism(g, P, w * 0.62, h - t, w, h, 0, berm, accent);
  prism(g, P, w - t, 0, w, h, 0, berm, accent);
  // Muret central séparant les deux alvéoles
  prism(g, P, t, h / 2 - 0.12, w - t, h / 2 + 0.12, 0, 4, shade(accent, 0.9));
  // Caisses d'obus
  prism(g, P, 0.5, 0.5, 0.9, 0.8, 0, 4, 0x6b5434);
  prism(g, P, 0.5, h / 2 + 0.4, 0.9, h / 2 + 0.7, 0, 4, 0x6b5434);
  const gun = (cy: number): void => {
    // Affût en flèches ouvertes
    g.lineStyle(3, shade(color, 0.7), 1);
    const pivot = P(w * 0.5, cy, 6);
    const l1 = P(w * 0.18, cy - 0.45, 2);
    const l2 = P(w * 0.18, cy + 0.45, 2);
    g.lineBetween(pivot.x, pivot.y, l1.x, l1.y);
    g.lineBetween(pivot.x, pivot.y, l2.x, l2.y);
    // Berceau et bouclier
    prism(g, P, w * 0.42, cy - 0.28, w * 0.6, cy + 0.28, 3, 10, color);
    prism(g, P, w * 0.58, cy - 0.34, w * 0.62, cy + 0.34, 6, 13, shade(color, 0.85));
    // Tube long, élevé vers l'avant (+x)
    g.lineStyle(4, shade(color, 0.55), 1);
    const breech = P(w * 0.45, cy, 10);
    const muzzle = P(w * 0.97, cy, height - 2);
    g.lineBetween(breech.x, breech.y, muzzle.x, muzzle.y);
    g.lineStyle(2, shade(color, 0.95), 1);
    g.lineBetween(breech.x, breech.y - 1, muzzle.x, muzzle.y - 1);
    // Frein de bouche
    g.fillStyle(shade(color, 0.45), 1);
    g.fillRect(Math.round(muzzle.x) - 2, Math.round(muzzle.y) - 2, 4, 4);
    // Roues
    for (const dy of [-0.32, 0.32]) {
      const c = P(w * 0.5, cy + dy, 3);
      g.fillStyle(0x1d1c18, 1);
      g.fillEllipse(c.x, c.y, 7, 6);
    }
  };
  gun(h * 0.27);
  gun(h * 0.73);
}

function drawHesco(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number): void {
  const { w, h } = geo;
  const i = 0.04;
  prism(g, P, i, i, w - i, h - i, 0, height, color);
  // Remplissage de terre au sommet
  poly(g, [P(i + 0.08, i + 0.08, height), P(w - i - 0.08, i + 0.08, height), P(w - i - 0.08, h - i - 0.08, height), P(i + 0.08, h - i - 0.08, height)], accent);
  // Grillage (montants verticaux)
  g.lineStyle(1, shade(color, 0.5), 0.7);
  for (let k = 1; k < 4; k++) {
    const gx = i + ((w - 2 * i) * k) / 4;
    const a = P(gx, h - i, 0);
    const b = P(gx, h - i, height);
    g.lineBetween(a.x, a.y, b.x, b.y);
    const gy = i + ((h - 2 * i) * k) / 4;
    const c = P(w - i, gy, 0);
    const d = P(w - i, gy, height);
    g.lineBetween(c.x, c.y, d.x, d.y);
  }
  g.lineStyle(1, shade(color, 0.6), 0.5);
  const m1 = P(i, h - i, height / 2);
  const m2 = P(w - i, h - i, height / 2);
  const m3 = P(w - i, i, height / 2);
  g.lineBetween(m1.x, m1.y, m2.x, m2.y);
  g.lineBetween(m2.x, m2.y, m3.x, m3.y);
}

/**
 * Cadre d'une porte dans le mur : deux piliers de gabions et un seuil ; pour un portail, une
 * traverse métallique. Les battants, animés, sont dessinés par le rendu (GateRenderer).
 */
function drawGate(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number, alongX: boolean, double: boolean): void {
  const { w, h } = geo;
  const p = 0.24; // épaisseur des piliers
  // Seuil de gravier tassé
  const sill = alongX ? [P(0, 0.3, 0), P(w, 0.3, 0), P(w, 0.7, 0), P(0, 0.7, 0)] : [P(0.3, 0, 0), P(0.7, 0, 0), P(0.7, h, 0), P(0.3, h, 0)];
  poly(g, sill, shade(color, 0.8), 0.7);
  const pillar = (x0: number, y0: number, x1: number, y1: number): void => {
    prism(g, P, x0, y0, x1, y1, 0, height, color);
    poly(g, [P(x0 + 0.03, y0 + 0.03, height), P(x1 - 0.03, y0 + 0.03, height), P(x1 - 0.03, y1 - 0.03, height), P(x0 + 0.03, y1 - 0.03, height)], shade(color, 1.2));
    g.lineStyle(1, shade(color, 0.5), 0.6);
    const a = alongX ? P(x0 + (x1 - x0) / 2, y1, 0) : P(x1, y0 + (y1 - y0) / 2, 0);
    const b = alongX ? P(x0 + (x1 - x0) / 2, y1, height) : P(x1, y0 + (y1 - y0) / 2, height);
    g.lineBetween(a.x, a.y, b.x, b.y);
  };
  if (alongX) {
    pillar(0, 0.15, p, 0.85);
    pillar(w - p, 0.15, w, 0.85);
  } else {
    pillar(0.15, 0, 0.85, p);
    pillar(0.15, h - p, 0.85, h);
  }
  if (double) {
    // Traverse métallique au-dessus du passage
    const z0 = height + 2;
    const a = alongX ? P(p / 2, 0.5, z0) : P(0.5, p / 2, z0);
    const b = alongX ? P(w - p / 2, 0.5, z0) : P(0.5, h - p / 2, z0);
    g.lineStyle(3, shade(accent, 0.7), 1);
    g.lineBetween(a.x, a.y, b.x, b.y);
    g.lineStyle(1, shade(accent, 1.3), 0.8);
    g.lineBetween(a.x, a.y - 1, b.x, b.y - 1);
  }
}

/** Poste de garde : guérite en bois à toit de tôle, ceinturée de sacs de sable. */
function drawBooth(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number): void {
  const { w, h } = geo;
  const bag = 0xa8946a;
  // Sacs de sable sur trois côtés (l'arrière reste ouvert)
  prism(g, P, 0.06, 0.06, w - 0.06, 0.2, 0, 8, bag);
  prism(g, P, 0.06, 0.2, 0.2, h - 0.06, 0, 8, bag);
  prism(g, P, 0.2, h - 0.2, w - 0.35, h - 0.06, 0, 8, bag);
  g.lineStyle(1, shade(bag, 0.6), 0.5);
  for (const z of [3, 6]) {
    const a = P(0.2, h - 0.06, z);
    const b = P(w - 0.35, h - 0.06, z);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  // Guérite et toit
  prism(g, P, 0.3, 0.25, w - 0.25, h - 0.3, 0, height - 6, color);
  const win = [P(0.38, h - 0.3, height - 10), P(w - 0.33, h - 0.3, height - 10), P(w - 0.33, h - 0.3, height - 15), P(0.38, h - 0.3, height - 15)];
  poly(g, win, 0x2b3a46);
  prism(g, P, 0.2, 0.15, w - 0.15, h - 0.2, height - 6, height - 4, accent);
  // Lampe et panneau « STOP »
  const lamp = P(w - 0.2, h - 0.25, height - 7);
  g.fillStyle(0xffe08a, 1);
  g.fillRect(Math.round(lamp.x) - 1, Math.round(lamp.y) - 1, 2, 2);
  const sign = P(w - 0.12, h - 0.12, 14);
  g.fillStyle(0xc0302a, 1);
  g.fillRect(Math.round(sign.x) - 2, Math.round(sign.y) - 2, 5, 4);
  const pole0 = P(w - 0.12, h - 0.12, 0);
  g.lineStyle(1, 0x3a3a34, 1);
  g.lineBetween(pole0.x, pole0.y, sign.x, sign.y + 2);
}

function drawTent(g: G, P: Proj, geo: BuildingGeometry, color: number, height: number, door: DoorFace = 'x'): void {
  const { w, h } = geo;
  const i = 0.12;
  const x0 = i, y0 = i, x1 = w - i, y1 = h - i;
  const wall = height * 0.38;
  const edge = shade(color, 0.42);
  // Socle (plancher bois)
  poly(g, [P(x0 - 0.06, y0 - 0.06, 0), P(x1 + 0.06, y0 - 0.06, 0), P(x1 + 0.06, y1 + 0.06, 0), P(x0 - 0.06, y1 + 0.06, 0)], 0x6b5a40);

  if (w >= h) {
    const ym = (y0 + y1) / 2;
    poly(g, [P(x0, y0, wall), P(x1, y0, wall), P(x1, ym, height), P(x0, ym, height)], shade(color, 0.9));
    poly(g, [P(x0, y1, wall), P(x1, y1, wall), P(x1, y1, 0), P(x0, y1, 0)], shade(color, 0.8));
    poly(g, [P(x1, y0, wall), P(x1, y1, wall), P(x1, y1, 0), P(x1, y0, 0)], shade(color, 0.62));
    poly(g, [P(x1, y0, wall), P(x1, ym, height), P(x1, y1, wall)], shade(color, 0.62));
    poly(g, [P(x0, ym, height), P(x1, ym, height), P(x1, y1, wall), P(x0, y1, wall)], shade(color, 1.1));
    // Coutures du toit
    g.lineStyle(1, shade(color, 0.85), 0.8);
    for (let k = 1; k < Math.round(w * 2); k++) {
      const gx = x0 + ((x1 - x0) * k) / Math.round(w * 2);
      const a = P(gx, ym, height);
      const b = P(gx, y1, wall);
      g.lineBetween(a.x, a.y, b.x, b.y);
    }
    g.lineStyle(1, edge, 0.9);
    const r0 = P(x0, ym, height);
    const r1 = P(x1, ym, height);
    g.lineBetween(r0.x, r0.y, r1.x, r1.y);
    outline(g, [P(x0, ym, height), P(x1, ym, height), P(x1, y0, wall), P(x1, y0, 0), P(x1, y1, 0), P(x0, y1, 0), P(x0, y1, wall)], edge);
    // Porte sur le pignon (s'il est visible)
    if (door === 'x') {
      const d = P(x1, ym, 0);
      g.fillStyle(shade(color, 0.35), 1);
      g.fillRect(Math.round(d.x) - 3, Math.round(d.y) - 10, 5, 9);
    }
  } else {
    const xm = (x0 + x1) / 2;
    poly(g, [P(x0, y0, wall), P(xm, y0, height), P(xm, y1, height), P(x0, y1, wall)], shade(color, 0.9));
    poly(g, [P(x0, y1, wall), P(x1, y1, wall), P(x1, y1, 0), P(x0, y1, 0)], shade(color, 0.8));
    poly(g, [P(x1, y0, wall), P(x1, y1, wall), P(x1, y1, 0), P(x1, y0, 0)], shade(color, 0.62));
    poly(g, [P(x0, y1, wall), P(xm, y1, height), P(x1, y1, wall)], shade(color, 0.8));
    poly(g, [P(xm, y0, height), P(x1, y0, wall), P(x1, y1, wall), P(xm, y1, height)], shade(color, 0.98));
    g.lineStyle(1, shade(color, 0.75), 0.8);
    for (let k = 1; k < Math.round(h * 2); k++) {
      const gy = y0 + ((y1 - y0) * k) / Math.round(h * 2);
      const a = P(xm, gy, height);
      const b = P(x1, gy, wall);
      g.lineBetween(a.x, a.y, b.x, b.y);
    }
    g.lineStyle(1, edge, 0.9);
    const r0 = P(xm, y0, height);
    const r1 = P(xm, y1, height);
    g.lineBetween(r0.x, r0.y, r1.x, r1.y);
    outline(g, [P(xm, y0, height), P(x1, y0, wall), P(x1, y0, 0), P(x1, y1, 0), P(x0, y1, 0), P(x0, y1, wall), P(xm, y1, height)], edge);
    if (door === 'y') {
      const d = P(xm, y1, 0);
      g.fillStyle(shade(color, 0.35), 1);
      g.fillRect(Math.round(d.x) - 3, Math.round(d.y) - 10, 5, 9);
    }
  }
}

function drawTank(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number, tw: number, th: number): void {
  const { w, h } = geo;
  // Dalle béton
  prism(g, P, 0.05, 0.05, w - 0.05, h - 0.05, 0, 3, accent);
  const c = P(w / 2, h / 2, 3);
  const r = Math.min(w, h) * 0.4;
  const rx = r * (tw / 2) * Math.SQRT2;
  const ry = r * (th / 2) * Math.SQRT2;
  const body = height - 6;
  // Corps cylindrique : moitié gauche éclairée, moitié droite ombrée
  g.fillStyle(shade(color, 0.85), 1);
  g.fillEllipse(c.x, c.y, rx * 2, ry * 2);
  g.fillRect(c.x - rx, c.y - body, rx, body);
  g.fillStyle(shade(color, 0.68), 1);
  g.fillRect(c.x, c.y - body, rx, body);
  // Cerclages
  g.lineStyle(1, shade(color, 0.5), 0.8);
  for (const k of [0.3, 0.7]) {
    const y = c.y - body * k;
    // Seule la moitié avant du cerclage est visible
    const arc: Pt[] = [];
    for (let s = 0; s <= 16; s++) {
      const a = (Math.PI * s) / 16;
      arc.push({ x: c.x + Math.cos(a) * rx, y: y + Math.sin(a) * ry });
    }
    g.strokePoints(arc, false);
  }
  // Dessus
  g.fillStyle(shade(color, 1.15), 1);
  g.fillEllipse(c.x, c.y - body, rx * 2, ry * 2);
  g.lineStyle(1, shade(color, 0.45), 0.9);
  g.strokeEllipse(c.x, c.y - body, rx * 2, ry * 2);
  // Trappe
  g.fillStyle(shade(color, 0.7), 1);
  g.fillEllipse(c.x + rx * 0.3, c.y - body - 1, 8, 4);
  // Contours latéraux
  g.lineStyle(1, shade(color, 0.42), 0.9);
  g.lineBetween(c.x - rx, c.y - body, c.x - rx, c.y);
  g.lineBetween(c.x + rx, c.y - body, c.x + rx, c.y);
}

function drawTower(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number): void {
  const { w, h } = geo;
  const deck = Math.round(height * 0.5);
  const leg = shade(color, 0.6);
  const legs: [number, number][] = [
    [0.18, 0.18],
    [w - 0.18, 0.18],
    [0.18, h - 0.18],
    [w - 0.18, h - 0.18],
  ];
  g.lineStyle(2, leg, 1);
  for (const [lx, ly] of legs) {
    const a = P(lx, ly, 0);
    const b = P(lx, ly, deck);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  // Croisillons
  g.lineStyle(1, shade(color, 0.75), 0.9);
  const cross = (ax: number, ay: number, bx: number, by: number): void => {
    const p1 = P(ax, ay, 0), p2 = P(bx, by, deck), p3 = P(ax, ay, deck), p4 = P(bx, by, 0);
    g.lineBetween(p1.x, p1.y, p2.x, p2.y);
    g.lineBetween(p3.x, p3.y, p4.x, p4.y);
  };
  cross(0.18, h - 0.18, w - 0.18, h - 0.18);
  cross(w - 0.18, 0.18, w - 0.18, h - 0.18);
  // Plancher
  prism(g, P, 0.05, 0.05, w - 0.05, h - 0.05, deck, deck + 3, color);
  // Parapet en sacs de sable
  prism(g, P, 0.1, 0.1, w - 0.1, h - 0.1, deck + 3, deck + 11, accent);
  g.lineStyle(1, shade(accent, 0.7), 0.8);
  const s1 = P(0.1, h - 0.1, deck + 7), s2 = P(w - 0.1, h - 0.1, deck + 7), s3 = P(w - 0.1, 0.1, deck + 7);
  g.lineBetween(s1.x, s1.y, s2.x, s2.y);
  g.lineBetween(s2.x, s2.y, s3.x, s3.y);
  // Poteaux et toit
  g.lineStyle(1, leg, 1);
  for (const [lx, ly] of [[0.15, h - 0.15], [w - 0.15, h - 0.15], [w - 0.15, 0.15]] as [number, number][]) {
    const a = P(lx, ly, deck + 11);
    const b = P(lx, ly, height - 4);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  prism(g, P, -0.05, -0.05, w + 0.05, h + 0.05, height - 4, height, shade(color, 0.9));
}

/** Mât d'éclairage : socle béton, mât, traverse et projecteurs. */
function drawPole(g: G, P: Proj, color: number, accent: number, height: number): void {
  prism(g, P, 0.32, 0.32, 0.68, 0.68, 0, 5, 0x8a8778);
  const base = P(0.5, 0.5, 5);
  const top = P(0.5, 0.5, height - 6);
  g.lineStyle(3, shade(color, 0.7), 1);
  g.lineBetween(base.x, base.y, top.x, top.y);
  g.lineStyle(1, shade(color, 1.2), 1);
  g.lineBetween(base.x + 1, base.y, top.x + 1, top.y);
  // Traverse et deux projecteurs orientés vers l'avant
  const l = P(0.3, 0.7, height - 6);
  const r = P(0.7, 0.3, height - 6);
  g.lineStyle(2, shade(color, 0.6), 1);
  g.lineBetween(l.x, l.y, r.x, r.y);
  for (const [px, py] of [[0.3, 0.7], [0.7, 0.3]] as [number, number][]) {
    prism(g, P, px - 0.08, py - 0.08, px + 0.08, py + 0.08, height - 6, height - 1, shade(color, 0.85));
    const lens = P(px + 0.08, py + 0.08, height - 3.5);
    g.fillStyle(accent, 1);
    g.fillCircle(lens.x, lens.y, 1.8);
  }
}

function drawBox(g: G, P: Proj, geo: BuildingGeometry, color: number, height: number): void {
  prism(g, P, 0.06, 0.06, geo.w - 0.06, geo.h - 0.06, 0, height, color);
}

/** Bâtiment en dur / conteneur : volume, toit débordant, porte, fenêtres, bandeau, antenne. */
function drawBlock(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number, antenna: boolean, door: DoorFace = 'y'): void {
  const { w, h } = geo;
  const i = 0.08;
  const body = antenna ? Math.round(height * 0.62) : height;
  prism(g, P, i, i, w - i, h - i, 0, body - 3, color);
  prism(g, P, i - 0.04, i - 0.04, w - i + 0.04, h - i + 0.04, body - 3, body, shade(color, 0.8));
  // Bandeau de couleur sur la façade gauche
  poly(g, [P(i, h - i, body - 7), P(w - i, h - i, body - 7), P(w - i, h - i, body - 10), P(i, h - i, body - 10)], accent);
  // Porte (sur la façade de l'entrée si elle est visible)
  const dz = Math.min(14, body - 10);
  const dark = shade(color, 0.35);
  if (door === 'y') {
    const dx = w / 2;
    poly(g, [P(dx - 0.18, h - i, 0), P(dx + 0.18, h - i, 0), P(dx + 0.18, h - i, dz), P(dx - 0.18, h - i, dz)], dark);
  } else if (door === 'x') {
    const dy = h / 2;
    poly(g, [P(w - i, dy - 0.18, 0), P(w - i, dy + 0.18, 0), P(w - i, dy + 0.18, dz), P(w - i, dy - 0.18, dz)], dark);
  }
  // Fenêtres sur la façade droite (sauf à l'emplacement de la porte)
  const wz0 = Math.round(body * 0.4);
  const wz1 = Math.min(body - 11, wz0 + 6);
  if (wz1 > wz0) {
    for (let k = 0; k < h; k++) {
      const gy = k + 0.5;
      if (gy - 0.2 < i || gy + 0.2 > h - i) continue;
      if (door === 'x' && Math.abs(gy - h / 2) < 0.45) continue;
      poly(g, [P(w - i, gy - 0.2, wz1), P(w - i, gy + 0.2, wz1), P(w - i, gy + 0.2, wz0), P(w - i, gy - 0.2, wz0)], 0x2b3036);
    }
  }
  if (antenna) {
    const base = P(w * 0.7, h * 0.3, body);
    g.lineStyle(1, 0x2b2a24, 1);
    g.lineBetween(base.x, base.y, base.x, base.y - (height - body) + 1);
    g.lineBetween(base.x - 3, base.y - (height - body) * 0.6, base.x + 3, base.y - (height - body) * 0.6);
    const dish = P(w * 0.3, h * 0.6, body);
    g.fillStyle(0xd8d4c8, 1);
    g.fillEllipse(dish.x, dish.y - 4, 8, 6);
    g.fillStyle(0x8a877e, 1);
    g.fillRect(dish.x - 1, dish.y - 2, 2, 3);
  }
}

/** Abri : volume bas couvert de sacs de sable, entrée sombre en chicane. */
function drawBunker(g: G, P: Proj, geo: BuildingGeometry, color: number, accent: number, height: number, door: DoorFace = 'y'): void {
  const { w, h } = geo;
  prism(g, P, 0.06, 0.06, w - 0.06, h - 0.06, 0, height * 0.7, color);
  prism(g, P, 0.2, 0.2, w - 0.2, h - 0.2, height * 0.7, height, accent);
  // Rangées de sacs
  g.lineStyle(1, shade(color, 0.6), 0.7);
  for (const z of [height * 0.23, height * 0.46]) {
    const a = P(0.06, h - 0.06, z);
    const b = P(w - 0.06, h - 0.06, z);
    const c = P(w - 0.06, 0.06, z);
    g.lineBetween(a.x, a.y, b.x, b.y);
    g.lineBetween(b.x, b.y, c.x, c.y);
  }
  for (let k = 1; k < 6; k++) {
    const u = 0.06 + ((w - 0.12) * k) / 6;
    const a = P(u, h - 0.06, 0);
    const b = P(u, h - 0.06, height * 0.7);
    g.lineBetween(a.x, a.y + (k % 2) * 2, b.x, b.y);
  }
  // Entrée
  if (door === 'y') poly(g, [P(w * 0.38, h - 0.06, 0), P(w * 0.62, h - 0.06, 0), P(w * 0.62, h - 0.06, height * 0.55), P(w * 0.38, h - 0.06, height * 0.55)], 0x16140f);
  else if (door === 'x') poly(g, [P(w - 0.06, h * 0.38, 0), P(w - 0.06, h * 0.62, 0), P(w - 0.06, h * 0.62, height * 0.55), P(w - 0.06, h * 0.38, height * 0.55)], 0x16140f);
}

/** Face visible portant la porte (+x : façade droite, +y : façade gauche), ou null si elle est au dos. */
type DoorFace = 'x' | 'y' | null;

function doorFace(def: BuildingDef, rot: Rotation): DoorFace {
  const side = BuildSystem.entranceSide(def, rot);
  if (!side) return def.visual.style === 'tent' ? 'x' : 'y';
  return side.x > 0 ? 'x' : side.y > 0 ? 'y' : null;
}

/** Axe du mur dans lequel la porte est posée : le long de x (passage selon y) ou l'inverse. */
export function gateAlongX(def: BuildingDef, rot: Rotation): boolean {
  const [w, h] = def.footprint;
  if (w !== h) return (rot % 2 === 0) === w > h;
  return rot % 2 === 0;
}

function drawBuilding(g: G, def: BuildingDef, geo: BuildingGeometry, tw: number, th: number, rot: Rotation = 0): void {
  const door = doorFace(def, rot);
  const P: Proj = (gx, gy, z) => ({
    x: geo.anchorX + ((gx - gy) * tw) / 2,
    y: geo.anchorY + ((gx + gy) * th) / 2 - z,
  });
  const color = hexToInt(def.visual.color);
  const accent = def.visual.accent ? hexToInt(def.visual.accent) : shade(color, 1.2);
  const height = def.visual.height;
  switch (def.visual.style) {
    case 'flat':
      return drawFlat(g, P, geo, color, accent, def.visual.markings);
    case 'hesco':
      return drawHesco(g, P, geo, color, accent, height);
    case 'gate':
      return drawGate(g, P, geo, color, accent, height, gateAlongX(def, rot), def.gate?.leaves === 2);
    case 'booth':
      return drawBooth(g, P, geo, color, accent, height);
    case 'tent':
      return drawTent(g, P, geo, color, height, door);
    case 'tank':
      return drawTank(g, P, geo, color, accent, height, tw, th);
    case 'tower':
      return drawTower(g, P, geo, color, accent, height);
    case 'box':
      return drawBox(g, P, geo, color, height);
    case 'building':
      return drawBlock(g, P, geo, color, accent, height, def.visual.antenna === true, door);
    case 'bunker':
      return drawBunker(g, P, geo, color, accent, height, door);
    case 'pole':
      return drawPole(g, P, color, accent, height);
    case 'howitzer':
      return drawHowitzer(g, P, geo, color, accent, height);
    case 'range':
      return drawRange(g, P, geo, color, accent, height);
    case 'course':
      return drawCourse(g, P, geo, color, accent);
    case 'killhouse':
      return drawKillhouse(g, P, geo, color, accent, height);
    case 'workout':
      return drawWorkout(g, P, geo, color, accent);
  }
}

// ---------------------------------------------------------------- Améliorations visibles

/** Élément ajouté par une amélioration (dessiné autour du point de pose ax, ay). */
function drawModuleArt(g: G, kind: string): void {
  const a = MODULE_ART[kind];
  const x = a.ax;
  const y = a.ay;
  // Petit volume isométrique centré sur (cx, cy) au sol : demi-largeurs en px, hauteur z
  const iso = (cx: number, cy: number, hw: number, hd: number, z0: number, z1: number, color: number): void => {
    const pt = (u: number, v: number, z: number): Pt => ({ x: cx + (u - v) * hw, y: cy + (u + v) * hd - z });
    poly(g, [pt(-1, 1, z1), pt(1, 1, z1), pt(1, 1, z0), pt(-1, 1, z0)], shade(color, 0.85)); // face gauche
    poly(g, [pt(1, -1, z1), pt(1, 1, z1), pt(1, 1, z0), pt(1, -1, z0)], shade(color, 0.65)); // face droite
    poly(g, [pt(-1, -1, z1), pt(1, -1, z1), pt(1, 1, z1), pt(-1, 1, z1)], color); // dessus
  };
  switch (kind) {
    case 'ac': {
      // Climatiseur posé contre le mur : caisson, grille, ventilateur
      iso(x, y - 2, 6, 3, 0, 11, 0xc8c4b8);
      g.fillStyle(0x4a4a44, 1);
      g.fillCircle(x - 2, y - 7, 3);
      g.lineStyle(1, 0x8a877e, 1);
      g.lineBetween(x - 4, y - 7, x, y - 7);
      g.lineBetween(x - 2, y - 9, x - 2, y - 5);
      g.lineStyle(1, 0x2b2a24, 0.8);
      g.lineBetween(x + 3, y - 10, x + 3, y - 18); // gaine vers le mur
      break;
    }
    case 'mast': {
      // Mât en treillis haubané, antennes en tête et feu rouge
      g.lineStyle(1, 0x5a5a52, 0.7);
      g.lineBetween(x, y - 50, x - 13, y);
      g.lineBetween(x, y - 50, x + 13, y - 2);
      g.lineBetween(x, y - 50, x + 4, y + 3);
      g.lineStyle(2, 0x4a4a44, 1);
      g.lineBetween(x - 2, y, x - 1, y - 68);
      g.lineBetween(x + 2, y, x + 1, y - 68);
      g.lineStyle(1, 0x6a6a62, 1);
      for (let k = 0; k < 9; k++) {
        const yy = y - 4 - k * 7;
        g.lineBetween(x - 2, yy, x + 2, yy - 6);
      }
      g.lineStyle(1, 0x2b2a24, 1);
      g.lineBetween(x - 6, y - 60, x + 6, y - 62);
      g.lineBetween(x - 5, y - 52, x + 5, y - 54);
      g.fillStyle(0xd03a2a, 1);
      g.fillRect(x - 1, y - 71, 3, 3);
      break;
    }
    case 'dish': {
      // Parabole satellite sur pied
      g.fillStyle(0x6a6a62, 1);
      g.fillRect(x - 1, y - 9, 3, 9);
      g.fillStyle(0x8a877e, 1);
      g.fillEllipse(x, y, 10, 4);
      g.fillStyle(0xe8e4d8, 1);
      g.fillEllipse(x - 2, y - 14, 20, 15);
      g.fillStyle(0xc8c4b8, 1);
      g.fillEllipse(x - 1, y - 14, 15, 11);
      g.lineStyle(1, 0x5a5a52, 1);
      g.lineBetween(x - 2, y - 14, x + 7, y - 20);
      g.fillStyle(0x3a3a34, 1);
      g.fillRect(x + 6, y - 22, 3, 3);
      break;
    }
    case 'servers': {
      // Groupe de refroidissement des serveurs et chemin de câbles
      iso(x, y - 1, 8, 4, 0, 8, 0xb8b4a8);
      g.fillStyle(0x3a3a34, 1);
      g.fillCircle(x - 3, y - 10, 2);
      g.fillCircle(x + 3, y - 13, 2);
      g.lineStyle(2, 0x2b2a24, 0.9);
      g.lineBetween(x - 8, y + 1, x - 11, y + 3);
      break;
    }
    case 'chimney': {
      // Conduit d'extraction de la cuisine avec chapeau
      g.fillStyle(0x8a877e, 1);
      g.fillRect(x - 2, y - 18, 5, 18);
      g.fillStyle(0xb8b4a8, 1);
      g.fillRect(x - 1, y - 18, 2, 18);
      g.fillStyle(0x6a6a62, 1);
      g.fillRect(x - 5, y - 21, 11, 3);
      g.fillStyle(0xd8d4c8, 0.35);
      g.fillCircle(x + 2, y - 23, 3);
      break;
    }
    case 'roof_tank': {
      // Réservoir d'eau cylindrique couché sur berceau
      g.fillStyle(0x5a5a52, 1);
      g.fillRect(x - 8, y - 4, 2, 4);
      g.fillRect(x + 6, y - 4, 2, 4);
      g.fillStyle(0x4f6f8a, 1);
      g.fillEllipse(x, y - 9, 22, 11);
      g.fillStyle(0x6f8faa, 1);
      g.fillEllipse(x - 2, y - 11, 14, 5);
      break;
    }
    case 'redcross': {
      // Croix rouge peinte sur le toit (losange isométrique)
      const d = (u: number, v: number): Pt => ({ x: x + (u - v) * 16, y: y + (u + v) * 8 });
      poly(g, [d(-0.55, -0.55), d(0.55, -0.55), d(0.55, 0.55), d(-0.55, 0.55)], 0xf0ece0);
      poly(g, [d(-0.12, -0.42), d(0.12, -0.42), d(0.12, 0.42), d(-0.12, 0.42)], 0xc0302a);
      poly(g, [d(-0.42, -0.12), d(0.42, -0.12), d(0.42, 0.12), d(-0.42, 0.12)], 0xc0302a);
      break;
    }
  }
}

/** Murets de sacs de sable le long des façades visibles, ouverts devant l'entrée. */
function drawSandbags(g: G, def: BuildingDef, rot: Rotation, tw: number, th: number): { width: number; height: number; anchorX: number; anchorY: number } {
  const [w, h] = BuildSystem.footprint(def, rot);
  const geo = sandbagGeometry(w, h, tw, th);
  const P: Proj = (gx, gy, z) => ({ x: geo.anchorX + ((gx + 0.5 - (gy + 0.5)) * tw) / 2, y: geo.anchorY + ((gx + 0.5 + gy + 0.5) * th) / 2 - z });
  const side = BuildSystem.entranceSide(def, rot);
  const bag = 0xb39a6b;
  const H = 7;
  // Façade droite (+x)
  const gapX = side && side.x > 0 ? [h / 2 - 0.6, h / 2 + 0.6] : null;
  const segX: [number, number][] = gapX ? [[-0.1, gapX[0]], [gapX[1], h + 0.35]] : [[-0.1, h + 0.35]];
  for (const [y0, y1] of segX) prism(g, P, w + 0.08, y0, w + 0.38, y1, 0, H, bag);
  // Façade gauche (+y)
  const gapY = side && side.y > 0 ? [w / 2 - 0.6, w / 2 + 0.6] : null;
  const segY: [number, number][] = gapY ? [[-0.1, gapY[0]], [gapY[1], w + 0.38]] : [[-0.1, w + 0.38]];
  for (const [x0, x1] of segY) prism(g, P, x0, h + 0.08, x1, h + 0.38, 0, H, shade(bag, 0.95));
  // Rangées de sacs
  g.lineStyle(1, shade(bag, 0.65), 0.7);
  const a = P(-0.1, h + 0.38, H / 2);
  const b = P(w + 0.38, h + 0.38, H / 2);
  const c = P(w + 0.38, -0.1, H / 2);
  g.lineBetween(a.x, a.y, b.x, b.y);
  g.lineBetween(b.x, b.y, c.x, c.y);
  return geo;
}

// ---------------------------------------------------------------- Personnel


// ---------------------------------------------------------------- Point d'entrée

export const PlaceholderFactory = {
  /** Génère toutes les textures manquantes. Renvoie le nombre de placeholders créés. */
  ensureAll(scene: Phaser.Scene, content: ContentRegistry): number {
    const { tileWidth: tw, tileHeight: th } = content.balance.map;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    let created = 0;

    // Terrain : tuiles générées une à une puis regroupées dans un atlas unique (TERRAIN_ATLAS),
    // ce qui permet un rendu par Blitter, indispensable sur une grande carte.
    const tileW = tw + TERRAIN_BLEED * 2;
    const tileH = th + TERRAIN_BLEED * 2;
    const generated: string[] = [];
    for (const def of content.terrains) {
      for (let v = 0; v < TERRAIN_VARIANTS; v++) {
        const key = terrainKey(def.id, v);
        if (AssetLoader.has(scene, key)) continue;
        g.clear();
        drawTerrainTile(g, def, v, tw, th);
        g.generateTexture(key, tileW, tileH);
        generated.push(key);
        created++;
      }
    }
    if (generated.length > 0 && !scene.textures.exists(TERRAIN_ATLAS)) {
      const cols = Math.ceil(Math.sqrt(generated.length));
      const canvas = document.createElement('canvas');
      canvas.width = cols * tileW;
      canvas.height = Math.ceil(generated.length / cols) * tileH;
      const c2d = canvas.getContext('2d')!;
      generated.forEach((key, i) => {
        c2d.drawImage(scene.textures.get(key).getSourceImage() as CanvasImageSource, (i % cols) * tileW, Math.floor(i / cols) * tileH);
      });
      const atlas = scene.textures.addCanvas(TERRAIN_ATLAS, canvas)!;
      generated.forEach((key, i) => {
        atlas.add(key, 0, (i % cols) * tileW, Math.floor(i / cols) * tileH, tileW, tileH);
        scene.textures.remove(key);
        AssetLoader.registerFrame(key, { texture: TERRAIN_ATLAS, frame: key });
      });
    }

    for (const def of content.vehicleList) {
      for (const axis of [0, 1] as const) {
        for (const flip of [false, true]) {
          const key = vehicleKey(def.id, axis, flip);
          if (AssetLoader.has(scene, key)) continue;
          const geo = vehicleGeometry(axis, def.visual.length ?? 2, def.visual.height ?? 24, tw, th, def.visual.width ?? 1);
          const P = (gx: number, gy: number, z: number): Pt => ({
            x: geo.anchorX + ((gx - gy) * tw) / 2,
            y: geo.anchorY + ((gx + gy) * th) / 2 - z,
          });
          g.clear();
          drawVehicleArt(g, def, axis, flip, P);
          g.generateTexture(key, Math.ceil(geo.width), Math.ceil(geo.height));
          created++;
        }
      }
    }

    // Personnel : toutes les poses, trois teintes de peau (la pose « debout », teinte 1, sert aussi d'icône)
    for (const def of content.personnelList) {
      const spec: FigureSpec = { ...def.visual, kit: def.visual.kit };
      for (const pose of FIGURE_POSES) {
        for (let skin = 0; skin < SKIN_TONES.length; skin++) {
          const key = figureKey(def.id, pose, skin);
          if (AssetLoader.has(scene, key)) continue;
          g.clear();
          drawFigure(g, spec, pose, skin);
          g.generateTexture(key, AGENT_W, AGENT_H);
          created++;
        }
      }
      const key = agentKey(def.id);
      if (AssetLoader.has(scene, key)) continue;
      g.clear();
      drawFigure(g, spec, 'stand', 1);
      g.generateTexture(key, AGENT_W, AGENT_H);
      created++;
    }

    for (const kind of Object.keys(MODULE_ART)) {
      const key = moduleKey(kind);
      if (AssetLoader.has(scene, key)) continue;
      g.clear();
      drawModuleArt(g, kind);
      g.generateTexture(key, MODULE_ART[kind].w, MODULE_ART[kind].h);
      created++;
    }
    for (const def of content.buildingList) {
      if (!def.modules?.some((m) => m.visual === 'sandbags')) continue;
      for (const rot of [0, 1, 2, 3] as Rotation[]) {
        const key = sandbagKey(def.id, rot);
        if (AssetLoader.has(scene, key)) continue;
        g.clear();
        const geo = drawSandbags(g, def, rot, tw, th);
        g.generateTexture(key, Math.ceil(geo.width), Math.ceil(geo.height));
        created++;
      }
    }

    for (const [id, visual] of Object.entries(content.visitors.visuals)) {
      const key = `visitor.${id}`;
      if (AssetLoader.has(scene, key)) continue;
      g.clear();
      drawFigure(g, { ...visual, kit: visual.rifle ? 'insurgent' : 'civilian', beard: visual.beard ?? (visual.headwear === 'turban' || visual.headwear === 'pakol') }, 'stand', visual.headwear === 'turban' || visual.headwear === 'pakol' || visual.headwear === 'headscarf' ? 2 : 1);
      g.generateTexture(key, AGENT_W, AGENT_H);
      created++;
    }

    for (const def of content.combat.enemies) {
      const key = `enemy.${def.id}`;
      if (AssetLoader.has(scene, key)) continue;
      g.clear();
      drawFigure(g, { color: def.visual.color, accent: def.visual.accent, headwear: def.visual.headwear, kit: 'insurgent', rifle: true }, 'stand', 2);
      g.generateTexture(key, AGENT_W, AGENT_H);
      created++;
    }

    for (const def of content.buildingList) {
      const rotations: Rotation[] = def.entrance ? [0, 1, 2, 3] : def.footprint[0] === def.footprint[1] ? [0] : [0, 1];
      for (const rot of rotations) {
        const key = buildingKey(def, rot);
        if (AssetLoader.has(scene, key)) continue;
        const geo = buildingGeometry(def, rot, tw, th);
        g.clear();
        drawBuilding(g, def, geo, tw, th, rot);
        g.generateTexture(key, Math.ceil(geo.width), Math.ceil(geo.height));
        created++;
      }
    }

    g.destroy();
    return created;
  },
};
