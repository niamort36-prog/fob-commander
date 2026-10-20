/**
 * Fenêtre de diplomatie d'un village (depuis la carte) : attitude et emprise (avec tendance),
 * besoins et projets, demande du chef et promesse, actions civilo-militaires,
 * recrutement d'auxiliaires locaux.
 */
import type { GameContext } from '../core/GameContext';
import { bagEntries } from '../core/resources';
import { formatNumber, t } from '../utils/i18n';
import { clear, el } from './dom';

export class VillagePanel {
  private readonly backdrop: HTMLElement;
  private readonly body: HTMLElement;
  private villageId: string | null = null;
  private sig = '';
  private message: { text: string; good: boolean } | null = null;
  private recruitCount = 1;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.body = el('div', { class: 'panel modal village-panel' });
    this.backdrop = el('div', { class: 'modal-backdrop hidden' }, [this.body]);
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    parent.append(this.backdrop);
    this.unsubs.push(
      ctx.bus.on('ui:openVillage', ({ id }) => this.open(id)),
      ctx.bus.on('diplomacy:shura', ({ villageId, success, need }) => {
        if (villageId !== this.villageId) return;
        const leader = this.leaderName();
        this.message = success
          ? { text: need ? t('village.shuraDemand', { leader, need: t(`need.${need}`) }) : t('village.shuraOk', { leader }), good: true }
          : { text: t('village.shuraFail', { leader }), good: false };
        this.sig = '';
      }),
    );
  }

  open(id: string): void {
    this.villageId = id;
    this.message = null;
    this.recruitCount = 1;
    this.sig = '';
    this.backdrop.classList.remove('hidden');
    this.update();
  }

  close(): void {
    this.backdrop.classList.add('hidden');
    this.villageId = null;
  }

  private leaderName(): string {
    if (!this.villageId) return '';
    const def = this.ctx.sim.diplomacy.villageDef(this.villageId);
    const p = def.leader ? this.ctx.content.region.personalities.find((x) => x.id === def.leader) : undefined;
    if (!p) return t('village.elders');
    return this.ctx.state.region.personalities[p.id]?.known ? p.name : t('village.elders');
  }

  private cost(bag: Partial<Record<string, number>>): string {
    const parts = bagEntries(bag as never).map(([id, v]) => `${formatNumber(v)} ${this.ctx.content.resource(id).short}`);
    return parts.length ? parts.join(', ') : t('village.free');
  }

  update(): void {
    const id = this.villageId;
    if (!id || this.backdrop.classList.contains('hidden')) return;
    const s = this.ctx.state;
    const st = s.region.villages[id];
    const v = this.ctx.sim.diplomacy.village(id);
    const projects = Object.values(s.diplomacy.projects).filter((p) => p.villageId === id);
    const sig = [
      Math.round(st.attitude),
      Math.round(st.influence),
      JSON.stringify(v),
      projects.map((p) => `${p.id}${Math.floor(((s.time.tick - p.startTick) / Math.max(1, p.endTick - p.startTick)) * 20)}`).join(),
      Math.floor(s.resources.stock.funds / 100),
      Math.floor(s.time.tick / 60),
      this.message?.text ?? '',
      this.recruitCount,
    ].join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    this.render(id);
  }

  private bar(label: string, value: number, min: number, max: number, color: string, delta: number): HTMLElement {
    const pct = ((value - min) / (max - min)) * 100;
    const trend = Math.abs(delta) < 0.5 ? '' : delta > 0 ? ` ▲${Math.round(delta)}` : ` ▼${Math.round(-delta)}`;
    return el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label', text: label }),
      el('span', { class: 'bar' }, [el('span', { class: 'bar-fill', attrs: { style: `width:${pct}%;background:${color}` } })]),
      el('span', { class: 'bar-value', text: `${Math.round(value)}${trend}` }),
    ]);
  }

  private render(id: string): void {
    const s = this.ctx.state;
    const dip = this.ctx.sim.diplomacy;
    const def = dip.villageDef(id);
    const st = s.region.villages[id];
    const v = dip.village(id);
    const stance = dip.stance(st.attitude);
    const ticksPerDay = 1440 / this.ctx.content.balance.time.minutesPerTick;
    clear(this.body);

    this.body.append(
      el('div', { class: 'panel-title' }, [
        t('village.title', { name: def.name }),
        el('button', { class: 'btn close', text: '×', onClick: () => this.close() }),
      ]),
      el('div', { class: 'muted small', text: t('village.sub', { tribe: def.tribe, pop: formatNumber(def.population), leader: this.leaderName() }) }),
      el('div', { class: 'village-stance', text: stance.label, attrs: { style: `color:${stance.color}` } }),
      this.bar(t('map.attitude'), st.attitude, -100, 100, st.attitude >= 0 ? '#8fbf6a' : '#d0644a', st.attitude - v.prevAttitude),
      this.bar(t('map.influence'), st.influence, 0, 100, '#b03a2e', st.influence - v.prevInfluence),
    );
    if (this.message) this.body.append(el('div', { class: `village-msg ${this.message.good ? 'good' : 'bad'}`, text: this.message.text }));

    // Demande du chef et promesse
    if (v.demand) {
      const need = t(`need.${v.demand.need}`);
      this.body.append(
        el('div', { class: 'village-demand' }, [
          el('div', { text: t('village.demand', { leader: this.leaderName(), need }) }),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'btn primary',
              text: t('village.promise', { days: this.ctx.content.diplomacy.config.promise.days }),
              onClick: () => {
                this.message = null;
                this.ctx.commands.push({ type: 'answerDemand', villageId: id, accept: true });
              },
            }),
            el('button', {
              class: 'btn',
              text: t('village.refuse'),
              onClick: () => {
                this.message = null;
                this.ctx.commands.push({ type: 'answerDemand', villageId: id, accept: false });
              },
            }),
          ]),
        ]),
      );
    }
    if (v.promise) {
      const days = Math.max(0, (v.promise.deadlineTick - s.time.tick) / ticksPerDay);
      this.body.append(el('div', { class: 'village-promise', text: t('village.promiseActive', { need: t(`need.${v.promise.need}`), days: days.toFixed(1) }) }));
    }

    // Besoins et projets
    this.body.append(el('div', { class: 'section-title', text: t('village.needs') }));
    const needs = dip.needs(id);
    if (!needs.length) this.body.append(el('div', { class: 'muted small', text: t('village.noNeeds') }));
    for (const n of needs) {
      const label = t(`need.${n.need}`);
      if (n.satisfied) {
        this.body.append(el('div', { class: 'need-row done', text: `✓ ${label} — ${t('village.satisfied')}` }));
        continue;
      }
      if (n.progress !== null && n.project) {
        this.body.append(el('div', { class: 'need-row', text: `◷ ${label} — ${t('village.inProgress', { name: n.project.name, pct: Math.round(n.progress * 100) })}` }));
        continue;
      }
      if (!n.project) {
        this.body.append(el('div', { class: 'need-row', text: `• ${label}` }));
        continue;
      }
      const block = dip.projectBlock(id, n.project.id);
      this.body.append(
        el('div', { class: 'need-row' }, [
          el('div', {}, [
            el('div', { text: `• ${label} — ${n.project.name}` }),
            el('div', { class: 'muted small', text: `${n.project.desc} ${t('village.projectCost', { cost: this.cost(n.project.cost), days: n.project.days })}` }),
          ]),
          el('button', {
            class: 'btn small-btn',
            text: t('village.build'),
            title: block ? t(`village.block.${block}`) : '',
            attrs: block ? { disabled: '' } : {},
            onClick: () => this.ctx.commands.push({ type: 'startProject', villageId: id, projectId: n.project!.id }),
          }),
        ]),
      );
    }

    // Actions
    this.body.append(el('div', { class: 'section-title', text: t('village.actions') }));
    for (const a of this.ctx.content.diplomacy.actions) {
      const block = dip.actionBlock(id, a.id);
      const reason = block === 'cooldown' ? t('village.cooldown', { h: dip.cooldownLeftHours(id, a) }) : block ? t(`village.block.${block}`) : '';
      this.body.append(
        el('div', { class: 'action-row' }, [
          el('div', {}, [
            el('div', { text: a.name }),
            el('div', { class: 'muted small', text: `${a.desc} — ${this.cost(a.cost)}` }),
            reason ? el('div', { class: 'small warn-text', text: reason }) : null,
          ]),
          el('button', {
            class: 'btn small-btn',
            text: t('village.do'),
            attrs: block ? { disabled: '' } : {},
            onClick: () => {
              this.message = null;
              this.ctx.commands.push({ type: 'diplomacyAction', villageId: id, actionId: a.id });
            },
          }),
        ]),
      );
    }

    // Auxiliaires
    const aux = this.ctx.content.diplomacy.config.auxiliary;
    const avail = dip.auxiliariesAvailable(id);
    this.recruitCount = Math.max(1, Math.min(this.recruitCount, Math.max(1, avail)));
    const block = dip.recruitBlock(id, this.recruitCount);
    const risk = dip.infiltrationRisk(id);
    const riskLabel = t(risk >= 0.25 ? 'village.riskHigh' : risk >= 0.1 ? 'village.riskMid' : 'village.riskLow');
    this.body.append(
      el('div', { class: 'section-title', text: t('village.auxiliaries') }),
      el('div', { class: 'muted small', text: t('village.auxInfo', { n: v.auxiliaries, avail, min: aux.minAttitude, risk: riskLabel }) }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small-btn', text: '−', onClick: () => ((this.recruitCount = Math.max(1, this.recruitCount - 1)), (this.sig = '')) }),
        el('span', { class: 'stepper-value', text: String(this.recruitCount) }),
        el('button', { class: 'btn small-btn', text: '+', onClick: () => ((this.recruitCount = Math.min(Math.max(1, avail), this.recruitCount + 1)), (this.sig = '')) }),
        el('button', {
          class: 'btn',
          text: t('village.recruit', { cost: formatNumber(aux.price * this.recruitCount) }),
          title: block ? t(`village.recruitBlock.${block}`) : '',
          attrs: block ? { disabled: '' } : {},
          onClick: () => this.ctx.commands.push({ type: 'recruitAuxiliaries', villageId: id, count: this.recruitCount }),
        }),
      ]),
    );
    if (block) this.body.append(el('div', { class: 'small warn-text', text: t(`village.recruitBlock.${block}`, { min: aux.minAttitude }) }));
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.backdrop.remove();
  }
}
