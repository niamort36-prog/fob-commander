/** Panneau d'information du bâtiment sélectionné (état, flux, services, occupants, ouvriers). */
import { levelName, nextLevel } from '../core/buildingStats';
import type { GameContext } from '../core/GameContext';
import type { Id, ResourceBag } from '../core/GameState';
import { bagEntries } from '../core/resources';
import { formatNumber, t } from '../utils/i18n';
import { clear, el } from './dom';
import { distanceToZone, noiseRadius, noiseZones } from '../systems/modules';

export class InfoPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private selected: Id | null = null;
  private lastRender = '';
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.body = el('div', { class: 'info-body' });
    this.root = el('div', { class: 'panel info-panel hidden' }, [this.body]);
    parent.append(this.root);
    this.unsubs.push(
      ctx.bus.on('ui:select', ({ target }) => {
        this.selected = target?.kind === 'building' ? target.id : null;
        this.lastRender = '';
        this.update();
      }),
    );
  }

  private bag(bag: ResourceBag | undefined): string {
    return bagEntries(bag)
      .map(([r, v]) => `${formatNumber(v)} ${this.ctx.content.resource(r).short}`)
      .join(', ');
  }

  private costText(cost: ResourceBag): string {
    return bagEntries(cost)
      .map(([r, v]) => (r === 'funds' ? `$${formatNumber(v)}` : `${formatNumber(v)} ${this.ctx.content.resource(r).short}`))
      .join(' ');
  }

  update(): void {
    const b = this.selected ? this.ctx.state.fob.buildings[this.selected] : undefined;
    if (!b) {
      this.root.classList.add('hidden');
      return;
    }
    const agents = this.ctx.sim.agents;
    const def = this.ctx.content.building(b.defId);
    const refund = this.ctx.sim.build.refundFor(b);
    const build = this.ctx.sim.build;
    const st = build.stats(b);
    const economy = this.ctx.sim.economy;

    const rows: [string, string][] = [[t('info.status'), t(`status.${b.state}`)]];
    if (def.levels?.length) rows.push([t('info.level'), `${b.level} / ${def.levels.length + 1}`]);
    if (b.upgrade) rows.push([t('info.upgrading'), `${Math.floor(b.upgrade.progress * 100)} %`]);
    if (def.wearPerDay) rows.push([t('info.wear'), `${Math.round(b.wear * 100)} %${build.needsWork(b, true) && b.state !== 'construction' && !b.upgrade ? ' — ' + t('info.repairing') : ''}`]);
    if (b.state !== 'construction' && (st.powerDemand > 0 || st.productionPerDay)) {
      rows.push([t('info.efficiency'), `${Math.round(economy.buildingEfficiency(b) * 100)} %`]);
    }
    if (st.powerDemand > 0) rows.push([t('info.power'), `${st.powerDemand} kW`]);
    if (st.powerSupply > 0) rows.push([t('info.powerSupply'), `${st.powerSupply} kW`]);
    if (def.acceptsCargo?.length) rows.push([t('info.acceptsCargo'), def.acceptsCargo.map((r) => this.ctx.content.resource(r).short).join(', ')]);
    if (b.state === 'construction') {
      rows.push([t('info.progress'), `${Math.floor(b.buildProgress * 100)} %`]);
      rows.push([t('info.workers'), `${agents.builders(b.id)} / ${this.ctx.content.balance.build.maxWorkersPerSite}`]);
      rows.push([t('info.buildSpeed'), `×${this.ctx.sim.build.constructionSpeed(b).toFixed(2)}`]);
    }
    // Matériaux du chantier en cours (construction, amélioration, module)
    const logistics = this.ctx.sim.logistics;
    if (b.materials) {
      const m = b.materials;
      const waiting = build.waitingForMaterials(b) ? ` — ${t('info.materialsWaiting')}` : '';
      rows.push([t('info.materials'), `${Math.floor(m.delivered)} / ${m.needed}${waiting}`]);
      rows.push([t('info.fetchers'), String(logistics.fetchers(b))]);
    }
    // Stock local livré par le soutien
    if (b.state !== 'construction') {
      for (const res of logistics.supplied(b)) {
        const n = logistics.stock(b, res);
        const incoming = logistics.incoming(b, res);
        const extra = logistics.starved(b, res) ? ` — ${t('info.starved')}` : incoming > 0 ? ` (${t('info.incoming', { n: formatNumber(incoming) })})` : '';
        rows.push([`${t('info.localStock')} ${this.ctx.content.resource(res).short}`, `${formatNumber(Math.floor(n))} / ${logistics.capacity(b, res)}${extra}`]);
      }
      if (def.kitchen) {
        const amateur = logistics.meals(b) >= 1 && logistics.mealQuality(b) < 0.9 ? ` — ${t('info.mealsAmateur')}` : '';
        rows.push([t('info.meals'), `${Math.floor(logistics.meals(b))} / ${def.kitchen.mealCapacity}${amateur}`]);
      }
      if (def.cleaning) {
        const c = logistics.cleanliness(b);
        const cleaning = agents.agentList().some((a) => a.activity?.id === 'clean' && a.activity.targetId === b.id);
        rows.push([t('info.cleanliness'), `${Math.round(c * 100)} %${cleaning ? ' — ' + t('info.cleaning') : logistics.dirty(b) ? ' — ' + t('info.dirty') : ''}`]);
      }
    }
    rows.push([t('info.hp'), `${formatNumber(b.hp)} / ${formatNumber(def.hp)}`]);
    const upkeep = this.bag(st.upkeepPerDay);
    if (upkeep) rows.push([t('info.upkeep'), `${upkeep}${t('hud.perDay')}`]);
    const cons = this.bag(st.consumptionPerDay);
    if (cons) rows.push([t('info.consumption'), `${cons}${t('hud.perDay')}`]);
    const prod = this.bag(st.productionPerDay);
    if (prod) rows.push([t('info.production'), `${prod}${t('hud.perDay')}`]);
    const storage = this.bag(st.storage);
    if (storage) rows.push([t('info.storage'), storage]);
    for (const [k, v] of Object.entries(def.provides ?? {})) rows.push([t(`provides.${k}`), String(v)]);
    for (const [service, svc] of Object.entries(st.services)) {
      if (service === 'parking') {
        const parked = Object.values(this.ctx.state.vehicles).filter((v) => v.targetId === b.id && (v.state === 'unloading' || v.state === 'inbound')).length;
        rows.push([t('service.parking'), `${parked} / ${svc.slots}`]);
        continue;
      }
      const used = service === 'sleep' ? agents.residents(b.id).length : agents.occupancy(b.id, service);
      rows.push([t(`service.${service}`), `${used} / ${svc.slots}`]);
    }
    if (def.walkSpeedMult) rows.push([t('info.walkSpeed'), `×${def.walkSpeedMult}`]);
    // Portes et murs : passage, contrôle par un poste de garde, résistance à un assaut
    if (def.gate) {
      rows.push([t('info.gate'), t(def.gate.vehicles ? 'info.gateVehicles' : 'info.gatePeople')]);
      rows.push([t('info.guarded'), t(this.ctx.sim.supply.gateGuarded(b.id) ? 'info.guardedYes' : 'info.guardedNo')]);
    }
    if (def.breachMin !== undefined && (def.gate || def.placement.line)) rows.push([t('info.breach'), t('info.breachMin', { min: Math.round(def.breachMin * (1 - b.wear)) })]);
    if (def.noise) rows.push([t('info.noise'), t('info.noiseRadius', { r: Math.round(noiseRadius(def, b)) })]);
    if (def.services?.sleep) {
      for (const z of noiseZones(this.ctx.content, this.ctx.state)) {
        const d = distanceToZone(def, b, z);
        if (d <= z.radius) rows.push([t('info.noise'), t('info.noiseNear', { name: z.name, d: Math.round(d) })]);
      }
    }

    const lv = nextLevel(def, b.level);
    const upgradeReason = build.upgradeCheck(b);

    // Ne reconstruit le DOM que si l'affichage change (évite le scintillement des boutons).
    const moduleSig = (def.modules ?? [])
      .map((m) => `${m.id}:${build.moduleCheck(b, m.id)}:${b.moduleWork?.id === m.id ? Math.floor(b.moduleWork.progress * 20) : ''}`)
      .join(',');
    const signature = `${b.id}|${refund.funds}|${upgradeReason}|${moduleSig}|${rows.map((r) => r[1]).join('|')}`;
    if (signature === this.lastRender) return;
    this.lastRender = signature;

    this.root.classList.remove('hidden');
    clear(this.body);
    const category = this.ctx.content.categories.find((c) => c.id === def.category);
    this.body.append(
      el('div', { class: 'panel-title' }, [levelName(def, b.level), el('button', { class: 'btn close', text: '×', onClick: () => this.ctx.bus.emit('ui:select', { target: null }) })]),
      el('div', { class: 'muted small', text: category?.name ?? '' }),
      el('p', { class: 'desc', text: def.desc }),
      el('table', { class: 'kv' }, rows.map(([k, v]) => el('tr', {}, [el('td', { text: k }), el('td', { text: v })]))),
      lv
        ? el('button', {
            class: 'btn wide',
            text: t('info.upgrade', { name: lv.name ?? '', cost: this.costText(lv.cost), hours: (lv.buildTimeMin / 60).toFixed(1) }),
            title: upgradeReason ? t(`upgrade.${upgradeReason}`) : '',
            attrs: upgradeReason ? { disabled: '' } : {},
            onClick: () => this.ctx.commands.push({ type: 'upgradeBuilding', buildingId: b.id }),
          })
        : '',
      this.modulesSection(b.id),
      el('button', {
        class: 'btn danger wide',
        text: t('info.demolish', { refund: formatNumber(refund.funds ?? 0) }),
        onClick: () => this.ctx.commands.push({ type: 'demolish', buildingId: b.id }),
      }),
    );
  }

  /** Améliorations installables : installées, en cours, ou bouton d'installation (avec la raison d'un refus). */
  private modulesSection(id: Id): HTMLElement | string {
    const b = this.ctx.state.fob.buildings[id];
    const def = this.ctx.content.building(b.defId);
    if (!def.modules?.length || b.state === 'construction') return '';
    const build = this.ctx.sim.build;
    const box = el('div', { class: 'modules' }, [el('div', { class: 'section-title', text: t('info.modules') })]);
    for (const m of def.modules) {
      const check = build.moduleCheck(b, m.id);
      const power = m.powerDemand ? ` · ${t('module.power', { n: m.powerDemand })}` : '';
      const head = el('div', { class: 'module-name' }, [m.name]);
      const row = el('div', { class: `module-row${check === 'installed' ? ' done' : ''}`, title: m.desc }, [head]);
      if (check === 'installed') head.append(el('span', { class: 'good small', text: ` ✓ ${t('info.moduleInstalled')}` }));
      else if (b.moduleWork?.id === m.id) head.append(el('span', { class: 'muted small', text: ` — ${t('info.moduleWorking', { pct: Math.floor(b.moduleWork.progress * 100) })}` }));
      else {
        const reason =
          check === 'requires'
            ? t('module.block.requires', { name: def.modules.find((x) => x.id === m.requires)?.name ?? '' })
            : check
              ? t(`module.block.${check}`)
              : '';
        row.append(
          el('div', { class: 'muted small', text: `${m.desc}${power}` }),
          el('button', {
            class: 'btn small-btn',
            text: t('info.moduleInstall', { cost: this.costText(m.cost), hours: (m.buildTimeMin / 60).toFixed(1) }),
            title: reason,
            attrs: check ? { disabled: '' } : {},
            onClick: () => this.ctx.commands.push({ type: 'installModule', buildingId: id, moduleId: m.id }),
          }),
        );
        if (reason && check !== 'funds') row.append(el('div', { class: 'small warn-text', text: reason }));
      }
      box.append(row);
    }
    return box;
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
