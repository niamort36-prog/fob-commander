/**
 * Tutoriel guidé (tutorial.json) : proposé en début de partie (option), une étape à la fois,
 * validée par un bouton, par la pose de bâtiments ou par un événement du jeu ; l'élément
 * concerné de l'interface est mis en évidence. La progression est sauvegardée avec la partie.
 */
import type { GameContext } from '../core/GameContext';
import type { TutorialStepDef } from '../core/ContentTypes';
import { t } from '../utils/i18n';
import { clear, el } from './dom';

const STEP_FLAG = 'tutorialStep';
const OFF_FLAG = 'tutorialOff';

export class TutorialPanel {
  private readonly root: HTMLElement;
  private readonly unsubs: (() => void)[] = [];
  private shown = '';
  private highlighted: Element[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.root = el('div', { class: 'panel tutorial hidden' });
    parent.append(this.root);
    // Validation par événement
    const events = new Set(ctx.content.tutorial.steps.filter((s) => s.done.type === 'event').map((s) => s.done.event!));
    for (const ev of events) {
      this.unsubs.push(
        ctx.bus.on(ev as never, (() => {
          const step = this.current();
          if (step?.done.type === 'event' && step.done.event === ev) this.advance();
        }) as never),
      );
    }
  }

  private get flags() {
    return this.ctx.state.progression.flags;
  }

  /** Étape en cours, ou null (tutoriel terminé, refusé ou pas encore proposé). */
  private current(): TutorialStepDef | null {
    if (!this.ctx.hasGame || this.flags[OFF_FLAG]) return null;
    const i = this.flags[STEP_FLAG];
    if (typeof i !== 'number') return null;
    return this.ctx.content.tutorial.steps[i] ?? null;
  }

  private advance(): void {
    const i = this.flags[STEP_FLAG];
    if (typeof i !== 'number') return;
    if (i + 1 >= this.ctx.content.tutorial.steps.length) this.flags[OFF_FLAG] = true;
    else this.flags[STEP_FLAG] = i + 1;
    this.shown = '';
  }

  private stop(): void {
    this.flags[OFF_FLAG] = true;
    this.shown = '';
  }

  private buildingCount(defId: string): number {
    return Object.values(this.ctx.state.fob.buildings).filter((b) => b.defId === defId).length;
  }

  update(): void {
    if (!this.ctx.hasGame) return;
    const f = this.flags;
    // Proposition en début de partie
    if (f[STEP_FLAG] === undefined && !f[OFF_FLAG]) {
      if (!this.ctx.settings.bool('tutorial') || this.ctx.state.time.day > 1) {
        f[OFF_FLAG] = true;
      } else if (this.shown !== 'offer' && !this.ctx.state.diplomacy.campaign.notice) {
        this.renderOffer();
      }
      return;
    }
    const step = this.current();
    if (!step) {
      this.hide();
      return;
    }
    if (step.done.type === 'building' && this.buildingCount(step.done.defId!) >= (step.done.count ?? 1)) {
      this.advance();
      return;
    }
    const sig = `${f[STEP_FLAG]}`;
    if (sig !== this.shown) this.renderStep(step);
  }

  private hide(): void {
    this.root.classList.add('hidden');
    this.setHighlight(null);
    this.shown = 'none';
  }

  private setHighlight(selector: string | null | undefined): void {
    for (const e of this.highlighted) e.classList.remove('tuto-highlight');
    this.highlighted = selector ? [...document.querySelectorAll(selector)] : [];
    for (const e of this.highlighted) e.classList.add('tuto-highlight');
  }

  private renderOffer(): void {
    this.shown = 'offer';
    clear(this.root);
    this.root.append(
      el('div', { class: 'panel-title', text: t('tuto.offerTitle') }),
      el('p', { text: t('tuto.offer') }),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn primary',
          text: t('tuto.yes'),
          onClick: () => {
            this.flags[STEP_FLAG] = 0;
            this.shown = '';
          },
        }),
        el('button', { class: 'btn', text: t('tuto.no'), onClick: () => this.stop() }),
      ]),
    );
    this.root.classList.remove('hidden');
  }

  private renderStep(step: TutorialStepDef): void {
    const i = this.flags[STEP_FLAG] as number;
    const total = this.ctx.content.tutorial.steps.length;
    this.shown = `${i}`;
    clear(this.root);
    const buttons = el('div', { class: 'row' });
    if (step.done.type === 'ack') buttons.append(el('button', { class: 'btn primary', text: i + 1 >= total ? t('tuto.finish') : t('tuto.next'), onClick: () => this.advance() }));
    else buttons.append(el('span', { class: 'muted small', text: t('tuto.waiting') }));
    buttons.append(el('button', { class: 'btn small-btn', text: t('tuto.skip'), onClick: () => this.stop() }));
    this.root.append(
      el('div', { class: 'tuto-step muted small', text: t('tuto.step', { n: i + 1, total }) }),
      el('div', { class: 'panel-title', text: step.title }),
      el('p', { text: step.text }),
      buttons,
    );
    this.root.classList.remove('hidden');
    this.setHighlight(step.highlight);
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.setHighlight(null);
    this.root.remove();
  }
}
