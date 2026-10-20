/**
 * Panneau radio : message d'une unité en mission (texte qui défile façon transmission),
 * réponses possibles du TOC (avec leur coût), puis accusé de réception.
 * Le jeu reste en pause jusqu'à la fin de l'échange.
 */
import type { GameContext } from '../core/GameContext';
import { bagEntries } from '../core/resources';
import { formatNumber, t } from '../utils/i18n';
import { clear, el } from './dom';

export class RadioPanel {
  private readonly backdrop: HTMLElement;
  private readonly header: HTMLElement;
  private readonly text: HTMLElement;
  private readonly actions: HTMLElement;
  private timer: number | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.header = el('div', { class: 'radio-head' });
    this.text = el('p', { class: 'radio-text' });
    this.actions = el('div', { class: 'dialog-actions' });
    this.backdrop = el('div', { class: 'dialog-backdrop radio-backdrop hidden' }, [el('div', { class: 'panel radio' }, [this.header, this.text, this.actions])]);
    parent.append(this.backdrop);
    this.unsubs.push(
      ctx.bus.on('radio:message', () => this.show()),
      ctx.bus.on('radio:answered', () => this.showAnswer()),
      ctx.bus.on('radio:closed', () => this.backdrop.classList.add('hidden')),
    );
    if (ctx.state.radio.pending) this.show();
  }

  private type(text: string, done: () => void): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    let i = 0;
    this.text.textContent = '';
    this.timer = window.setInterval(() => {
      i += Math.max(1, Math.round(2 * this.ctx.settings.num('textSpeed')));
      this.text.textContent = text.slice(0, i);
      if (i >= text.length) {
        window.clearInterval(this.timer!);
        this.timer = null;
        done();
      }
    }, 14);
  }

  private show(): void {
    const p = this.ctx.state.radio.pending;
    if (!p) return;
    const m = this.ctx.state.missions[p.missionId];
    const msg = this.ctx.content.radioMessage(p.radioId);
    if (!m) return;
    this.backdrop.classList.remove('hidden');
    this.header.textContent = t('radio.header', { callsign: m.callsign, mission: this.ctx.content.missionType(m.defId).name });
    clear(this.actions);
    const radio = this.ctx.sim.radio;
    const text = radio.format(msg.text);
    if (p.answer) return this.showAnswer();
    this.type(text, () => {
      msg.choices.forEach((c, i) => {
        const block = radio.choiceBlock(c);
        const cost = bagEntries(radio.costOf(c))
          .map(([r, v]) => (r === 'funds' ? `−$${formatNumber(v)}` : `−${formatNumber(v)} ${this.ctx.content.resource(r).short}`))
          .join(', ');
        this.actions.append(
          el(
            'button',
            {
              class: 'btn choice',
              attrs: block ? { disabled: '' } : {},
              title: block ? t(`radio.need.${block}`) : '',
              onClick: () => this.ctx.commands.push({ type: 'radioChoose', choiceId: c.id }),
            },
            [
              el('span', { class: 'choice-key', text: `${i + 1}.` }),
              `« ${radio.format(c.text)} »${cost ? ` (${cost})` : ''}`,
              block && block !== 'cost' ? el('span', { class: 'muted small', text: ` — ${t(`radio.need.${block}`)}` }) : '',
            ],
          ),
        );
      });
    });
  }

  private showAnswer(): void {
    const p = this.ctx.state.radio.pending;
    if (!p?.answer) return;
    clear(this.actions);
    this.actions.append(
      el('div', { class: 'radio-ack', text: t('radio.ack', { log: p.answer }) }),
      el('button', { class: 'btn choice primary', text: t('radio.close'), onClick: () => this.ctx.commands.push({ type: 'radioClose' }) }),
    );
  }

  destroy(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    for (const u of this.unsubs) u();
    this.backdrop.remove();
  }
}
