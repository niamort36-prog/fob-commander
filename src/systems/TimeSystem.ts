/** TimeSystem — horloge de jeu, jours, heures et vitesse. */
import type { Command } from '../core/Commands';
import type { GameContext } from '../core/GameContext';
import type { GameSpeed } from '../core/GameState';
import type { System } from './System';

export const MINUTES_PER_DAY = 1440;

export class TimeSystem implements System {
  readonly id = 'time';
  /** Dernière vitesse non nulle, pour reprendre après une pause. */
  private lastSpeed: GameSpeed = 1;

  constructor(private readonly ctx: GameContext) {}

  onStateLoaded(): void {
    const speed = this.ctx.state.time.speed;
    if (speed !== 0) this.lastSpeed = speed;
  }

  onTick(): void {
    const time = this.ctx.state.time;
    const { startHour, minutesPerTick } = this.ctx.content.balance.time;
    time.tick += 1;

    const total = startHour * 60 + time.tick * minutesPerTick;
    const day = Math.floor(total / MINUTES_PER_DAY) + 1;
    const minute = total % MINUTES_PER_DAY;
    const prevHour = Math.floor(time.minuteOfDay / 60);
    time.minuteOfDay = minute;

    if (day !== time.day) {
      time.day = day;
      this.ctx.bus.emit('time:newDay', { day });
    }
    const hour = Math.floor(minute / 60);
    if (hour !== prevHour) this.ctx.bus.emit('time:hour', { day, hour });
  }

  handleCommand(cmd: Command): boolean {
    // Pendant un dialogue d'événement, le temps reste figé.
    if ((cmd.type === 'setSpeed' || cmd.type === 'togglePause') && (this.ctx.state.events.active || this.ctx.state.radio.pending)) return true;
    switch (cmd.type) {
      case 'setSpeed':
        this.setSpeed(cmd.speed);
        return true;
      case 'togglePause':
        this.setSpeed(this.ctx.state.time.speed === 0 ? this.lastSpeed : 0);
        return true;
      default:
        return false;
    }
  }

  private setSpeed(speed: GameSpeed): void {
    if (!this.ctx.content.balance.time.speeds.includes(speed)) return;
    if (speed !== 0) this.lastSpeed = speed;
    if (this.ctx.state.time.speed === speed) return;
    this.ctx.state.time.speed = speed;
    this.ctx.bus.emit('time:speedChanged', { speed });
  }
}
