/**
 * Panneau des opérations (touche O) : missions en cours (étape, échéance, estimation)
 * et comptes rendus de mission (ouverts automatiquement au retour d'une unité).
 */
import type { GameContext } from '../core/GameContext';
import type { MissionInstance, MissionReport } from '../core/GameState';
import { formatClock, t } from '../utils/i18n';
import { clear, el } from './dom';

export class OpsPanel {
  private readonly root: HTMLElement;
  private readonly active: HTMLElement;
  private readonly reports: HTMLElement;
  private readonly reportBackdrop: HTMLElement;
  private readonly reportBody: HTMLElement;
  private visible = false;
  private sig = '';
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.active = el('div', { class: 'orders-list' });
    this.reports = el('div', { class: 'orders-list' });
    this.root = el('div', { class: 'panel ops-panel hidden' }, [
      el('div', { class: 'panel-title' }, [t('ops.title'), el('button', { class: 'btn close', text: '×', onClick: () => this.toggle(false) })]),
      el('p', { class: 'muted small', text: t('ops.hint') }),
      el('button', {
        class: 'btn wide',
        text: t('ops.openMap'),
        onClick: () => {
          if (!this.root.parentElement?.classList.contains('map-open')) ctx.bus.emit('ui:toggleMap', {});
        },
      }),
      el('div', { class: 'section-title', text: t('ops.active') }),
      this.active,
      el('div', { class: 'section-title', text: t('ops.reports') }),
      this.reports,
    ]);
    this.reportBody = el('div', { class: 'panel modal report' });
    this.reportBackdrop = el('div', { class: 'modal-backdrop hidden' }, [this.reportBody]);
    this.reportBackdrop.addEventListener('click', (e) => {
      if (e.target === this.reportBackdrop) this.reportBackdrop.classList.add('hidden');
    });
    parent.append(this.root, this.reportBackdrop);
    this.unsubs.push(
      ctx.bus.on('ui:toggleOps', () => this.toggle()),
      ctx.bus.on('ui:openReport', ({ id }) => this.openReport(id)),
      ctx.bus.on('mission:done', ({ reportId }) => this.openReport(reportId)),
    );
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    this.sig = '';
    this.update();
  }

  private clock(tick: number): string {
    const time = this.ctx.content.balance.time;
    const total = time.startHour * 60 + tick * time.minutesPerTick;
    return `J${Math.floor(total / 1440) + 1} ${formatClock(total % 1440)}`;
  }

  phaseText(m: MissionInstance): string {
    return t(`mission.phase.${m.phase}`, { eta: this.clock(m.phaseEndTick) });
  }

  update(): void {
    if (!this.visible) return;
    const missions = this.ctx.sim.missions.active();
    const reports = this.ctx.state.missionReports;
    const sig = missions.map((m) => `${m.id}${m.phase}${m.phaseEndTick}`).join() + '|' + reports.map((r) => `${r.id}${r.read}`).join();
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.active);
    if (!missions.length) this.active.append(el('div', { class: 'muted small', text: t('ops.none') }));
    for (const m of missions) {
      const def = this.ctx.content.missionType(m.defId);
      this.active.append(
        el(
          'div',
          {
            class: 'order-row',
            onClick: () => {
              if (!this.root.parentElement?.classList.contains('map-open')) this.ctx.bus.emit('ui:toggleMap', {});
              this.ctx.bus.emit('ui:mapSelect', { target: { kind: 'mission', id: m.id } });
            },
          },
          [
            el('div', { class: 'order-name', text: `${m.callsign} — ${def.name}` }),
            el('div', { class: 'muted small', text: t('ops.line', { target: m.target.name, n: m.memberIds.length, estimate: Math.round(m.estimate * 100) }) }),
            el('div', { class: 'order-status', text: this.phaseText(m) }),
          ],
        ),
      );
    }
    clear(this.reports);
    if (!reports.length) this.reports.append(el('div', { class: 'muted small', text: t('ops.noReports') }));
    for (const r of reports) {
      this.reports.append(
        el('div', { class: `order-row report-row result-${r.result}${r.read ? '' : ' unread'}`, onClick: () => this.openReport(r.id) }, [
          el('div', { class: 'order-name', text: `${r.read ? '' : '● '}${r.callsign} — ${r.title}` }),
          el('div', { class: 'order-status', text: `${t(`mission.result.${r.result}`)} · J${r.day} ${formatClock(r.minute)}` }),
        ]),
      );
    }
  }

  openReport(id: string): void {
    const r: MissionReport | undefined = this.ctx.state.missionReports.find((x) => x.id === id);
    if (!r) return;
    r.read = true;
    clear(this.reportBody);
    this.reportBody.append(
      el('div', { class: 'panel-title' }, [t('report.window'), el('button', { class: 'btn close', text: '×', onClick: () => this.reportBackdrop.classList.add('hidden') })]),
      el('div', { class: `report-result result-${r.result}`, text: t(`mission.result.${r.result}`) }),
      el('pre', { class: 'report-text', text: r.lines.join('\n') }),
    );
    this.reportBackdrop.classList.remove('hidden');
    this.sig = '';
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
    this.reportBackdrop.remove();
  }
}
