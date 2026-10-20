/** Éclairage nocturne : état des sources de lumière (partagé par le combat et le rendu). */
import type { ContentRegistry } from '../core/ContentRegistry';
import type { BuildingInstance, GameState } from '../core/GameState';

/** Part de la demande électrique couverte (0..1). */
export function powerRatio(state: GameState): number {
  const { supply, demand } = state.resources.power;
  if (demand <= 0) return supply > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, supply / demand));
}

/** Intensité d'une source de lumière de bâtiment (0 = éteinte). */
export function buildingLight(content: ContentRegistry, state: GameState, b: BuildingInstance, ratio = powerRatio(state)): number {
  const light = content.building(b.defId).light;
  if (!light || (b.state !== 'active' && b.state !== 'damaged')) return 0;
  const k = light.power ? ratio : 1;
  return b.state === 'damaged' ? k * 0.6 : k;
}

export interface AmbientSample {
  r: number;
  g: number;
  b: number;
  /** Part de nuit (0 = plein jour, 1 = nuit noire). */
  night: number;
}

/** Teinte et part de nuit à une heure donnée (minutes depuis minuit), interpolées entre les repères. */
export function ambientAt(keyframes: { hour: number; color: string; night: number }[], minuteOfDay: number): AmbientSample {
  const h = (((minuteOfDay / 60) % 24) + 24) % 24;
  const rgb = (hex: string): [number, number, number] => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  for (let i = 1; i < keyframes.length; i++) {
    if (h <= keyframes[i].hour) {
      const a = keyframes[i - 1];
      const b = keyframes[i];
      const k = (h - a.hour) / Math.max(0.0001, b.hour - a.hour);
      const [ar, ag, ab] = rgb(a.color);
      const [br, bg, bb] = rgb(b.color);
      return { r: ar + (br - ar) * k, g: ag + (bg - ag) * k, b: ab + (bb - ab) * k, night: a.night + (b.night - a.night) * k };
    }
  }
  const last = keyframes[keyframes.length - 1];
  const [r, g, b] = rgb(last.color);
  return { r, g, b, night: last.night };
}
