import type { Command } from '../core/Commands';

/**
 * Contrat commun des systèmes de simulation.
 * Un système reçoit le GameContext à sa construction et lit toujours `ctx.state`
 * au moment de l'appel (l'état est remplacé lors d'un chargement).
 */
export interface System {
  readonly id: string;
  /** Un pas de simulation. */
  onTick?(): void;
  /** Renvoie true si la commande a été prise en charge. */
  handleCommand?(cmd: Command): boolean;
  /** Après nouvelle partie ou chargement : reconstruire les index dérivés. */
  onStateLoaded?(): void;
}
