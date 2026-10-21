/**
 * Journal des opérations (derniers messages). Réduit, il se range dans le bandeau du bas sous la
 * forme d'une enveloppe qui s'allume (couleur selon la gravité) et compte les messages non lus ;
 * ouvert, il s'illumine brièvement à chaque nouvelle entrée.
 */
import type { GameContext } from '../core/GameContext';
import type { LogEntry } from '../core/GameState';
import { formatClock, formatNumber, t } from '../utils/i18n';
import { el } from './dom';

const VISIBLE = 7;
/** Durée de l'éclat lumineux à l'arrivée d'un message (ms). */
const FLASH_MS = 1600;
const OPEN_KEY = 'fobcmd.ui.log.open';
const RANK: Record<string, number> = { info: 0, good: 1, warn: 2, bad: 3 };

export class LogPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly unsubs: (() => void)[] = [];
  private unread = 0;
  private unreadLevel: LogEntry['type'] = 'info';
  private flashTimer = 0;
  private open = true;

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.list = el('div', { class: 'log-list' });
    const title = el('div', { class: 'panel-title' }, [
      el('span', { class: 'title-text', text: t('log.title') }),
      el('button', { class: 'btn collapse-btn', text: '▼', title: t('bar.mailClose'), onClick: () => this.setOpen(false) }),
    ]);
    this.root = el('div', { class: 'panel log-panel' }, [title, this.list]);
    parent.append(this.root);
    // Sur petit écran, le journal démarre rangé dans le bandeau
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(OPEN_KEY);
    } catch {
      stored = null;
    }
    this.open = stored === null ? window.innerWidth >= 700 : stored === '1';
    for (const entry of ctx.state.log.slice(-VISIBLE)) this.add(entry, false);
    this.unsubs.push(
      ctx.bus.on('log:added', ({ entry }) => this.add(entry, true)),
      ctx.bus.on('ui:toggleLog', () => this.setOpen(!this.open)),
      // Petit écran : ouvrir le menu de construction range le journal
      ctx.bus.on('ui:buildOpen', ({ open }) => {
        if (open && this.open && window.innerWidth < 700) this.setOpen(false);
      }),
    );
    this.setOpen(this.open, false);
  }

  private setOpen(open: boolean, remember = true): void {
    this.open = open;
    this.root.classList.toggle('hidden', !open);
    if (open) {
      this.unread = 0;
      this.unreadLevel = 'info';
    }
    if (remember) {
      try {
        localStorage.setItem(OPEN_KEY, open ? '1' : '0');
      } catch {
        // sans mémoire : tant pis
      }
    }
    this.publish();
  }

  private publish(): void {
    this.ctx.bus.emit('ui:logState', { open: this.open, unread: this.unread, level: this.unreadLevel });
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
    if (this.open) {
      this.flash(entry.type);
      return;
    }
    // Rangé : l'enveloppe du bandeau compte les messages non lus (couleur du plus grave)
    this.unread++;
    if ((RANK[entry.type] ?? 0) >= (RANK[this.unreadLevel] ?? 0)) this.unreadLevel = entry.type;
    this.publish();
  }

  private flash(type: LogEntry['type']): void {
    this.root.classList.remove('flash-info', 'flash-good', 'flash-warn', 'flash-bad');
    void this.root.offsetWidth; // relance l'animation même si elle était en cours
    this.root.classList.add(`flash-${type}`);
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.root.classList.remove(`flash-${type}`), FLASH_MS);
  }

  destroy(): void {
    window.clearTimeout(this.flashTimer);
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
