/**
 * Panneau logistique (touche L) : suivi des commandes en cours, passage de nouvelles commandes
 * (cargaison, renforts, coût, délai, risque) et achat d'équipement (chariots élévateurs).
 */
import type { SupplyOrderDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { SupplyRejection } from '../core/GameEvents';
import type { PassengerRequest, ResourceBag, ResourceId, SupplyOrder } from '../core/GameState';
import { bagEntries } from '../core/resources';
import { bagTotal } from '../systems/SupplySystem';
import { formatClock, formatNumber, t } from '../utils/i18n';
import { clear, el, setText } from './dom';

export class LogisticsPanel {
  private readonly root: HTMLElement;
  private readonly ordersList: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly form: HTMLElement;
  private readonly equipment: HTMLElement;
  private readonly gear: HTMLElement;
  private gearSignature = '';
  private visible = false;
  private selected: string;
  private cargo: ResourceBag = {};
  private passengers = new Map<string, number>();
  private vehicles = new Map<string, number>();
  private ordersSignature = '';
  private equipmentSignature = '';
  // Éléments dynamiques du formulaire
  private summary!: HTMLElement;
  private submit!: HTMLButtonElement;
  private reason!: HTMLElement;
  private readonly qtyLabels = new Map<string, HTMLElement>();
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.selected = ctx.content.supply.orders[0].id;
    this.ordersList = el('div', { class: 'orders-list' });
    this.tabs = el('div', { class: 'tabs' });
    this.form = el('div', { class: 'order-form' });
    this.equipment = el('div', { class: 'equipment' });
    this.gear = el('div', { class: 'equipment' });
    this.root = el('div', { class: 'panel logistics-panel hidden' }, [
      el('div', { class: 'panel-title' }, [t('logi.title'), el('button', { class: 'btn close', text: '×', onClick: () => this.toggle(false) })]),
      el('div', { class: 'section-title', text: t('logi.current') }),
      this.ordersList,
      el('div', { class: 'section-title', text: t('logi.new') }),
      this.tabs,
      this.form,
      el('div', { class: 'section-title', text: t('logi.equipment') }),
      this.equipment,
      el('div', { class: 'section-title', text: t('logi.gear') }),
      el('div', { class: 'muted small', text: t('logi.gearHint') }),
      this.gear,
    ]);
    parent.append(this.root);
    for (const def of ctx.content.supply.orders) {
      this.tabs.append(el('button', { class: 'btn tab', text: def.name, attrs: { 'data-id': def.id }, onClick: () => this.select(def.id) }));
    }
    this.select(this.selected);
    this.unsubs.push(ctx.bus.on('ui:toggleLogistics', () => this.toggle()));
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    if (this.visible) this.select(this.selected); // renforts débloqués entre-temps
    this.ordersSignature = '';
    this.equipmentSignature = '';
    this.update();
  }

  // ------------------------------------------------------------ Formulaire

  private select(id: string): void {
    this.selected = id;
    this.cargo = {};
    this.passengers.clear();
    this.vehicles.clear();
    for (const b of this.tabs.querySelectorAll('button')) b.classList.toggle('active', b.getAttribute('data-id') === id);
    this.buildForm(this.ctx.content.supplyOrder(id));
    this.refreshForm();
  }

  private stepper(key: string, label: string, sub: string, onChange: (delta: number) => void, locked = false): HTMLElement {
    const qty = el('span', { class: 'qty' });
    this.qtyLabels.set(key, qty);
    return el('div', { class: 'stepper-row' + (locked ? ' locked' : '') }, [
      el('span', { class: 'stepper-label', text: label }),
      el('span', { class: 'muted small', text: sub }),
      el('button', { class: 'btn step', text: '−', onClick: () => onChange(-1), attrs: locked ? { disabled: '' } : {} }),
      qty,
      el('button', { class: 'btn step', text: '+', onClick: () => onChange(1), attrs: locked ? { disabled: '' } : {} }),
    ]);
  }

  private buildForm(def: SupplyOrderDef): void {
    const content = this.ctx.content;
    const supply = content.supply;
    clear(this.form);
    this.qtyLabels.clear();
    this.form.append(el('p', { class: 'desc', text: def.desc }));

    if (def.cargo) {
      const step = supply.cargoStep;
      for (const r of def.cargo) {
        const res = content.resource(r);
        const price = supply.unitPrices[r] ?? 0;
        this.form.append(
          this.stepper(`cargo.${r}`, res.name, t('logi.unitPrice', { price: formatNumber(price), step }), (d) => {
            this.cargo[r] = Math.max(0, (this.cargo[r] ?? 0) + d * step);
            this.refreshForm();
          }),
        );
      }
    } else if (def.fixed) {
      const items = bagEntries(def.fixed).map(([r, v]) => `${formatNumber(v)} ${content.resource(r).name.toLowerCase()}`);
      this.form.append(el('div', { class: 'fixed-cargo', text: t('logi.fixed', { items: items.join(', '), price: formatNumber(def.fixedPrice ?? 0) }) }));
    }

    if (def.passengers) {
      this.form.append(el('div', { class: 'muted small sub-title', text: t('logi.recruits') }));
      for (const r of supply.recruits) {
        const block = this.ctx.sim.supply.recruitBlock(r.type);
        const locked = block !== null;
        const sub =
          block === 'level'
            ? t('logi.locked', { rep: r.reputation })
            : block === 'requires'
              ? t('logi.requiresPersonnel', { name: content.personnel(r.requires!).name })
              : block === 'max'
                ? t('logi.maxReached')
                : `$${formatNumber(r.price)}`;
        this.form.append(
          this.stepper(`pax.${r.type}`, content.personnel(r.type).name, sub, (d) => {
            this.passengers.set(r.type, Math.max(0, (this.passengers.get(r.type) ?? 0) + d));
            this.refreshForm();
          }, locked),
        );
      }
    }
    if (def.vehicles) {
      this.form.append(el('div', { class: 'muted small sub-title', text: t('logi.vehicles') }));
      for (const v of content.vehicleList.filter((x) => x.price !== undefined && x.kind === 'base')) {
        this.form.append(
          this.stepper(`veh.${v.id}`, v.name, `$${formatNumber(v.price!)}`, (d) => {
            this.vehicles.set(v.id, Math.max(0, (this.vehicles.get(v.id) ?? 0) + d));
            this.refreshForm();
          }),
        );
      }
    }
    this.summary = el('div', { class: 'order-summary' });
    this.reason = el('div', { class: 'warn small' });
    this.submit = el('button', {
      class: 'btn wide primary',
      text: t('logi.submit'),
      onClick: () => {
        this.ctx.commands.push({ type: 'orderSupply', orderId: this.selected, cargo: { ...this.cargo }, passengers: this.paxList(), vehicles: this.vehList() });
        this.select(this.selected); // remise à zéro du formulaire
      },
    });
    this.form.append(this.summary, this.reason, this.submit);
  }

  private vehList(): string[] {
    const out: string[] = [];
    for (const [id, n] of this.vehicles) for (let i = 0; i < n; i++) out.push(id);
    return out;
  }

  private paxList(): PassengerRequest[] {
    return [...this.passengers].filter(([, n]) => n > 0).map(([type, count]) => ({ type, count }));
  }

  private refreshForm(): void {
    const content = this.ctx.content;
    const def = content.supplyOrder(this.selected);
    const vdef = content.vehicle(def.vehicle);
    for (const [key, label] of this.qtyLabels) {
      const [kind, id] = key.split('.');
      setText(label, String(kind === 'cargo' ? (this.cargo[id as ResourceId] ?? 0) : kind === 'veh' ? (this.vehicles.get(id) ?? 0) : (this.passengers.get(id) ?? 0)));
    }
    const pax = this.paxList();
    const vehs = this.vehList();
    const cost = this.ctx.sim.supply.orderCost(def, this.cargo, pax, vehs);
    const site = this.ctx.site;
    const risk = def.risk * (vdef.kind === 'road' ? site.roadRisk : 1);
    const parts = [
      t('logi.cost', { cost: formatNumber(cost) }),
      t('logi.delay', { min: def.delayHours[0], max: def.delayHours[1] }),
      t('logi.risk', { risk: Math.round(risk * 100) }),
    ];
    if (def.cargo) parts.unshift(t('logi.load', { n: bagTotal(this.cargo), max: vdef.capacity ?? 0 }));
    if (def.passengers) parts.push(t('logi.pax', { n: pax.reduce((s, p) => s + p.count, 0), max: vdef.passengers ?? 0 }));
    if (def.vehicles) parts.push(t('logi.veh', { n: vehs.length, max: vdef.vehicleSlots ?? 0 }));
    setText(this.summary, parts.join(' · '));
    const reason = this.ctx.sim.supply.check(this.selected, this.cargo, pax, vehs);
    this.submit.disabled = reason !== null;
    setText(this.reason, reason ? this.reasonText(reason, def) : '');
  }

  private reasonText(reason: SupplyRejection, def: SupplyOrderDef): string {
    if (reason === 'requires') return t('supply.requires', { building: this.ctx.content.building(def.requires).name });
    return t(`supply.${reason}`);
  }

  // ------------------------------------------------------------ Suivi

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

  private renderOrders(): void {
    const orders = this.ctx.sim.supply.orders().slice(0, 6);
    const signature = orders.map((o) => `${o.id}:${this.statusText(o)}`).join('|');
    if (signature === this.ordersSignature) return;
    this.ordersSignature = signature;
    clear(this.ordersList);
    if (orders.length === 0) {
      this.ordersList.append(el('div', { class: 'muted small', text: t('logi.none') }));
      return;
    }
    for (const o of orders) {
      const def = this.ctx.content.supplyOrder(o.orderId);
      const items = bagEntries(o.cargo).map(([r, n]) => `${formatNumber(n)} ${this.ctx.content.resource(r).short}`);
      const pax = o.passengers.reduce((s, p) => s + p.count, 0);
      if (pax) items.push(t('logi.paxShort', { n: pax }));
      const v = o.vehicleId ? this.ctx.state.vehicles[o.vehicleId] : undefined;
      this.ordersList.append(
        el(
          'div',
          {
            class: `order-row status-${o.status}`,
            onClick: v
              ? () => {
                  this.ctx.bus.emit('ui:select', { target: { kind: 'vehicle', id: v.id } });
                  this.ctx.bus.emit('ui:focus', { pos: { x: v.pos.x, y: v.pos.y } });
                }
              : undefined,
          },
          [el('div', { class: 'order-name', text: def.name }), el('div', { class: 'muted small', text: items.join(' · ') }), el('div', { class: 'order-status', text: this.statusText(o) })],
        ),
      );
    }
  }

  private renderGear(): void {
    const supply = this.ctx.sim.supply;
    const items = this.ctx.content.equipment.items;
    const st = this.ctx.state.equipment;
    const sig = items.map((i) => `${i.id}:${st[i.id] ?? 0}:${supply.gearGiven(i.id)}:${supply.gearPendingCount(i.id)}:${supply.gearBlock(i.id, 5)}`).join('|');
    if (sig === this.gearSignature) return;
    this.gearSignature = sig;
    clear(this.gear);
    for (const item of items) {
      const block = supply.gearBlock(item.id, 5);
      const stock = st[item.id] ?? 0;
      const given = supply.gearGiven(item.id);
      this.gear.append(
        el('div', { class: 'equip-row', title: item.desc }, [
          el('div', {}, [
            el('div', { class: 'order-name', text: item.name }),
            el('div', { class: 'muted small', text: item.desc }),
            el('div', { class: 'small', text: t('logi.gearLine', { stock, given, pending: supply.gearPendingCount(item.id) }) }),
          ]),
          el('div', { class: 'equip-actions' }, [
            el('button', {
              class: 'btn',
              text: t('logi.gearBuy', { cost: formatNumber(item.price * 5) }),
              attrs: block ? { disabled: '' } : {},
              title: block === 'requires' ? t('logi.gearNeedDepot') : '',
              onClick: () => this.ctx.commands.push({ type: 'buyGear', itemId: item.id, count: 5 }),
            }),
            el('button', { class: 'btn', text: t('logi.gearGive'), attrs: stock ? {} : { disabled: '' }, onClick: () => this.ctx.commands.push({ type: 'distributeGear', itemId: item.id }) }),
            el('button', { class: 'btn', text: t('logi.gearTake'), attrs: given || supply.gearPendingCount(item.id) ? {} : { disabled: '' }, onClick: () => this.ctx.commands.push({ type: 'recoverGear', itemId: item.id }) }),
            block === 'requires' ? el('div', { class: 'warn small', text: t('logi.gearNeedDepot') }) : '',
          ]),
        ]),
      );
    }
  }

  private renderEquipment(): void {
    const supply = this.ctx.sim.supply;
    const items = this.ctx.content.vehicleList.filter((v) => v.price !== undefined);
    const signature = items.map((v) => `${v.id}:${supply.canBuyVehicle(v.id)}:${supply.vehicles().filter((x) => x.defId === v.id).length}`).join('|');
    if (signature === this.equipmentSignature) return;
    this.equipmentSignature = signature;
    clear(this.equipment);
    for (const v of items) {
      const owned = supply.vehicles().filter((x) => x.defId === v.id).length;
      const reason = supply.canBuyVehicle(v.id);
      const why =
        reason === 'requires' ? t('supply.requires', { building: this.ctx.content.building(v.requires!).name }) : reason ? t(`supply.${reason}`) : '';
      this.equipment.append(
        el('div', { class: 'equip-row', title: v.desc }, [
          el('div', {}, [el('div', { class: 'order-name', text: `${v.name} (${owned})` }), el('div', { class: 'muted small', text: v.desc ?? '' })]),
          el('div', { class: 'equip-actions' }, [
            el('button', {
              class: 'btn',
              text: t('logi.buy', { price: formatNumber(v.price!) }),
              attrs: reason ? { disabled: '' } : {},
              onClick: () => this.ctx.commands.push({ type: 'buyVehicle', defId: v.id }),
            }),
            el('div', { class: 'warn small', text: why }),
          ]),
        ]),
      );
    }
  }

  update(): void {
    if (!this.visible) return;
    this.renderOrders();
    this.renderEquipment();
    this.renderGear();
    this.refreshForm();
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
