/**
 * Conversions grille ↔ écran pour une projection isométrique 2:1.
 * Le point écran d'une case (x, y) est son sommet nord (haut du losange).
 */
import type { GridPos } from '../core/GameState';

export interface Point {
  x: number;
  y: number;
}

export class IsoMath {
  readonly halfW: number;
  readonly halfH: number;

  constructor(
    readonly tileW: number,
    readonly tileH: number,
  ) {
    this.halfW = tileW / 2;
    this.halfH = tileH / 2;
  }

  /** Sommet nord de la case (accepte des coordonnées fractionnaires). */
  toScreen(x: number, y: number): Point {
    return { x: (x - y) * this.halfW, y: (x + y) * this.halfH };
  }

  /** Centre du losange de la case. */
  tileCenter(x: number, y: number): Point {
    return this.toScreen(x + 0.5, y + 0.5);
  }

  /** Coordonnées de grille fractionnaires d'un point du monde. */
  toGridFloat(sx: number, sy: number): Point {
    const a = sx / this.halfW;
    const b = sy / this.halfH;
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  /** Case contenant le point du monde. */
  toGrid(sx: number, sy: number): GridPos {
    const g = this.toGridFloat(sx, sy);
    return { x: Math.floor(g.x), y: Math.floor(g.y) };
  }

  /** Les 4 sommets (N, E, S, O) d'un rectangle de cases, en coordonnées monde. */
  footprintCorners(x: number, y: number, w: number, h: number): [Point, Point, Point, Point] {
    return [this.toScreen(x, y), this.toScreen(x + w, y), this.toScreen(x + w, y + h), this.toScreen(x, y + h)];
  }
}
