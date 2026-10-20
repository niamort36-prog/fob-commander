/**
 * Silhouettes des personnages (canevas AGENT_W × AGENT_H, pieds en AGENT_FOOT_Y) :
 * tenue propre à chaque rôle (casque, gilet, casquette, gilet haute visibilité, brassard de
 * secouriste, tenue civile, shalwar kamiz…), trois teintes de peau et plusieurs poses
 * (debout, en marche, couché au tir, bras levés pour les tractions).
 */
import type Phaser from 'phaser';
import { AGENT_FOOT_Y, AGENT_W } from './spriteKeys';

type G = Phaser.GameObjects.Graphics;

/** Poses de sport (tenue de sport : t-shirt gris, short noir, baskets ; sans arme ni casque). */
export const SPORT_POSES = ['run', 'run2', 'hang', 'pull', 'climb', 'pushup', 'pushdown', 'squatup', 'squat', 'bench', 'benchdown'] as const;
export type SportPose = (typeof SPORT_POSES)[number];
export type FigurePose = 'stand' | 'walk' | 'prone' | 'armsup' | SportPose;
export const FIGURE_POSES: FigurePose[] = ['stand', 'walk', 'prone', 'armsup', ...SPORT_POSES];
export const SKIN_TONES = [0xe0b48e, 0xc9a07a, 0x9a7050];

export type FigureKit = 'infantry' | 'sf' | 'officer' | 'commander' | 'logistics' | 'cook' | 'medic' | 'contractor' | 'cia' | 'auxiliary' | 'insurgent' | 'civilian';

export interface FigureSpec {
  color: string; // tenue (haut et pantalon)
  accent?: string;
  kit?: FigureKit;
  vest?: string;
  helmet?: boolean;
  headwear?: 'turban' | 'pakol' | 'headscarf' | 'cap' | 'none';
  beard?: string | boolean;
  rifle?: boolean;
}

const hex = (s: string): number => parseInt(s.slice(1), 16);
const shade = (c: number, f: number): number => {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
};

/** Couvre-chef par défaut selon le rôle. */
function headOf(spec: FigureSpec): 'helmet' | 'helmet_nvg' | 'cap' | 'patrol' | 'pakol' | 'turban' | 'headscarf' | 'toque' | 'none' {
  if (spec.headwear === 'turban' || spec.headwear === 'pakol' || spec.headwear === 'headscarf') return spec.headwear;
  if (spec.headwear === 'cap') return 'cap';
  switch (spec.kit) {
    case 'infantry':
      return 'helmet';
    case 'sf':
      return spec.helmet === false ? 'cap' : 'helmet_nvg';
    case 'officer':
    case 'commander':
      return 'patrol';
    case 'logistics':
    case 'contractor':
    case 'cia':
      return 'cap';
    case 'medic':
      return 'helmet';
    case 'auxiliary':
      return 'pakol';
    case 'cook':
      return 'toque';
    default:
      return spec.helmet ? 'helmet' : 'none';
  }
}

/**
 * Silhouette en tenue de sport. Repères (pieds en f = AGENT_FOOT_Y) :
 * - « hang » : bras tendus jusqu'au haut du canevas (mains à f − 26) ;
 * - « pull » : mains à f − 21, coudes écartés (le rendu soulève le sprite de 5 px : mêmes mains) ;
 * - « bench » / « benchdown » : allongé sur le dos dans l'axe x de la grille (diagonale), barre tendue / à la poitrine ;
 * - « squatup » / « squat » : barre sur les épaules, debout / accroupi ;
 * - « pushup » / « pushdown » : gainage bras tendus / poitrine au sol ;
 * - « climb » : comme « hang », sans barre (escalade du mur du parcours) ;
 * - « run » / « run2 » : foulées alternées.
 */
