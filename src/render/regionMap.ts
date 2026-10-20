/**
 * Fond de carte topographique de la région, dessiné sur un canevas 2D (indépendant de Phaser,
 * réutilisé par la carte tactique et par l'écran de choix du site) :
 * teintes hypsométriques, ombrage du relief, cultures irriguées le long des rivières,
 * courbes de niveau (maîtresses épaissies), rivières, routes et pistes, villages,
 * quadrillage kilométrique avec repères, toponymes, cartouche, échelle et nord.
 */
import type { PolylineDef, RegionDef } from '../core/ContentTypes';
import { valueNoise } from '../utils/noise';
import { Rng } from '../utils/Rng';

export interface Heightmap {
  w: number;
  h: number;
  cellKm: number;
  data: Float32Array;
  river: Float32Array; // distance à la rivière la plus proche (km)
}

const HYPSO: [number, [number, number, number]][] = [
  [800, [230, 223, 191]],
  [1100, [221, 210, 166]],
  [1400, [209, 191, 143]],
  [1800, [190, 162, 122]],
  [2300, [166, 138, 106]],
  [2900, [142, 118, 96]],
];
const FIELDS: [number, number, number] = [178, 192, 128];

/** Distance d'un point à une polyligne (km). */
export function distToPolyline(x: number, y: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

const cache = new Map<string, Heightmap>();

/** Relief : pente générale sud → nord, massifs gaussiens, bruit, vallées creusées par les rivières. */
export function heightmap(def: RegionDef, cellKm: number): Heightmap {
  const key = `${def.name}:${cellKm}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = Math.ceil(def.size.width / cellKm) + 1;
  const h = Math.ceil(def.size.height / cellKm) + 1;
  const r = def.relief;
  const noise = valueNoise(w, h, Math.max(2, r.noiseScaleKm / cellKm), new Rng(def.seed), 4);
  const data = new Float32Array(w * h);
  const river = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = i * cellKm;
      const y = j * cellKm;
      let z = r.baseNorth + (r.baseSouth - r.baseNorth) * (y / def.size.height);
      for (const m of def.mountains) {
        const dx = (x - m.x) / m.rx;
        const dy = (y - m.y) / m.ry;
        z += m.h * Math.exp(-(dx * dx + dy * dy) * 1.6);
      }
      z += (noise[j * w + i] - 0.5) * 2 * r.noiseAmp;
      let dr = Infinity;
      for (const rv of def.rivers) dr = Math.min(dr, distToPolyline(x, y, rv.points));
      river[j * w + i] = dr;
      if (dr < r.riverCarveKm) z -= r.riverCarve * (1 - dr / r.riverCarveKm) ** 1.5;
      data[j * w + i] = z;
    }
  }
  const hm = { w, h, cellKm, data, river };
  cache.set(key, hm);
  return hm;
}

function hypso(z: number): [number, number, number] {
  if (z <= HYPSO[0][0]) return HYPSO[0][1];
  for (let i = 1; i < HYPSO.length; i++) {
    if (z <= HYPSO[i][0]) {
      const [z0, c0] = HYPSO[i - 1];
      const [z1, c1] = HYPSO[i];
      const t = (z - z0) / (z1 - z0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return HYPSO[HYPSO.length - 1][1];
}

export interface BaseOptions {
  labels: boolean;
  /** Marge (px) autour de la carte pour les repères du quadrillage. */
  margin: number;
}

/** Dessine le fond de carte complet. Retourne les dimensions utiles. */
export function drawRegionBase(canvas: HTMLCanvasElement, def: RegionDef, pxPerKm: number, opts: BaseOptions): void {
  const W = def.size.width * pxPerKm;
  const H = def.size.height * pxPerKm;
  const M = opts.margin;
  canvas.width = Math.ceil(W + M * 2);
  canvas.height = Math.ceil(H + M * 2);
  const g = canvas.getContext('2d')!;
  const X = (km: number): number => M + km * pxPerKm;
  const Y = (km: number): number => M + km * pxPerKm;

  // Marge façon papier
  g.fillStyle = '#e8e1c8';
  g.fillRect(0, 0, canvas.width, canvas.height);

  // Teintes hypsométriques + ombrage + cultures
  const cellKm = pxPerKm >= 20 ? 0.125 : 0.25;
  const hm = heightmap(def, cellKm);
  const cpx = cellKm * pxPerKm;
  const fieldNoise = valueNoise(hm.w, hm.h, 3, new Rng(def.seed + 7), 2);
  for (let j = 0; j < hm.h - 1; j++) {
    for (let i = 0; i < hm.w - 1; i++) {
      const k = j * hm.w + i;
      const z = hm.data[k];
      let [r, gg, b] = hypso(z);
      if (hm.river[k] < def.relief.fieldsKm && z < 1650 && fieldNoise[k] > 0.35) {
        const t = 0.55 * (1 - hm.river[k] / def.relief.fieldsKm) + 0.25;
        r += (FIELDS[0] - r) * t;
        gg += (FIELDS[1] - gg) * t;
        b += (FIELDS[2] - b) * t;
      }
      // Ombrage : lumière du nord-ouest
      const dzx = hm.data[k + 1] - hm.data[Math.max(0, k - 1)];
      const dzy = hm.data[k + hm.w] - hm.data[Math.max(0, k - hm.w)];
      const shade = Math.max(0.78, Math.min(1.14, 1 - (dzx + dzy) / (cellKm * 1000) / 3.2));
      g.fillStyle = `rgb(${(r * shade) | 0},${(gg * shade) | 0},${(b * shade) | 0})`;
      g.fillRect(X(i * cellKm), Y(j * cellKm), cpx + 0.6, cpx + 0.6);
    }
  }

  // Courbes de niveau (marching squares)
  const step = def.relief.contourStep;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const z of hm.data) {
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  const lerp = (a: number, b: number, lv: number): number => (lv - a) / (b - a || 1);
  for (let lv = Math.ceil(zmin / step) * step; lv <= zmax; lv += step) {
    const index = lv % def.relief.indexContour === 0;
    if (pxPerKm < 20 && !index) continue; // petite échelle : maîtresses seulement
    g.beginPath();
    for (let j = 0; j < hm.h - 1; j++) {
      for (let i = 0; i < hm.w - 1; i++) {
        const a = hm.data[j * hm.w + i];
        const b = hm.data[j * hm.w + i + 1];
        const c = hm.data[(j + 1) * hm.w + i + 1];
        const d = hm.data[(j + 1) * hm.w + i];
        const code = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const x0 = i * cellKm;
        const y0 = j * cellKm;
        const top: [number, number] = [x0 + lerp(a, b, lv) * cellKm, y0];
        const right: [number, number] = [x0 + cellKm, y0 + lerp(b, c, lv) * cellKm];
        const bottom: [number, number] = [x0 + lerp(d, c, lv) * cellKm, y0 + cellKm];
        const left: [number, number] = [x0, y0 + lerp(a, d, lv) * cellKm];
        const seg = (p: [number, number], q: [number, number]): void => {
          g.moveTo(X(p[0]), Y(p[1]));
          g.lineTo(X(q[0]), Y(q[1]));
        };
        switch (code) {
          case 1: case 14: seg(left, bottom); break;
          case 2: case 13: seg(bottom, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(top, right); break;
          case 5: seg(left, top); seg(bottom, right); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, top); break;
          case 10: seg(top, right); seg(left, bottom); break;
        }
      }
    }
    g.strokeStyle = index ? 'rgba(110,72,40,0.75)' : 'rgba(130,90,55,0.35)';
    g.lineWidth = index ? 1.3 : 0.7;
    g.stroke();
  }

  const polyline = (p: PolylineDef): void => {
    g.beginPath();
    p.points.forEach(([x, y], i) => (i === 0 ? g.moveTo(X(x), Y(y)) : g.lineTo(X(x), Y(y))));
  };

  // Rivières
  for (const rv of def.rivers) {
    polyline(rv);
    g.strokeStyle = '#3e6f9a';
    g.lineWidth = (rv.width ?? 2) * (pxPerKm / 16) + 1;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
    polyline(rv);
    g.strokeStyle = '#7aa6c8';
    g.lineWidth = Math.max(0.6, (rv.width ?? 2) * (pxPerKm / 40));
    g.stroke();
  }

  // Routes et pistes
  for (const rd of def.roads) {
    polyline(rd);
    if (rd.type === 'highway') {
      g.setLineDash([]);
      g.strokeStyle = '#6e241a';
      g.lineWidth = Math.max(2, pxPerKm / 7);
      g.stroke();
      polyline(rd);
      g.strokeStyle = '#e8b890';
      g.lineWidth = Math.max(0.8, pxPerKm / 22);
      g.stroke();
    } else {
      g.setLineDash([pxPerKm / 4, pxPerKm / 6]);
      g.strokeStyle = '#4a3826';
      g.lineWidth = Math.max(1, pxPerKm / 22);
      g.stroke();
      g.setLineDash([]);
    }
  }

  // Quadrillage kilométrique
  const grid = def.gridKm;
  g.strokeStyle = 'rgba(40,70,100,0.38)';
  g.lineWidth = 1;
  for (let x = 0; x <= def.size.width; x += grid) {
    g.beginPath();
    g.moveTo(X(x), Y(0));
    g.lineTo(X(x), Y(def.size.height));
    g.stroke();
  }
  for (let y = 0; y <= def.size.height; y += grid) {
    g.beginPath();
    g.moveTo(X(0), Y(y));
    g.lineTo(X(def.size.width), Y(y));
    g.stroke();
  }
  g.strokeStyle = '#2a2a22';
  g.lineWidth = 2;
  g.strokeRect(X(0), Y(0), W, H);

  const text = (s: string, x: number, y: number, size: number, color: string, opts2: { italic?: boolean; align?: CanvasTextAlign; halo?: boolean } = {}): void => {
    g.font = `${opts2.italic ? 'italic ' : ''}${size}px VT323, "Courier New", monospace`;
    g.textAlign = opts2.align ?? 'center';
    g.textBaseline = 'middle';
    if (opts2.halo !== false) {
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(240,234,214,0.85)';
      g.strokeText(s, x, y);
    }
    g.fillStyle = color;
    g.fillText(s, x, y);
  };

  // Repères du quadrillage dans la marge
  if (M > 0) {
    for (let x = 0; x < def.size.width; x += grid) {
      const label = String.fromCharCode(65 + x / grid);
      text(label, X(x + grid / 2), M / 2, Math.max(12, M * 0.6), '#2a3a4a', { halo: false });
      text(label, X(x + grid / 2), canvas.height - M / 2, Math.max(12, M * 0.6), '#2a3a4a', { halo: false });
    }
    for (let y = 0; y < def.size.height; y += grid) {
      const label = String(y / grid + 1);
      text(label, M / 2, Y(y + grid / 2), Math.max(12, M * 0.6), '#2a3a4a', { halo: false });
      text(label, canvas.width - M / 2, Y(y + grid / 2), Math.max(12, M * 0.6), '#2a3a4a', { halo: false });
    }
  }

  // Villages (pâtés de maisons) et toponymes
  const fs = Math.max(11, pxPerKm * 0.6);
  for (const v of def.villages) {
    const cx = X(v.pos.x);
    const cy = Y(v.pos.y);
    const n = v.type === 'town' ? 9 : v.type === 'village' ? 4 : 2;
    const s = Math.max(2, pxPerKm / 9);
    const rng = new Rng(v.name.length * 97 + Math.round(v.pos.x * 13));
    g.fillStyle = '#2a2420';
    for (let k = 0; k < n; k++) {
      const ox = (rng.next() - 0.5) * s * (v.type === 'town' ? 7 : 4);
      const oy = (rng.next() - 0.5) * s * (v.type === 'town' ? 5 : 3);
      g.fillRect(cx + ox - s / 2, cy + oy - s / 2, s, s);
    }
    if (v.type === 'town') {
      g.strokeStyle = '#2a2420';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, s * 5, 0, Math.PI * 2);
      g.stroke();
    }
    if (opts.labels) text(v.type === 'town' ? v.name.toUpperCase() : v.name, cx, cy + s * (v.type === 'town' ? 7 : 4) + fs * 0.4, v.type === 'town' ? fs * 1.15 : fs, '#1e1a16');
  }

  if (opts.labels) {
    for (const m of def.mountains) text(m.name, X(m.x), Y(m.y), fs * 0.95, '#6a4628', { italic: true });
    for (const rv of def.rivers) {
      const mid = rv.points[Math.floor(rv.points.length / 2)];
      if (rv.name) text(rv.name, X(mid[0]) + pxPerKm * 0.6, Y(mid[1]) - pxPerKm * 0.6, fs * 0.9, '#2e5a82', { italic: true });
    }
    const hw = def.roads.find((r) => r.type === 'highway');
    if (hw?.name) {
      const p = hw.points[1];
      text(hw.name, X(p[0]), Y(p[1]) - pxPerKm * 0.7, fs * 0.85, '#6e241a');
    }

    // Cartouche
    const bw = 13 * pxPerKm;
    const bh = 3.4 * pxPerKm;
    const bx = X(def.size.width) - bw - pxPerKm * 0.6;
    const by = Y(def.size.height) - bh - pxPerKm * 0.6;
    g.fillStyle = 'rgba(240,234,214,0.92)';
    g.fillRect(bx, by, bw, bh);
    g.strokeStyle = '#2a2a22';
    g.lineWidth = 1.5;
    g.strokeRect(bx, by, bw, bh);
    text(def.province.toUpperCase(), bx + bw / 2, by + bh * 0.2, fs * 1.1, '#1e1a16', { halo: false });
    text(`${def.name} — carte tactique (fictive)`, bx + bw / 2, by + bh * 0.43, fs * 0.9, '#3a3228', { halo: false });
    // Échelle
    const sx = bx + pxPerKm;
    const sy = by + bh * 0.72;
    for (let k = 0; k < 2; k++) {
      g.fillStyle = k % 2 === 0 ? '#1e1a16' : '#f0ead6';
      g.fillRect(sx + k * 5 * pxPerKm, sy, 5 * pxPerKm, pxPerKm * 0.22);
    }
    g.strokeStyle = '#1e1a16';
    g.strokeRect(sx, sy, 10 * pxPerKm, pxPerKm * 0.22);
    text('0', sx, sy + pxPerKm * 0.6, fs * 0.8, '#1e1a16', { halo: false });
    text('5', sx + 5 * pxPerKm, sy + pxPerKm * 0.6, fs * 0.8, '#1e1a16', { halo: false });
    text('10 km', sx + 10 * pxPerKm, sy + pxPerKm * 0.6, fs * 0.8, '#1e1a16', { halo: false });

    // Nord
    const nx = X(def.size.width) - pxPerKm * 1.6;
    const ny = Y(0) + pxPerKm * 2;
    g.fillStyle = '#1e1a16';
    g.beginPath();
    g.moveTo(nx, ny - pxPerKm);
    g.lineTo(nx + pxPerKm * 0.4, ny + pxPerKm * 0.5);
    g.lineTo(nx, ny + pxPerKm * 0.2);
    g.lineTo(nx - pxPerKm * 0.4, ny + pxPerKm * 0.5);
    g.closePath();
    g.fill();
    text('N', nx, ny - pxPerKm * 1.5, fs * 1.1, '#1e1a16');
  }
}

/** Référence de carroyage (ex. « D5 ») d'une position en km. */
export function gridRef(def: RegionDef, x: number, y: number): string {
  const col = String.fromCharCode(65 + Math.min(Math.floor(def.size.width / def.gridKm) - 1, Math.max(0, Math.floor(x / def.gridKm))));
  const row = Math.min(Math.floor(def.size.height / def.gridKm), Math.max(1, Math.floor(y / def.gridKm) + 1));
  return `${col}${row}`;
}
