/**
 * Portraits pixel art générés à partir des paramètres de events.json (32 × 32, agrandis en CSS).
 * Teint, cheveux, barbe, couvre-chef, vêtements et accessoires suffisent à distinguer les personnages.
 */
import type { PortraitDef } from '../core/ContentTypes';

export const PORTRAIT_SIZE = 32;

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number): number => Math.min(255, Math.max(0, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

export function drawPortrait(canvas: HTMLCanvasElement, p: PortraitDef): void {
  canvas.width = PORTRAIT_SIZE;
  canvas.height = PORTRAIT_SIZE;
  const g = canvas.getContext('2d')!;
  const px = (x: number, y: number, w: number, h: number, color: string): void => {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  };
  const skin = p.skin;
  const hair = p.hair;
  const beard = p.beardColor ?? p.hair;
  const hw = p.headwearColor ?? '#6b6a4a';

  // Fond : lumière chaude en haut, ombre en bas
  for (let y = 0; y < 32; y++) px(0, y, 32, 1, y < 16 ? '#2a2c22' : '#1d1f17');
  px(0, 0, 32, 1, '#3a3d2c');

  // Voile : couvre la tête et les épaules
  if (p.headwear === 'headscarf') {
    px(6, 4, 20, 28, hw);
    px(5, 8, 1, 24, shade(hw, 0.7));
    px(26, 8, 1, 24, shade(hw, 0.7));
  }

  // Épaules et vêtement
  px(4, 25, 24, 7, p.clothes);
  px(3, 27, 1, 5, shade(p.clothes, 0.7));
  px(28, 27, 1, 5, shade(p.clothes, 0.7));
  px(12, 24, 8, 2, shade(p.clothes, 0.75)); // col
  if (p.accessory === 'press') {
    px(4, 27, 24, 5, '#3f6fa0');
    px(9, 28, 14, 2, '#e8e2d0');
  }
  if (p.accessory === 'medic') {
    px(20, 27, 5, 5, '#e8e2d0');
    px(22, 27, 1, 5, '#b03a2e');
    px(20, 29, 5, 1, '#b03a2e');
  }

  // Cou et visage
  px(13, 20, 6, 5, shade(skin, 0.82));
  px(10, 8, 12, 14, skin);
  px(11, 7, 10, 1, skin);
  px(11, 22, 10, 1, shade(skin, 0.9));
  px(10, 8, 1, 14, shade(skin, 0.88)); // ombre latérale
  px(21, 9, 1, 12, shade(skin, 0.8));
  px(9, 13, 1, 4, shade(skin, 0.85)); // oreilles
  px(22, 13, 1, 4, shade(skin, 0.75));

  // Cheveux (visibles sous les couvre-chefs légers)
  if (p.headwear === 'none' || p.headwear === 'cap' || p.headwear === 'patrol_cap') {
    px(10, 6, 12, 3, hair);
    px(9, 8, 2, 5, hair);
    px(21, 8, 2, 5, hair);
  }

  // Yeux, sourcils, nez, bouche
  px(12, 12, 3, 1, shade(hair, 0.9));
  px(17, 12, 3, 1, shade(hair, 0.9));
  px(13, 14, 2, 1, '#1a1612');
  px(18, 14, 2, 1, '#1a1612');
  px(16, 15, 1, 3, shade(skin, 0.78));
  px(14, 19, 4, 1, shade(skin, 0.6));

  // Barbe
  switch (p.beard) {
    case 'stubble':
      for (let y = 17; y < 22; y++) for (let x = 11; x < 21; x++) if ((x + y) % 2 === 0 && !(y === 19 && x >= 14 && x < 18)) px(x, y, 1, 1, shade(beard, 1.1));
      break;
    case 'short':
      px(11, 17, 10, 5, beard);
      px(12, 22, 8, 1, beard);
      px(14, 19, 4, 1, shade(skin, 0.6));
      break;
    case 'long':
      px(11, 16, 10, 7, beard);
      px(12, 23, 8, 3, beard);
      px(13, 26, 6, 1, shade(beard, 0.9));
      px(14, 19, 4, 1, shade(beard, 0.6));
      break;
    case 'mustache':
      px(13, 17, 6, 1, beard);
      px(12, 18, 1, 1, beard);
      px(19, 18, 1, 1, beard);
      break;
    default:
      break;
  }

  // Couvre-chef
  switch (p.headwear) {
    case 'turban':
      px(8, 3, 16, 7, hw);
      px(9, 2, 14, 1, hw);
      px(8, 9, 16, 1, shade(hw, 0.8));
      for (const y of [4, 6, 8]) px(9, y, 14, 1, shade(hw, 0.88));
      px(20, 3, 3, 3, shade(hw, 1.08));
      break;
    case 'pakol':
      px(9, 4, 14, 3, hw);
      px(8, 7, 16, 2, shade(hw, 0.82));
      px(10, 4, 12, 1, shade(hw, 1.1));
      break;
    case 'helmet':
      px(8, 4, 16, 6, hw);
      px(9, 3, 14, 1, hw);
      px(7, 9, 18, 1, shade(hw, 0.75));
      px(10, 5, 4, 1, shade(hw, 1.15));
      px(9, 10, 1, 9, '#2a2a22'); // jugulaire
      px(22, 10, 1, 9, '#2a2a22');
      break;
    case 'cap':
      px(9, 4, 14, 4, hw);
      px(9, 8, 16, 1, shade(hw, 0.7)); // visière
      px(11, 5, 4, 1, shade(hw, 1.15));
      break;
    case 'patrol_cap':
      px(9, 3, 14, 5, hw);
      px(9, 8, 15, 1, shade(hw, 0.7));
      px(10, 3, 12, 1, shade(hw, 1.12));
      break;
    case 'headscarf':
      px(9, 5, 14, 3, hw);
      px(9, 8, 1, 14, hw);
      px(22, 8, 1, 14, hw);
      break;
    default:
      break;
  }

  // Lunettes
  if (p.accessory === 'glasses') {
    g.strokeStyle = '#1a1612';
    g.lineWidth = 1;
    g.strokeRect(11.5, 13.5, 4, 2);
    g.strokeRect(16.5, 13.5, 4, 2);
    px(15, 14, 2, 1, '#1a1612');
  }
}
