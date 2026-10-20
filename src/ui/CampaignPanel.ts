/**
 * Panneau de campagne (touche C) : phase en cours et objectifs, stabilité régionale
 * (courbe, composantes, effets sur le budget, les attaques et les routes), situation des villages.
 * Affiche aussi les annonces de campagne (briefing, phase atteinte, délai dépassé, victoire, relève).
 */
import type { GameContext } from '../core/GameContext';
import { formatNumber, t } from '../utils/i18n';
import { clear, el } from './dom';

export class CampaignPanel {
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;
  private readonly noticeBackdrop: HTMLElement;
  private readonly noticeBody: HTMLElement;
  private visible = false;
  private sig = '';
  private noticeSig = '';
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.content = el('div');
    this.root = el('div', { class: 'panel campaign-panel hidden' }, [
      el('div', { class: 'panel-title' }, [t('campaign.title'), el('button', { class: 'btn close', text: '×', onClick: () => this.toggle(false) })]),
      this.content,
    ]);
    this.noticeBody = el('div', { class: 'panel modal campaign-notice' });
    this.noticeBackdrop = el('div', { class: 'modal-backdrop hidden' }, [this.noticeBody]);
    parent.append(this.root, this.noticeBackdrop);
    this.unsubs.push(ctx.bus.on('ui:toggleCampaign', () => this.toggle()));
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    this.sig = '';
    this.update();
  }

  update(): void {
    this.updateNotice();
    if (!this.visible) return;
    const s = this.ctx.state;
    const d = s.diplomacy;
    const sig = [
      s.region.stability,
      d.campaign.phaseIndex,
      d.campaign.status,
      JSON.stringify(d.campaign.stats),
      Object.values(s.region.villages)
        .map((v) => `${Math.round(v.attitude)}:${Math.round(v.influence)}`)
        .join(),
      Math.floor(s.time.tick / 60),
      Math.round(s.progression.reputation),
      Object.keys(s.region.contacts).length,
    ].join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    this.render();
  }

  private sparkline(values: number[]): HTMLCanvasElement {
    const c = el('canvas', { class: 'sparkline', attrs: { width: '360', height: '60' } });
    const g = c.getContext('2d');
    if (!g) return c;
    g.fillStyle = 'rgba(240,234,214,0.05)';
    g.fillRect(0, 0, 360, 60);
    // Seuils de la phase en cours
    g.strokeStyle = 'rgba(240,234,214,0.15)';
    for (const y of [25, 50, 75]) {
      g.beginPath();
      g.moveTo(0, 60 - (y / 100) * 60);
      g.lineTo(360, 60 - (y / 100) * 60);
      g.stroke();
    }
    if (values.length >= 1) {
      g.strokeStyle = '#d8c47a';
      g.lineWidth = 2;
      g.beginPath();
      values.forEach((v, i) => {
        const x = values.length === 1 ? 180 : (i / (values.length - 1)) * 356 + 2;
        const y = 60 - (v / 100) * 56 - 2;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    }
    return c;
  }

  private mini(label: string, value: number): HTMLElement {
    return el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label', text: label }),
      el('span', { class: 'bar' }, [el('span', { class: 'bar-fill', attrs: { style: `width:${value}%;background:#8e9a5a` } })]),
      el('span', { class: 'bar-value', text: String(value) }),
    ]);
  }

  private render(): void {
    const s = this.ctx.state;
    const dip = this.ctx.sim.diplomacy;
    const c = s.diplomacy.campaign;
    const phase = dip.currentPhase();
    clear(this.content);

    // Phase et objectifs
    const status =
      c.status === 'won'
        ? t('campaign.won')
        : c.status === 'lost'
          ? t('campaign.lost')
          : c.status === 'sandbox'
            ? t('campaign.sandbox')
            : t('campaign.deadline', { days: Math.max(0, dip.daysLeft()).toFixed(1) });
    this.content.append(
      el('div', { class: 'campaign-phase', text: phase.name }),
      el('div', { class: `small ${c.status === 'active' && dip.daysLeft() < 3 ? 'warn-text' : 'muted'}`, text: status }),
      el('p', { class: 'muted small', text: phase.brief }),
    );
    for (const o of phase.objectives) {
      const p = dip.objectiveProgress(o);
      const value = o.type === 'neutralize' ? '' : ` (${p.value}/${p.target})`;
      this.content.append(el('div', { class: `objective ${p.done ? 'done' : ''}`, text: `${p.done ? '✓' : '○'} ${o.text}${value}` }));
    }

    // Stabilité régionale
    const trend = dip.stabilityTrend();
    const comp = s.diplomacy.components;
    this.content.append(
      el('div', { class: 'section-title', text: t('campaign.stability') }),
      el('div', { class: 'stability-big' }, [
        el('span', { text: String(s.region.stability) }),
        el('span', { class: `small ${trend > 0 ? 'good' : trend < 0 ? 'bad' : 'muted'}`, text: trend ? ` ${trend > 0 ? '▲' : '▼'}${Math.abs(trend)}` : '' }),
      ]),
      this.sparkline(s.diplomacy.history),
      this.mini(t('campaign.comp.attitude'), comp.attitude),
      this.mini(t('campaign.comp.influence'), comp.influence),
      this.mini(t('campaign.comp.enemy'), comp.enemy),
      this.mini(t('campaign.comp.incidents'), comp.incidents),
      el('div', {
        class: 'muted small',
        text: t('campaign.effects', {
          budget: formatNumber(this.ctx.sim.economy.dailyBudget()),
          bmult: dip.budgetMult().toFixed(2),
          threat: dip.threatMult().toFixed(2),
          road: dip.roadRiskMult().toFixed(2),
        }),
      }),
    );

    // Villages
    this.content.append(el('div', { class: 'section-title', text: t('campaign.villages') }));
    const informant = this.ctx.content.region.intel.informantAttitude;
    for (const v of this.ctx.content.region.villages) {
      const st = s.region.villages[v.id];
      const stance = dip.stance(st.attitude);
      const vd = dip.village(v.id);
      const flags = [st.attitude >= informant ? '👁' : '', vd.promise ? '✋' : '', vd.demand ? '!' : ''].join('');
      this.content.append(
        el('div', { class: 'village-line', title: t('campaign.villageHint'), onClick: () => this.ctx.bus.emit('ui:openVillage', { id: v.id }) }, [
          el('span', { class: 'vl-name', text: v.name }),
          el('span', { class: 'vl-stance', text: stance.label, attrs: { style: `color:${stance.color}` } }),
          el('span', { class: 'vl-num', text: `${Math.round(st.attitude)}` }),
          el('span', { class: 'vl-num bad', text: `${Math.round(st.influence)}` }),
          el('span', { class: 'vl-flags', text: flags }),
        ]),
      );
    }
    this.content.append(el('div', { class: 'muted small', text: t('campaign.villageLegend') }));

    // Bilan
    const st = c.stats;
    this.content.append(
      el('div', { class: 'section-title', text: t('campaign.record') }),
      el('div', {
        class: 'muted small',
        text: t('campaign.stats', {
          missions: st.missionsSuccess,
          projects: st.projectsDone,
          kept: st.promisesKept,
          broken: st.promisesBroken,
          neutralized: st.contactsNeutralized,
          aux: st.auxiliaries,
        }),
      }),
    );
  }

  private updateNotice(): void {
    const n = this.ctx.hasGame ? this.ctx.state.diplomacy?.campaign.notice : null;
    const sig = n ? `${n.kind}${n.phaseIndex}` : '';
    if (sig === this.noticeSig) return;
    this.noticeSig = sig;
    if (!n) {
      this.noticeBackdrop.classList.add('hidden');
      return;
    }
    const camp = this.ctx.content.campaign;
    const phase = camp.phases[n.phaseIndex];
    const prev = camp.phases[n.phaseIndex - 1];
    clear(this.noticeBody);
    const lines: string[] = [];
    let title = t('campaign.noticeTitle');
    switch (n.kind) {
      case 'start':
        title = phase.name;
        lines.push(phase.brief);
        break;
      case 'phaseDone':
        title = phase.name;
        if (prev) {
          lines.push(camp.texts.phaseDone.replace('{name}', prev.name));
          const r = prev.rewards;
          lines.push(t('campaign.rewards', { funds: formatNumber(r.funds ?? 0), rep: r.reputation ?? 0 }));
        }
        lines.push(camp.texts.phaseNext.replace('{name}', phase.name), phase.brief);
        break;
      case 'missed':
        lines.push(camp.texts.phaseMissed.replace('{name}', phase.name).replace('{days}', String(phase.penalty.graceDays)));
        break;
      case 'victory':
        title = t('campaign.victoryTitle');
        lines.push(camp.texts.victory);
        break;
      case 'defeat':
        title = t('campaign.defeatTitle');
        lines.push(camp.texts.defeat);
        break;
      default:
        break;
    }
    this.noticeBody.append(el('div', { class: 'panel-title', text: title }), ...lines.map((l) => el('p', { text: l })));
    if (n.kind === 'start' || n.kind === 'phaseDone') {
      for (const o of phase.objectives) this.noticeBody.append(el('div', { class: 'objective', text: `○ ${o.text}` }));
      this.noticeBody.append(el('div', { class: 'muted small', text: t('campaign.deadlineDays', { days: phase.days }) }));
    }
    const buttons = el('div', { class: 'row' });
    if (n.kind === 'victory' || n.kind === 'defeat') {
      this.noticeBody.classList.add('end-screen');
      this.noticeBody.append(this.endStats());
    } else this.noticeBody.classList.remove('end-screen');
    if (n.kind === 'defeat') {
      buttons.append(el('button', { class: 'btn primary', text: t('campaign.continueSandbox'), onClick: () => this.ctx.commands.push({ type: 'campaignAck', continueSandbox: true }) }));
    } else if (n.kind === 'victory') {
      buttons.append(el('button', { class: 'btn primary', text: t('campaign.continuePlaying'), onClick: () => this.ctx.commands.push({ type: 'campaignAck', continueSandbox: true }) }));
    } else {
      buttons.append(el('button', { class: 'btn primary', text: t('campaign.ok'), onClick: () => this.ctx.commands.push({ type: 'campaignAck' }) }));
    }
    if (n.kind === 'victory' || n.kind === 'defeat') {
      buttons.append(el('button', { class: 'btn', text: t('campaign.toMenu'), onClick: () => this.ctx.bus.emit('ui:quitToMenu', {}) }));
    }
    this.noticeBody.append(buttons);
    this.noticeBackdrop.classList.remove('hidden');
  }

  /** Bilan de fin de campagne. */
  private endStats(): HTMLElement {
    const s = this.ctx.state;
    const st = s.diplomacy.campaign.stats;
    const villages = Object.values(s.region.villages);
    const rows: [string, string][] = [
      [t('end.days'), String(s.time.day)],
      [t('end.stability'), String(s.region.stability)],
      [t('end.reputation'), String(Math.round(s.progression.reputation))],
      [t('end.missions'), String(st.missionsSuccess)],
      [t('end.reports'), String(s.missionReports.length)],
      [t('end.kia'), String(s.memorial.length)],
      [t('end.neutralized'), String(st.contactsNeutralized)],
      [t('end.projects'), String(st.projectsDone)],
      [t('end.promises'), `${st.promisesKept} / ${st.promisesBroken}`],
      [t('end.auxiliaries'), String(st.auxiliaries)],
      [t('end.favorable'), `${villages.filter((v) => v.attitude >= 20).length} / ${villages.length}`],
      [t('end.funds'), formatNumber(s.resources.stock.funds)],
    ];
    const box = el('div', { class: 'end-stats' }, [el('div', { class: 'section-title', text: t('end.title') })]);
    for (const [k, v] of rows) box.append(el('div', { class: 'end-row' }, [el('span', { text: k }), el('span', { class: 'end-value', text: v })]));
    if (s.memorial.length) {
      box.append(el('div', { class: 'section-title', text: t('end.memorial') }), el('div', { class: 'muted small', text: s.memorial.map((m) => `${m.name} (J${m.day})`).join(' · ') }));
    }
    return box;
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
    this.noticeBackdrop.remove();
  }
}
