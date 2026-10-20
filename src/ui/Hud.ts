/** Barre supérieure : ressources (avec projections), horloge, vitesses, menu système. */
import type { GameContext } from '../core/GameContext';
import type { GameSpeed, ResourceId } from '../core/GameState';
import { UNCAPPED } from '../systems/EconomySystem';
import { formatClock, formatNumber, formatSigned, t } from '../utils/i18n';
import { el, setText } from './dom';

export interface HudActions {
  save(): void;
  load(): void;
  menu(): void;
}

interface ResourceWidget {
  box: HTMLElement;
  value: HTMLElement;
  delta: HTMLElement;
  bar: HTMLElement;
}

const SPEED_LABELS: Record<GameSpeed, string> = { 0: '❚❚', 1: '▶', 2: '▶▶', 4: '▶▶▶', 8: '▶▶▶▶' };

export class Hud {
  private readonly root: HTMLElement;
  private readonly resources = new Map<ResourceId, ResourceWidget>();
  private readonly clock: HTMLElement;
  private readonly dayPhase: HTMLElement;
  private readonly population: HTMLElement;
  private readonly command: HTMLElement;
  private readonly stability: HTMLElement;
  private readonly points: HTMLElement;
  /** Bouton « Besoins » : signale un besoin de la base non couvert. */
  private readonly needsBtn: HTMLElement;
  private readonly speedButtons = new Map<GameSpeed, HTMLButtonElement>();

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
    actions: HudActions,
  ) {
    const resBar = el('div', { class: 'hud-resources' });
    for (const def of ctx.content.resources) {
      if (!def.hud) continue;
      const value = el('span', { class: 'res-value' });
      const delta = el('span', { class: 'res-delta' });
      const bar = el('span', { class: 'res-bar-fill' });
      const box = el('div', { class: 'res' }, [
        el('span', { class: 'res-label', text: def.short, attrs: { style: `color:${def.color}` } }),
        value,
        delta,
        el('span', { class: 'res-bar' }, [bar]),
      ]);
      this.resources.set(def.id, { box, value, delta, bar });
      resBar.append(box);
    }

    this.clock = el('span', { class: 'clock-time' });
    this.dayPhase = el('span', { class: 'clock-phase' });
    const speeds = el('div', { class: 'speeds' });
    for (const speed of ctx.content.balance.time.speeds) {
      const btn = el('button', {
        class: 'btn btn-speed',
        text: SPEED_LABELS[speed] ?? `x${speed}`,
        title: t(speed === 0 ? 'hud.pause' : 'hud.speed', { speed }),
        onClick: () => ctx.commands.push({ type: 'setSpeed', speed }),
      });
      this.speedButtons.set(speed, btn);
      speeds.append(btn);
    }

    this.needsBtn = el('button', { class: 'btn', text: t('hud.needs'), title: t('hud.needsHint'), onClick: () => ctx.bus.emit('ui:toggleNeeds', {}) });
    this.population = el('div', { class: 'hud-pop' });
    this.command = el('div', { class: 'hud-pop' });
    this.stability = el('div', { class: 'hud-pop hud-stability', onClick: () => ctx.bus.emit('ui:toggleCampaign', {}) });
    this.points = el('div', { class: 'hud-pop hud-points', title: t('hud.pointsHint') });
    const system = el('div', { class: 'hud-system' }, [
      el('button', { class: 'btn', text: t('hud.logistics'), title: t('hud.logisticsHint'), onClick: () => ctx.bus.emit('ui:toggleLogistics', {}) }),
      el('button', { class: 'btn', text: t('hud.personnel'), title: t('hud.personnelHint'), onClick: () => ctx.bus.emit('ui:toggleRoster', {}) }),
      this.needsBtn,
      el('button', { class: 'btn', text: t('hud.map'), title: t('hud.mapHint'), onClick: () => ctx.bus.emit('ui:toggleMap', {}) }),
      el('button', { class: 'btn', text: t('hud.ops'), title: t('hud.opsHint'), onClick: () => ctx.bus.emit('ui:toggleOps', {}) }),
      el('button', { class: 'btn', text: t('hud.campaign'), title: t('hud.campaignHint'), onClick: () => ctx.bus.emit('ui:toggleCampaign', {}) }),
      el('button', { class: 'btn', text: t('hud.options'), onClick: () => ctx.bus.emit('ui:openOptions', {}) }),
      el('button', { class: 'btn', text: t('hud.save'), onClick: () => actions.save() }),
      el('button', { class: 'btn', text: t('hud.load'), onClick: () => actions.load() }),
      el('button', { class: 'btn', text: t('hud.menu'), onClick: () => actions.menu() }),
    ]);

    this.root = el('div', { class: 'panel hud-top' }, [
      resBar,
      el('div', { class: 'hud-status' }, [this.population, this.command, el('div', { class: 'hud-row' }, [this.stability, this.points])]),
      el('div', { class: 'hud-clock' }, [this.clock, this.dayPhase, speeds]),
      system,
    ]);
    parent.append(this.root);
    this.update();
  }

  update(): void {
    // La barre peut passer sur deux lignes : les autres panneaux se placent sous elle.
    const height = `${this.root.offsetHeight}px`;
    if (document.documentElement.style.getPropertyValue('--hud-h') !== height) {
      document.documentElement.style.setProperty('--hud-h', height);
    }
    const { state, content } = this.ctx;
    // Un besoin de la base non couvert fait clignoter le bouton « Besoins »
    const shortNeeds = this.ctx.sim.requirements.status().filter((r) => r.state === 'short').length;
    this.needsBtn.classList.toggle('attention', shortNeeds > 0);
    const needsText = shortNeeds > 0 ? `${t('hud.needs')} (${shortNeeds})` : t('hud.needs');
    if (this.needsBtn.textContent !== needsText) this.needsBtn.textContent = needsText;
    const projections = this.ctx.sim.economy.projections();
    const lowDays = content.balance.economy.lowStockDays;

    for (const [id, w] of this.resources) {
      if (id === 'power') {
        // L'électricité est un flux : production / demande
        const { supply, demand } = state.resources.power;
        setText(w.value, `${supply}/${demand}`);
        setText(w.delta, '');
        w.bar.style.width = demand > 0 ? `${Math.min(100, (supply / demand) * 100)}%` : '100%';
        const short = demand > 0 && supply < demand;
        w.box.classList.toggle('short', short);
        const title = t('hud.powerHint', { supply, demand });
        if (w.box.title !== title) w.box.title = title;
        continue;
      }
      const stock = state.resources.stock[id];
      const cap = state.resources.capacity[id];
      const p = projections[id];
      const capped = cap !== UNCAPPED;
      setText(w.value, formatNumber(stock));
      setText(w.delta, p.perDay !== 0 ? `${formatSigned(p.perDay)}${t('hud.perDay')}` : '');
      w.delta.className = 'res-delta ' + (p.perDay > 0 ? 'pos' : p.perDay < 0 ? 'neg' : '');
      w.bar.style.width = capped && cap > 0 ? `${Math.min(100, (stock / cap) * 100)}%` : '0';
      w.bar.parentElement!.style.display = capped ? '' : 'none';

      const short = state.resources.shortages.includes(id);
      const low = p.daysLeft !== null && p.daysLeft < lowDays;
      w.box.classList.toggle('short', short);
      w.box.classList.toggle('low', !short && low);

      const lines = [content.resource(id).name, `${t('hud.stock')} : ${formatNumber(stock)}${capped ? ` / ${formatNumber(cap)}` : ''}`];
      lines.push(`${t('hud.flow')} : ${formatSigned(p.perDay)}${t('hud.perDay')}`);
      if (p.daysLeft !== null) lines.push(t('hud.daysLeft', { days: p.daysLeft.toFixed(1) }));
      const title = lines.join('\n');
      if (w.box.title !== title) w.box.title = title;
    }

    const agents = Object.values(state.agents);
    const beds = this.ctx.sim.agents.beds();
    const morale = agents.length ? agents.reduce((sum, a) => sum + a.needs.morale, 0) / agents.length : 0;
    setText(this.population, t('hud.population', { count: agents.length, beds: beds.total, morale: Math.round(morale) }));
    this.population.classList.toggle('warn', beds.total < agents.length);
    const popTitle = t('hud.populationHint', { count: agents.length, beds: beds.total, homeless: agents.length - beds.assigned, morale: Math.round(morale) });
    if (this.population.title !== popTitle) this.population.title = popTitle;

    const rating = state.progression.lastRating;
    setText(this.command, t('hud.command', { rep: Math.round(state.progression.reputation), rating: rating === null ? '—' : `${Math.round(rating * 100)} %` }));
    const ev = this.ctx.sim.economy.evaluate();
    const cmdTitle = t('hud.commandHint', {
      rep: Math.round(state.progression.reputation),
      morale: Math.round(ev.morale * 100),
      housing: Math.round(ev.housing * 100),
      guard: Math.round(ev.guard * 100),
      supply: Math.round(ev.supply * 100),
      rating: Math.round(ev.rating * 100),
      budget: formatNumber(this.ctx.sim.economy.dailyBudget(ev.rating)),
    });
    if (this.command.title !== cmdTitle) this.command.title = cmdTitle;

    setText(this.points, t('hud.points', { pts: state.progression.points }));
    const dip = this.ctx.sim.diplomacy;
    const trend = dip.stabilityTrend();
    setText(this.stability, t('hud.stability', { value: state.region.stability, trend: trend > 0 ? '▲' : trend < 0 ? '▼' : '' }));
    const low = state.region.stability < this.ctx.content.campaign.defeat.warnBelow;
    this.stability.classList.toggle('warn', low);
    const phase = dip.currentPhase();
    const stabTitle = t('hud.stabilityHint', {
      value: state.region.stability,
      phase: phase.name,
      days: Math.max(0, dip.daysLeft()).toFixed(1),
      bmult: dip.budgetMult().toFixed(2),
      threat: dip.threatMult().toFixed(2),
      road: dip.roadRiskMult().toFixed(2),
    });
    if (this.stability.title !== stabTitle) this.stability.title = stabTitle;

    const time = state.time;
    setText(this.clock, t('hud.clock', { day: time.day, time: formatClock(time.minuteOfDay) }));
    const hour = time.minuteOfDay / 60;
    setText(this.dayPhase, t(hour < 5 || hour >= 21 ? 'hud.night' : hour < 7 ? 'hud.dawn' : hour < 19 ? 'hud.day' : 'hud.dusk'));
    for (const [speed, btn] of this.speedButtons) btn.classList.toggle('active', speed === time.speed);
  }

  destroy(): void {
    this.root.remove();
  }
}
