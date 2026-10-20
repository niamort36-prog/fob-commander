/**
 * Interface de la carte tactique (visible uniquement quand la carte est ouverte) :
 * bandeau de titre, couches et légende, liste du renseignement et des personnalités,
 * fiche de l'objet sélectionné (village, contact, personnalité, unité, FOB).
 */
import type { GameContext } from '../core/GameContext';
import type { MapSelection } from '../core/GameEvents';
import { mapLayers, type MapLayer } from '../render/mapState';
import { gridRef } from '../render/regionMap';
import { sourceLabel } from '../systems/IntelSystem';
import { formatNumber, t } from '../utils/i18n';
import { clear, el, setText } from './dom';
import { drawPortrait } from './portrait';

const LAYERS: MapLayer[] = ['contacts', 'uncertainty', 'friendly', 'villages', 'personalities', 'coverage', 'sites', 'world'];

export class MapPanel {
  private readonly top: HTMLElement;
  private readonly side: HTMLElement;
  private readonly info: HTMLElement;
  private readonly intelList: HTMLElement;
  private readonly peopleList: HTMLElement;
  private readonly newsList: HTMLElement;
  private readonly status: HTMLElement;
  private open = false;
  private selected: MapSelection | null = null;
  private listSig = '';
  private infoSig = '';
  private readonly unsubs: (() => void)[] = [];

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    const def = ctx.content.region;
    this.status = el('span', { class: 'muted small' });
    this.top = el('div', { class: 'panel map-top hidden' }, [
      el('div', {}, [el('div', { class: 'map-title', text: t('map.title', { name: def.name, province: def.province }) }), this.status]),
      el('button', { class: 'btn', text: t('map.back'), onClick: () => ctx.bus.emit('ui:toggleMap', {}) }),
    ]);

    const layers = el('div', { class: 'map-layers' });
    for (const l of LAYERS) {
      const box = el('input', { attrs: { type: 'checkbox' } });
      box.checked = mapLayers[l];
      box.addEventListener('change', () => {
        mapLayers[l] = box.checked;
        ctx.bus.emit('ui:mapLayers', {});
      });
      layers.append(el('label', { class: 'map-layer' }, [box, t(`map.layer.${l}`)]));
    }
    const legend = el('div', { class: 'map-legend' }, [
      el('div', {}, [el('span', { class: 'sw sw-friend' }), t('map.legend.friend')]),
      el('div', {}, [el('span', { class: 'sw sw-hostile' }), t('map.legend.hostile')]),
      el('div', {}, [el('span', { class: 'sw sw-unknown' }), t('map.legend.unknown')]),
      el('div', {}, [el('span', { class: 'sw sw-dashed' }), t('map.legend.presumed')]),
      el('div', { class: 'muted small', text: t('map.legend.grades') }),
    ]);
    this.intelList = el('div', { class: 'map-list' });
    this.peopleList = el('div', { class: 'map-list' });
    this.newsList = el('div', { class: 'map-list' });
    this.side = el('div', { class: 'panel map-side hidden' }, [
      el('div', { class: 'section-title', text: t('map.layers') }),
      layers,
      el('div', { class: 'section-title', text: t('map.legend') }),
      legend,
      el('div', { class: 'section-title', text: t('map.intel') }),
      this.intelList,
      el('div', { class: 'section-title', text: t('map.people') }),
      this.peopleList,
      el('div', { class: 'section-title', text: t('map.incidents') }),
      this.newsList,
    ]);
    this.info = el('div', { class: 'panel info-panel map-info hidden' });
    parent.append(this.top, this.side, this.info);

