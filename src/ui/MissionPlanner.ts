/**
 * Planification d'une mission : type, personnel (par groupe ou à l'unité), véhicules blindés,
 * dotation ; estimation de la chance de succès (fourchette selon la fiabilité du renseignement),
 * durées, coûts. « Lancer la mission » envoie la commande à la simulation.
 */
import type { MissionTypeDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { Agent, MissionTarget } from '../core/GameState';
import { bagEntries } from '../core/resources';
import { gridRef } from '../render/regionMap';
import type { MissionPlan } from '../systems/MissionSystem';
import { formatNumber, t } from '../utils/i18n';
import { clear, el, setText } from './dom';

export class MissionPlanner {
  private readonly backdrop: HTMLElement;
  private readonly body: HTMLElement;
  private target: MissionTarget | null = null;
  private typeId = '';
  private members = new Set<string>();
  private vehicles = 0;
  /** Type d'hélicoptère de transport choisi (null : pas d'héliportage). */
  private helo: string | null = null;
  private heloBox!: HTMLElement;
  private loadout = 'standard';
  private support = 'none';
  private supportBox!: HTMLElement;
  private summary!: HTMLElement;
  private reason!: HTMLElement;
  private launchBtn!: HTMLButtonElement;
  private vehicleLabel!: HTMLElement;
  private memberCount!: HTMLElement;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.body = el('div', { class: 'panel modal planner' });
    this.backdrop = el('div', { class: 'modal-backdrop hidden' }, [this.body]);
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    parent.append(this.backdrop);
    this.unsubs.push(
      ctx.bus.on('ui:planMission', ({ target }) => {
        const tgt = ctx.sim.missions.targetFrom(target);
        if (tgt) this.open(tgt);
      }),
      ctx.bus.on('mission:launched', () => this.close()),
    );
  }

  open(target: MissionTarget): void {
    this.target = target;
    const types = this.ctx.sim.missions.typesFor(target);
    this.typeId = types[0]?.id ?? '';
    this.members.clear();
    this.vehicles = 0;
    this.helo = null;
    this.loadout = 'standard';
    this.support = 'none';
    this.render();
    this.backdrop.classList.remove('hidden');
  }

  close(): void {
    this.backdrop.classList.add('hidden');
    this.target = null;
  }

  private plan(): MissionPlan | null {
    if (!this.target || !this.typeId) return null;
    const heli = this.helo ? this.ctx.sim.missions.freeHeli(this.helo) : null;
    const vehicleIds = heli ? [] : this.ctx.sim.missions.availableVehicles().slice(0, this.vehicles).map((v) => v.id);
    return { typeId: this.typeId, target: this.target, memberIds: [...this.members], vehicleIds, loadout: this.loadout, support: this.support, heliId: heli?.id };
  }

  private agentLine(a: Agent, def: MissionTypeDef): HTMLElement {
    const box = el('input', { attrs: { type: 'checkbox' } });
    box.checked = this.members.has(a.id);
    box.addEventListener('change', () => {
      if (box.checked) this.members.add(a.id);
      else this.members.delete(a.id);
      this.refresh();
    });
    // Compétence principale pour cette mission
    const main = Object.entries(def.skills).sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'shooting';
    return el('label', { class: 'planner-agent' }, [
      box,
      el('span', { class: 'pa-name', text: `${a.rank} ${a.lastName}` }),
      el('span', { class: 'muted small', text: this.ctx.content.personnel(a.defId).name }),
      el('span', { class: 'small', text: `${this.ctx.content.skillName(main)} ${a.skills[main] ?? 0}` }),
      el('span', { class: `small ${a.health < 70 ? 'warn' : 'muted'}`, text: `♥${Math.round(a.health)}` }),
    ]);
  }

  private render(): void {
    clear(this.body);
    const target = this.target;
    if (!target) return;
    const missions = this.ctx.sim.missions;
    const types = missions.typesFor(target);
    const def = this.ctx.content.missionType(this.typeId);
    const region = this.ctx.content.region;

    const tabs = el('div', { class: 'tabs planner-tabs' });
    for (const d of types) {
      tabs.append(
        el('button', {
          class: `btn tab${d.id === this.typeId ? ' active' : ''}`,
          text: d.name,
          onClick: () => {
            this.typeId = d.id;
            this.render();
          },
        }),
      );
    }

    // Personnel disponible, par groupe
    const agents = missions.availableAgents();
    const list = el('div', { class: 'planner-list' });
    const groups = [...Object.values(this.ctx.state.groups), { id: '', name: t('agent.noGroup'), memberIds: agents.filter((a) => !a.groupId).map((a) => a.id) }];
    for (const g of groups) {
      const avail = agents.filter((a) => g.memberIds.includes(a.id));
      if (!avail.length) continue;
      list.append(
        el('div', { class: 'planner-group' }, [
          el('span', { text: `${g.name} (${avail.length})` }),
          el('button', {
            class: 'btn small-btn',
            text: t('planner.wholeGroup'),
            onClick: () => {
              for (const a of avail) this.members.add(a.id);
              this.render();
            },
          }),
        ]),
      );
      for (const a of avail) list.append(this.agentLine(a, def));
    }
    if (!agents.length) list.append(el('div', { class: 'muted', text: t('planner.noAgents') }));

    // Véhicules et dotation
    this.vehicleLabel = el('span', { class: 'qty' });
    const maxV = missions.availableVehicles().length;
    const vehicles = el('div', { class: 'stepper-row' }, [
      el('span', { class: 'stepper-label', text: t('planner.vehicles') }),
      el('span', { class: 'muted small', text: t('planner.vehiclesAvail', { n: maxV }) }),
      el('button', { class: 'btn step', text: '−', onClick: () => this.setVehicles(this.vehicles - 1) }),
      this.vehicleLabel,
      el('button', { class: 'btn step', text: '+', onClick: () => this.setVehicles(this.vehicles + 1) }),
    ]);
    const loadouts = el('div', { class: 'planner-loadouts' });
    for (const l of this.ctx.content.missions.loadouts) {
      const radio = el('input', { attrs: { type: 'radio', name: 'loadout' } });
      radio.checked = l.id === this.loadout;
      radio.addEventListener('change', () => {
        this.loadout = l.id;
        this.refresh();
      });
      const cost = bagEntries(l.consumes).map(([r, v]) => `${v} ${this.ctx.content.resource(r).short}`).join(', ');
      loadouts.append(el('label', { class: 'map-layer', title: l.desc }, [radio, `${l.name} (${cost})`]));
    }

    this.supportBox = el('div', { class: 'planner-loadouts' });

    this.memberCount = el('span', { class: 'muted small' });
    this.summary = el('div', { class: 'order-summary' });
    this.reason = el('div', { class: 'warn small' });
    this.launchBtn = el('button', {
      class: 'btn wide primary',
      text: t('planner.launch'),
      onClick: () => {
        const plan = this.plan();
        if (plan) this.ctx.commands.push({ type: 'launchMission', ...plan });
      },
    });

    this.body.append(
      el('div', { class: 'panel-title' }, [
        t('planner.title', { target: target.name, grid: gridRef(region, target.pos.x, target.pos.y) }),
        el('button', { class: 'btn close', text: '×', onClick: () => this.close() }),
      ]),
      types.length ? tabs : el('p', { class: 'warn', text: t('planner.noType') }),
      el('p', { class: 'desc', text: def?.desc ?? '' }),
      el('div', { class: 'section-title' }, [t('planner.personnel'), ' ', this.memberCount]),
      list,
      el('div', { class: 'section-title', text: t('planner.equipment') }),
      vehicles,
      (this.heloBox = el('div', { class: 'planner-loadouts' })),
      loadouts,
      el('div', { class: 'section-title', text: t('planner.support') }),
      this.supportBox,
      this.summary,
      this.reason,
      this.launchBtn,
    );
    this.refresh();
  }

  /** Options d'appui feu, grisées avec leur raison si indisponibles. */
  private renderSupport(): void {
    if (!this.target) return;
    const missions = this.ctx.sim.missions;
    const sig = this.ctx.content.missions.support.map((s) => `${s.id}:${missions.supportBlock(s.id, this.target!)}:${this.support}`).join('|');
    if (this.supportBox.dataset.sig === sig) return;
    this.supportBox.dataset.sig = sig;
    this.supportBox.replaceChildren();
    for (const s of this.ctx.content.missions.support) {
      const block = missions.supportBlock(s.id, this.target);
      if (block && this.support === s.id) this.support = 'none';
      const radio = el('input', { attrs: { type: 'radio', name: 'support' } });
      radio.checked = this.support === s.id;
      if (block) radio.disabled = true;
      radio.addEventListener('change', () => {
        this.support = s.id;
        this.supportBox.dataset.sig = '';
        this.refresh();
      });
      const cost = bagEntries(s.cost).map(([r, v]) => `${formatNumber(v)} ${this.ctx.content.resource(r).short}`).join(', ');
      let why = '';
      if (block === 'requires') why = t('planner.supportBlock.requires', { building: this.ctx.content.building(s.requires!).name });
      else if (block === 'range') why = t('planner.supportBlock.range', { km: s.rangeKm ?? 0 });
      else if (block === 'cooldown') why = t('planner.supportBlock.cooldown', { h: missions.supportCooldownHours(s) });
      else if (block === 'hours') why = t('planner.supportBlock.hours', { from: s.hours![0], to: s.hours![1] });
      else if (block === 'resources') why = t('planner.supportBlock.resources');
      else if (block === 'vehicle') why = t('planner.supportBlock.vehicle', { name: this.ctx.content.vehicle(s.vehicle!).name.toLowerCase() });
      this.supportBox.append(
        el('label', { class: `map-layer${block ? ' disabled' : ''}`, title: s.desc }, [
          radio,
          `${s.name}${cost ? ` (${cost})` : ''}`,
          why ? el('span', { class: 'muted small', text: ` — ${why}` }) : '',
        ]),
      );
    }
  }

  /** Héliportage : choix parmi les hélicoptères de transport disponibles (Black Hawk, Little Bird…). */
  private renderHelo(): void {
    const missions = this.ctx.sim.missions;
    const types = this.ctx.content.vehicleList.filter((v) => v.kind === 'air' && v.role === 'transport' && missions.freeHeli(v.id));
    if (this.helo && !types.some((v) => v.id === this.helo)) this.helo = null;
    const sig = `${types.map((v) => v.id).join(',')}:${this.helo}`;
    if (this.heloBox.dataset.sig === sig) return;
    this.heloBox.dataset.sig = sig;
    this.heloBox.replaceChildren();
    if (types.length === 0) {
      this.heloBox.append(el('div', { class: 'muted small', text: t('planner.heloNone') }));
      return;
    }
    const option = (id: string | null, label: string, title = ''): HTMLElement => {
      const radio = el('input', { attrs: { type: 'radio', name: 'planner-helo' } }) as HTMLInputElement;
      radio.checked = this.helo === id;
      radio.addEventListener('change', () => {
        this.helo = id;
        if (id) this.vehicles = 0;
        this.heloBox.dataset.sig = '';
        this.refresh();
      });
      return el('label', { class: 'map-layer', title }, [radio, label]);
    };
    this.heloBox.append(option(null, t('planner.heloOff')));
    for (const def of types) this.heloBox.append(option(def.id, t('planner.helo', { name: def.name, n: def.passengers ?? 0 }), def.desc));
  }

  private setVehicles(n: number): void {
    if (this.helo && n > 0) return;
    this.vehicles = Math.max(0, Math.min(this.ctx.sim.missions.availableVehicles().length, n));
    this.refresh();
  }

  private refresh(): void {
    this.renderSupport();
    this.renderHelo();
    const plan = this.plan();
    if (!plan) return;
    const missions = this.ctx.sim.missions;
    const def = this.ctx.content.missionType(plan.typeId);
    setText(this.vehicleLabel, String(this.vehicles));
    setText(this.memberCount, t('planner.count', { n: plan.memberIds.length, min: def.minMembers, max: def.maxMembers }));
    const est = missions.estimate(plan);
    const costs = bagEntries(est.costs).map(([r, v]) => `${formatNumber(v)} ${this.ctx.content.resource(r).short}`).join(', ');
    const pct = (x: number): number => Math.round(x * 100);
    const risk = def.risk >= 0.15 ? t('planner.riskHigh') : def.risk >= 0.08 ? t('planner.riskMid') : t('planner.riskLow');
    setText(
      this.summary,
      [
        t('planner.chance', { chance: pct(est.chance), low: pct(est.low), high: pct(est.high) }),
        t('planner.distance', { km: est.distanceKm.toFixed(1), mode: t(est.heli ? 'planner.heloMode' : est.motorized ? 'planner.motorized' : 'planner.onFoot') }),
        t('planner.duration', { h: (est.travelHours * 2 + est.objectiveHours).toFixed(1) }),
        t('planner.risk', { risk }),
        t('planner.costs', { costs: costs || '—' }),
      ].join(' · ') +
        '\n' +
        [
          t(est.toc.mod < 0 ? 'planner.tocLow' : 'planner.toc', { n: est.toc.present, req: est.toc.required }),
          t('planner.comms', {
            state: est.comms.global ? t('planner.commsSat') : est.comms.penalty > 0 ? t('planner.commsWeak', { pct: Math.round(est.comms.penalty * 100) }) : t('planner.commsGood'),
          }),
          est.gear.length ? t('planner.gear', { items: est.gear.map((g) => `${g.short} ${g.n}/${plan.memberIds.length}`).join(', ') }) : '',
          est.night ? t('planner.night') : '',
          est.stealth > 0 ? t('planner.stealth', { pct: Math.round(est.stealth * 100) }) : '',
          est.fragile ? t('planner.fragile') : '',
        ]
          .filter(Boolean)
          .join(' · '),
    );
    this.summary.classList.toggle('toc-low', est.toc.mod < 0);
    const block = missions.check(plan);
    this.launchBtn.disabled = block !== null;
    let reason = block ? t(`planner.block.${block}`) : '';
    if (block === 'requires') reason = def.requires?.sf ? t('planner.needSf', { n: def.requires.sf }) : t('planner.needOfficer');
    setText(this.reason, reason);
  }

  update(): void {
    if (this.target && !this.backdrop.classList.contains('hidden')) this.refresh();
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.backdrop.remove();
  }
}
