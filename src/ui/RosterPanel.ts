/**
 * Liste du personnel par groupe (touche P) : activité, moral, alertes ; clic = sélection + centrage.
 * Organisation : renommer un groupe (✎), le dissoudre (✕), en créer un nouveau, et changer un
 * soldat de groupe avec sa liste déroulante.
 */
import type { GameContext } from '../core/GameContext';
import type { Agent, Id } from '../core/GameState';
import { GROUP_NAME_MAX } from '../systems/GroupSystem';
import { t } from '../utils/i18n';
import { clear, el } from './dom';

const NEW_GROUP = '__new__';
const NO_GROUP = '';

export class RosterPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;
  private visible = false;
  private signature = '';
  /** Groupe en cours de renommage (le rafraîchissement est suspendu pendant la saisie). */
  private editing: Id | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.list = el('div', { class: 'roster-list' });
    this.summary = el('div', { class: 'muted small' });
    this.root = el('div', { class: 'panel roster-panel hidden' }, [
      el('div', { class: 'panel-title' }, [t('roster.title'), el('button', { class: 'btn close', text: '×', onClick: () => this.toggle(false) })]),
      this.summary,
      this.legend(),
      el('div', { class: 'roster-tools' }, [
        el('button', { class: 'btn small-btn', text: t('group.new'), onClick: () => this.ctx.commands.push({ type: 'createGroup' }) }),
        el('span', { class: 'muted small', text: t('group.hint') }),
      ]),
      this.list,
    ]);
    parent.append(this.root);
    this.unsubs.push(
      ctx.bus.on('ui:toggleRoster', () => this.toggle()),
      ctx.bus.on('group:changed', () => (this.signature = '')),
    );
  }

  /** Légende des insignes de rôle (couleurs affichées au-dessus des personnages). */
  private legend(): HTMLElement {
    return el(
      'div',
      { class: 'role-legend' },
      this.ctx.content.personnelList
        .filter((p) => p.visual.badge)
        .map((p) => el('span', { class: 'role-item' }, [el('span', { class: 'role-pip', attrs: { style: `background:${p.visual.badge}` } }), p.name])),
    );
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    this.editing = null;
    this.signature = '';
    this.update();
  }

  private status(a: Agent): string {
    if (a.missionId) {
      const m = this.ctx.state.missions[a.missionId];
      if (m) return t('roster.onMission', { callsign: m.callsign });
    }
    if (!a.activity) return t('agent.idle');
    const def = this.ctx.content.activity(a.activity.id);
    return a.activity.stage === 'moving' ? `→ ${def.name}` : def.name;
  }

  update(): void {
    if (!this.visible) return;
    // Saisie en cours (nom de groupe, liste déroulante ouverte) : on ne reconstruit pas la liste
    if (this.editing || this.list.contains(document.activeElement)) return;
    const { state } = this.ctx;
    const agents = Object.values(state.agents);
    const groupsSig = Object.values(state.groups)
      .map((g) => `${g.id}=${g.name}:${g.memberIds.length}`)
      .join(',');
    const rows = agents.map((a) => `${a.id}:${a.groupId}:${this.status(a)}:${Math.round(a.needs.morale / 5)}:${this.ctx.sim.agents.criticalNeeds(a).length}`);
    const signature = groupsSig + '|' + rows.join('|');
    if (signature === this.signature) return;
    this.signature = signature;

    const avgMorale = agents.length ? agents.reduce((s, a) => s + a.needs.morale, 0) / agents.length : 0;
    const beds = this.ctx.sim.agents.beds();
    this.summary.textContent = t('roster.summary', { count: agents.length, morale: Math.round(avgMorale), beds: beds.total, homeless: agents.length - beds.assigned });

    clear(this.list);
    const groups = Object.values(state.groups);
    const ungrouped = agents.filter((a) => !a.groupId || !state.groups[a.groupId]);
    for (const g of groups) {
      this.list.append(this.groupHeader(g.id, g.name, g.memberIds.length));
      for (const id of g.memberIds) {
        const a = state.agents[id];
        if (a) this.list.append(this.row(a));
      }
    }
    if (ungrouped.length) {
      this.list.append(el('div', { class: 'roster-group' }, [el('span', { class: 'rg-name', text: `${t('group.none')} (${ungrouped.length})` })]));
      for (const a of ungrouped) this.list.append(this.row(a));
    }
  }

  private groupHeader(id: Id, name: string, count: number): HTMLElement {
    const label = el('span', { class: 'rg-name', text: `${name} (${count})` });
    const header = el('div', { class: 'roster-group' }, [
      label,
      el('span', { class: 'rg-actions' }, [
        el('button', { class: 'btn small-btn', text: '✎', title: t('group.rename'), onClick: () => this.startRename(header, label, id, name) }),
        el('button', { class: 'btn small-btn', text: '✕', title: t('group.disband'), onClick: () => this.ctx.commands.push({ type: 'disbandGroup', groupId: id }) }),
      ]),
    ]);
    return header;
  }

  /** Renommage sur place : Entrée ou perte du focus valide, Échap annule. */
  private startRename(header: HTMLElement, label: HTMLElement, id: Id, name: string): void {
    this.editing = id;
    const input = el('input', { class: 'rg-input', attrs: { type: 'text', maxlength: String(GROUP_NAME_MAX) } });
    input.value = name;
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      input.blur(); // libère le focus : la liste peut de nouveau se rafraîchir
      if (commit && input.value.trim() && input.value.trim() !== name) this.ctx.commands.push({ type: 'renameGroup', groupId: id, name: input.value });
      this.editing = null;
      this.signature = '';
      this.update();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // les touches ne pilotent pas le jeu pendant la saisie
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    header.replaceChild(input, label);
    input.focus();
    input.select();
  }

  private row(a: Agent): HTMLElement {
    const { state, content } = this.ctx;
    const critical = this.ctx.sim.agents.criticalNeeds(a);
    const moraleClass = a.needs.morale < content.need('morale').critical ? 'bad' : a.needs.morale < content.need('morale').low ? 'warn' : 'good';
    const select = el('select', { class: 'roster-move', title: t('group.moveTo') });
    const add = (value: string, text: string): void => {
      const o = el('option', { text, attrs: { value } });
      select.append(o);
    };
    for (const g of Object.values(state.groups)) add(g.id, g.name);
    add(NO_GROUP, t('group.none'));
    add(NEW_GROUP, t('group.newFor'));
    select.value = a.groupId && state.groups[a.groupId] ? a.groupId : NO_GROUP;
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('keydown', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      if (select.value === NEW_GROUP) this.ctx.commands.push({ type: 'createGroup', memberIds: [a.id] });
      else this.ctx.commands.push({ type: 'moveAgent', agentId: a.id, groupId: select.value || null });
      select.blur();
      this.signature = '';
    });
    return el(
      'div',
      {
        class: 'roster-row',
        title: critical.length ? t('roster.critical', { needs: critical.map((n) => content.need(n).name).join(', ') }) : undefined,
        onClick: () => {
          this.ctx.bus.emit('ui:select', { target: { kind: 'agent', id: a.id } });
          this.ctx.bus.emit('ui:focus', { pos: { x: a.pos.x, y: a.pos.y } });
        },
      },
      [
        el('span', { class: 'roster-name' }, [
          el('span', { class: 'role-pip', attrs: { style: `background:${content.personnel(a.defId).visual.badge ?? '#888'}` }, title: content.personnel(a.defId).name }),
          `${a.rank} ${a.lastName}`,
        ]),
        el('span', { class: 'roster-status muted', text: this.status(a) }),
        el('span', { class: `roster-morale ${moraleClass}`, text: `${critical.length ? '! ' : ''}${Math.round(a.needs.morale)}` }),
        select,
      ],
    );
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
