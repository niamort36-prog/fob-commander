/**
 * Écran Personnel (touche P, bouton Personnel) : plein écran, organigramme militaire.
 *  - En haut, le commandement de la FOB ; en dessous, reliés par des traits, les groupes
 *    (escouades, soutien, équipes SF…) avec leur symbole OTAN, leur effectif et leurs hommes.
 *  - Chaque soldat : insigne de grade, nom, rôle, activité, moral et besoins urgents.
 *  - Glisser-déposer un soldat sur un groupe le mute ; ✎ renomme un groupe ; ✕ le dissout.
 *  - Clic sur un soldat : fiche individuelle (besoins, compétences, carrière, équipement),
 *    où l'on peut aussi le renommer ou le changer de groupe.
 */
import type { GameContext } from '../core/GameContext';
import type { Agent, GroupKind, Id, UnitGroup } from '../core/GameState';
import { AGENT_NAME_MAX, GROUP_NAME_MAX } from '../systems/GroupSystem';
import { t } from '../utils/i18n';
import { clear, el, setText } from './dom';

const NO_GROUP = '';
const NEW_GROUP = '__new__';

/** Bandeau de couleur et symbole OTAN de chaque type de groupe. */
const KIND_STYLE: Record<GroupKind | 'none', { band: string; symbol: string; echelon: string }> = {
  hq: { band: '#a8322a', symbol: 'hq', echelon: '|||' },
  squad: { band: '#5a6b2e', symbol: 'infantry', echelon: '••' },
  support: { band: '#2f5a8a', symbol: 'logistics', echelon: '••' },
  sf_team: { band: '#3a3a34', symbol: 'sf', echelon: '•' },
  contractor_team: { band: '#7a5a2a', symbol: 'pmc', echelon: '•' },
  none: { band: '#4a4a42', symbol: 'none', echelon: '' },
};

/** Symbole OTAN (APP-6 simplifié) dans un cadre ami. */
function natoSymbol(kind: string): string {
  const frame = '<rect x="2" y="2" width="44" height="28" fill="#9fd4f0" stroke="#1b1a14" stroke-width="2"/>';
  const inner: Record<string, string> = {
    infantry: '<line x1="2" y1="2" x2="46" y2="30" stroke="#1b1a14" stroke-width="2"/><line x1="46" y1="2" x2="2" y2="30" stroke="#1b1a14" stroke-width="2"/>',
    logistics: '<line x1="2" y1="22" x2="46" y2="22" stroke="#1b1a14" stroke-width="2"/><circle cx="24" cy="12" r="5" fill="none" stroke="#1b1a14" stroke-width="2"/>',
    hq: '<text x="24" y="21" text-anchor="middle" font-size="12" font-family="VT323,monospace" fill="#1b1a14">QG</text>',
    sf: '<text x="24" y="22" text-anchor="middle" font-size="14" font-family="VT323,monospace" fill="#1b1a14">FS</text><line x1="2" y1="2" x2="46" y2="30" stroke="#1b1a14" stroke-width="1"/>',
    pmc: '<text x="24" y="22" text-anchor="middle" font-size="12" font-family="VT323,monospace" fill="#1b1a14">PMC</text>',
    medic: '<line x1="24" y1="6" x2="24" y2="26" stroke="#b03a2e" stroke-width="4"/><line x1="12" y1="16" x2="36" y2="16" stroke="#b03a2e" stroke-width="4"/>',
    none: '<text x="24" y="22" text-anchor="middle" font-size="16" font-family="VT323,monospace" fill="#1b1a14">?</text>',
  };
  return `<svg viewBox="0 0 48 32" width="48" height="32">${frame}${inner[kind] ?? inner.none}</svg>`;
}

