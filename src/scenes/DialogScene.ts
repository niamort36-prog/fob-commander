/**
 * DialogScene — fenêtre d'événement RP : portrait pixel art, nom et fonction du personnage,
 * texte qui défile, choix (avec leur coût), puis issue et conséquences. Le jeu est en pause
 * pendant tout le dialogue ; « Continuer » ferme l'événement et relance le temps.
 */
import Phaser from 'phaser';
import type { EventChoiceDef } from '../core/ContentTypes';
import { game, type GameContext } from '../core/GameContext';
import { bagEntries } from '../core/resources';
import { clear, el, uiRoot } from '../ui/dom';
import { drawPortrait } from '../ui/portrait';
import { formatNumber, t } from '../utils/i18n';

const TYPE_MS = 16;
const CHARS_PER_STEP = 2;

export class DialogScene extends Phaser.Scene {
  private ctx!: GameContext;
  private root!: HTMLElement;
  private textEl!: HTMLElement;
  private actions!: HTMLElement;
  private timer: number | null = null;
  private fullText = '';
  private onTyped: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    super('DialogScene');
  }

  create(): void {
    this.ctx = game();
    this.unsubs = [];
    const events = this.ctx.sim.events;
    const active = this.ctx.state.events.active;
    const def = events.activeDef();
    if (!active || !def) {
      this.scene.stop();
      return;
    }
    const speaker = events.speakerOf(def);

    const canvas = el('canvas', { class: 'portrait' });
    drawPortrait(canvas, speaker.portrait);
    this.textEl = el('p', { class: 'dialog-text' });
    this.actions = el('div', { class: 'dialog-actions' });
    this.textEl.addEventListener('click', () => this.finishTyping());

    const dialog = el('div', { class: `panel dialog cat-${def.category}` }, [
      el('div', { class: 'dialog-head' }, [el('span', { class: 'dialog-category', text: t(`eventcat.${def.category}`) }), el('span', { class: 'dialog-title', text: def.title })]),
      el('div', { class: 'dialog-body' }, [
        el('div', { class: 'portrait-frame' }, [
          canvas,
          el('div', { class: 'speaker-name', text: String(active.vars.speaker ?? '') }),
          el('div', { class: 'speaker-role', text: speaker.role }),
        ]),
        el('div', { class: 'dialog-main' }, [this.textEl, this.actions]),
      ]),
    ]);
    this.root = el('div', { class: 'dialog-backdrop' }, [dialog]);
    uiRoot().append(this.root);

    if (active.outcome) this.showOutcome();
    else this.type(events.format(def.text), () => this.showChoices(def.choices));

    this.unsubs.push(
      this.ctx.bus.on('event:resolved', () => this.showOutcome()),
      this.ctx.bus.on('event:closed', () => this.scene.stop()),
    );
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        if (this.timer !== null) {
          e.preventDefault();
          this.finishTyping();
        }
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      const btn = this.actions.querySelectorAll<HTMLButtonElement>('button')[n - 1];
      if (btn && !btn.disabled) btn.click();
    };
    window.addEventListener('keydown', this.keyHandler);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  // ------------------------------------------------------------ Texte défilant

  private type(text: string, done: () => void): void {
    this.stopTyping();
    this.fullText = text;
    this.onTyped = done;
    let i = 0;
    this.textEl.textContent = '';
    this.timer = window.setInterval(() => {
      i += Math.max(1, Math.round(CHARS_PER_STEP * game().settings.num('textSpeed')));
      this.textEl.textContent = this.fullText.slice(0, i);
      if (i >= this.fullText.length) this.finishTyping();
    }, TYPE_MS);
  }

  private stopTyping(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private finishTyping(): void {
    if (this.timer === null) return;
    this.stopTyping();
    this.textEl.textContent = this.fullText;
    const done = this.onTyped;
    this.onTyped = null;
    done?.();
  }

  // ------------------------------------------------------------ Choix et issue

  private costText(choice: EventChoiceDef): string {
    const parts = bagEntries(choice.effects?.resources)
      .filter(([, v]) => v < 0)
      .map(([r, v]) => (r === 'funds' ? `−$${formatNumber(-v)}` : `−${formatNumber(-v)} ${this.ctx.content.resource(r).short}`));
    return parts.length ? ` (${parts.join(', ')})` : '';
  }

  private showChoices(choices: EventChoiceDef[]): void {
    clear(this.actions);
    const events = this.ctx.sim.events;
    choices.forEach((c, i) => {
      const block = events.choiceBlock(c);
      const reason = block === 'building' && c.requires?.building ? t('choice.building', { name: this.ctx.content.building(c.requires.building).name }) : block ? t(`choice.${block}`) : '';
      this.actions.append(
        el(
          'button',
          {
            class: 'btn choice',
            title: reason,
            attrs: block ? { disabled: '' } : {},
            onClick: () => this.ctx.commands.push({ type: 'chooseEvent', choiceId: c.id }),
          },
          [el('span', { class: 'choice-key', text: `${i + 1}.` }), `${c.text}${this.costText(c)}`, reason ? el('span', { class: 'choice-reason', text: ` — ${reason}` }) : null],
        ),
      );
    });
  }

  private showOutcome(): void {
    const outcome = this.ctx.state.events.active?.outcome;
    if (!outcome) return;
    clear(this.actions);
    this.type(outcome.text, () => {
      if (outcome.summary.length) {
        this.actions.append(el('ul', { class: 'outcome-summary' }, outcome.summary.map((s) => el('li', { text: s }))));
      }
      if (outcome.pendingAttack) this.actions.append(el('div', { class: 'warn', text: t('dialog.attackIncoming') }));
      this.actions.append(el('button', { class: 'btn choice primary', text: t('dialog.continue'), onClick: () => this.ctx.commands.push({ type: 'closeEvent' }) }));
    });
  }

  private cleanup(): void {
    this.stopTyping();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    this.root?.remove();
  }
}