function drawSport(g: G, spec: FigureSpec, pose: SportPose, skin: number): void {
  const cx = AGENT_W / 2;
  const f = AGENT_FOOT_Y;
  const shirt = 0x8c8c84;
  const shirtDark = 0x6e6e68;
  const shorts = 0x1e1e1e;
  const shoe = 0xd8d8d0;
  const hair = spec.kit === 'auxiliary' || spec.beard ? 0x1e1812 : 0x2a2018;
  const steel = 0x8a877e;
  const plate = 0x1e1d18;
  const px = (x: number, y: number, w: number, h: number, c: number, a = 1): void => {
    g.fillStyle(c, a);
    g.fillRect(x, y, w, h);
  };
  const head = (x: number, y: number): void => {
    px(x - 1, y - 1, 6, 6, 0x1e1d16, 0.6); // contour
    px(x, y, 4, 4, skin);
    px(x, y - 1, 4, 2, hair);
    px(x + 1, y + 2, 1, 1, 0x2b2018);
    px(x + 3, y + 2, 1, 1, 0x2b2018);
  };
  const barbell = (x0: number, y0: number, x1: number, y1: number): void => {
    // Barre (tracé en pixels) et disques aux extrémités
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let k = 0; k <= n; k++) px(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), 1, 1, steel);
    px(Math.round(x0) - 1, Math.round(y0) - 2, 2, 5, plate);
    px(Math.round(x1), Math.round(y1) - 2, 2, 5, plate);
  };
  const shadow = (w = 12): void => {
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(cx, f, w, 4);
  };

  switch (pose) {
    case 'run':
    case 'run2': {
      shadow();
      const a = pose === 'run' ? 1 : -1;
      // Jambes en foulée (mollets nus, baskets)
      px(cx - 3 - a, f - 6, 2, 5, skin);
      px(cx + 1 + a, f - 6, 2, 5, skin);
      px(cx - 3 - a, f - 1, 3, 1, shoe);
      px(cx + 1 + a, f - 1, 3, 1, shoe);
      px(cx - 4, f - 10, 8, 4, shorts);
      px(cx - 4, f - 17, 8, 7, shirt);
      px(cx - 4, f - 17, 1, 7, shirtDark);
      // Bras balancés
      px(cx - 5, f - 16 + a, 1, 5, skin);
      px(cx + 4, f - 16 - a, 1, 5, skin);
      head(cx - 2, f - 22);
      return;
    }
    case 'hang':
    case 'pull':
    case 'climb': {
      const pull = pose === 'pull';
      // Bras : tendus jusqu'en haut, ou fléchis coudes écartés
      // Bras (2 px, liseré sombre pour la lisibilité) et barre tenue par-dessus les mains
      const arm = (x: number, y: number, w: number, hgt: number): void => {
        px(x - 1, y, w + 2, hgt, 0x1e1d16, 0.5);
        px(x, y, w, hgt, skin);
      };
      // La barre du portique suit l'axe x de la grille : elle monte de 1 px tous les 2 px vers la
      // gauche à l'écran. Main gauche en haut, main droite 4 px plus bas.
      const hands = pull ? 5 : 1;
      const barY = (x: number): number => hands - 1 + Math.round((x - (cx - 4)) / 2);
      if (!pull) {
        arm(cx - 5, barY(cx - 4) + 1, 2, f - 17 - barY(cx - 4) - 1);
        arm(cx + 3, barY(cx + 4) + 1, 2, f - 17 - barY(cx + 4) - 1);
      } else {
        // Coudes écartés et fléchis
        arm(cx - 5, barY(cx - 4) + 1, 2, 2);
        arm(cx + 3, barY(cx + 4) + 1, 2, 2);
        arm(cx - 7, 7, 3, 2);
        arm(cx + 4, 7, 3, 2);
        arm(cx - 7, 8, 2, 2);
        arm(cx + 5, 8, 2, 2);
      }
      // Escalade : bras levés agrippés au sommet du mur, sans barre
      if (pose !== 'climb')
        for (let x = 0; x < AGENT_W; x++) {
          const y = barY(x);
          if (y >= 0) px(x, y, 1, 2, steel);
        }
      px(cx - 5, barY(cx - 4), 2, 2, shade(skin, 0.85));
      px(cx + 3, barY(cx + 4), 2, 2, shade(skin, 0.85));
      px(cx - 4, f - 17, 8, 7, shirt);
      px(cx - 4, f - 17, 1, 7, shirtDark);
      px(cx - 4, f - 10, 8, 3, shorts);
      // Jambes pendantes, genoux légèrement fléchis
      px(cx - 3, f - 7, 2, 5, skin);
      px(cx + 1, f - 7, 2, 5, skin);
      px(cx - 4, f - 2, 3, 1, shoe);
      px(cx + 1, f - 2, 3, 1, shoe);
      head(cx - 2, f - 22);
      return;
    }
    case 'pushup':
    case 'pushdown': {
      shadow(14);
      const low = pose === 'pushdown';
      // Corps gainé : épaules à gauche, pieds à droite
      const sh = low ? f - 3 : f - 7;
      for (let x = 4; x <= 14; x++) {
        const y = Math.round(sh + ((f - 1 - sh) * (x - 4)) / 10);
        const c = x < 9 ? shirt : x < 11 ? shorts : x < 14 ? skin : shoe;
        px(x, y - 1, 1, 3, c);
      }
      // Bras : tendus (verticaux) ou fléchis (coude relevé)
      if (!low) px(4, sh + 1, 1, f - sh - 1, skin);
      else {
        px(5, sh - 2, 1, 2, skin);
        px(3, sh + 1, 2, 1, skin);
      }
      head(0, sh - 3);
      return;
    }
    case 'squatup':
    case 'squat': {
      shadow();
      const low = pose === 'squat';
      const d = low ? 4 : 0;
      if (!low) {
        px(cx - 3, f - 7, 2, 6, skin);
        px(cx + 1, f - 7, 2, 6, skin);
      } else {
        // Cuisses à l'horizontale, genoux en avant
        px(cx - 4, f - 6, 3, 2, shorts);
        px(cx + 1, f - 6, 3, 2, shorts);
        px(cx - 5, f - 5, 2, 4, skin);
        px(cx + 3, f - 5, 2, 4, skin);
      }
      px(cx - 4, f - 1, 3, 1, shoe);
      px(cx + 1, f - 1, 3, 1, shoe);
      px(cx - 4, f - 10 + d, 8, low ? 4 : 3, shorts);
      px(cx - 4, f - 17 + d, 8, 7, shirt);
      px(cx - 4, f - 17 + d, 1, 7, shirtDark);
      head(cx - 2, f - 22 + d);
      // Barre sur les trapèzes, mains de part et d'autre
      barbell(1, f - 17 + d, 14, f - 17 + d);
      px(cx - 5, f - 17 + d, 1, 3, skin);
      px(cx + 4, f - 17 + d, 1, 3, skin);
      return;
    }
    case 'bench':
    case 'benchdown': {
      // Allongé sur le dos, dans l'axe x de la grille (vers le bas à droite à l'écran)
      const at = (k: number): [number, number] => [2 + k, Math.round(f - 12 + k / 2)];
      for (let k = 0; k <= 10; k++) {
        const [x, y] = at(k);
        const c = k < 4 ? 0 : k < 7 ? shirt : k < 9 ? shorts : skin;
        if (c) px(x, y, 1, 3, c);
      }
      // Jambes repliées, pieds au sol de part et d'autre du banc
      const [kx, ky] = at(10);
      px(kx, ky + 2, 1, 4, skin);
      px(kx, ky + 6, 2, 1, shoe);
      const [hx, hy] = at(0);
      head(hx - 1, hy - 2);
      // Bras et barre (perpendiculaire au banc : direction iso y)
      const [sx, sy] = at(5);
      const up = pose === 'bench' ? 8 : 3;
      px(sx, sy - up, 1, up, skin);
      barbell(sx - 4, sy - up + 2, sx + 4, sy - up - 2);
      return;
    }
  }
}

