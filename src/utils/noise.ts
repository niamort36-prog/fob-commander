/** Bruit de valeur 2D multi-octaves, normalisé dans [0, 1]. */
import type { Rng } from './Rng';

const smooth = (t: number): number => t * t * (3 - 2 * t);

export function valueNoise(width: number, height: number, scale: number, rng: Rng, octaves = 3): Float32Array {
  const out = new Float32Array(width * height);
  let amp = 1;
  let cell = Math.max(1, scale);

  for (let o = 0; o < octaves; o++) {
    const gw = Math.ceil(width / cell) + 2;
    const gh = Math.ceil(height / cell) + 2;
    const lattice = new Float32Array(gw * gh);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();

    for (let y = 0; y < height; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      for (let x = 0; x < width; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const a = lattice[y0 * gw + x0];
        const b = lattice[y0 * gw + x0 + 1];
        const c = lattice[(y0 + 1) * gw + x0];
        const d = lattice[(y0 + 1) * gw + x0 + 1];
        const top = a + (b - a) * tx;
        const bottom = c + (d - c) * tx;
        out[y * width + x] += amp * (top + (bottom - top) * ty);
      }
    }
    amp *= 0.5;
    cell = Math.max(1, cell / 2);
  }

  // Normalisation min-max : les seuils des sites deviennent des proportions approximatives.
  let min = Infinity;
  let max = -Infinity;
  for (const v of out) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) / span;
  return out;
}
