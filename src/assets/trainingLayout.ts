/**
 * Disposition des structures d'entraînement, partagée par leur dessin (PlaceholderFactory) et
 * l'animation des soldats qui s'y exercent (AgentRenderer) : positions en fractions de l'emprise
 * (x le long de la largeur w, y le long de la profondeur h, après rotation), hauteurs en pixels.
 */

/** Aire de musculation (3 × 3, non orientable). */
export const WORKOUT = {
  /** Portique de traction : barre parallèle à x. */
  pullBar: { y: 0.2, x0: 0.14, x1: 0.62, z: 34 },
  /** Postes de traction sous la barre. */
  pull: [0.27, 0.49],
  /** Banc de développé couché, dans l'axe x (tête côté x0, où sont les supports de barre). */
  bench: { x0: 0.12, x1: 0.42, y: 0.62, seat: 6 },
  /** Cage à squat : deux montants de part et d'autre de y. */
  squat: { x: 0.8, y: 0.3, z: 24 },
  /** Tapis de pompes. */
  mat: { x: 0.66, y: 0.78 },
  /** Pneu de tracteur et kettlebells. */
  tire: { x: 0.86, y: 0.62 },
  bells: { x: 0.44, y: 0.88 },
  /** Arbre à disques. */
  plates: { x: 0.92, y: 0.18 },
} as const;

export type CourseMove = 'run' | 'climb' | 'beam' | 'crawl' | 'jump' | 'hop';

/** Parcours du combattant (rotatif : fractions de l'emprise tournée). */
export const COURSE = {
  wall: { x0: 0.15, x1: 0.2, y0: 0.2, y1: 0.55, z: 16 },
  beam: { x0: 0.35, x1: 0.75, y0: 0.15, y1: 0.2, z: 6 },
  /** Pneus : 3 colonnes × 2 rangées. */
  tires: { x0: 0.3, dx: 0.09, y0: 0.66, dy: 0.13 },
  net: { x0: 0.65, x1: 0.92, y0: 0.55, y1: 0.9, z: 5 },
  pit: { x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.5 },
  /** Itinéraire bouclé à travers les obstacles : point d'arrivée et manière d'y aller. */
  route: [
    { x: 0.08, y: 0.38, move: 'run' },
    { x: 0.12, y: 0.38, move: 'run' },
    { x: 0.24, y: 0.38, move: 'climb' },
    { x: 0.33, y: 0.175, move: 'run' },
    { x: 0.77, y: 0.175, move: 'beam' },
    { x: 0.94, y: 0.4, move: 'run' },
    { x: 0.94, y: 0.72, move: 'run' },
    { x: 0.62, y: 0.72, move: 'crawl' },
    { x: 0.64, y: 0.45, move: 'run' },
    { x: 0.36, y: 0.45, move: 'jump' },
    { x: 0.55, y: 0.72, move: 'run' },
    { x: 0.25, y: 0.72, move: 'hop' },
    { x: 0.08, y: 0.38, move: 'run' },
  ] as { x: number; y: number; move: CourseMove }[],
};
