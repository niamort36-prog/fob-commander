/** Panneau du véhicule sélectionné : état, cargaison restante, renforts, déchargement. */
import type { GameContext } from '../core/GameContext';
import type { Id } from '../core/GameState';
import { bagEntries } from '../core/resources';
import { formatNumber, t } from '../utils/i18n';
import { clear, el } from './dom';

export class VehiclePanel {
  private readonly root: HTMLElement;
  private selected: Id | null = null;
  private signature = '';
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.root = el('div', { class: 'panel info-panel hidden' });
    parent.append(this.root);
    this.unsubs.push(
      ctx.bus.on('ui:select', ({ target }) => {
        this.selected = target?.kind === 'vehicle' ? target.id : null;
        this.signature = '';
        this.update();
      }),
    );
  }

  update(): void {
    const v = this.selected ? this.ctx.state.vehicles[this.selected] : undefined;
    if (!v) {
      this.root.classList.add('hidden');
      return;
    }
    const content = this.ctx.content;
    const def = content.vehicle(v.defId);
    const rows: [string, string][] = [[t('info.status'), t(`vehicle.${v.state}`)]];
    const cargo = bagEntries(v.cargo).filter(([, n]) => n >= 1).map(([r, n]) => `${formatNumber(n)} ${content.resource(r).short}`);
    if (cargo.length) rows.push([t('vehicle.cargo'), cargo.join(', ')]);
    if (v.carry) rows.push([t('vehicle.carry'), `${formatNumber(v.carry.amount)} ${content.resource(v.carry.resource).short}`]);
    const pax = v.passengers.reduce((s, p) => s + p.count, 0);
    if (pax) rows.push([t('vehicle.passengers'), String(pax)]);
    if (v.state === 'unloading') rows.push([t('vehicle.haulers'), String(this.ctx.sim.agents.haulers(v.id))]);
    const target = v.targetId ? this.ctx.state.fob.buildings[v.targetId] : undefined;
    if (target) rows.push([t('vehicle.target'), content.building(target.defId).name]);
    const home = v.homeId ? this.ctx.state.fob.buildings[v.homeId] : undefined;
    if (home) rows.push([t('vehicle.home'), content.building(home.defId).name]);

    const signature = `${v.id}|${rows.map((r) => r[1]).join('|')}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.root.classList.remove('hidden');
    clear(this.root);
    this.root.append(
      el('div', { class: 'panel-title' }, [def.name, el('button', { class: 'btn close', text: '×', onClick: () => this.ctx.bus.emit('ui:select', { target: null }) })]),
      el('table', { class: 'kv' }, rows.map(([k, val]) => el('tr', {}, [el('td', { text: k }), el('td', { text: val })]))),
    );
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
