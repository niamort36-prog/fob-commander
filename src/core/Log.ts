/** Journal des opérations : messages horodatés affichés dans l'interface. */
import type { GameContext } from './GameContext';
import type { LogType } from './GameState';

export function pushLog(
  ctx: GameContext,
  type: LogType,
  key: string,
  params?: Record<string, string | number>,
): void {
  const s = ctx.state;
  const entry = { tick: s.time.tick, day: s.time.day, minute: s.time.minuteOfDay, type, key, params };
  s.log.push(entry);
  const max = ctx.content.balance.log.maxEntries;
  if (s.log.length > max) s.log.splice(0, s.log.length - max);
  ctx.bus.emit('log:added', { entry });
}
