/**
 * Menu de construction : outils (sélection, démolition), onglets de catégories, liste des bâtiments
 * avec leur vignette. Il s'ouvre vers le haut depuis le bouton « Construction » du bandeau du bas.
 */
import type { BuildingDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { ToolMode } from '../core/GameEvents';
import { bagEntries, canAfford } from '../core/resources';
import { formatNumber, t } from '../utils/i18n';
import { buildingThumb } from '../assets/thumbnails';
import { clear, el } from './dom';

const OPEN_KEY = 'fobcmd.ui.build.open';

interface Entry {
  def: BuildingDef;
  button: HTMLButtonElement;
  size: HTMLElement;
}

export class BuildMenu {
  private readonly root: HTMLElement;
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly list: HTMLElement;
  private readonly selectBtn: HTMLButtonElement;
  private readonly demolishBtn: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly expandBtn: HTMLButtonElement;
  private entries: Entry[] = [];
  private category: string;
  private tool: ToolMode = { kind: 'select' };
  private open = true;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    const setTool = (tool: ToolMode): void => ctx.bus.emit('ui:setTool', { tool });

    this.selectBtn = el('button', { class: 'btn tool', text: t('build.select'), title: t('build.selectHint'), onClick: () => setTool({ kind: 'select' }) });
    this.demolishBtn = el('button', { class: 'btn tool danger', text: t('build.demolish'), title: t('build.demolishHint'), onClick: () => setTool({ kind: 'demolish' }) });

    const tabBar = el('div', { class: 'tabs' });
    for (const cat of ctx.content.categories) {
      const count = ctx.content.buildingsInCategory(cat.id).length;
      const tab = el('button', {
        class: 'btn tab' + (count === 0 ? ' empty' : ''),
        text: cat.short,
        title: cat.name,
        onClick: () => this.showCategory(cat.id),
      });
      this.tabs.set(cat.id, tab);
      tabBar.append(tab);
    }
    this.list = el('div', { class: 'build-list' });
    this.hint = el('div', { class: 'hint' });
    this.expandBtn = el('button', { class: 'btn wide expand', title: t('build.expandHint'), onClick: () => ctx.commands.push({ type: 'expandZone' }) });

    const title = el('div', { class: 'panel-title' }, [
      el('span', { class: 'title-text', text: t('build.title') }),
      el('button', { class: 'btn collapse-btn', text: '▼', title: t('bar.buildClose'), onClick: () => this.setOpen(false) }),
    ]);
    this.root = el('div', { class: 'panel build-menu' }, [title, el('div', { class: 'tools' }, [this.selectBtn, this.demolishBtn]), tabBar, this.list, this.expandBtn]);
    parent.append(this.root);
    try {
      this.open = localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      // stockage indisponible : menu ouvert
    }

    const firstWithContent = ctx.content.categories.find((c) => ctx.content.buildingsInCategory(c.id).length > 0);
    this.category = firstWithContent?.id ?? ctx.content.categories[0].id;
    this.showCategory(this.category);

    this.unsubs.push(
      ctx.bus.on('ui:toolChanged', ({ tool }) => {
        this.tool = tool;
        this.refreshTool();
      }),
      ctx.bus.on('ui:toggleBuild', () => this.setOpen(!this.open)),
      // Petit écran : ouvrir le journal range le menu (ils se superposeraient)
      ctx.bus.on('ui:logState', ({ open }) => {
        if (open && this.open && window.innerWidth < 700) this.setOpen(false);
      }),
    );
    this.setOpen(this.open);
  }

  /** Ouvre ou range le menu dans le bandeau du bas (état mémorisé). */
  private setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('hidden', !open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      // sans mémoire : tant pis
    }
    this.ctx.bus.emit('ui:buildOpen', { open });
  }

  private showCategory(id: string): void {
    this.category = id;
    for (const [catId, tab] of this.tabs) tab.classList.toggle('active', catId === id);
    clear(this.list);
    this.entries = [];
    const cat = this.ctx.content.categories.find((c) => c.id === id);
    this.list.append(el('div', { class: 'list-heading', text: cat?.name ?? '' }));

    const defs = this.ctx.content.buildingsInCategory(id);
    if (defs.length === 0) {
      this.list.append(el('div', { class: 'muted', text: t('build.emptyCategory') }));
      return;
    }
    for (const def of defs) {
      const cost = bagEntries(def.cost)
        .map(([r, v]) => (r === 'funds' ? `$${formatNumber(v)}` : `${formatNumber(v)} ${this.ctx.content.resource(r).short}`))
        .join(' ');
      const [w, h] = def.footprint;
      const size = el('span', { class: 'build-size', text: def.placement.line ? t('build.line') : `${w}×${h}` });
      const button = el(
        'button',
        {
          class: 'btn build-item',
          title: this.tooltip(def),
          onClick: () => {
            const reason = this.ctx.sim.build.lockReason(def);
            if (reason === 'points') this.ctx.commands.push({ type: 'unlockBuilding', defId: def.id });
            else if (reason === 'level') this.ctx.bus.emit('progression:unlockRejected', { defId: def.id, reason: 'level' });
            else this.ctx.bus.emit('ui:setTool', { tool: { kind: 'build', defId: def.id } });
          },
        },
        [
          buildingThumb(def) ? el('img', { class: 'build-thumb', attrs: { src: buildingThumb(def), alt: '' } }) : el('span', { class: 'build-thumb empty' }),
          el('span', { class: 'build-text' }, [
            el('span', { class: 'build-name', text: def.name }),
            el('span', { class: 'build-meta' }, [el('span', { class: 'build-cost', text: cost }), size]),
          ]),
        ],
      );
      this.entries.push({ def, button, size });
      this.list.append(button);
    }
    this.refreshTool();
    this.update();
  }

  private tooltip(def: BuildingDef): string {
    const lines = [def.name, def.desc];
    const upkeep = bagEntries(def.upkeepPerDay).map(([r, v]) => `${formatNumber(v)} ${this.ctx.content.resource(r).short}`);
    if (upkeep.length) lines.push(`${t('info.upkeep')} : ${upkeep.join(', ')}${t('hud.perDay')}`);
    const cons = bagEntries(def.consumptionPerDay).map(([r, v]) => `${formatNumber(v)} ${this.ctx.content.resource(r).short}`);
    if (cons.length) lines.push(`${t('info.consumption')} : ${cons.join(', ')}${t('hud.perDay')}`);
    lines.push(t('build.timeHint', { hours: (def.buildTimeMin / 60).toFixed(1) }));
    if (def.rotatable) lines.push(t('build.rotateHint'));
    return lines.join('\n');
  }

  private refreshTool(): void {
    this.selectBtn.classList.toggle('active', this.tool.kind === 'select');
    this.demolishBtn.classList.toggle('active', this.tool.kind === 'demolish');
    for (const e of this.entries) {
      e.button.classList.toggle('active', this.tool.kind === 'build' && this.tool.defId === e.def.id);
    }
    let hint = t('hint.select');
    if (this.tool.kind === 'demolish') hint = t('hint.demolish');
    else if (this.tool.kind === 'build') {
      const def = this.ctx.content.building(this.tool.defId);
      hint = t(def.placement.line ? 'hint.buildLine' : def.rotatable ? 'hint.buildRotate' : 'hint.build');
    }
    this.hint.textContent = hint;
  }

  /** Rafraîchit l'état « abordable / verrouillé » des boutons. */
  update(): void {
    const state = this.ctx.state;
    const cost = this.ctx.sim.build.expansionCost();
    const label = cost === null ? t('build.expandMax') : t('build.expand', { cost: formatNumber(cost), step: this.ctx.content.balance.zone.step });
    if (this.expandBtn.textContent !== label) this.expandBtn.textContent = label;
    this.expandBtn.disabled = cost === null;
    this.expandBtn.classList.toggle('unaffordable', cost !== null && state.resources.stock.funds < cost);
    for (const e of this.entries) {
      const reason = this.ctx.sim.build.lockReason(e.def);
      const locked = reason !== null;
      e.button.classList.toggle('locked', locked);
      e.button.classList.toggle('purchasable', reason === 'points' && state.progression.points >= (e.def.unlock.points ?? 0));
      const [w, h] = e.def.footprint;
      const pts = e.def.unlock.points ?? 0;
      const sizeText =
        reason === 'level' ? t('build.requiresLevel', { rep: e.def.unlock.reputation }) : reason === 'points' ? t('build.unlockCost', { pts }) : e.def.placement.line ? t('build.line') : `${w}×${h}`;
      if (e.size.textContent !== sizeText) e.size.textContent = sizeText;
      if (locked) {
        const title = t('build.unlockHint', { pts, have: state.progression.points, rep: e.def.unlock.reputation });
        if (e.button.dataset.lockTitle !== title) {
          e.button.dataset.lockTitle = title;
          e.button.title = `${title}\n\n${e.def.desc}`;
        }
      } else if (e.button.dataset.lockTitle) {
        delete e.button.dataset.lockTitle;
        e.button.title = this.tooltip(e.def);
      }
      e.button.classList.toggle('unaffordable', !locked && !canAfford(state, e.def.cost));
    }
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