/** Insigne de grade (galons, chevrons) dessiné en SVG. */
function rankInsignia(rank: string): string {
  const r = rank.toLowerCase();
  const W = 22;
  const H = 26;
  const box = (body: string): string => `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="2" fill="#2a2c22" stroke="#5a5c4a"/>${body}</svg>`;
  const chevrons = (n: number, color: string): string =>
    box(Array.from({ length: n }, (_, i) => `<polyline points="5,${8 + i * 5} 11,${4 + i * 5} 17,${8 + i * 5}" fill="none" stroke="${color}" stroke-width="2.5"/>`).join(''));
  const bars = (colors: string[]): string => box(colors.map((c, i) => `<rect x="4" y="${4 + i * 4}" width="14" height="2.5" fill="${c}"/>`).join(''));
  const G = '#d8b44a';
  const S = '#c8c8c0';
  const R = '#c0302a';
  if (r === 'soldat') return box('');
  if (r.includes('1re classe')) return chevrons(1, R);
  if (r === 'caporal-chef') return chevrons(3, R);
  if (r === 'caporal') return chevrons(2, R);
  if (r === 'sergent-chef') return box(`<rect x="4" y="5" width="14" height="3" fill="${G}"/><rect x="4" y="10" width="14" height="3" fill="${G}"/><rect x="4" y="15" width="14" height="3" fill="${G}"/>`);
  if (r === 'sergent') return box(`<rect x="4" y="7" width="14" height="3" fill="${G}"/><rect x="4" y="13" width="14" height="3" fill="${G}"/>`);
  if (r === 'adjudant-chef') return box(`<rect x="4" y="8" width="14" height="8" fill="${G}"/><rect x="4" y="10" width="14" height="1.5" fill="${R}"/><rect x="4" y="13" width="14" height="1.5" fill="${R}"/>`);
  if (r === 'adjudant') return box(`<rect x="4" y="8" width="14" height="8" fill="${S}"/><rect x="4" y="11.3" width="14" height="1.5" fill="${R}"/>`);
  if (r === 'major') return box(`<rect x="4" y="8" width="14" height="8" fill="${G}"/><rect x="4" y="8" width="14" height="1.5" fill="${R}"/><rect x="4" y="14.5" width="14" height="1.5" fill="${R}"/>`);
  if (r === 'sous-lieutenant') return bars([G]);
  if (r === 'lieutenant') return bars([G, G]);
  if (r === 'capitaine') return bars([G, G, G]);
  if (r === 'commandant') return bars([G, G, G, G]);
  if (r === 'lieutenant-colonel') return bars([G, S, G, S, G]);
  if (r.includes('médecin')) return box(`<line x1="11" y1="5" x2="11" y2="21" stroke="${R}" stroke-width="3"/><line x1="5" y1="13" x2="17" y2="13" stroke="${R}" stroke-width="3"/>`);
  if (r.includes('infirmier')) return box(`<line x1="11" y1="7" x2="11" y2="19" stroke="${S}" stroke-width="2.5"/><line x1="6" y1="13" x2="16" y2="13" stroke="${S}" stroke-width="2.5"/>`);
  return box(`<circle cx="11" cy="13" r="4" fill="${S}"/>`);
}

/** Abréviation militaire du grade (l'insigne le montre déjà en entier). */
const RANK_ABBR: Record<string, string> = {
  soldat: 'SDT',
  'soldat de 1re classe': '1CL',
  caporal: 'CPL',
  'caporal-chef': 'CCH',
  sergent: 'SGT',
  'sergent-chef': 'SCH',
  adjudant: 'ADJ',
  'adjudant-chef': 'ADC',
  major: 'MAJ',
  'sous-lieutenant': 'SLT',
  lieutenant: 'LTN',
  capitaine: 'CNE',
  commandant: 'CDT',
  'lieutenant-colonel': 'LCL',
  infirmier: 'INF',
  'infirmier-chef': 'IFC',
  médecin: 'MED',
  'médecin-chef': 'MDC',
  auxiliaire: 'AUX',
  'chef de groupe': 'CDG',
  'chef de section': 'CDS',
  contractor: 'PMC',
  "chef d'équipe": 'CDE',
  'chef de mission': 'CDM',
  'officier de liaison': 'OL',
  'officier traitant': 'OT',
  'chef de poste': 'CDP',
};

function rankAbbr(rank: string): string {
  return RANK_ABBR[rank.toLowerCase()] ?? rank.slice(0, 3).toUpperCase();
}

function svg(html: string): HTMLElement {
  const span = el('span', { class: 'svg-wrap' });
  span.innerHTML = html;
  return span;
}

