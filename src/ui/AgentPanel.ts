/** Fiche individuelle de l'agent sélectionné : identité, activité, besoins, compétences, traits. */
import type { GameContext } from '../core/GameContext';
import type { Agent, Id } from '../core/GameState';
import { t } from '../utils/i18n';
import { clear, el, setText } from './dom';

interface Bar {
  fill: HTMLElement;
  value: HTMLElement;
}

export class AgentPanel {
  private readonly root: HTMLElement;
  private selected: Id | null = null;
  private builtFor: Id | null = null;
  private readonly unsubs: (() => void)[] = [];
  // Éléments mis à jour en continu
  private activity!: HTMLElement;
  private home!: HTMLElement;
  private bars = new Map<string, Bar>();
  private stats!: HTMLElement;
  private gearLine!: HTMLElement;
  private title!: HTMLElement;
  private careerNext!: HTMLElement;
  private groupSig = '';

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.root = el('div', { class: 'panel info-panel agent-panel hidden' });
    parent.append(this.root);
    this.unsubs.push(
      ctx.bus.on('ui:select', ({ target }) => {
        this.selected = target?.kind === 'agent' ? target.id : null;
        this.update();
      }),
    );
  }

  private bar(label: string, color: string, title?: string): [HTMLElement, Bar] {
    const fill = el('span', { class: 'bar-fill', attrs: { style: `background:${color}` } });
    const value = el('span', { class: 'bar-value' });
    const row = el('div', { class: 'bar-row', title }, [el('span', { class: 'bar-label', text: label }), el('span', { class: 'bar' }, [fill]), value]);
    return [row, { fill, value }];
  }

  /** Construit la structure de la fiche (une fois par agent sélectionné). */
  private build(a: Agent): void {
    const content = this.ctx.content;
    const def = content.personnel(a.defId);
    const routine = content.routine(def.routine);
    this.bars.clear();
    clear(this.root);

    this.activity = el('div', { class: 'agent-activity' });
    this.home = el('div', { class: 'muted small' });
    this.stats = el('div', { class: 'muted small' });
    this.gearLine = el('div', { class: 'muted small' });

    const needs = el('div', { class: 'bars' });
    for (const nd of content.needs.needs) {
      const [row, bar] = this.bar(nd.name, nd.color);
      this.bars.set(`need.${nd.id}`, bar);
      needs.append(row);
    }
    const [healthRow, healthBar] = this.bar(t('agent.health'), '#c97a7a');
    this.bars.set('health', healthBar);
    needs.append(healthRow);

    // Carrière : avancement vers le grade suivant
    this.careerNext = el('div', { class: 'muted small' });
    const [careerRow, careerBar] = this.bar(t('agent.career'), '#c9a14a', t('agent.careerHint'));
    this.bars.set('career', careerBar);
    const career = el('div', { class: 'bars' }, [careerRow]);

    const skills = el('div', { class: 'bars' });
    for (const s of content.skills) {
      const [row, bar] = this.bar(s.name, '#8e9a5a');
      this.bars.set(`skill.${s.id}`, bar);
      skills.append(row);
    }

    const traits = el(
      'div',
      { class: 'traits' },
      a.traits.length
        ? a.traits.map((id) => {
            const tr = content.trait(id);
            return el('span', { class: 'trait', text: tr.name, title: tr.desc });
          })
        : [el('span', { class: 'muted small', text: t('agent.noTraits') })],
    );

    const shiftLabel = routine.shifts > 1 ? ` · ${t('agent.shift', { shift: String.fromCharCode(65 + a.shift) })}` : '';
    this.title = el('span', { text: `${a.rank} ${a.firstName} ${a.lastName}` });
    this.root.append(
      el('div', { class: 'panel-title' }, [this.title, el('button', { class: 'btn close', text: '×', onClick: () => this.ctx.bus.emit('ui:select', { target: null }) })]),
      el('div', { class: 'muted small', text: `${def.name}${shiftLabel}` }),
      this.groupSelect(a),
      this.activity,
      this.home,
      el('div', { class: 'section-title', text: t('agent.careerTitle') }),
      career,
      this.careerNext,
      el('div', { class: 'section-title', text: t('agent.needs') }),
      needs,
      el('div', { class: 'section-title', text: t('agent.skills') }),
      skills,
      el('div', { class: 'section-title', text: t('agent.traits') }),
      traits,
      this.gearLine,
      this.stats,
      el('button', {
        class: 'btn wide',
        text: t('agent.focus'),
        onClick: () => this.ctx.bus.emit('ui:focus', { pos: { x: a.pos.x, y: a.pos.y } }),
      }),
    );
    this.builtFor = a.id;
  }

  /** Groupe du soldat, modifiable depuis sa fiche. */
  private groupSelect(a: Agent): HTMLElement {
    const groups = Object.values(this.ctx.state.groups);
    const select = el('select', { class: 'roster-move' });
    for (const g of groups) select.append(el('option', { text: g.name, attrs: { value: g.id } }));
    select.append(el('option', { text: t('group.none'), attrs: { value: '' } }));
    select.append(el('option', { text: t('group.newFor'), attrs: { value: '__new__' } }));
    select.value = a.groupId && this.ctx.state.groups[a.groupId] ? a.groupId : '';
    select.addEventListener('keydown', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      if (select.value === '__new__') this.ctx.commands.push({ type: 'createGroup', memberIds: [a.id] });
      else this.ctx.commands.push({ type: 'moveAgent', agentId: a.id, groupId: select.value || null });
      select.blur();
    });
    this.groupSig = this.groupSignature(a);
    return el('label', { class: 'agent-group muted small' }, [`${t('agent.group')} : `, select]);
  }

  private groupSignature(a: Agent): string {
    return `${a.groupId}|${Object.values(this.ctx.state.groups)
      .map((g) => `${g.id}=${g.name}`)
      .join(',')}`;
  }

  update(): void {
    const a = this.selected ? this.ctx.state.agents[this.selected] : undefined;
    if (!a) {
      this.root.classList.add('hidden');
      this.builtFor = null;
      return;
    }
    // Reconstruit la fiche si le soldat change de groupe ou si les groupes changent (hors saisie)
    if (this.builtFor !== a.id || (this.groupSig !== this.groupSignature(a) && !this.root.contains(document.activeElement))) this.build(a);
    this.root.classList.remove('hidden');
    const content = this.ctx.content;
    const fob = this.ctx.state.fob;

    let activity = t('agent.idle');
    const mission = a.missionId ? this.ctx.state.missions[a.missionId] : undefined;
    if (mission) activity = t('roster.onMission', { callsign: mission.callsign });
    else if (a.activity) {
      const def = content.activity(a.activity.id);
      const target = a.activity.targetId ? fob.buildings[a.activity.targetId] : undefined;
      const where = target ? ` — ${content.building(target.defId).name}` : '';
      activity = a.activity.stage === 'moving' ? t('agent.goingTo', { activity: def.name.toLowerCase(), where }) : `${def.name}${where}`;
    }
    setText(this.activity, a.disturbed ? activity + t('agent.disturbed') : activity);
    const home = a.homeId ? fob.buildings[a.homeId] : undefined;
    setText(this.home, home ? t('agent.home', { name: content.building(home.defId).name }) : t('agent.noHome'));

    for (const nd of content.needs.needs) {
      const bar = this.bars.get(`need.${nd.id}`)!;
      const v = a.needs[nd.id];
      bar.fill.style.width = `${v}%`;
      bar.fill.parentElement!.classList.toggle('low', v < nd.low && v >= nd.critical);
      bar.fill.parentElement!.classList.toggle('critical', v < nd.critical);
      setText(bar.value, String(Math.round(v)));
    }
    // Grade (peut changer en cours de route) et avancement
    setText(this.title, `${a.rank} ${a.firstName} ${a.lastName}`);
    const pg = this.ctx.sim.career.progress(a);
    const cb = this.bars.get('career')!;
    cb.fill.style.width = `${Math.round(pg.ratio * 100)}%`;
    setText(cb.value, pg.next ? `${Math.floor(a.xp)}/${pg.to}` : String(Math.floor(a.xp)));
    setText(this.careerNext, pg.next ? t('agent.careerNext', { rank: pg.next.rank, n: Math.max(0, Math.ceil(pg.to - a.xp)) }) : t('agent.careerTop'));
    const hb = this.bars.get('health')!;
    hb.fill.style.width = `${a.health}%`;
    setText(hb.value, String(Math.round(a.health)));
    for (const s of content.skills) {
      const bar = this.bars.get(`skill.${s.id}`)!;
      const v = a.skills[s.id] ?? 0;
      bar.fill.style.width = `${v}%`;
      setText(bar.value, String(Math.round(v)));
    }
    const gear = (a.gear ?? []).map((g) => content.equipment.items.find((i) => i.id === g)?.name ?? g);
    const pending = (a.gearPending ?? []).map((g) => content.equipment.items.find((i) => i.id === g)?.name ?? g);
    const cap = content.personnel(a.defId).ammoCapacity ?? 0;
    const ammoText = cap > 0 ? ` · ${t('agent.ammo', { n: Math.floor(a.ammo ?? cap), cap })}` : '';
    setText(
      this.gearLine,
      (gear.length ? t('agent.gear', { items: gear.join(', ') }) : t('agent.noGear')) +
        (pending.length ? t('agent.gearPending', { items: pending.join(', ') }) : '') +
        ammoText,
    );
    setText(
      this.stats,
      t('agent.stats', {
        efficiency: Math.round(a.efficiency * 100),
        fatigue: Math.round(100 - a.needs.sleep),
        xp: Math.floor(a.xp),
      }),
    );
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
