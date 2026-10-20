import type { GameState, Id } from '../core/GameState';

/** Génère un identifiant unique et stable (compteur sauvegardé dans l'état). */
export function newId(state: GameState, prefix: string): Id {
  state.meta.nextId += 1;
  return `${prefix}_${state.meta.nextId.toString().padStart(4, '0')}`;
}