export class RosterPanel {
  private readonly root: HTMLElement;
  private readonly chart: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly modal: HTMLElement;
  private visible = false;
  private signature = '';
  /** Saisie en cours (renommage) : le rafraîchissement est suspendu. */
  private editing = false;
  private dragging: Id | null = null;
  private fileFor: Id | null = null;
  private fileBars = new Map<string, { fill: HTMLElement; value: HTMLElement }>();
  private fileDyn: { activity: HTMLElement; career: HTMLElement; title: HTMLElement; gear: HTMLElement } | null = null;
  private readonly unsubs: (() => void)[] = [];
  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.visible || e.key !== 'Escape' || this.editing) return;
    e.stopPropagation();
    if (this.fileFor) this.closeFile();
    else this.toggle(false);
  };

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.chart = el('div', { class: 'org-chart' });
    this.summary = el('div', { class: 'org-summary' });
    this.modal = el('div', { class: 'org-modal-backdrop hidden', onClick: (e) => e.target === this.modal && this.closeFile() });
    this.root = el('div', { class: 'panel personnel-screen hidden' }, [
      el('div', { class: 'logi-head' }, [
        el('div', { class: 'logi-title', text: t('roster.title') }),
        this.summary,
        el('button', { class: 'btn', text: t('group.new'), onClick: () => this.ctx.commands.push({ type: 'createGroup' }) }),
        el('button', { class: 'btn close', text: '×', title: t('logi.closeHint'), onClick: () => this.toggle(false) }),
      ]),
      el('div', { class: 'muted small org-hint', text: t('org.hint') }),
      el('div', { class: 'org-scroll' }, [this.chart]),
      this.modal,
    ]);
    parent.append(this.root);
    window.addEventListener('keydown', this.onKey, true);
    this.unsubs.push(
      ctx.bus.on('ui:toggleRoster', () => this.toggle()),
      ctx.bus.on('group:changed', () => (this.signature = '')),
    );
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    if (!this.visible) this.closeFile();
    this.editing = false;
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

  // ------------------------------------------------------------ Organigramme

  update(): void {
    if (!this.visible) return;
    if (this.fileFor) this.updateFile();
    if (this.editing || this.dragging) return;
    const { state } = this.ctx;
    const agents = Object.values(state.agents);
    const groupsSig = Object.values(state.groups)
      .map((g) => `${g.id}=${g.name}:${g.memberIds.join('.')}`)
      .join(',');
    const rows = agents.map((a) => `${a.id}:${a.rank}:${a.firstName}:${a.lastName}:${a.groupId}:${this.status(a)}:${Math.round(a.needs.morale / 5)}:${this.ctx.sim.agents.criticalNeeds(a).length}`);
    const signature = groupsSig + '|' + rows.join('|');
    if (signature === this.signature) return;
    this.signature = signature;

    const avgMorale = agents.length ? agents.reduce((s, a) => s + a.needs.morale, 0) / agents.length : 0;
    const beds = this.ctx.sim.agents.beds();
    setText(this.summary, t('roster.summary', { count: agents.length, morale: Math.round(avgMorale), beds: beds.total, homeless: agents.length - beds.assigned }));

    clear(this.chart);
    const groups = Object.values(state.groups);
    const hq = groups.find((g) => g.kind === 'hq') ?? null;
    const others = groups.filter((g) => g !== hq);
    const ungrouped = agents.filter((a) => !a.groupId || !state.groups[a.groupId]);
    // Sommet : commandement de la FOB
    const top = el('div', { class: 'org-top' }, [el('div', { class: 'org-top-title', text: t('org.fob', { site: this.ctx.site.name }) })]);
    const root = el('div', { class: 'org-root' }, [top]);
    if (hq) root.append(this.groupNode(hq));
    const children = el('div', { class: 'org-children' });
    for (const g of others) children.append(el('div', { class: 'org-branch' }, [this.groupNode(g)]));
    if (ungrouped.length) children.append(el('div', { class: 'org-branch' }, [this.groupNode(null, ungrouped)]));
    // Zone de dépôt : nouveau groupe
    const drop = el('div', { class: 'org-branch' }, [el('div', { class: 'org-new', text: t('org.dropNew') })]);
    this.dropTarget(drop.firstElementChild as HTMLElement, NEW_GROUP);
    children.append(drop);
    this.chart.append(root, children);
  }

  private groupNode(g: UnitGroup | null, loose: Agent[] = []): HTMLElement {
    const { state } = this.ctx;
    const kind: GroupKind | 'none' = g ? g.kind : 'none';
    const style = KIND_STYLE[kind];
    const members = g ? g.memberIds.map((id) => state.agents[id]).filter(Boolean) : loose;
    // Groupe composé de soignants : croix rouge plutôt que logistique
    const symbol = members.length && members.every((a) => a.defId === 'medic') ? 'medic' : style.symbol;
    const name = g ? g.name : t('group.none');
    const label = el('span', { class: 'org-name', text: name });
    const head = el('div', { class: 'org-head', attrs: { style: `background:${style.band}` } }, [
      label,
      el('span', { class: 'org-count', text: `${members.length}` }),
    ]);
    if (g) {
      head.append(
        el('span', { class: 'org-actions' }, [
          el('button', { class: 'btn small-btn', text: '✎', title: t('group.rename'), onClick: () => this.renameGroup(head, label, g) }),
          g.kind !== 'hq' ? el('button', { class: 'btn small-btn', text: '✕', title: t('group.disband'), onClick: () => this.ctx.commands.push({ type: 'disbandGroup', groupId: g.id }) }) : '',
        ]),
      );
    }
    const morale = members.length ? Math.round(members.reduce((s, a) => s + a.needs.morale, 0) / members.length) : 0;
    const box = el('div', { class: `org-node kind-${kind}` }, [
      head,
      el('div', { class: 'org-symbol-row' }, [
        el('span', { class: 'org-echelon', text: style.echelon }),
        svg(natoSymbol(symbol)),
        el('span', { class: 'org-morale', text: members.length ? t('org.morale', { n: morale }) : '' }),
      ]),
    ]);
    const list = el('div', { class: 'org-members' });
    for (const a of members) list.append(this.memberCard(a));
    if (!members.length) list.append(el('div', { class: 'muted small org-empty', text: t('org.empty') }));
    box.append(list);
    if (g) this.dropTarget(box, g.id);
    else this.dropTarget(box, NO_GROUP);
    return box;
  }

  private memberCard(a: Agent): HTMLElement {
    const content = this.ctx.content;
    const def = content.personnel(a.defId);
    const critical = this.ctx.sim.agents.criticalNeeds(a);
    const mCls = a.needs.morale < content.need('morale').critical ? 'bad' : a.needs.morale < content.need('morale').low ? 'warn' : 'good';
    const card = el(
      'div',
      {
        class: `org-member${a.missionId ? ' away' : ''}`,
        title: `${a.rank} ${a.firstName} ${a.lastName} — ${def.name}\n${critical.length ? t('roster.critical', { needs: critical.map((n) => content.need(n).name).join(', ') }) : t('org.open')}`,
        onClick: () => this.openFile(a.id),
      },
      [
        svg(rankInsignia(a.rank)),
        el('div', { class: 'org-member-text' }, [
          el('span', { class: 'org-member-name' }, [
            el('span', { class: 'role-pip', attrs: { style: `background:${def.visual.badge ?? '#888'}` } }),
            el('span', { class: 'org-rank', text: rankAbbr(a.rank) }),
            `${a.firstName.charAt(0)}. ${a.lastName}`,
          ]),
          el('span', { class: 'org-member-status', text: this.status(a) }),
        ]),
        el('span', { class: `org-member-morale ${mCls}`, text: `${critical.length ? '! ' : ''}${Math.round(a.needs.morale)}` }),
      ],
    );
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      this.dragging = a.id;
      e.dataTransfer?.setData('text/plain', a.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      this.dragging = null;
      card.classList.remove('dragging');
      this.signature = '';
    });
    return card;
  }

  /** Dépôt d'un soldat sur un groupe (ou « sans groupe », ou nouveau groupe). */
  private dropTarget(node: HTMLElement, groupId: string): void {
    node.addEventListener('dragover', (e) => {
      e.preventDefault();
      node.classList.add('drop-over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-over'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('drop-over');
      const id = e.dataTransfer?.getData('text/plain') || this.dragging;
      if (!id) return;
      if (groupId === NEW_GROUP) this.ctx.commands.push({ type: 'createGroup', memberIds: [id] });
      else this.ctx.commands.push({ type: 'moveAgent', agentId: id, groupId: groupId || null });
      this.dragging = null;
      this.signature = '';
    });
  }

  /** Champ de saisie sur place : Entrée ou perte du focus valide, Échap annule. */
  private inlineInput(value: string, max: number, onCommit: (v: string) => void, onEnd: () => void): HTMLInputElement {
    const input = el('input', { class: 'rg-input', attrs: { type: 'text', maxlength: String(max) } });
    input.value = value;
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      input.blur();
      if (commit && input.value.trim() && input.value.trim() !== value) onCommit(input.value);
      this.editing = false;
      onEnd();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    return input;
  }

  private renameGroup(head: HTMLElement, label: HTMLElement, g: UnitGroup): void {
    this.editing = true;
    const input = this.inlineInput(g.name, GROUP_NAME_MAX, (v) => this.ctx.commands.push({ type: 'renameGroup', groupId: g.id, name: v }), () => {
      this.signature = '';
      this.update();
    });
    head.replaceChild(input, label);
    input.focus();
    input.select();
  }

  // ------------------------------------------------------------ Fiche individuelle

  private openFile(id: Id): void {
    this.fileFor = id;
    this.buildFile();
    this.modal.classList.remove('hidden');
  }

  private closeFile(): void {
    this.fileFor = null;
    this.fileDyn = null;
    this.modal.classList.add('hidden');
    clear(this.modal);
  }

  private buildFile(): void {
    const a = this.fileFor ? this.ctx.state.agents[this.fileFor] : undefined;
    clear(this.modal);
    this.fileBars.clear();
    if (!a) return this.closeFile();
    const content = this.ctx.content;
    const def = content.personnel(a.defId);
    const title = el('span', { class: 'file-name', text: `${a.rank} ${a.firstName} ${a.lastName}` });
    const rename = el('button', { class: 'btn small-btn', text: '✎', title: t('org.renameSoldier') });
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editing = true;
      const first = this.inlineInput(a.firstName, AGENT_NAME_MAX, () => {}, () => {});
      const last = this.inlineInput(a.lastName, AGENT_NAME_MAX, () => {}, () => {});
      // Les deux champs se valident ensemble
      const commit = (): void => {
        this.ctx.commands.push({ type: 'renameAgent', agentId: a.id, firstName: first.value, lastName: last.value });
        this.editing = false;
        window.setTimeout(() => this.buildFile(), 0);
      };
      const ok = el('button', { class: 'btn small-btn primary', text: '✓', onClick: commit });
      for (const input of [first, last]) input.addEventListener('keydown', (ev) => ev.key === 'Enter' && commit());
      const row = el('span', { class: 'file-rename' }, [first, last, ok]);
      title.replaceWith(row);
      rename.remove();
      first.focus();
      first.select();
    });

    // Groupe : liste déroulante
    const select = el('select', { class: 'roster-move' });
    for (const g of Object.values(this.ctx.state.groups)) select.append(el('option', { text: g.name, attrs: { value: g.id } }));
    select.append(el('option', { text: t('group.none'), attrs: { value: NO_GROUP } }));
    select.append(el('option', { text: t('group.newFor'), attrs: { value: NEW_GROUP } }));
    select.value = a.groupId && this.ctx.state.groups[a.groupId] ? a.groupId : NO_GROUP;
    select.addEventListener('keydown', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      if (select.value === NEW_GROUP) this.ctx.commands.push({ type: 'createGroup', memberIds: [a.id] });
      else this.ctx.commands.push({ type: 'moveAgent', agentId: a.id, groupId: select.value || null });
      this.signature = '';
    });

    const bar = (key: string, label: string, color: string): HTMLElement => {
      const fill = el('span', { class: 'bar-fill', attrs: { style: `background:${color}` } });
      const value = el('span', { class: 'bar-value' });
      this.fileBars.set(key, { fill, value });
      return el('div', { class: 'bar-row' }, [el('span', { class: 'bar-label', text: label }), el('span', { class: 'bar' }, [fill]), value]);
    };
    const needs = el('div', { class: 'bars' }, content.needs.needs.map((n) => bar(`need.${n.id}`, n.name, n.color)));
    needs.append(bar('health', t('agent.health'), '#c97a7a'));
    const skills = el('div', { class: 'bars' }, content.skills.map((s) => bar(`skill.${s.id}`, s.name, '#8e9a5a')));
    const traits = el(
      'div',
      { class: 'traits' },
      a.traits.length ? a.traits.map((id) => el('span', { class: 'trait', text: content.trait(id).name, title: content.trait(id).desc })) : [el('span', { class: 'muted small', text: t('agent.noTraits') })],
    );
    const activity = el('div', { class: 'agent-activity' });
    const career = el('div', { class: 'muted small' });
    const gear = el('div', { class: 'muted small' });
    this.fileDyn = { activity, career, title, gear };

    const card = el('div', { class: 'panel org-file' }, [
      el('div', { class: 'file-head' }, [
        svg(rankInsignia(a.rank)),
        el('div', { class: 'file-id' }, [el('div', { class: 'file-title' }, [title, rename]), el('div', { class: 'muted small', text: def.name })]),
        el('button', { class: 'btn close', text: '×', onClick: () => this.closeFile() }),
      ]),
      el('label', { class: 'agent-group muted small' }, [`${t('agent.group')} : `, select]),
      activity,
      el('div', { class: 'file-cols' }, [
        el('div', {}, [el('div', { class: 'section-title', text: t('agent.needs') }), needs]),
        el('div', {}, [
          el('div', { class: 'section-title', text: t('agent.careerTitle') }),
          bar('career', t('agent.career'), '#c9a14a'),
          career,
          el('div', { class: 'section-title', text: t('agent.skills') }),
          skills,
          el('div', { class: 'section-title', text: t('agent.traits') }),
          traits,
        ]),
      ]),
      gear,
      el('div', { class: 'file-actions' }, [
        el('button', {
          class: 'btn',
          text: t('agent.focus'),
          onClick: () => {
            const ag = this.ctx.state.agents[a.id];
            this.toggle(false);
            if (!ag) return;
            this.ctx.bus.emit('ui:select', { target: { kind: 'agent', id: ag.id } });
            this.ctx.bus.emit('ui:focus', { pos: { x: ag.pos.x, y: ag.pos.y } });
          },
        }),
        el('button', { class: 'btn', text: t('org.close'), onClick: () => this.closeFile() }),
      ]),
    ]);
    this.modal.append(card);
    this.updateFile();
  }

  private updateFile(): void {
    const a = this.fileFor ? this.ctx.state.agents[this.fileFor] : undefined;
    if (!a) return this.closeFile();
    if (!this.fileDyn) return;
    const content = this.ctx.content;
    const set = (key: string, v: number, text?: string): void => {
      const b = this.fileBars.get(key);
      if (!b) return;
      b.fill.style.width = `${Math.max(0, Math.min(100, v))}%`;
      setText(b.value, text ?? String(Math.round(v)));
    };
    for (const n of content.needs.needs) {
      set(`need.${n.id}`, a.needs[n.id]);
      const b = this.fileBars.get(`need.${n.id}`);
      b?.fill.parentElement?.classList.toggle('low', a.needs[n.id] < n.low && a.needs[n.id] >= n.critical);
      b?.fill.parentElement?.classList.toggle('critical', a.needs[n.id] < n.critical);
    }
    set('health', a.health);
    for (const s of content.skills) set(`skill.${s.id}`, a.skills[s.id] ?? 0);
    const pg = this.ctx.sim.career.progress(a);
    set('career', pg.ratio * 100, pg.next ? `${Math.floor(a.xp)}/${pg.to}` : String(Math.floor(a.xp)));
    setText(this.fileDyn.career, pg.next ? t('agent.careerNext', { rank: pg.next.rank, n: Math.max(0, Math.ceil(pg.to - a.xp)) }) : t('agent.careerTop'));
    if (this.fileDyn.title.isConnected) setText(this.fileDyn.title, `${a.rank} ${a.firstName} ${a.lastName}`);
    setText(this.fileDyn.activity, `${this.status(a)} · ${t('agent.stats', { efficiency: Math.round(a.efficiency * 100), fatigue: Math.round(100 - a.needs.sleep) })}`);
    const items = (a.gear ?? []).map((g) => content.equipment.items.find((i) => i.id === g)?.name ?? g);
    const cap = content.personnel(a.defId).ammoCapacity ?? 0;
    const home = a.homeId ? this.ctx.state.fob.buildings[a.homeId] : undefined;
    setText(
      this.fileDyn.gear,
      [
        items.length ? t('agent.gear', { items: items.join(', ') }) : t('agent.noGear'),
        cap > 0 ? t('agent.ammo', { n: Math.floor(a.ammo ?? cap), cap }) : '',
        home ? t('agent.home', { name: content.building(home.defId).name }) : t('agent.noHome'),
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
