/**
 * Écran logistique (touche L, bouton Logistique) : plein écran, en quatre onglets.
 *  - Commander : choix du moyen de transport (carte avec le véhicule, délai, risque, capacité),
 *    composition de la cargaison (stock actuel et autonomie de chaque ressource, boutons rapides,
 *    jauge de chargement colorée), renforts et véhicules à bord, et bon de commande récapitulatif
 *    (lignes, total face aux fonds, arrivée prévue, risque) avec le bouton de validation.
 *  - Convois en cours : chaque commande avec ses étapes (commandée → en route → déchargement → livrée).
 *  - Véhicules de la base et équipement individuel.
 */
import { vehicleThumb } from '../assets/thumbnails';
import type { SupplyOrderDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { SupplyRejection } from '../core/GameEvents';
import type { PassengerRequest, ResourceBag, ResourceId, SupplyOrder } from '../core/GameState';
import { bagEntries } from '../core/resources';
import { bagTotal } from '../systems/SupplySystem';
import { formatClock, formatNumber, t } from '../utils/i18n';
import { clear, el, setText } from './dom';

type Tab = 'order' | 'convoys' | 'vehicles' | 'gear';
const STEPS = ['pending', 'en_route', 'unloading', 'delivered'] as const;

export class LogisticsPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabBtns = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'order';
  private visible = false;
  private selected: string;
  private cargo: ResourceBag = {};
  private passengers = new Map<string, number>();
  private vehicles = new Map<string, number>();
  private sig = '';
  // Éléments dynamiques de l'onglet Commander
  private readonly qty = new Map<string, HTMLElement>();
  private gauge: HTMLElement | null = null;
  private gaugeText: HTMLElement | null = null;
  private receipt: HTMLElement | null = null;
  private submit: HTMLButtonElement | null = null;
  private reason: HTMLElement | null = null;
  private readonly unsubs: (() => void)[] = [];
  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.visible && e.key === 'Escape') {
      e.stopPropagation();
      this.toggle(false);
    }
  };

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.selected = ctx.content.supply.orders[0].id;
    const tabs = el('div', { class: 'logi-tabs' });
    for (const id of ['order', 'convoys', 'vehicles', 'gear'] as Tab[]) {
      const b = el('button', { class: 'btn logi-tab', text: t(`logi.tab.${id}`), onClick: () => this.show(id) });
      this.tabBtns.set(id, b);
      tabs.append(b);
    }
    this.body = el('div', { class: 'logi-body' });
    this.root = el('div', { class: 'panel logistics-screen hidden' }, [
      el('div', { class: 'logi-head' }, [
        el('div', { class: 'logi-title', text: t('logi.title') }),
        tabs,
        el('button', { class: 'btn close', text: '×', title: t('logi.closeHint'), onClick: () => this.toggle(false) }),
      ]),
      this.body,
    ]);
    parent.append(this.root);
    window.addEventListener('keydown', this.onKey, true);
    this.unsubs.push(ctx.bus.on('ui:toggleLogistics', () => this.toggle()));
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    document.body.classList.toggle('logistics-open', this.visible);
    if (this.visible) this.show(this.tab);
  }

  private show(tab: Tab): void {
    this.tab = tab;
    for (const [id, b] of this.tabBtns) b.classList.toggle('active', id === tab);
    this.sig = '';
    clear(this.body);
    this.gauge = this.gaugeText = this.receipt = this.reason = null;
    this.submit = null;
    if (tab === 'order') this.buildOrder();
    this.update();
  }

  // ------------------------------------------------------------ Commander

  private money(n: number): string {
    return `$${formatNumber(n)}`;
  }

  private riskLabel(risk: number): { text: string; cls: string } {
    const pct = Math.round(risk * 100);
    const cls = pct >= 15 ? 'bad' : pct >= 6 ? 'warn' : 'good';
    return { text: t(`logi.risk.${cls}`, { pct }), cls };
  }

  private orderRisk(def: SupplyOrderDef): number {
    const vdef = this.ctx.content.vehicle(def.vehicle);
    return def.risk * (vdef.kind === 'road' ? this.ctx.site.roadRisk : 1);
  }

  private buildOrder(): void {
    const content = this.ctx.content;
    const supply = content.supply;
    // Colonne 1 : moyens de transport
    const transports = el('div', { class: 'logi-col logi-transports' }, [el('div', { class: 'logi-col-title', text: t('logi.step1') })]);
    for (const def of supply.orders) {
      const vdef = content.vehicle(def.vehicle);
      const block = this.ctx.sim.supply.check(def.id, def.fixed ?? {}, [], []);
      const requiresMissing = block === 'requires';
      const risk = this.riskLabel(this.orderRisk(def));
      const caps: string[] = [];
      if (def.cargo) caps.push(t('logi.capCargo', { n: vdef.capacity ?? 0 }));
      if (def.fixed) caps.push(t('logi.capFixed'));
      if (def.passengers) caps.push(t('logi.capPax', { n: vdef.passengers ?? 0 }));
      if (def.vehicles) caps.push(t('logi.capVeh', { n: vdef.vehicleSlots ?? 0 }));
      const thumb = vehicleThumb(def.vehicle);
      const card = el(
        'button',
        { class: `btn transport-card${def.id === this.selected ? ' active' : ''}${requiresMissing ? ' locked' : ''}`, onClick: () => this.select(def.id) },
        [
          thumb ? el('img', { class: 'transport-thumb', attrs: { src: thumb, alt: '' } }) : el('span', { class: 'transport-thumb' }),
          el('span', { class: 'transport-text' }, [
            el('span', { class: 'transport-name', text: def.name }),
            el('span', { class: 'transport-meta', text: `${vdef.name} · ${t('logi.delayShort', { min: def.delayHours[0], max: def.delayHours[1] })}` }),
            el('span', { class: 'transport-meta', text: caps.join(' · ') }),
            el('span', { class: `transport-risk ${risk.cls}`, text: risk.text }),
            requiresMissing ? el('span', { class: 'transport-lock', text: t('supply.requires', { building: content.building(def.requires).name }) }) : '',
          ]),
        ],
      );
      transports.append(card);
    }

    // Colonne 2 : composition
    const def = content.supplyOrder(this.selected);
    const vdef = content.vehicle(def.vehicle);
    const compose = el('div', { class: 'logi-col logi-compose' }, [el('div', { class: 'logi-col-title', text: t('logi.step2') }), el('p', { class: 'desc', text: def.desc })]);
    this.qty.clear();
    if (def.cargo) {
      this.gauge = el('div', { class: 'load-gauge' });
      this.gaugeText = el('div', { class: 'load-text' });
      compose.append(el('div', { class: 'load-wrap' }, [this.gaugeText, this.gauge]));
      const step = supply.cargoStep;
      const proj = this.ctx.sim.economy.projections();
      for (const r of def.cargo) {
        const res = content.resource(r);
        const price = supply.unitPrices[r] ?? 0;
        const stock = Math.floor(this.ctx.state.resources.stock[r]);
        const days = proj[r]?.daysLeft;
        const autonomy = days === null || days === undefined ? t('logi.stable') : t('logi.days', { n: days < 10 ? days.toFixed(1) : Math.round(days) });
        const low = days !== null && days !== undefined && days < content.balance.economy.lowStockDays;
        const q = el('span', { class: 'res-qty' });
        this.qty.set(`cargo.${r}`, q);
        const change = (d: number): void => {
          this.cargo[r] = Math.max(0, (this.cargo[r] ?? 0) + d);
          this.refresh();
        };
        const fill = (): void => {
          const free = Math.max(0, (vdef.capacity ?? 0) - bagTotal(this.cargo));
          this.cargo[r] = (this.cargo[r] ?? 0) + Math.floor(free / step) * step;
          this.refresh();
        };
        compose.append(
          el('div', { class: `res-line${low ? ' low' : ''}` }, [
            el('span', { class: 'res-swatch', attrs: { style: `background:${res.color}` } }),
            el('div', { class: 'res-info' }, [
              el('span', { class: 'res-name', text: res.name }),
              el('span', { class: 'res-sub', text: `${t('logi.stock', { n: formatNumber(stock) })} · ${autonomy} · ${this.money(price)}/u` }),
            ]),
            el('div', { class: 'res-ctrl' }, [
              el('button', { class: 'btn step', text: `−${step * 5}`, onClick: () => change(-step * 5) }),
              el('button', { class: 'btn step', text: `−${step}`, onClick: () => change(-step) }),
              q,
              el('button', { class: 'btn step', text: `+${step}`, onClick: () => change(step) }),
              el('button', { class: 'btn step', text: `+${step * 5}`, onClick: () => change(step * 5) }),
              el('button', { class: 'btn step fill', text: t('logi.fill'), title: t('logi.fillHint'), onClick: fill }),
            ]),
          ]),
        );
      }
    } else if (def.fixed) {
      const items = bagEntries(def.fixed).map(([r, v]) => `${formatNumber(v)} ${content.resource(r).name.toLowerCase()}`);
      compose.append(el('div', { class: 'fixed-cargo', text: t('logi.fixedLoad', { items: items.join(', ') }) }));
    }
    if (def.passengers) {
      compose.append(el('div', { class: 'logi-sub', text: t('logi.recruitsTitle', { n: vdef.passengers ?? 0 }) }));
      for (const r of supply.recruits) {
        const block = this.ctx.sim.supply.recruitBlock(r.type);
        const sub =
          block === 'level'
            ? t('logi.locked', { rep: r.reputation })
            : block === 'requires'
              ? t('logi.requiresPersonnel', { name: content.personnel(r.requires!).name })
              : block === 'max'
                ? t('logi.maxReached')
                : `${this.money(r.price)} · ${t('logi.salary', { n: content.personnel(r.type).salaryPerDay })}`;
        compose.append(this.counter(`pax.${r.type}`, content.personnel(r.type).name, sub, block !== null, (d) => this.passengers.set(r.type, Math.max(0, (this.passengers.get(r.type) ?? 0) + d))));
      }
    }
    if (def.vehicles) {
      compose.append(el('div', { class: 'logi-sub', text: t('logi.vehiclesTitle', { n: vdef.vehicleSlots ?? 0 }) }));
      for (const v of content.vehicleList.filter((x) => x.price !== undefined && x.kind === 'base')) {
        compose.append(this.counter(`veh.${v.id}`, v.name, this.money(v.price!), false, (d) => this.vehicles.set(v.id, Math.max(0, (this.vehicles.get(v.id) ?? 0) + d))));
      }
    }

    // Colonne 3 : bon de commande
    this.receipt = el('div', { class: 'receipt-lines' });
    this.reason = el('div', { class: 'receipt-reason' });
    this.submit = el('button', {
      class: 'btn wide primary receipt-submit',
      text: t('logi.submit'),
      onClick: () => {
        this.ctx.commands.push({ type: 'orderSupply', orderId: this.selected, cargo: { ...this.cargo }, passengers: this.paxList(), vehicles: this.vehList() });
        this.select(this.selected);
      },
    });
    const receipt = el('div', { class: 'logi-col logi-receipt' }, [
      el('div', { class: 'logi-col-title', text: t('logi.step3') }),
      el('div', { class: 'receipt' }, [this.receipt, this.reason, this.submit]),
    ]);
    this.body.append(el('div', { class: 'logi-order' }, [transports, compose, receipt]));
    this.refresh();
  }

  private counter(key: string, label: string, sub: string, locked: boolean, change: (d: number) => void): HTMLElement {
    const q = el('span', { class: 'res-qty' });
    this.qty.set(key, q);
    const act = (d: number): void => {
      change(d);
      this.refresh();
    };
    return el('div', { class: `res-line${locked ? ' locked' : ''}` }, [
      el('div', { class: 'res-info' }, [el('span', { class: 'res-name', text: label }), el('span', { class: 'res-sub', text: sub })]),
      el('div', { class: 'res-ctrl' }, [
        el('button', { class: 'btn step', text: '−', onClick: () => act(-1), attrs: locked ? { disabled: '' } : {} }),
        q,
        el('button', { class: 'btn step', text: '+', onClick: () => act(1), attrs: locked ? { disabled: '' } : {} }),
      ]),
    ]);
  }

  private select(id: string): void {
    this.selected = id;
    this.cargo = {};
    this.passengers.clear();
    this.vehicles.clear();
    if (this.tab === 'order') this.show('order');
  }

  private vehList(): string[] {
    const out: string[] = [];
    for (const [id, n] of this.vehicles) for (let i = 0; i < n; i++) out.push(id);
    return out;
  }

  private paxList(): PassengerRequest[] {
    return [...this.passengers].filter(([, n]) => n > 0).map(([type, count]) => ({ type, count }));
  }

  private eta(def: SupplyOrderDef): string {
    const time = this.ctx.content.balance.time;
    const now = time.startHour * 60 + this.ctx.state.time.tick * time.minutesPerTick;
    const at = (h: number): string => {
      const m = now + h * 60;
      return t('logi.at', { day: Math.floor(m / 1440) + 1, time: formatClock(m % 1440) });
    };
    return t('logi.etaRange', { from: at(def.delayHours[0]), to: at(def.delayHours[1]) });
  }

  /** Met à jour quantités, jauge et bon de commande. */
  private refresh(): void {
    if (!this.receipt || !this.submit || !this.reason) return;
    const content = this.ctx.content;
    const def = content.supplyOrder(this.selected);
    const vdef = content.vehicle(def.vehicle);
    for (const [key, label] of this.qty) {
      const [kind, id] = key.split('.');
      setText(label, String(kind === 'cargo' ? (this.cargo[id as ResourceId] ?? 0) : kind === 'veh' ? (this.vehicles.get(id) ?? 0) : (this.passengers.get(id) ?? 0)));
    }
    // Jauge de chargement : un segment coloré par ressource
    if (this.gauge && this.gaugeText) {
      const cap = vdef.capacity ?? 0;
      const load = bagTotal(this.cargo);
      clear(this.gauge);
      for (const [r, n] of bagEntries(this.cargo)) {
        if (n <= 0) continue;
        this.gauge.append(el('span', { class: 'load-seg', attrs: { style: `width:${Math.min(100, (n / Math.max(1, cap)) * 100)}%;background:${content.resource(r).color}`, title: `${content.resource(r).name} : ${n}` } }));
      }
      this.gauge.classList.toggle('over', load > cap);
      setText(this.gaugeText, t('logi.loadGauge', { n: formatNumber(load), max: formatNumber(cap) }));
    }
    // Bon de commande
    const pax = this.paxList();
    const vehs = this.vehList();
    const cost = this.ctx.sim.supply.orderCost(def, this.cargo, pax, vehs);
    const funds = this.ctx.state.resources.stock.funds;
    clear(this.receipt);
    const line = (label: string, value: string, cls = ''): void => {
      this.receipt!.append(el('div', { class: `receipt-line ${cls}` }, [el('span', { text: label }), el('span', { text: value })]));
    };
    line(t('logi.fee', { vehicle: vdef.name }), this.money(def.fee));
    if (def.fixed) line(t('logi.fixedLine'), this.money(def.fixedPrice ?? 0));
    for (const [r, n] of bagEntries(this.cargo)) {
      if (n > 0) line(`${formatNumber(n)} × ${content.resource(r).name}`, this.money(n * (content.supply.unitPrices[r] ?? 0)));
    }
    for (const p of pax) {
      const rec = content.supply.recruits.find((x) => x.type === p.type);
      line(`${p.count} × ${content.personnel(p.type).name}`, this.money(p.count * (rec?.price ?? 0)));
    }
    for (const [id, n] of this.vehicles) if (n > 0) line(`${n} × ${content.vehicle(id).name}`, this.money(n * (content.vehicle(id).price ?? 0)));
    this.receipt.append(el('div', { class: 'receipt-sep' }));
    line(t('logi.total'), this.money(cost), 'total');
    line(t('logi.funds'), this.money(funds), funds < cost ? 'bad' : 'dim');
    line(t('logi.after'), this.money(funds - cost), funds < cost ? 'bad' : 'dim');
    this.receipt.append(el('div', { class: 'receipt-sep' }));
    line(t('logi.arrival'), this.eta(def), 'dim');
    const risk = this.riskLabel(this.orderRisk(def));
    line(t('logi.riskTitle'), risk.text, risk.cls);
    const reason = this.ctx.sim.supply.check(this.selected, this.cargo, pax, vehs);
    this.submit.disabled = reason !== null;
    setText(this.reason, reason ? this.reasonText(reason, def) : '');
  }

  private reasonText(reason: SupplyRejection, def: SupplyOrderDef): string {
    if (reason === 'requires') return t('supply.requires', { building: this.ctx.content.building(def.requires).name });
    return t(`supply.${reason}`);
  }

  // ------------------------------------------------------------ Convois

  private clockOf(tick: number): string {
    const time = this.ctx.content.balance.time;
    const total = time.startHour * 60 + tick * time.minutesPerTick;
    return t('logi.at', { day: Math.floor(total / 1440) + 1, time: formatClock(total % 1440) });
  }

  private statusText(o: SupplyOrder): string {
    const v = o.vehicleId ? this.ctx.state.vehicles[o.vehicleId] : undefined;
    switch (o.status) {
      case 'pending':
        return t(o.ambushed ? 'order.delayed' : 'order.pending', { eta: this.clockOf(o.etaTick) });
      case 'en_route':
        if (v?.state === 'blocked') return t('order.blocked');
        if (v?.state === 'waiting') return t('order.waiting');
        return t('order.enRoute');
      case 'unloading': {
        const left = v ? Math.ceil(bagTotal(v.cargo)) : 0;
        return t(v?.state === 'pumping' ? 'order.pumping' : 'order.unloading', { left: formatNumber(left), haulers: v ? this.ctx.sim.agents.haulers(v.id) : 0 });
      }
      default:
        return t(`order.${o.status}`);
    }
  }

  private renderConvoys(): void {
    const orders = this.ctx.sim.supply.orders();
    const sig = orders.map((o) => `${o.id}:${this.statusText(o)}`).join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.body);
    if (orders.length === 0) {
      this.body.append(el('div', { class: 'logi-empty' }, [el('div', { text: t('logi.none') }), el('button', { class: 'btn primary', text: t('logi.tab.order'), onClick: () => this.show('order') })]));
      return;
    }
    const grid = el('div', { class: 'convoy-grid' });
    for (const o of orders) {
      const def = this.ctx.content.supplyOrder(o.orderId);
      const items = bagEntries(o.cargo).map(([r, n]) => `${formatNumber(n)} ${this.ctx.content.resource(r).short}`);
      const pax = o.passengers.reduce((s, p) => s + p.count, 0);
      if (pax) items.push(t('logi.paxShort', { n: pax }));
      const v = o.vehicleId ? this.ctx.state.vehicles[o.vehicleId] : undefined;
      const idx = o.status === 'leaving' ? 3 : STEPS.indexOf(o.status as (typeof STEPS)[number]);
      const steps = el(
        'div',
        { class: 'convoy-steps' },
        STEPS.map((s, i) => el('span', { class: `convoy-step${i < idx ? ' done' : i === idx ? ' current' : ''}`, text: t(`logi.stepName.${s}`) })),
      );
      const thumb = vehicleThumb(def.vehicle);
      grid.append(
        el('div', { class: `convoy-card status-${o.status}${o.ambushed ? ' ambushed' : ''}` }, [
          el('div', { class: 'convoy-head' }, [
            thumb ? el('img', { class: 'transport-thumb', attrs: { src: thumb, alt: '' } }) : el('span', { class: 'transport-thumb' }),
            el('div', {}, [el('div', { class: 'transport-name', text: def.name }), el('div', { class: 'res-sub', text: items.join(' · ') || '—' })]),
          ]),
          steps,
          el('div', { class: 'convoy-status', text: this.statusText(o) }),
          v
            ? el('button', {
                class: 'btn',
                text: t('logi.locate'),
                onClick: () => {
                  this.toggle(false);
                  this.ctx.bus.emit('ui:select', { target: { kind: 'vehicle', id: v.id } });
                  this.ctx.bus.emit('ui:focus', { pos: { x: v.pos.x, y: v.pos.y } });
                },
              })
            : '',
        ]),
      );
    }
    this.body.append(grid);
  }

  // ------------------------------------------------------------ Véhicules et équipement

  private renderVehicles(): void {
    const supply = this.ctx.sim.supply;
    const items = this.ctx.content.vehicleList.filter((v) => v.price !== undefined);
    const sig = items.map((v) => `${v.id}:${supply.canBuyVehicle(v.id)}:${supply.vehicles().filter((x) => x.defId === v.id).length}`).join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.body);
    const grid = el('div', { class: 'shop-grid' });
    for (const v of items) {
      const owned = supply.vehicles().filter((x) => x.defId === v.id).length;
      const reason = supply.canBuyVehicle(v.id);
      const why = reason === 'requires' ? t('supply.requires', { building: this.ctx.content.building(v.requires!).name }) : reason ? t(`supply.${reason}`) : '';
      const thumb = vehicleThumb(v.id);
      grid.append(
        el('div', { class: `shop-card${reason ? ' locked' : ''}` }, [
          thumb ? el('img', { class: 'shop-thumb', attrs: { src: thumb, alt: '' } }) : el('span', { class: 'shop-thumb' }),
          el('div', { class: 'transport-name', text: v.name }),
          el('div', { class: 'res-sub', text: v.desc ?? '' }),
          el('div', { class: 'shop-owned', text: t('logi.owned', { n: owned }) }),
          el('button', { class: 'btn primary', text: t('logi.buy', { price: formatNumber(v.price!) }), attrs: reason ? { disabled: '' } : {}, onClick: () => this.ctx.commands.push({ type: 'buyVehicle', defId: v.id }) }),
          why ? el('div', { class: 'receipt-reason', text: why }) : '',
        ]),
      );
    }
    this.body.append(grid);
  }

  private renderGear(): void {
    const supply = this.ctx.sim.supply;
    const items = this.ctx.content.equipment.items;
    const st = this.ctx.state.equipment;
    const sig = items.map((i) => `${i.id}:${st[i.id] ?? 0}:${supply.gearGiven(i.id)}:${supply.gearPendingCount(i.id)}:${supply.gearBlock(i.id, 5)}`).join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.body);
    this.body.append(el('div', { class: 'muted small logi-hint', text: t('logi.gearHint') }));
    const grid = el('div', { class: 'shop-grid' });
    for (const item of items) {
      const block = supply.gearBlock(item.id, 5);
      const stock = st[item.id] ?? 0;
      const given = supply.gearGiven(item.id);
      grid.append(
        el('div', { class: 'shop-card', title: item.desc }, [
          el('div', { class: 'transport-name', text: item.name }),
          el('div', { class: 'res-sub', text: item.desc }),
          el('div', { class: 'shop-owned', text: t('logi.gearLine', { stock, given, pending: supply.gearPendingCount(item.id) }) }),
          el('div', { class: 'shop-actions' }, [
            el('button', { class: 'btn primary', text: t('logi.gearBuy', { cost: formatNumber(item.price * 5) }), attrs: block ? { disabled: '' } : {}, onClick: () => this.ctx.commands.push({ type: 'buyGear', itemId: item.id, count: 5 }) }),
            el('button', { class: 'btn', text: t('logi.gearGive'), attrs: stock ? {} : { disabled: '' }, onClick: () => this.ctx.commands.push({ type: 'distributeGear', itemId: item.id }) }),
            el('button', { class: 'btn', text: t('logi.gearTake'), attrs: given || supply.gearPendingCount(item.id) ? {} : { disabled: '' }, onClick: () => this.ctx.commands.push({ type: 'recoverGear', itemId: item.id }) }),
          ]),
          block === 'requires' ? el('div', { class: 'receipt-reason', text: t('logi.gearNeedDepot') }) : '',
        ]),
      );
    }
    this.body.append(grid);
  }

  update(): void {
    if (!this.visible) return;
    const n = this.ctx.sim.supply.orders().filter((o) => o.status !== 'delivered' && o.status !== 'cancelled').length;
    setText(this.tabBtns.get('convoys')!, n > 0 ? `${t('logi.tab.convoys')} (${n})` : t('logi.tab.convoys'));
    if (this.tab === 'order') this.refresh();
    else if (this.tab === 'convoys') this.renderConvoys();
    else if (this.tab === 'vehicles') this.renderVehicles();
    else this.renderGear();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    document.body.classList.remove('logistics-open');
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
