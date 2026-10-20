import { describe, expect, it } from 'vitest';
import { loadDefaultContent } from '../src/core/ContentRegistry';
import { DEPTH, objectDepth } from '../src/render/depth';

/** Profondeur d'un agent ou d'un véhicule au point (x, y) : même échelle que les rendus. */
const pointDepth = (x: number, y: number): number => DEPTH.objects + (x + y - 1) * 10 + 6;

describe('Tri de profondeur de la vue isométrique', () => {
  const content = loadDefaultContent();
  const dfac = content.building('dfac'); // 4 × 3
  const hesco = content.building('hesco');
  const B = { x: 10, y: 10, w: 4, h: 3 };
  const building = objectDepth(dfac, B.x, B.y, B.w, B.h);
  const wall = (x: number, y: number): number => objectDepth(hesco, x, y, 1, 1);

  it('les murs contre les façades visibles passent devant, ceux du fond derrière', () => {
    // Façade droite (+x) et façade avant (+y), sur toute leur longueur
    for (let y = B.y; y < B.y + B.h; y++) expect(wall(B.x + B.w, y)).toBeGreaterThan(building);
    for (let x = B.x; x < B.x + B.w; x++) expect(wall(x, B.y + B.h)).toBeGreaterThan(building);
    // Côtés cachés (−x, −y)
    for (let y = B.y; y < B.y + B.h; y++) expect(wall(B.x - 1, y)).toBeLessThan(building);
    for (let x = B.x; x < B.x + B.w; x++) expect(wall(x, B.y - 1)).toBeLessThan(building);
  });

  it('un soldat devant une façade est dessiné devant, derrière le bâtiment il est masqué', () => {
    expect(pointDepth(B.x + B.w + 0.5, B.y + 0.5)).toBeGreaterThan(building);
    expect(pointDepth(B.x + 0.5, B.y + B.h + 0.5)).toBeGreaterThan(building);
    expect(pointDepth(B.x + 2.5, B.y - 0.5)).toBeLessThan(building);
    expect(pointDepth(B.x - 0.5, B.y + 1.5)).toBeLessThan(building);
  });

  it('les aires plates restent sous les objets en volume', () => {
    expect(objectDepth(content.building('road'), 50, 50, 1, 1)).toBeLessThan(DEPTH.objects);
  });
});
