/**
 * Journal des opérations (derniers messages). Réductible : réduit, il s'illumine à chaque nouvelle
 * entrée (couleur selon la gravité) et affiche le nombre de messages non lus jusqu'à sa réouverture.
 */
import type { GameContext } from '../core/GameContext';
import type { LogEntry } from '../core/GameState';
import { formatClock, formatNumber, t } from '../utils/i18n';
import { el, makeCollapsible } from './dom';

const VISIBLE = 7;
/** Durée de l'éclat lumineux à l'arrivée d'un message (ms). */
const FLASH_MS = 1600;

export class LogPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly unsub: () => void;
  private unread = 0;
  private unreadLevel: LogEntry['type'] = 'info';
  private flashTimer = 0;
  private readonly isCollapsed: () => boolean;

  constructor(parent: HTMLElement, ctx: GameContext) {
    this.list = el('div', { class: 'log-list' });
    this.badge = el('span', { class: 'log-badge hidden' });
    const title = el('div', { class: 'panel-title' }, [el('span', { class: 'title-text', text: t('log.title') }), this.badge]);
    this.root = el('div', { class: 'panel log-panel' }, [title, this.list]);
    parent.append(this.root);
    this.isCollapsed = makeCollapsible(this.root, title, 'log', (collapsed) => {
      if (!collapsed) this.clearUnread();
    }).collapsed;
    for (const entry of ctx.state.log.slice(-VISIBLE)) this.add(entry, false);
    this.unsub = ctx.bus.on('log:added', ({ entry }) => this.add(entry, true));
  }

  private add(entry: LogEntry, fresh: boolean): void {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(entry.params ?? {})) params[k] = typeof v === 'number' ? formatNumber(v) : v;
    const line = el('div', { class: `log-line ${entry.type}${fresh ? ' fresh' : ''}` }, [
      el('span', { class: 'log-time', text: `J${entry.day} ${formatClock(entry.minute)}` }),
      el('span', { text: t(entry.key, params) }),
    ]);
    this.list.append(line);
    while (this.list.childElementCount > VISIBLE) this.list.firstElementChild?.remove();
    if (!fresh) return;
    // Éclat lumineux du panneau ; réduit, il garde la trace des messages non lus
    this.flash(entry.type);
    if (this.isCollapsed()) {
      this.unread++;
      const rank = { info: 0, good: 1, warn: 2, bad: 3 } as Record<string, number>;
      if ((rank[entry.type] ?? 0) >= (rank[this.unreadLevel] ?? 0)) this.unreadLevel = entry.type;
      this.badge.textContent = String(this.unread);
      this.badge.className = `log-badge ${this.unreadLevel}`;
      this.root.classList.add('unread');
    }
  }

  private flash(type: LogEntry['type']): void {
    this.root.classList.remove('flash-info', 'flash-good', 'flash-warn', 'flash-bad');
    // Relance l'animation même si elle était en cours
    void this.root.offsetWidth;
    this.root.classList.add(`flash-${type}`);
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.root.classList.remove(`flash-${type}`), FLASH_MS);
  }

  private clearUnread(): void {
    this.unread = 0;
    this.unreadLevel = 'info';
    this.badge.className = 'log-badge hidden';
    this.root.classList.remove('unread');
  }

  destroy(): void {
    window.clearTimeout(this.flashTimer);
    this.unsub();
    this.root.remove();
  }
}