export function drawFigure(g: G, spec: FigureSpec, pose: FigurePose, skinIndex: number): void {
  const skin = SKIN_TONES[Math.max(0, Math.min(SKIN_TONES.length - 1, skinIndex))];
  if ((SPORT_POSES as readonly string[]).includes(pose)) return drawSport(g, spec, pose as SportPose, skin);
  const cloth = hex(spec.color);
  const accent = spec.accent ? hex(spec.accent) : shade(cloth, 1.25);
  const vest = spec.vest ? hex(spec.vest) : null;
  const dark = 0x1e1d16;
  const boots = 0x3a2f22;
  const kit = spec.kit;
  const armed = spec.rifle ?? (kit === 'infantry' || kit === 'sf' || kit === 'contractor' || kit === 'auxiliary' || kit === 'insurgent');
  const beard = spec.beard === true ? 0x2a2018 : typeof spec.beard === 'string' ? hex(spec.beard) : kit === 'sf' || kit === 'contractor' || kit === 'cia' || kit === 'auxiliary' || kit === 'insurgent' ? 0x2a2018 : null;
  const head = headOf(spec);
  const cx = AGENT_W / 2;
  const f = AGENT_FOOT_Y;
  const px = (x: number, y: number, w: number, h: number, c: number, a = 1): void => {
    g.fillStyle(c, a);
    g.fillRect(x, y, w, h);
  };

  if (pose === 'prone') {
    // Couché au tir, tête à gauche, arme en avant
    px(0, f - 1, AGENT_W, 2, 0x000000, 0.25);
    px(1, f - 5, 14, 4, dark, 0.8); // contour
    px(10, f - 4, 5, 2, shade(cloth, 0.7)); // jambes
    px(14, f - 4, 2, 2, boots);
    px(5, f - 5, 6, 3, cloth); // torse
    if (vest !== null) px(6, f - 5, 4, 2, vest);
    px(2, f - 6, 4, 4, skin); // tête
    if (head === 'helmet' || head === 'helmet_nvg') px(2, f - 7, 4, 2, shade(cloth, 0.8));
    else if (head === 'cap' || head === 'patrol') px(2, f - 7, 4, 1, shade(accent, 0.9));
    else if (head === 'pakol' || head === 'turban') px(2, f - 7, 4, 2, accent);
    if (armed) {
      px(0, f - 4, 6, 1, dark);
      px(5, f - 3, 2, 1, 0x5a3a22);
    }
    return;
  }

  // Ombre et contour sombre (lisibilité sur le sable)
  px(cx - 6, f - 1, 12, 2, 0x000000, 0.22);
  g.fillStyle(0x000000, 0.28);
  g.fillEllipse(cx, f, 12, 4);
  const lift = pose === 'armsup' ? 1 : 0;
  px(cx - 5, f - 17 - lift, 10, 11, dark, 0.85);
  px(cx - 4, f - 9, 8, 9, dark, 0.85);
  px(cx - 4, f - 25 - lift, 8, 9, dark, 0.85);

  // Jambes (en marche : écartées)
  const trousers = kit === 'contractor' ? 0x5a5040 : kit === 'cia' ? 0x8a7a5a : kit === 'auxiliary' || kit === 'insurgent' ? shade(cloth, 0.9) : shade(cloth, 0.75);
  if (pose === 'walk') {
    px(cx - 4, f - 8, 2, 6, trousers);
    px(cx + 2, f - 8, 2, 6, trousers);
    px(cx - 4, f - 2, 2, 2, boots);
    px(cx + 2, f - 2, 2, 2, boots);
  } else {
    px(cx - 3, f - 8, 2, 6, trousers);
    px(cx + 1, f - 8, 2, 6, trousers);
    if (pose !== 'armsup') {
      px(cx - 3, f - 2, 2, 2, boots);
      px(cx + 1, f - 2, 2, 2, boots);
    } else {
      px(cx - 3, f - 2, 2, 1, boots);
      px(cx + 1, f - 2, 2, 1, boots);
    }
  }

  // Torse : tenue, tunique longue (auxiliaire), gilet, ceinturon
  const top = f - 16 - lift;
  if (kit === 'auxiliary' || kit === 'insurgent' || kit === 'civilian') px(cx - 4, top, 8, 10, cloth);
  else px(cx - 4, top, 8, 9, cloth);
  px(cx - 4, top, 1, 9, shade(cloth, 0.8));
  if (kit === 'logistics') {
    // Gilet haute visibilité à bandes réfléchissantes
    px(cx - 3, top + 1, 6, 6, 0xe0c040);
    px(cx - 3, top + 3, 6, 1, 0xd8d8d0);
    px(cx - 3, top + 5, 6, 1, 0xd8d8d0);
  } else if (vest !== null) {
    px(cx - 3, top + 1, 6, 6, vest);
    px(cx - 2, top + 4, 1, 2, shade(vest, 0.7)); // poches
    px(cx + 1, top + 4, 1, 2, shade(vest, 0.7));
  }
  if (kit === 'medic') {
    // Croix rouge sur fond blanc
    px(cx - 2, top + 2, 4, 4, 0xf0ece0);
    px(cx - 1, top + 2, 2, 4, 0xc0302a);
    px(cx - 2, top + 3, 4, 2, 0xc0302a);
  }
  if (kit === 'commander' || kit === 'officer') px(cx - 1, top + 1, 2, 1, hex(spec.accent ?? '#d8c47a')); // insigne de grade
  if (kit !== 'auxiliary' && kit !== 'insurgent' && kit !== 'civilian') px(cx - 4, f - 8, 8, 1, 0x2b2a24); // ceinturon
  if (kit === 'cook') {
    // Tablier blanc noué à la taille
    px(cx - 3, top + 2, 6, 11, 0xe8e4d8);
    px(cx - 3, top + 2, 1, 11, 0xc8c4b8);
    px(cx - 4, f - 8, 8, 1, 0xd0ccc0);
  }

  // Bras (levés pour les tractions)
  const sleeve = shade(cloth, 0.85);
  if (pose === 'armsup') {
    px(cx - 5, f - 27 - lift, 1, 11, sleeve);
    px(cx + 4, f - 27 - lift, 1, 11, sleeve);
    px(cx - 5, f - 28 - lift, 1, 1, skin);
    px(cx + 4, f - 28 - lift, 1, 1, skin);
  } else {
    const swing = pose === 'walk' ? 1 : 0;
    px(cx - 5, top + 1 + swing, 1, 6, sleeve);
    px(cx + 4, top + 1 - swing, 1, 6, sleeve);
    px(cx - 5, top + 7 + swing, 1, 1, skin);
    px(cx + 4, top + 7 - swing, 1, 1, skin);
    if (kit === 'medic') px(cx - 5, top + 2, 1, 2, 0xf0ece0); // brassard
  }

  // Tête et visage
  const hy = f - 22 - lift;
  px(cx - 3, hy, 6, 6, skin);
  px(cx - 2, hy + 2, 1, 1, 0x2b2018);
  px(cx + 1, hy + 2, 1, 1, 0x2b2018);
  if (kit === 'contractor') px(cx - 3, hy + 2, 6, 1, 0x1a1a18); // lunettes de soleil
  if (beard !== null) px(cx - 3, hy + 4, 6, head === 'turban' ? 3 : 2, beard);

  // Couvre-chef
  switch (head) {
    case 'helmet':
    case 'helmet_nvg': {
      const h = shade(vest ?? cloth, 0.95);
      px(cx - 4, hy - 2, 8, 3, h);
      px(cx - 3, hy - 3, 6, 1, h);
      if (head === 'helmet_nvg') px(cx - 1, hy - 3, 2, 2, 0x1a1a18);
      break;
    }
    case 'patrol':
      px(cx - 3, hy - 2, 6, 3, shade(cloth, 0.9));
      px(cx - 3, hy + 1, 7, 1, shade(cloth, 0.7));
      if (kit === 'commander') px(cx, hy - 1, 1, 1, 0xe8d070);
      break;
    case 'cap':
      px(cx - 3, hy - 2, 6, 2, kit === 'contractor' ? 0x2a2a26 : shade(accent, 0.9));
      px(cx - 3, hy, 7, 1, shade(kit === 'contractor' ? 0x2a2a26 : accent, 0.7));
      break;
    case 'toque':
      // Calot de cuisine blanc
      px(cx - 3, hy - 3, 6, 3, 0xf0ece4);
      px(cx - 3, hy, 6, 1, 0xd0ccc0);
      break;
    case 'pakol':
      px(cx - 4, hy - 2, 8, 3, accent);
      px(cx - 3, hy - 3, 6, 1, shade(accent, 1.1));
      break;
    case 'turban':
      px(cx - 4, hy - 3, 8, 4, accent);
      px(cx - 3, hy - 4, 6, 1, shade(accent, 1.08));
      break;
    case 'headscarf':
      px(cx - 4, hy - 2, 8, 3, accent);
      px(cx - 4, hy + 1, 1, 6, accent);
      px(cx + 3, hy + 1, 1, 6, accent);
      px(cx - 5, top, 10, 2, accent);
      break;
    default:
      px(cx - 3, hy - 1, 6, 2, 0x2a2018); // cheveux
  }

  // Arme tenue en travers (lunette pour les forces spéciales)
  if (armed && pose !== 'armsup') {
    g.fillStyle(0x1e1a14, 1);
    for (let k = 0; k < 11; k++) g.fillRect(cx - 6 + k, top + 7 - Math.floor(k / 2.2), 1, 2);
    px(cx - 7, top + 7, 3, 2, 0x5a3a22);
    if (kit === 'sf') px(cx - 1, top + 3, 2, 1, 0x3a3a34);
  }
  if ((kit === 'officer' || kit === 'commander') && pose !== 'armsup') px(cx + 3, f - 9, 1, 2, 0x2b2a24); // étui de pistolet
}
