/** Fenêtre modale de sauvegarde / chargement (emplacement auto + emplacements manuels). */
import type { GameContext } from '../core/GameContext';
import type { GameState } from '../core/GameState';
import { AUTO_SLOT } from '../systems/SaveSystem';
import { formatClock, formatNumber, t } from '../utils/i18n';
import { clear, el } from './dom';

export type SaveMenuMode = 'save' | 'load';

export class SaveMenu {
  private readonly backdrop: HTMLElement;
  private readonly rows: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
    private readonly mode: SaveMenuMode,
    private readonly onLoaded: (state: GameState) => void,
    private readonly onClose: () => void = () => {},
  ) {
    this.rows = el('div', { class: 'save-rows' });
    const dialog = el('div', { class: 'panel modal' }, [
      el('div', { class: 'panel-title' }, [
        t(mode === 'save' ? 'save.titleSave' : 'save.titleLoad'),
        el('button', { class: 'btn close', text: '×', onClick: () => this.close() }),
      ]),
      ctx.sim.save.available ? null : el('p', { class: 'warn', text: t('save.unavailable') }),
      this.rows,
    ]);
    this.backdrop = el('div', { class: 'modal-backdrop' }, [dialog]);
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    parent.append(this.backdrop);
    this.render();
  }

  private render(): void {
    clear(this.rows);
    const save = this.ctx.sim.save;
    for (const { slot, summary } of save.list()) {
      const name = slot === AUTO_SLOT ? t('save.autoSlot') : t('save.slot', { slot });
      const info = summary
        ? t('save.summary', {
            site: summary.siteName,
            day: summary.day,
            time: formatClock(summary.minuteOfDay),
            funds: formatNumber(summary.funds),
            date: new Date(summary.savedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }),
          })
        : t('save.empty');

      const actions: HTMLElement[] = [];
      if (this.mode === 'save' && slot !== AUTO_SLOT) {
        actions.push(
          el('button', {
            class: 'btn',
            text: t('save.saveHere'),
            onClick: () => {
              if (summary && !window.confirm(t('save.confirmOverwrite', { name }))) return;
              if (save.save(slot)) this.render();
            },
          }),
        );
      }
      if (this.mode === 'load' && summary) {
        actions.push(
          el('button', {
            class: 'btn',
            text: t('save.loadHere'),
            onClick: () => {
              const state = save.load(slot);
              if (!state) {
                this.ctx.bus.emit('ui:toast', { text: t('save.loadFailed'), kind: 'error' });
                return;
              }
              this.close();
              this.onLoaded(state);
            },
          }),
        );
      }
      if (summary) {
        actions.push(
          el('button', {
            class: 'btn danger',
            text: t('save.delete'),
            onClick: () => {
              if (!window.confirm(t('save.confirmDelete', { name }))) return;
              save.remove(slot);
              this.render();
            },
          }),
        );
      }

      this.rows.append(
        el('div', { class: 'save-row' + (summary ? '' : ' empty') }, [
          el('div', {}, [el('div', { class: 'save-name', text: name }), el('div', { class: 'muted small', text: info })]),
          el('div', { class: 'save-actions' }, actions),
        ]),
      );
    }
  }

  close(): void {
    this.backdrop.remove();
    this.onClose();
  }
}