    this.unsubs.push(
      ctx.bus.on('ui:mapToggled', ({ open }) => {
        this.open = open;
        this.top.classList.toggle('hidden', !open);
        this.side.classList.toggle('hidden', !open);
        if (!open) this.select(null);
        this.listSig = '';
        this.update();
      }),
      ctx.bus.on('ui:mapSelect', ({ target }) => {
        this.selected = target;
        this.infoSig = '';
        this.update();
      }),
    );
  }

  private select(target: MapSelection | null, focus?: { x: number; y: number }): void {
    this.ctx.bus.emit('ui:mapSelect', { target });
    if (focus) this.ctx.bus.emit('ui:mapFocus', focus);
  }

  update(): void {
    if (!this.open) {
      this.info.classList.add('hidden');
      return;
    }
    const intel = this.ctx.sim.intel;
    const region = this.ctx.state.region;
    const def = this.ctx.content.region;
    setText(this.status, t('map.status', { radius: intel.observationKm().toFixed(1), villages: intel.informantVillages().length, contacts: intel.knownContacts().length }));

    // Listes (reconstruites seulement si elles changent)
    const contacts = intel.knownContacts().sort((a, b) => b.reliability - a.reliability);
    const people = def.personalities.filter((p) => region.personalities[p.id]?.known);
    const news = [...(this.ctx.sim.world.region().incidents ?? [])].reverse().slice(0, 8);
    const sig = contacts.map((c) => `${c.id}${intel.grade(c)}`).join() + '|' + people.map((p) => p.id).join() + '|' + news.map((n) => n.tick).join();
    if (sig !== this.listSig) {
      this.listSig = sig;
      clear(this.intelList);
      if (contacts.length === 0) this.intelList.append(el('div', { class: 'muted small', text: t('map.noIntel') }));
      for (const c of contacts) {
        const cdef = intel.contactDef(c.id);
        const label = c.reliability < 0.3 ? t('map.unidentified') : def.contactKinds[cdef.kind].label;
        this.intelList.append(
          el('div', { class: 'map-row', onClick: () => this.select({ kind: 'contact', id: c.id }, c.estPos) }, [
            el('span', { class: `grade grade-${intel.grade(c)}`, text: intel.grade(c) }),
            el('span', { text: `${label} — ${gridRef(def, c.estPos.x, c.estPos.y)}` }),
          ]),
        );
      }
      clear(this.newsList);
      if (news.length === 0) this.newsList.append(el('div', { class: 'muted small', text: t('map.noIncident') }));
      for (const n of news) {
        const time = this.ctx.content.balance.time;
        const total = time.startHour * 60 + n.tick * time.minutesPerTick;
        const stamp = `J${Math.floor(total / 1440) + 1} ${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}h`;
        this.newsList.append(
          el('div', { class: `map-row news-${n.tone}`, onClick: () => this.select(null, n.pos) }, [el('span', { class: 'muted small', text: stamp }), el('span', { text: n.text })]),
        );
      }
      clear(this.peopleList);
      for (const p of people) {
        const v = def.villages.find((x) => x.id === p.village)!;
        this.peopleList.append(
          el('div', { class: 'map-row', onClick: () => this.select({ kind: 'personality', id: p.id }, v.pos) }, [
            el('span', { class: `stance stance-${p.stance}` }),
            el('span', { text: `${p.name} — ${v.name}` }),
          ]),
        );
      }
    }
    this.renderInfo();
  }

  private planButton(s: MapSelection): HTMLElement {
    const target = this.ctx.sim.missions.targetFrom(s);
    const possible = target ? this.ctx.sim.missions.typesFor(target).length > 0 : false;
    return el('button', {
      class: 'btn wide primary',
      text: t('map.planMission'),
      title: possible ? '' : t('map.noMission'),
      attrs: possible ? {} : { disabled: '' },
      onClick: () => this.ctx.bus.emit('ui:planMission', { target: s }),
    });
  }

  /** Distance depuis la FOB et durée du trajet selon le moyen (à pied, véhicule, hélicoptère). */
  private travelRows(p: { x: number; y: number }): [string, string][] {
    const fob = this.ctx.sim.intel.fobPos();
    const d = Math.hypot(p.x - fob.x, p.y - fob.y);
    const cfg = this.ctx.content.missions.config;
    return [
      [t('map.distance'), `${d.toFixed(1)} km`],
      ['', t('map.travel', { foot: (d / cfg.footSpeedKmh).toFixed(1), car: (d / cfg.vehicleSpeedKmh).toFixed(1), heli: Math.max(1, Math.round((d / cfg.heli.speedKmh) * 60)) })],
    ];
  }

  private bar(label: string, value: number, min: number, max: number, color: string): HTMLElement {
    const pct = ((value - min) / (max - min)) * 100;
    return el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label', text: label }),
      el('span', { class: 'bar' }, [el('span', { class: 'bar-fill', attrs: { style: `width:${pct}%;background:${color}` } })]),
      el('span', { class: 'bar-value', text: String(Math.round(value)) }),
    ]);
  }

  private renderInfo(): void {
    const s = this.selected;
    if (!s) {
      this.info.classList.add('hidden');
      return;
    }
    const def = this.ctx.content.region;
    const region = this.ctx.state.region;
    const intel = this.ctx.sim.intel;
    const rows: [string, string][] = [];
    const extra: HTMLElement[] = [];
    let title = '';
    let subtitle = '';
    let desc = '';
    let portrait: HTMLCanvasElement | null = null;

    if (s.kind === 'village') {
      const v = def.villages.find((x) => x.id === s.id)!;
      const st = region.villages[v.id];
      title = v.name;
      subtitle = t(`map.vtype.${v.type}`);
      desc = v.desc;
      rows.push([t('map.population'), formatNumber(v.population)], [t('map.tribe'), v.tribe], [t('map.grid'), gridRef(def, v.pos.x, v.pos.y)]);
      const leader = v.leader ? def.personalities.find((p) => p.id === v.leader) : null;
      if (leader) rows.push([t('map.leader'), region.personalities[leader.id]?.known ? leader.name : t('map.unknownPerson')]);
      const dip = this.ctx.sim.diplomacy;
      const vd = dip.village(v.id);
      rows.push([t('map.stance'), dip.stance(st.attitude).label]);
      if (v.needs.length) rows.push([t('map.needs'), dip.needs(v.id).map((n) => (n.satisfied ? `✓ ${t(`need.${n.need}`)}` : n.progress !== null ? `◷ ${t(`need.${n.need}`)}` : t(`need.${n.need}`))).join(', ')]);
      rows.push([t('map.informants'), st.attitude >= def.intel.informantAttitude ? t('map.yes') : t('map.no')]);
      rows.push(...this.travelRows(v.pos));
      if (vd?.auxiliaries) rows.push([t('map.auxiliaries'), String(vd.auxiliaries)]);
      if (vd?.promise) rows.push([t('map.promise'), t(`need.${vd.promise.need}`)]);
      if (vd?.demand) rows.push([t('map.demand'), t(`need.${vd.demand.need}`)]);
      extra.push(
        this.bar(t('map.attitude'), st.attitude, -100, 100, st.attitude >= 0 ? '#8fbf6a' : '#d0644a'),
        this.bar(t('map.influence'), st.influence, 0, 100, '#b03a2e'),
        el('button', { class: 'btn wide', text: t('map.diplomacy'), onClick: () => this.ctx.bus.emit('ui:openVillage', { id: v.id }) }),
        this.planButton(s),
      );
    } else if (s.kind === 'contact') {
      const c = region.contacts[s.id];
      if (!c || !c.known) return this.info.classList.add('hidden');
      const cdef = intel.contactDef(c.id);
      title = c.reliability < 0.3 ? t('map.unidentified') : def.contactKinds[cdef.kind].label;
      subtitle = c.reliability < 0.3 ? t('map.hostilePresumed') : cdef.label;
      rows.push(
        [t('map.grid'), `${gridRef(def, c.estPos.x, c.estPos.y)} (${c.estPos.x.toFixed(1)} / ${c.estPos.y.toFixed(1)} km)`],
        [t('map.reliability'), `${intel.grade(c)} — ${Math.round(c.reliability * 100)} %`],
        [t('map.error'), `± ${c.error.toFixed(1)} km`],
        [t('map.lastSeen'), t('map.hoursAgo', { h: Math.round(intel.ageHours(c)) })],
        [t('map.source'), sourceLabel(c.source)],
      );
      rows.push(...this.travelRows(c.estPos));
      extra.push(this.planButton(s));
    } else if (s.kind === 'site') {
      const site = def.sites.find((x) => x.id === s.id)!;
      const kind = def.siteKinds[site.kind];
      title = site.name;
      subtitle = `${t('map.siteKind')} — ${kind.label}`;
      desc = kind.desc;
      const seen = this.ctx.sim.world.region().sitesVisited?.[site.id];
      const days = seen !== undefined ? Math.floor(((this.ctx.state.time.tick - seen) * this.ctx.content.balance.time.minutesPerTick) / 1440) : null;
      rows.push([t('map.grid'), gridRef(def, site.pos.x, site.pos.y)], [t('map.visited'), days === null ? t('map.never') : t('map.daysAgo', { d: days })]);
      rows.push(...this.travelRows(site.pos));
      extra.push(this.planButton(s));
    } else if (s.kind === 'sector') {
      const target = this.ctx.sim.missions.targetFrom(s)!;
      title = target.name;
      subtitle = gridRef(def, target.pos.x, target.pos.y);
      desc = t('map.sectorDesc', { km: def.gridKm });
      rows.push(...this.travelRows(target.pos));
      extra.push(this.planButton(s));
    } else if (s.kind === 'actor') {
      const a = this.ctx.sim.world.region().actors?.[s.id];
      if (!a) return this.info.classList.add('hidden');
      title = a.label;
      subtitle = t(a.side === 'allied' ? 'map.actor.allied' : 'map.actor.civilian');
      rows.push([t('map.actor.dest'), `${a.destName} (${t(`map.actor.phase.${a.phase}`)})`], [t('map.grid'), gridRef(def, a.pos.x, a.pos.y)]);
    } else if (s.kind === 'personality') {
      const p = def.personalities.find((x) => x.id === s.id)!;
      const v = def.villages.find((x) => x.id === p.village)!;
      title = p.name;
      subtitle = p.role;
      desc = p.desc;
      portrait = el('canvas', { class: 'portrait small' });
      drawPortrait(portrait, p.portrait);
      rows.push([t('map.village'), v.name], [t('map.stance'), t(`map.stance.${p.stance}`)], [t('map.met'), region.personalities[p.id]?.met ? t('map.yes') : t('map.no')]);
    } else if (s.kind === 'friendly') {
      const u = def.friendlyUnits.find((x) => x.id === s.id)!;
      title = u.name;
      subtitle = t(`map.faction.${u.faction}`);
      rows.push([t('map.grid'), gridRef(def, u.pos.x, u.pos.y)]);
    } else if (s.kind === 'mission') {
      const m = this.ctx.state.missions[s.id];
      if (!m || m.phase === 'done') return this.info.classList.add('hidden');
      const mdef = this.ctx.content.missionType(m.defId);
      title = m.callsign;
      subtitle = `${mdef.name} — ${m.target.name}`;
      const time = this.ctx.content.balance.time;
      const total = time.startHour * 60 + m.phaseEndTick * time.minutesPerTick;
      const eta = `J${Math.floor(total / 1440) + 1} ${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      rows.push(
        [t('map.phaseLabel'), t(`mission.phase.${m.phase}`, { eta })],
        [t('map.members'), String(m.memberIds.length)],
        [t('map.vehiclesLabel'), String(m.vehicleIds.length)],
        [t('map.estimate'), `${Math.round(Math.max(0.03, Math.min(0.97, m.estimate + m.mods.success)) * 100)} %`],
      );
      for (const l of m.radioLog.slice(-4)) extra.push(el('div', { class: 'muted small', text: `• ${l.text}` }));
    } else {
      const fob = intel.fobPos();
      title = `FOB — ${this.ctx.site.name}`;
      subtitle = t('map.yourBase');
      rows.push(
        [t('map.grid'), gridRef(def, fob.x, fob.y)],
        [t('map.observation'), `${intel.observationKm().toFixed(1)} km`],
        [t('map.informantVillages'), String(intel.informantVillages().length)],
        [t('map.knownContacts'), String(intel.knownContacts().length)],
      );
      extra.push(this.planButton(s));
    }

    const sig = `${JSON.stringify(s)}|${title}|${rows.map((r) => r[1]).join('|')}|${extra.map((e) => e.textContent).join()}`;
    if (sig === this.infoSig) return;
    this.infoSig = sig;
    this.info.classList.remove('hidden');
    clear(this.info);
    this.info.append(
      el('div', { class: 'panel-title' }, [title, el('button', { class: 'btn close', text: '×', onClick: () => this.select(null) })]),
      el('div', { class: 'muted small', text: subtitle }),
      portrait ? el('div', { class: 'map-portrait' }, [portrait]) : '',
      desc ? el('p', { class: 'desc', text: desc }) : '',
      el('table', { class: 'kv' }, rows.map(([k, v]) => el('tr', {}, [el('td', { text: k }), el('td', { text: v })]))),
      ...extra,
    );
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.top.remove();
    this.side.remove();
    this.info.remove();
  }
}
