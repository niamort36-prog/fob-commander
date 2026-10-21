/**
 * Bandeau du bas : bouton « Construction » qui ouvre le menu vers le haut, vignette et coût du
 * bâtiment choisi (ou outil en cours), consigne de pose, et enveloppe du journal : réduit, le
 * journal se range dans le bandeau et l'enveloppe s'allume à chaque nouveau message.
 */
import { buildingThumb } from '../assets/thumbnails';
import type { GameContext } from '../core/GameContext';
import type { ToolMode } from '../core/GameEvents';
import { bagEntries, canAfford } from '../core/resources';
import { formatNumber, t } from '../utils/i18n';
import { clear, el, setText } from './dom';

export class BottomBar {
  private readonly root: HTMLElement;
  private readonly buildBtn: HTMLButtonElement;
  private readonly chip: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly mailBtn: HTMLButtonElement;
  private readonly badge: HTMLElement;
  /** Bouton « Besoins » : clignote et compte les besoins de la base non couverts. */
  private readonly needsBtn: HTMLButtonElement;
  private tool: ToolMode = { kind: 'select' };
  private chipSig = '';
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.buildBtn = el('button', { class: 'btn bar-build', title: t('bar.buildHint'), onClick: () => ctx.bus.emit('ui:toggleBuild', {}) });
    this.chip = el('div', { class: 'bar-chip' });
    this.hint = el('div', { class: 'bar-hint' });
    this.badge = el('span', { class: 'mail-badge hidden' });
    this.mailBtn = el('button', { class: 'btn bar-mail', title: t('bar.mailHint'), onClick: () => ctx.bus.emit('ui:toggleLog', {}) }, [
      el('span', { class: 'mail-icon', text: '✉' }),
      this.badge,
    ]);
    this.needsBtn = el('button', { class: 'btn bar-btn', text: t('hud.needs'), title: t('hud.needsHint'), onClick: () => ctx.bus.emit('ui:toggleNeeds', {}) });
    const panels = el('div', { class: 'bar-panels' }, [
      el('button', { class: 'btn bar-btn', text: t('hud.logistics'), title: t('hud.logisticsHint'), onClick: () => ctx.bus.emit('ui:toggleLogistics', {}) }),
      el('button', { class: 'btn bar-btn', text: t('hud.personnel'), title: t('hud.personnelHint'), onClick: () => ctx.bus.emit('ui:toggleRoster', {}) }),
      this.needsBtn,
    ]);
    this.root = el('div', { class: 'panel bottom-bar' }, [this.buildBtn, this.chip, this.hint, panels, this.mailBtn]);
    parent.append(this.root);
    this.setBuildOpen(true);
    this.unsubs.push(
      ctx.bus.on('ui:toolChanged', ({ tool }) => {
        this.tool = tool;
        this.chipSig = '';
        this.update();
      }),
      ctx.bus.on('ui:buildOpen', ({ open }) => this.setBuildOpen(open)),
      ctx.bus.on('ui:logState', ({ open, unread, level }) => {
        this.mailBtn.classList.toggle('open', open);
        this.mailBtn.classList.toggle('unread', unread > 0);
        this.mailBtn.dataset.level = level;
        this.badge.classList.toggle('hidden', unread === 0);
        setText(this.badge, String(unread));
        this.mailBtn.title = open ? t('bar.mailClose') : unread > 0 ? t('bar.mailUnread', { n: unread }) : t('bar.mailHint');
      }),
    );
  }

  private setBuildOpen(open: boolean): void {
    this.buildBtn.textContent = `${open ? '▼' : '▲'} ${t('bar.build')}`;
    this.buildBtn.classList.toggle('active', open);
  }

  /** Vignette du bâtiment choisi (ou de l'outil), coût et consigne de pose. */
  update(): void {
    // Hauteur du bandeau : les panneaux du bas se placent au-dessus
    const h = `${this.root.offsetHeight}px`;
    if (document.documentElement.style.getPropertyValue('--bar-h') !== h) document.documentElement.style.setProperty('--bar-h', h);
    const shortNeeds = this.ctx.sim.requirements.status().filter((r) => r.state === 'short').length;
    this.needsBtn.classList.toggle('attention', shortNeeds > 0);
    setText(this.needsBtn, shortNeeds > 0 ? `${t('hud.needs')} (${shortNeeds})` : t('hud.needs'));
    const tool = this.tool;
    let sig = tool.kind;
    if (tool.kind === 'build') sig += `:${tool.defId}:${canAfford(this.ctx.state, this.ctx.content.building(tool.defId).cost)}`;
    if (sig === this.chipSig) return;
    this.chipSig = sig;
    clear(this.chip);
    if (tool.kind === 'build') {
      const def = this.ctx.content.building(tool.defId);
      const cost = bagEntries(def.cost)
        .map(([r, v]) => (r === 'funds' ? `$${formatNumber(v)}` : `${formatNumber(v)} ${this.ctx.content.resource(r).short}`))
        .join(' ');
      const url = buildingThumb(def);
      this.chip.append(
        url ? el('img', { class: 'bar-thumb', attrs: { src: url, alt: '' } }) : el('span', { class: 'bar-thumb empty' }),
        el('div', { class: 'bar-chip-text' }, [
          el('span', { class: 'bar-chip-name', text: def.name }),
          el('span', { class: `bar-chip-cost${canAfford(this.ctx.state, def.cost) ? '' : ' unaffordable'}`, text: cost }),
        ]),
        el('button', { class: 'btn bar-cancel', text: '×', title: t('bar.cancel'), onClick: () => this.ctx.bus.emit('ui:setTool', { tool: { kind: 'select' } }) }),
      );
      setText(this.hint, t(def.placement.line ? 'hint.buildLine' : def.rotatable ? 'hint.buildRotate' : 'hint.build'));
    } else if (tool.kind === 'demolish') {
      this.chip.append(el('span', { class: 'bar-chip-name danger-text', text: t('build.demolish') }));
      setText(this.hint, t('hint.demolish'));
    } else {
      setText(this.hint, t('hint.select'));
    }
    this.chip.classList.toggle('hidden', tool.kind === 'select');
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
