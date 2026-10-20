/** SetupScene — choix de l'emplacement de la FOB parmi les sites de sites.json. */
import Phaser from 'phaser';
import { game } from '../core/GameContext';
import type { SiteDef } from '../core/ContentTypes';
import { bagEntries } from '../core/resources';
import { drawRegionBase } from '../render/regionMap';
import { el, uiRoot } from '../ui/dom';
import { formatNumber, t } from '../utils/i18n';

export class SetupScene extends Phaser.Scene {
  private selected: string | null = null;

  constructor() {
    super('SetupScene');
  }

  create(): void {
    const ctx = game();
    const sites = ctx.content.sites;
    this.selected = sites[0].id;

    const deploy = el('button', { class: 'btn big primary', text: t('setup.deploy'), onClick: () => this.deploy() });
    const cards = sites.map((site) => this.card(site));

    // Carte du district avec les emplacements possibles
    const region = ctx.content.region;
    const pxPerKm = 10;
    const margin = 14;
    const canvas = document.createElement('canvas');
    drawRegionBase(canvas, region, pxPerKm, { labels: true, margin });
    const mapBox = el('div', { class: 'setup-map' }, [canvas]);
    const markers = sites.map((site) => {
      const m = el('div', { class: 'site-marker', text: site.name });
      m.style.left = `${((margin + site.regionPos.x * pxPerKm) / canvas.width) * 100}%`;
      m.style.top = `${((margin + site.regionPos.y * pxPerKm) / canvas.height) * 100}%`;
      mapBox.append(m);
      return m;
    });

    const refresh = (): void => {
      cards.forEach((c, i) => c.classList.toggle('active', sites[i].id === this.selected));
      markers.forEach((m, i) => m.classList.toggle('active', sites[i].id === this.selected));
    };
    const choose = (i: number): void => {
      this.selected = sites[i].id;
      refresh();
    };
    cards.forEach((c, i) => c.addEventListener('click', () => choose(i)));
    markers.forEach((m, i) => m.addEventListener('click', () => choose(i)));
    refresh();

    const screen = el('div', { class: 'screen setup-screen' }, [
      el('div', { class: 'panel setup-box' }, [
        el('div', { class: 'panel-title', text: t('setup.title') }),
        el('p', { class: 'muted', text: `${t('setup.intro')} ${t('setup.mapHint')}` }),
        mapBox,
        el('div', { class: 'site-cards' }, cards),
        el('div', { class: 'setup-actions' }, [el('button', { class: 'btn big', text: t('setup.back'), onClick: () => this.scene.start('MenuScene') }), deploy]),
      ]),
    ]);
    uiRoot().append(screen);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => screen.remove());
  }

  private card(site: SiteDef): HTMLElement {
    const ctx = game();
    const budget = Math.round(ctx.content.balance.economy.dailyBudget * site.budgetMult);
    const start = bagEntries(site.startResources)
      .map(([r, v]) => `${ctx.content.resource(r).short} ${formatNumber(v)}`)
      .join(' · ');
    return el('div', { class: 'site-card' }, [
      el('div', { class: 'site-name', text: site.name }),
      el('p', { class: 'desc', text: site.desc }),
      el('ul', { class: 'pros' }, site.pros.map((p) => el('li', { text: p }))),
      el('ul', { class: 'cons' }, site.cons.map((c) => el('li', { text: c }))),
      el('div', { class: 'muted small', text: t('setup.budget', { budget: formatNumber(budget) }) }),
      el('div', { class: 'muted small', text: start }),
    ]);
  }

  private deploy(): void {
    if (!this.selected) return;
    game().newGame(this.selected);
    this.scene.start('FobScene');
  }
}
