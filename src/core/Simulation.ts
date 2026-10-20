/**
 * Simulation — boucle à pas fixe, indépendante de l'affichage.
 *
 * 1 tick = `balance.time.minutesPerTick` minute(s) de jeu.
 * À la vitesse x1, `ticksPerSecondAtX1` ticks sont joués par seconde réelle.
 * Le rendu appelle `update(dtMs)` à chaque frame ; les commandes du joueur sont
 * traitées même en pause (on peut construire en pause, comme dans tout city builder).
 */
import type { Command } from './Commands';
import type { GameContext } from './GameContext';
import type { System } from '../systems/System';
import { TimeSystem } from '../systems/TimeSystem';
import { BuildSystem } from '../systems/BuildSystem';
import { EconomySystem } from '../systems/EconomySystem';
import { SaveSystem, type StorageLike } from '../systems/SaveSystem';
import { NeedsSystem } from '../systems/NeedsSystem';
import { AgentAI } from '../systems/AgentAI';
import { SupplySystem } from '../systems/SupplySystem';
import { AttackSystem } from '../systems/AttackSystem';
import { MissionSystem } from '../systems/MissionSystem';
import { RadioSystem } from '../systems/RadioSystem';
import { EventSystem } from '../systems/EventSystem';
import { DiplomacySystem } from '../systems/DiplomacySystem';
import { IntelSystem } from '../systems/IntelSystem';
import { VisitSystem } from '../systems/VisitSystem';
import { CheckpointSystem } from '../systems/CheckpointSystem';
import { GroupSystem } from '../systems/GroupSystem';
import { LogisticsSystem } from '../systems/LogisticsSystem';
import { WorldSystem } from '../systems/WorldSystem';

export class Simulation {
  readonly time: TimeSystem;
  readonly build: BuildSystem;
  readonly economy: EconomySystem;
  readonly needs: NeedsSystem;
  readonly agents: AgentAI;
  readonly supply: SupplySystem;
  readonly events: EventSystem;
  readonly attacks: AttackSystem;
  readonly intel: IntelSystem;
  readonly missions: MissionSystem;
  readonly radio: RadioSystem;
  readonly diplomacy: DiplomacySystem;
  readonly visits: VisitSystem;
  readonly checkpoint: CheckpointSystem;
  readonly groups: GroupSystem;
  readonly logistics: LogisticsSystem;
  readonly world: WorldSystem;
  readonly save: SaveSystem;

  /** Ordre d'exécution à chaque tick. */
  private readonly systems: System[];
  private accumulator = 0;

  constructor(
    private readonly ctx: GameContext,
    storage?: StorageLike | null,
  ) {
    this.time = new TimeSystem(ctx);
    this.build = new BuildSystem(ctx);
    this.economy = new EconomySystem(ctx);
    this.needs = new NeedsSystem(ctx);
    this.agents = new AgentAI(ctx);
    this.supply = new SupplySystem(ctx);
    this.events = new EventSystem(ctx);
    this.attacks = new AttackSystem(ctx);
    this.intel = new IntelSystem(ctx);
    this.missions = new MissionSystem(ctx);
    this.radio = new RadioSystem(ctx);
    this.diplomacy = new DiplomacySystem(ctx);
    this.visits = new VisitSystem(ctx);
    this.checkpoint = new CheckpointSystem(ctx);
    this.groups = new GroupSystem(ctx);
    this.logistics = new LogisticsSystem(ctx);
    this.world = new WorldSystem(ctx);
    this.save = new SaveSystem(ctx, storage);
    this.systems = [
      this.time,
      this.build,
      this.economy,
      this.needs,
      this.agents,
      this.logistics, // après AgentAI : cuisine et nettoyage des agents à l'ouvrage
      this.supply,
      this.visits, // après SupplySystem : pilote les véhicules des délégations
      this.checkpoint, // civils fouillés au poste de garde (véhicules pilotés ici aussi)
      this.groups,
      this.attacks,
      this.missions,
      this.world, // après MissionSystem : rencontres des unités en mission
      this.radio,
      this.events,
      this.intel,
      this.diplomacy, // après IntelSystem : la région doit être initialisée
      this.save,
    ];
  }

  /** Appelé après création ou chargement d'un état : les systèmes reconstruisent leurs index dérivés. */
  onStateLoaded(): void {
    this.accumulator = 0;
    for (const s of this.systems) s.onStateLoaded?.();
  }

  /** À appeler à chaque frame avec le temps réel écoulé. */
  update(dtMs: number): void {
    if (!this.ctx.hasGame) return;
    const state = this.ctx.state;
    state.meta.playtimeSec += dtMs / 1000;
    this.processCommands();

    const speed = state.time.speed;
    if (speed === 0) {
      this.accumulator = 0;
      return;
    }
    const { ticksPerSecondAtX1, maxTicksPerFrame } = this.ctx.content.balance.time;
    const msPerTick = 1000 / (ticksPerSecondAtX1 * speed);
    this.accumulator += dtMs;
    let ticks = 0;
    while (this.accumulator >= msPerTick && ticks < maxTicksPerFrame) {
      this.step();
      this.accumulator -= msPerTick;
      ticks++;
    }
    // Onglet en arrière-plan / gros ralentissement : on abandonne le retard plutôt que de geler.
    if (ticks >= maxTicksPerFrame) this.accumulator = 0;
  }

  /** Avance d'exactement un tick (utilisé aussi par les tests). */
  step(): void {
    this.processCommands();
    for (const s of this.systems) s.onTick?.();
  }

  /** Fraction du tick courant écoulée (0..1), pour interpoler l'affichage. */
  get alpha(): number {
    if (!this.ctx.hasGame || this.ctx.state.time.speed === 0) return 0;
    const msPerTick = 1000 / (this.ctx.content.balance.time.ticksPerSecondAtX1 * this.ctx.state.time.speed);
    return Math.min(1, this.accumulator / msPerTick);
  }

  private processCommands(): void {
    for (const cmd of this.ctx.commands.drain()) this.dispatch(cmd);
  }

  private dispatch(cmd: Command): void {
    for (const s of this.systems) {
      if (s.handleCommand?.(cmd)) return;
    }
    console.warn('[Simulation] commande non traitée', cmd);
  }
}
