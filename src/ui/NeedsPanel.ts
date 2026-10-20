/**
 * Panneau « Besoins de la base » (bouton Besoins, touche B) : pour l'effectif actuel, places au
 * réfectoire, douches, latrines, soins, sport, spécialistes… disponibles face au nécessaire,
 * files d'attente mesurées sur 24 h, conseil quand un besoin n'est pas couvert, et effet sur le moral.
 */
import type { GameContext } from '../core/GameContext';
import { t } from '../utils/i18n';
import { clear, el } from './dom';

export class NeedsPanel {
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;
  private visible = false;
  private sig = '';
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.content = el('div');
    this.root = el('div', { class: 'panel needs-panel hidden' }, [
      el('div', { class: 'panel-title' }, [t('needs.title'), el('button', { class: 'btn close', text: '×', onClick: () => this.toggle(false) })]),
      this.content,
    ]);
    parent.append(this.root);
    this.unsubs.push(ctx.bus.on('ui:toggleNeeds', () => this.toggle()));
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    this.sig = '';
    this.update();
  }

  update(): void {
    if (!this.visible) return;
    const req = this.ctx.sim.requirements;
    const status = req.status();
    const penalty = req.moralePenalty();
    const sig = `${req.headcount()}|${Math.round(penalty * 10)}|${status.map((r) => `${r.capacity}/${r.required}/${r.state}/${Math.round(r.avgWait)}/${r.gaveUp}`).join(',')}`;
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.content);
    this.content.append(el('div', { class: 'muted small', text: t('needs.headcount', { n: req.headcount() }) }));
    const table = el('div', { class: 'needs-list' });
    for (const r of status) {
      const value = r.def.personnel ? t('needs.staff', { have: r.capacity, need: r.required }) : t('needs.places', { have: r.capacity, need: r.required });
      const wait = r.waits > 0 ? t('needs.wait', { min: Math.round(r.avgWait), n: r.waits }) + (r.gaveUp ? t('needs.gaveUp', { n: r.gaveUp }) : '') : '';
      const row = el('div', { class: `needs-row ${r.state}` }, [
        el('div', { class: 'needs-head' }, [
          el('span', { class: 'needs-dot' }),
          el('span', { class: 'needs-name', text: r.def.name }),
          el('span', { class: 'needs-value', text: r.state === 'inactive' ? t('needs.inactive', { n: r.def.minHeadcount }) : value }),
        ]),
      ]);
      if (wait) row.append(el('div', { class: 'muted small', text: wait }));
      if (r.state === 'short' || r.state === 'tight') {
        const n = Math.round(r.def.moralePenalty * r.shortfall * req.ramp());
        const cost = n > 0 ? ` ${t('needs.cost', { n })}` : '';
        row.append(el('div', { class: 'needs-advice', text: r.def.advice + cost }));
      }
      table.append(row);
    }
    this.content.append(table);
    const short = status.filter((r) => r.state === 'short').length;
    this.content.append(
      el('div', {
        class: `needs-summary ${short > 0 ? 'bad' : 'good'}`,
        text: short === 0 ? t('needs.allGood') : penalty >= 1 ? t('needs.penalty', { short, n: Math.round(penalty) }) : t('needs.shortNoCost', { short }),
      }),
    );
    if (req.ramp() < 1) this.content.append(el('div', { class: 'muted small', text: t('needs.grace') }));
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
