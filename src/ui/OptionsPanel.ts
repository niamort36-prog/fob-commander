/**
 * Fenêtre des options (menu principal et en jeu) : construite à partir de settings.json
 * (curseurs et cases à cocher regroupés), appliquée et enregistrée immédiatement.
 */
import type { GameContext } from '../core/GameContext';
import { audio } from '../audio/AudioManager';
import { t } from '../utils/i18n';
import { el } from './dom';

export class OptionsPanel {
  private readonly backdrop: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
    private readonly onClose: () => void = () => {},
  ) {
    const body = el('div', { class: 'panel modal options-panel' });
    this.backdrop = el('div', { class: 'modal-backdrop options-backdrop' }, [body]);
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    parent.append(this.backdrop);
    this.render(body);
  }

  private render(body: HTMLElement): void {
    const s = this.ctx.settings;
    const def = this.ctx.content.settings;
    body.append(el('div', { class: 'panel-title' }, [t('options.title'), el('button', { class: 'btn close', text: '×', onClick: () => this.close() })]));
    for (const g of def.groups) {
      body.append(el('div', { class: 'section-title', text: g.label }));
      for (const o of def.options.filter((x) => x.group === g.id)) {
        if (o.type === 'toggle') {
          const box = el('input', { attrs: { type: 'checkbox' } });
          box.checked = s.bool(o.id);
          box.addEventListener('change', () => s.set(o.id, box.checked));
          body.append(el('label', { class: 'option-row' }, [box, el('span', { text: o.label })]));
        } else {
          const value = el('span', { class: 'option-value' });
          const input = el('input', { attrs: { type: 'range', min: String(o.min ?? 0), max: String(o.max ?? 1), step: String(o.step ?? 0.1) } });
          const show = (): void => {
            const v = s.num(o.id);
            value.textContent = (o.max ?? 1) <= 1 ? `${Math.round(v * 100)} %` : `×${v}`;
          };
          input.value = String(s.num(o.id));
          input.addEventListener('input', () => {
            s.set(o.id, Number(input.value));
            show();
          });
          // Aperçu sonore des volumes
          input.addEventListener('change', () => {
            if (o.group === 'sound') audio()?.play(o.id === 'radio' ? 'notify' : o.id === 'sfx' ? 'shotFriendly' : 'click');
          });
          show();
          body.append(el('div', { class: 'option-row slider' }, [el('span', { class: 'option-label', text: o.label }), input, value]));
        }
      }
    }
    body.append(
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn',
          text: t('options.reset'),
          onClick: () => {
            s.reset();
            body.replaceChildren();
            this.render(body);
          },
        }),
        el('button', { class: 'btn primary', text: t('options.close'), onClick: () => this.close() }),
      ]),
    );
  }

  close(): void {
    this.backdrop.remove();
    this.onClose();
  }
}
