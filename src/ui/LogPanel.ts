/** Journal des opérations (derniers messages). */
import type { GameContext } from '../core/GameContext';
import type { LogEntry } from '../core/GameState';
import { formatClock, formatNumber, t } from '../utils/i18n';
import { el } from './dom';

const VISIBLE = 7;

export class LogPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly unsub: () => void;

  constructor(parent: HTMLElement, ctx: GameContext) {
    this.list = el('div', { class: 'log-list' });
    this.root = el('div', { class: 'panel log-panel' }, [el('div', { class: 'panel-title', text: t('log.title') }), this.list]);
    parent.append(this.root);
    for (const entry of ctx.state.log.slice(-VISIBLE)) this.add(entry);
    this.unsub = ctx.bus.on('log:added', ({ entry }) => this.add(entry));
  }

  private add(entry: LogEntry): void {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(entry.params ?? {})) params[k] = typeof v === 'number' ? formatNumber(v) : v;
    const line = el('div', { class: `log-line ${entry.type}` }, [
      el('span', { class: 'log-time', text: `J${entry.day} ${formatClock(entry.minute)}` }),
      el('span', { text: t(entry.key, params) }),
    ]);
    this.list.append(line);
    while (this.list.childElementCount > VISIBLE) this.list.firstElementChild?.remove();
  }

  destroy(): void {
    this.unsub();
    this.root.remove();
  }
}
