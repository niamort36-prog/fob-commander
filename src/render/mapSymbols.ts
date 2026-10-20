/**
 * Symboles tactiques simplifiés d'après l'APP-6 de l'OTAN :
 * cadre selon l'affiliation (ami : rectangle bleu ; hostile : losange rouge ; neutre : carré vert ;
 * inconnu : trèfle jaune), pictogramme de la fonction, indicateur d'échelon au-dessus.
 * Un cadre en pointillés signale un contact présumé (renseignement peu fiable ou ancien).
 */
import type Phaser from 'phaser';
import type { MapIcon } from '../core/ContentTypes';

export type Affiliation = 'friend' | 'hostile' | 'neutral' | 'unknown';

const FILL: Record<Affiliation, number> = {
  friend: 0x80c0ff,
  hostile: 0xff8080,
  neutral: 0xaaffaa,
  unknown: 0xffff80,
};

type G = Phaser.GameObjects.Graphics;

function dashedPolygon(g: G, pts: { x: number; y: number }[], dash: number): void {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let d = 0; d < len; d += dash * 2) {
      const t0 = d / len;
      const t1 = Math.min(1, (d + dash) / len);
      g.lineBetween(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1);
    }
  }
}

export interface SymbolBox {
  /** Demi-largeur / demi-hauteur du cadre (pour placer l'échelon et les étiquettes). */
  hw: number;
  hh: number;
}

/** Dessine un symbole centré en (x, y) ; `s` = taille de base en pixels monde. */
export function drawSymbol(g: G, x: number, y: number, s: number, aff: Affiliation, icon: MapIcon, dashed = false): SymbolBox {
  let pts: { x: number; y: number }[];
  let hw: number;
  let hh: number;
  switch (aff) {
    case 'friend':
      hw = s * 0.75;
      hh = s * 0.5;
      pts = [{ x: x - hw, y: y - hh }, { x: x + hw, y: y - hh }, { x: x + hw, y: y + hh }, { x: x - hw, y: y + hh }];
      break;
    case 'hostile':
      hw = s * 0.68;
      hh = s * 0.68;
      pts = [{ x, y: y - hh }, { x: x + hw, y }, { x, y: y + hh }, { x: x - hw, y }];
      break;
    case 'neutral':
      hw = s * 0.55;
      hh = s * 0.55;
      pts = [{ x: x - hw, y: y - hh }, { x: x + hw, y: y - hh }, { x: x + hw, y: y + hh }, { x: x - hw, y: y + hh }];
      break;
    default: {
      hw = s * 0.62;
      hh = s * 0.62;
      // Trèfle approché (quatre lobes)
      pts = [];
      for (let k = 0; k <= 32; k++) {
        const a = (Math.PI * 2 * k) / 32;
        const r = s * (0.48 + 0.14 * Math.cos(4 * a));
        pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
      }
    }
  }
  g.fillStyle(FILL[aff], dashed ? 0.55 : 1);
  g.fillPoints(pts, true);
  g.lineStyle(Math.max(1, s / 14), 0x101010, 1);
  if (dashed) dashedPolygon(g, pts, s / 6);
  else g.strokePoints(pts, true);

  // Pictogrammes (dans la boîte intérieure)
  const ix = hw * (aff === 'hostile' ? 0.5 : 0.8);
  const iy = hh * (aff === 'hostile' ? 0.5 : 0.8);
  g.lineStyle(Math.max(1, s / 16), 0x101010, 1);
  switch (icon) {
    case 'infantry':
      g.lineBetween(x - ix, y - iy, x + ix, y + iy);
      g.lineBetween(x - ix, y + iy, x + ix, y - iy);
      break;
    case 'hq':
      g.lineBetween(x - ix, y - iy, x + ix, y + iy);
      g.lineBetween(x - ix, y + iy, x + ix, y - iy);
      // Hampe du poste de commandement
      g.lineBetween(x - hw, y, x - hw, y + hh + s * 0.6);
      break;
    case 'mortar':
      g.strokeCircle(x, y + iy * 0.35, s * 0.12);
      g.lineBetween(x, y + iy * 0.35 - s * 0.12, x, y - iy);
      g.lineBetween(x, y - iy, x - s * 0.12, y - iy + s * 0.14);
      g.lineBetween(x, y - iy, x + s * 0.12, y - iy + s * 0.14);
      break;
    case 'camp':
      g.lineBetween(x - ix, y + iy * 0.6, x, y - iy * 0.6);
      g.lineBetween(x, y - iy * 0.6, x + ix, y + iy * 0.6);
      g.lineBetween(x - ix, y + iy * 0.6, x + ix, y + iy * 0.6);
      break;
    case 'cache':
      g.strokeRect(x - ix * 0.7, y - iy * 0.5, ix * 1.4, iy);
      g.lineBetween(x - ix * 0.7, y - iy * 0.5, x + ix * 0.7, y + iy * 0.5);
      break;
    case 'installation':
      g.fillStyle(0x101010, 1);
      g.fillRect(x - hw * 0.5, y - hh - s * 0.18, hw, s * 0.18);
      g.lineBetween(x - ix, y - iy, x + ix, y + iy);
      g.lineBetween(x - ix, y + iy, x + ix, y - iy);
      break;
    case 'mechanized':
      // Infanterie mécanisée : croix + ovale de blindé
      g.lineBetween(x - ix, y - iy, x + ix, y + iy);
      g.lineBetween(x - ix, y + iy, x + ix, y - iy);
      g.strokeEllipse(x, y, ix * 1.5, iy * 1.2);
      break;
    case 'police':
    case 'ied':
      // Texte dessiné par l'appelant
      break;
  }
  return { hw, hh };
}
