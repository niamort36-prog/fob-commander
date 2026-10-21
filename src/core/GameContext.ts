/**
 * GameContext — point d'accès unique à l'état, au bus, au contenu et à la simulation.
 * Aucune dépendance à Phaser : utilisable tel quel dans les tests (Node).
 */
import { CommandQueue } from './Commands';
import type { ContentRegistry } from './ContentRegistry';
import type { SiteDef } from './ContentTypes';
import { EventBus } from './EventBus';
import type { GameEvents } from './GameEvents';
import { createInitialState, type GameState } from './GameState';
import { pushLog } from './Log';
import { Settings } from './Settings';
import { Simulation } from './Simulation';
import { Rng, randomSeed } from '../utils/Rng';
import type { StorageLike } from '../systems/SaveSystem';

export class GameContext {
  readonly bus = new EventBus<GameEvents>();
  readonly commands = new CommandQueue();
  readonly sim: Simulation;
  /** Options du joueur (navigateur) ; valeurs par défaut hors navigateur (tests). */
  readonly settings: Settings;
  private current: GameState | null = null;

  /** @param storage stockage des sauvegardes ; undefined = localStorage du navigateur. */
  constructor(
    readonly content: ContentRegistry,
    storage?: StorageLike | null,
  ) {
    this.settings = new Settings(content.settings, storage === undefined ? undefined : null);
    this.sim = new Simulation(this, storage);
  }

  get state(): GameState {
    if (!this.current) throw new Error('Aucune partie en cours');
    return this.current;
  }

  get hasGame(): boolean {
    return this.current !== null;
  }

  get site(): SiteDef {
    return this.content.site(this.state.meta.siteId);
  }

  newGame(siteId: string, seed: number = randomSeed()): void {
    this.current = createInitialState(this.content, siteId, seed);
    this.commands.drain();
    pushLog(this, 'info', 'log.deployed', { site: this.site.name });
    this.sim.onStateLoaded();
    this.bus.emit('state:loaded', {});
  }

  loadState(state: GameState): void {
    this.current = state;
    this.commands.drain();
    this.sim.onStateLoaded();
    // Une partie reprise démarre en pause (Espace reprend à la vitesse d'avant)
    state.time.speed = 0;
    pushLog(this, 'info', 'log.loaded');
    this.bus.emit('state:loaded', {});
  }

  /** Tirage aléatoire déterministe ; l'état du générateur est sauvegardé avec la partie. */
  random(): number {
    const rng = new Rng(this.state.meta.rngState);
    const v = rng.next();
    this.state.meta.rngState = rng.state;
    return v;
  }
}

// ---------------------------------------------------------------- Instance globale (côté rendu)

let instance: GameContext | null = null;

export function setGame(ctx: GameContext): void {
  instance = ctx;
}

export function game(): GameContext {
  if (!instance) throw new Error('GameContext non initialisé (BootScene non exécutée ?)');
  return instance;
}
