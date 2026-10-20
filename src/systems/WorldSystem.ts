/**
 * WorldSystem — le monde vivant de la carte régionale.
 *
 *  - Groupes ennemis mobiles avec de vrais objectifs (heure par heure) :
 *    combattants qui patrouillent entre villages sous emprise et caches, et s'approchent parfois de
 *    la FOB ; équipes mortier qui alternent cachette et position de tir près de la FOB, puis changent
 *    de place après avoir tiré ; cellules IED qui posent des engins sur les routes.
 *  - Patrouilles des forces afghanes (depuis les unités alliées) et circulation civile (marchands,
 *    bergers, pèlerins, familles, convois humanitaires) entre villages, bourgs et lieux d'intérêt.
 *  - Rencontres entre ces acteurs : accrochages, embuscades, vols, engins explosifs. Elles changent
 *    l'emprise insurgée, l'attitude des villages et la stabilité, et renseignent la base.
 *  - Rencontres des unités en mission avec les vrais groupes ennemis et les engins posés : qui voit
 *    l'autre en premier (compétence, nuit, vision nocturne, thermique, optiques, véhicules,
 *    hélicoptère) décide de l'embuscade ou de l'avantage.
 */
import type { BehaviourDef, ContactDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { Agent, ContactState, EnemyTask, KmPos, MissionInstance, PlantedIed, RegionState, WorldActor } from '../core/GameState';
import { pushLog } from '../core/Log';
import { gain } from '../core/resources';
import { newId } from '../utils/ids';
import { t } from '../utils/i18n';
import type { System } from './System';
import { isNightHour } from './modules';

const dist = (a: KmPos, b: KmPos): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Points d'une direction en toutes lettres (radio). */
export function bearingText(from: KmPos, to: KmPos): string {
  const a = (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
  const dirs = ['au nord', 'au nord-est', "à l'est", 'au sud-est', 'au sud', 'au sud-ouest', "à l'ouest", 'au nord-ouest'];
  return dirs[Math.round((((a % 360) + 360) % 360) / 45) % 8];
}

/** Référence de carroyage (A1, B3…) d'un point. */
export function gridRefOf(width: number, height: number, gridKm: number, x: number, y: number): string {
  const col = String.fromCharCode(65 + Math.min(Math.floor(width / gridKm) - 1, Math.max(0, Math.floor(x / gridKm))));
  const row = Math.min(Math.floor(height / gridKm), Math.max(1, Math.floor(y / gridKm) + 1));
  return `${col}${row}`;
}

export class WorldSystem implements System {
  readonly id = 'world';
  private roadPoints: KmPos[] | null = null;

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('time:hour', () => this.hourly());
    ctx.bus.on('combat:ended', () => this.afterAttack());
  }

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private hoursToTicks(h: number): number {
    return Math.round((h * 60) / this.ctx.content.balance.time.minutesPerTick);
  }

  private get beh(): BehaviourDef {
    return this.ctx.content.region.behaviour;
  }

  private rand(a: number, b: number): number {
    return a + (b - a) * this.ctx.random();
  }

  private pick<T>(list: T[]): T | undefined {
    return list.length ? list[Math.floor(this.ctx.random() * list.length)] : undefined;
  }

  /** État régional, avec les champs du monde vivant initialisés (anciennes sauvegardes). */
  region(): RegionState {
    const r = this.ctx.state.region;
    r.actors ??= {};
    r.ieds ??= [];
    r.incidents ??= [];
    r.sitesVisited ??= {};
    return r;
  }

  fob(): KmPos {
    return this.ctx.site.regionPos;
  }

  private clampMap(p: KmPos): KmPos {
    const { width, height } = this.ctx.content.region.size;
    return { x: Math.min(width - 0.3, Math.max(0.3, p.x)), y: Math.min(height - 0.3, Math.max(0.3, p.y)) };
  }

  private around(c: KmPos, rMin: number, rMax: number): KmPos {
    const a = this.ctx.random() * Math.PI * 2;
    const r = this.rand(rMin, rMax);
    return this.clampMap({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }

  private def(c: ContactState): ContactDef {
    return this.ctx.sim.intel.contactDef(c.id);
  }

  kindOf(c: ContactState): string {
    return this.def(c).kind;
  }

  /** Village le plus proche d'un point (et sa distance). */
  nearestVillage(p: KmPos): { id: string; name: string; d: number } | null {
    let best: { id: string; name: string; d: number } | null = null;
    for (const v of this.ctx.content.region.villages) {
      const d = dist(v.pos, p);
      if (!best || d < best.d) best = { id: v.id, name: v.name, d };
    }
    return best;
  }

  private placeName(p: KmPos): string {
    const v = this.nearestVillage(p);
    const site = this.ctx.content.region.sites.reduce<{ name: string; d: number } | null>((b, s) => {
      const d = dist(s.pos, p);
      return !b || d < b.d ? { name: s.name, d } : b;
    }, null);
    if (site && (!v || site.d < v.d)) return site.name;
    return v?.name ?? gridRefOf(this.ctx.content.region.size.width, this.ctx.content.region.size.height, this.ctx.content.region.gridKm, p.x, p.y);
  }

  /** Fait marquant affiché sur la carte et dans le journal. */
  private incident(pos: KmPos, text: string, tone: 'good' | 'bad' | 'info'): void {
    const r = this.region();
    r.incidents!.push({ pos: { ...pos }, tick: this.now, text, tone });
    if (r.incidents!.length > 40) r.incidents!.shift();
    pushLog(this.ctx, tone === 'bad' ? 'warn' : tone === 'good' ? 'good' : 'info', 'log.world', { text });
  }

  private adjustNear(p: KmPos, attitude: number, influence: number): void {
    const v = this.nearestVillage(p);
    if (v && v.d <= 8) this.ctx.sim.intel.adjustVillage(v.id, attitude, influence);
  }

  private stability(delta: number): void {
    const r = this.ctx.state.region;
    r.stability = Math.max(0, Math.min(100, r.stability + delta));
  }

  // ------------------------------------------------------------ Routes

  private roads(): KmPos[] {
    if (this.roadPoints) return this.roadPoints;
    const pts: KmPos[] = [];
    for (const road of this.ctx.content.region.roads) {
      for (let i = 0; i + 1 < road.points.length; i++) {
        const [x0, y0] = road.points[i];
        const [x1, y1] = road.points[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 1.5));
        for (let k = 0; k < n; k++) pts.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n });
      }
    }
    this.roadPoints = pts;
    return pts;
  }

  // ------------------------------------------------------------ Groupes ennemis

  private hideouts(home: KmPos, range: number): KmPos[] {
    const kinds = this.ctx.content.region.siteKinds;
    return this.ctx.content.region.sites.filter((s) => kinds[s.kind]?.hideout && dist(s.pos, home) <= range).map((s) => s.pos);
  }

  private task(type: EnemyTask['type'], dest: KmPos): EnemyTask {
    return { type, dest: this.clampMap(dest), arrived: false, until: 0 };
  }

  /** Prochain objectif d'un groupe selon son type. */
  private nextTask(c: ContactState): EnemyTask | null {
    const kind = this.kindOf(c);
    const home = this.def(c).pos;
    const fob = this.fob();
    const prev = c.task?.type;
    if (kind === 'cell') {
      const b = this.beh.cell;
      if (prev !== 'approach' && dist(home, fob) <= b.rangeKm + b.approachKm[1] && this.ctx.random() < b.approachChance) {
        return this.task('approach', this.around(fob, b.approachKm[0], b.approachKm[1]));
      }
      const r = this.ctx.state.region;
      const villages = this.ctx.content.region.villages.filter((v) => dist(v.pos, home) <= b.rangeKm && (r.villages[v.id]?.influence ?? 0) >= 30).map((v) => this.around(v.pos, 0.3, 1.2));
      const spots = [...villages, ...this.hideouts(home, b.rangeKm), home];
      return this.task(prev === 'approach' ? 'rest' : 'patrol', this.pick(spots) ?? home);
    }
    if (kind === 'mortar') {
      const b = this.beh.mortar;
      const hide = this.pick([...this.hideouts(home, b.rangeKm), home]) ?? home;
      if (prev === 'hide' && dist(home, fob) <= b.rangeKm + b.firingKm[1]) return this.task('firing', this.around(fob, b.firingKm[0], b.firingKm[1]));
      return this.task('hide', hide);
    }
    if (kind === 'ied') {
      const b = this.beh.ied;
      const r = this.region();
      if (prev !== 'plant' && r.ieds!.length < b.maxIeds) {
        const near = this.roads().filter((p) => dist(p, home) <= b.rangeKm && dist(p, fob) <= b.roadKm && dist(p, fob) > 2.5);
        const spot = this.pick(near.length ? near : this.roads().filter((p) => dist(p, home) <= b.rangeKm));
        if (spot) return this.task('plant', spot);
      }
      return this.task('hide', this.pick([...this.hideouts(home, b.rangeKm), home]) ?? home);
    }
    return null; // QG, camps et caches ne bougent pas
  }

  private dwell(c: ContactState, type: EnemyTask['type']): number {
    const b = this.beh;
    switch (type) {
      case 'approach':
        return this.rand(b.cell.approachHours[0], b.cell.approachHours[1]);
      case 'firing':
        return this.rand(b.mortar.firingHours[0], b.mortar.firingHours[1]);
      case 'hide':
        return this.kindOf(c) === 'ied' ? this.rand(b.ied.hideHours[0], b.ied.hideHours[1]) : this.rand(b.mortar.hideHours[0], b.mortar.hideHours[1]);
      case 'plant':
        return b.ied.plantHours;
      default:
        return this.rand(b.cell.restHours[0], b.cell.restHours[1]);
    }
  }

  private speed(c: ContactState): number {
    const kind = this.kindOf(c) as 'cell' | 'mortar' | 'ied';
    return this.beh[kind]?.speedKmh ?? 0;
  }

  private moveEnemies(): void {
    for (const c of Object.values(this.ctx.state.region.contacts)) {
      c.strength ??= 1;
      if (!this.speed(c)) continue;
      c.task ??= this.nextTask(c) ?? undefined;
      const task = c.task;
      if (!task) continue;
      if (!task.arrived) {
        const d = dist(c.truePos, task.dest);
        const step = this.speed(c);
        if (d <= step) {
          c.truePos = { ...task.dest };
          task.arrived = true;
          task.until = this.now + this.hoursToTicks(this.dwell(c, task.type));
        } else {
          c.truePos = { x: c.truePos.x + ((task.dest.x - c.truePos.x) / d) * step, y: c.truePos.y + ((task.dest.y - c.truePos.y) / d) * step };
        }
      } else if (this.now >= task.until) {
        if (task.type === 'plant') this.plantIed(c);
        c.task = this.nextTask(c) ?? undefined;
      }
    }
  }

  private plantIed(c: ContactState): void {
    const r = this.region();
    if (r.ieds!.length >= this.beh.ied.maxIeds) return;
    r.ieds!.push({ id: newId(this.ctx.state, 'ied'), pos: { ...c.truePos }, tick: this.now, by: c.id });
  }

  /** Groupe d'un type arrivé en position près de la FOB (mortier en batterie, combattants à l'affût). */
  inPosition(kind: string): ContactState | null {
    const fob = this.fob();
    let best: ContactState | null = null;
    for (const c of Object.values(this.ctx.state.region.contacts)) {
      if (this.kindOf(c) !== kind || !c.task?.arrived) continue;
      if (c.task.type !== 'firing' && c.task.type !== 'approach') continue;
      if (!best || dist(c.truePos, fob) < dist(best.truePos, fob)) best = c;
    }
    return best;
  }

  /** Engins posés à moins de km de la FOB. */
  iedsNear(km: number, p = this.fob()): PlantedIed[] {
    return this.region().ieds!.filter((i) => dist(i.pos, p) <= km);
  }

  /** Retire l'engin le plus proche (découvert près de la base). */
  takeIedNear(km: number): PlantedIed | null {
    const near = this.iedsNear(km).sort((a, b) => dist(a.pos, this.fob()) - dist(b.pos, this.fob()));
    if (!near[0]) return null;
    const r = this.region();
    r.ieds = r.ieds!.filter((i) => i.id !== near[0].id);
    return near[0];
  }

  /** Après une attaque : le groupe qui a tiré est localisé à sa position de tir, puis il décroche. */
  private afterAttack(): void {
    const c = this.inPosition('mortar') ?? this.inPosition('cell');
    if (!c) return;
    this.ctx.sim.intel.report(c.id, this.ctx.content.region.intel.attackRevealReliability, 'attack');
    const kind = this.kindOf(c);
    const home = this.def(c).pos;
    const range = kind === 'mortar' ? this.beh.mortar.rangeKm : this.beh.cell.rangeKm;
    c.task = this.task(kind === 'mortar' ? 'hide' : 'rest', this.pick([...this.hideouts(home, range), home]) ?? home);
  }

  /** Pertes infligées à un groupe ennemi ; détruit à zéro. Renvoie true si détruit. */
  damageEnemy(id: string, amount: number, by: 'coalition' | 'allied'): boolean {
    const c = this.ctx.state.region.contacts[id];
    if (!c || amount <= 0) return false;
    c.strength = (c.strength ?? 1) - amount;
    if (c.strength > 0.05) {
      // Un groupe éprouvé décroche vers sa base
      if (this.speed(c)) c.task = this.task('hide', this.def(c).pos);
      return false;
    }
    const label = this.def(c).label;
    this.ctx.sim.diplomacy.onContactNeutralized(id, this.kindOf(c));
    delete this.ctx.state.region.contacts[id];
    this.incident(c.truePos, t('log.enemyDestroyed', { label }), by === 'coalition' ? 'good' : 'info');
    this.ctx.bus.emit('intel:contact', { id });
    return true;
  }

  // ------------------------------------------------------------ Patrouilles alliées et civils

  private spawnActors(): void {
    const r = this.region();
    const w = this.ctx.content.region.world;
    const actors = Object.values(r.actors!);
    // Patrouilles des forces afghanes (une par unité alliée au plus)
    for (const u of this.ctx.content.region.friendlyUnits) {
      if (u.faction !== 'allied') continue;
      const kind = u.icon === 'police' ? 'police' : 'army';
      const cfg = w.allied[kind];
      if (!cfg || actors.some((a) => a.id.startsWith(`${u.id}:`)) || this.ctx.random() >= cfg.spawnChancePerHour) continue;
      const villages = this.ctx.content.region.villages.filter((v) => dist(v.pos, u.pos) <= cfg.patrolKm);
      const dest = this.pick(villages);
      const destPos = dest ? this.around(dest.pos, 0.2, 1) : this.around(u.pos, 3, cfg.patrolKm);
      const id = `${u.id}:${newId(this.ctx.state, 'pat')}`;
      r.actors![id] = { id, side: 'allied', kind, label: cfg.label, pos: { ...u.pos }, dest: destPos, home: { ...u.pos }, destName: dest?.name ?? this.placeName(destPos), phase: 'out', until: 0, strength: 1 };
    }
    // Circulation civile
    const civ = actors.filter((a) => a.side === 'civilian').length;
    if (civ >= w.civilians.max || this.ctx.random() >= w.civilians.spawnChancePerHour) return;
    const kinds = Object.entries(w.civilians.kinds);
    let x = this.ctx.random() * kinds.reduce((s, [, k]) => s + k.weight, 0);
    let chosen = kinds[0];
    for (const k of kinds) {
      x -= k[1].weight;
      if (x <= 0) {
        chosen = k;
        break;
      }
    }
    const [kind, cfg] = chosen;
    const villages = this.ctx.content.region.villages;
    const from = this.pick(villages)!;
    let dest: { pos: KmPos; name: string } | undefined;
    const others = villages.filter((v) => v.id !== from.id && dist(v.pos, from.pos) <= 30);
    if (kind === 'merchant' || kind === 'family') dest = this.pick(others.filter((v) => v.type === 'town')) ?? this.pick(others);
    else if (kind === 'pilgrims') dest = this.pick(this.ctx.content.region.sites.filter((s) => s.kind === 'shrine' && dist(s.pos, from.pos) <= 35));
    else if (kind === 'aid') dest = this.pick(others.filter((v) => v.needs.some((n) => n === 'health' || n === 'water')));
    else dest = { pos: this.around(from.pos, 1, 3.5), name: t('map.pastures') };
    if (!dest) return;
    const id = newId(this.ctx.state, 'civ');
    r.actors![id] = { id, side: 'civilian', kind, label: cfg.label, pos: { ...from.pos }, dest: { ...dest.pos }, home: { ...from.pos }, destName: dest.name, phase: 'out', until: 0, strength: 1 };
  }

  /** Désignation de l'acteur dans une phrase (« une patrouille de police »). */
  private indef(a: WorldActor): string {
    const w = this.ctx.content.region.world;
    return (a.side === 'allied' ? w.allied[a.kind]?.indef : w.civilians.kinds[a.kind]?.indef) ?? a.label.toLowerCase();
  }

  private actorSpeed(a: WorldActor): number {
    const w = this.ctx.content.region.world;
    return a.side === 'allied' ? (w.allied[a.kind]?.speedKmh ?? 8) : (w.civilians.kinds[a.kind]?.speedKmh ?? 4);
  }

  private moveActors(): void {
    const r = this.region();
    for (const a of Object.values(r.actors!)) {
      if (a.phase === 'stay') {
        if (this.now >= a.until) {
          a.phase = 'back';
          a.dest = { ...a.home };
        }
        continue;
      }
      const d = dist(a.pos, a.dest);
      const step = this.actorSpeed(a);
      if (d > step) {
        a.pos = { x: a.pos.x + ((a.dest.x - a.pos.x) / d) * step, y: a.pos.y + ((a.dest.y - a.pos.y) / d) * step };
        continue;
      }
      a.pos = { ...a.dest };
      if (a.phase === 'back') {
        delete r.actors![a.id];
        continue;
      }
      a.phase = 'stay';
      const rest = a.side === 'allied' ? (this.ctx.content.region.world.allied[a.kind]?.restHours ?? [2, 4]) : [1, 4];
      a.until = this.now + this.hoursToTicks(this.rand(rest[0], rest[1]));
      // Une patrouille alliée rassure le village où elle s'arrête
      if (a.side === 'allied') this.adjustNear(a.pos, 0.5, -0.5);
    }
  }

  /** Rencontres entre acteurs du monde et groupes ennemis, engins sur les routes. */
  private worldEncounters(): void {
    const r = this.region();
    const w = this.ctx.content.region.world;
    const intelCfg = this.ctx.content.region.intel;
    for (const a of Object.values(r.actors!)) {
      // Les forces alliées signalent à la base les groupes qu'elles aperçoivent
      if (a.side === 'allied') {
        for (const c of Object.values(r.contacts)) if (dist(c.truePos, a.pos) <= w.intelKm && this.ctx.random() < 0.5) this.ctx.sim.intel.report(c.id, 0.6, 'allied');
      }
      for (const c of Object.values(r.contacts)) {
        if (!r.actors![a.id] || dist(c.truePos, a.pos) > w.encounterKm) continue;
        const kind = this.kindOf(c);
        if (kind !== 'cell' && kind !== 'mortar' && kind !== 'ied') continue;
        if (this.ctx.random() > 0.6) continue; // pas forcément de contact pour autant
        const where = this.placeName(a.pos);
        const label = this.def(c).label;
        if (a.side === 'allied') {
          const power = w.allied[a.kind]?.power ?? 0.4;
          const enemy = (c.strength ?? 1) * (kind === 'cell' ? 0.6 : 0.3);
          if (this.ctx.random() < power / (power + enemy)) {
            const destroyed = this.damageEnemy(c.id, this.rand(0.3, 0.7), 'allied');
            this.adjustNear(a.pos, 1, -4);
            this.stability(1);
            if (!destroyed) this.incident(a.pos, t('world.alliedWin', { unit: this.indef(a), enemy: label, place: where }), 'good');
          } else {
            a.strength -= 0.5;
            this.adjustNear(a.pos, -2, 5);
            this.stability(-2);
            this.incident(a.pos, t('world.alliedLoss', { unit: this.indef(a), enemy: label, place: where }), 'bad');
            if (a.strength <= 0) delete r.actors![a.id];
            else {
              a.phase = 'back';
              a.dest = { ...a.home };
            }
          }
        } else if (kind === 'cell') {
          // Civils rançonnés ; s'ils sont d'un village ami, ils préviennent la base
          this.adjustNear(a.pos, 0, 2);
          const v = this.nearestVillage(a.home);
          const friendly = v && (r.villages[v.id]?.attitude ?? 0) >= intelCfg.informantAttitude;
          if (friendly) this.ctx.sim.intel.report(c.id, 0.45, 'village');
          this.incident(a.pos, t(friendly ? 'world.civilianReport' : 'world.civilianRobbed', { who: this.indef(a), enemy: label, place: where }), friendly ? 'info' : 'bad');
          a.phase = 'back';
          a.dest = { ...a.home };
        }
      }
      // Engins explosifs sur l'itinéraire
      if (!r.actors![a.id]) continue;
      const ied = r.ieds!.find((i) => dist(i.pos, a.pos) <= 0.8);
      if (!ied) continue;
      r.ieds = r.ieds!.filter((i) => i.id !== ied.id);
      const where = this.placeName(ied.pos);
      if (a.side === 'allied' && this.ctx.random() < 0.5) {
        this.stability(1);
        this.incident(ied.pos, t('world.iedCleared', { unit: this.indef(a), place: where }), 'good');
      } else if (a.side === 'allied') {
        this.stability(-2);
        this.adjustNear(ied.pos, 0, 2);
        this.incident(ied.pos, t('world.iedHitAllied', { unit: this.indef(a), place: where }), 'bad');
        a.strength -= 0.5;
        if (a.strength <= 0) delete r.actors![a.id];
      } else {
        // Des civils tués : colère contre les poseurs de bombes
        this.stability(-3);
        this.adjustNear(ied.pos, 3, -3);
        this.incident(ied.pos, t('world.iedHitCivilians', { who: this.indef(a), place: where }), 'bad');
        delete r.actors![a.id];
      }
    }
  }

  private expire(): void {
    const r = this.region();
    const life = this.hoursToTicks(this.beh.ied.iedLifeHours);
    r.ieds = r.ieds!.filter((i) => this.now - i.tick < life);
    const keep = this.hoursToTicks(this.ctx.content.region.world.incidentHours);
    r.incidents = r.incidents!.filter((i) => this.now - i.tick < keep);
  }

  /** Un groupe arrivé en position près de la FOB passe à l'acte (selon la menace du site). */
  private enemyAttacks(): void {
    const threat = this.ctx.site.threat * this.ctx.sim.diplomacy.threatMult();
    const night = this.night();
    if (this.inPosition('mortar') && this.ctx.random() < 0.16 * threat) {
      this.ctx.sim.events.tryTrigger('mortar_attack');
      return;
    }
    if (this.inPosition('cell') && this.ctx.random() < 0.12 * threat) this.ctx.sim.events.tryTrigger(night ? 'night_assault' : 'harassment');
  }

  private hourly(): void {
    if (!this.ctx.state.region.initialized) return;
    this.moveEnemies();
    this.enemyAttacks();
    this.spawnActors();
    this.moveActors();
    this.worldEncounters();
    this.expire();
  }

  // ------------------------------------------------------------ Rencontres des unités en mission

  onTick(): void {
    if (!this.ctx.state.region.initialized) return;
    const every = Math.max(1, Math.round(this.beh.encounter.checkEveryMin / this.ctx.content.balance.time.minutesPerTick));
    if (this.now % every !== 0) return;
    for (const m of this.ctx.sim.missions.active()) {
      if (m.phase !== 'outbound' && m.phase !== 'objective' && m.phase !== 'inbound') continue;
      if (m.heliId && m.phase !== 'objective') continue; // en vol : pas de rencontre au sol
      this.checkMission(m);
    }
  }

  private members(m: MissionInstance): Agent[] {
    return m.memberIds.map((id) => this.ctx.state.agents[id]).filter(Boolean);
  }

  private avgSkill(m: MissionInstance, skill: string): number {
    const list = this.members(m);
    return list.length ? list.reduce((s, a) => s + (a.skills[skill] ?? 30), 0) / list.length : 30;
  }

  /** Part de l'équipe équipée d'un article (0..1). */
  private gearShare(m: MissionInstance, item: string): number {
    const list = this.members(m);
    return list.length ? list.filter((a) => a.gear?.includes(item)).length / list.length : 0;
  }

  private night(): boolean {
    return isNightHour(this.ctx.content, Math.floor(this.ctx.state.time.minuteOfDay / 60));
  }

  /** Chance que l'unité repère l'ennemi en premier (et inversement). */
  detection(m: MissionInstance, c: ContactState | null): { ours: number; theirs: number } {
    const e = this.beh.encounter;
    const night = this.night();
    const stealth = (this.avgSkill(m, 'stealth') - 40) / 200;
    let ours = e.ourBase + stealth + (this.avgSkill(m, 'radio') - 40) / 400;
    if (c?.known) ours += e.knownBonus * c.reliability;
    if (m.defId === 'sector_patrol' || m.defId === 'recon') ours += e.sweepBonus;
    if (night) ours -= e.nightPenalty;
    for (const [item, g] of Object.entries(e.gear)) ours += this.gearShare(m, item) * ((night ? g.night : g.day) ?? 0);
    let theirs = e.theirBase - stealth;
    if (m.vehicleIds.length) theirs += e.motorizedExposure;
    if (m.heliId) theirs += e.heliExposure;
    if (night) theirs -= e.enemyNightPenalty;
    const clamp = (v: number): number => Math.max(0.05, Math.min(0.95, v));
    return { ours: clamp(ours), theirs: clamp(theirs) };
  }

  private checkMission(m: MissionInstance): void {
    const r = this.region();
    const e = this.beh.encounter;
    const pos = this.ctx.sim.missions.position(m);
    const range = m.vehicleIds.length ? e.motorizedKm : e.footKm;
    m.encountered ??= [];
    for (const c of Object.values(r.contacts)) {
      if (m.encountered.includes(c.id) || dist(c.truePos, pos) > range) continue;
      // L'objectif d'un raid est traité à l'arrivée sur l'objectif
      if (m.target.kind === 'contact' && m.target.id === c.id) continue;
      m.encountered.push(c.id);
      this.encounter(m, c, pos);
    }
    if (m.heliId) return;
    const ied = r.ieds!.find((i) => !m.encountered!.includes(i.id) && dist(i.pos, pos) <= e.iedKm);
    if (ied) {
      m.encountered.push(ied.id);
      this.iedEncounter(m, ied);
    }
  }

  private queueRadio(m: MissionInstance, radioId: string, contactId?: string): void {
    if (!this.ctx.content.radio.messages.some((x) => x.id === radioId)) return;
    this.ctx.state.radio.queue.push({ missionId: m.id, radioId, contactId });
    m.radioUsed = [...(m.radioUsed ?? []), radioId];
  }

  private encounter(m: MissionInstance, c: ContactState, _pos: KmPos): void {
    const kind = this.kindOf(c);
    const mobile = kind === 'cell' || kind === 'mortar' || kind === 'ied';
    const det = this.detection(m, c);
    const weSee = this.ctx.random() < det.ours;
    const theySee = mobile && this.ctx.random() < det.theirs * (kind === 'cell' ? 1 : 0.8);
    if (!weSee && !theySee) return; // passage à proximité sans que personne ne s'en aperçoive
    const e = this.beh.encounter;
    const label = weSee ? this.def(c).label : t('map.unidentified');
    this.ctx.sim.missions.log(m, t('mission.logEncounter', { label }));
    if (weSee) this.ctx.sim.intel.report(c.id, 0.8, 'mission');
    if (weSee && !theySee) {
      m.mods.success += e.spottedSuccess;
      this.queueRadio(m, mobile ? `enc_spot_${kind}` : 'enc_spot_static', c.id);
    } else if (!weSee && theySee) {
      if (kind === 'cell') {
        m.mods.casualty += e.ambushCasualty;
        this.queueRadio(m, 'enc_ambush', c.id);
      } else this.queueRadio(m, 'enc_evaded', c.id);
    } else {
      this.queueRadio(m, kind === 'cell' ? 'enc_meeting' : 'enc_evaded', c.id);
    }
  }

  private iedEncounter(m: MissionInstance, ied: PlantedIed): void {
    const r = this.region();
    r.ieds = r.ieds!.filter((i) => i.id !== ied.id);
    const e = this.beh.encounter;
    const night = this.night();
    let find = e.iedFindBase + (this.avgSkill(m, 'mechanics') - 30) / 200 + (this.avgSkill(m, 'stealth') - 40) / 300;
    find += night ? this.gearShare(m, 'thermal') * 0.2 + this.gearShare(m, 'nvg') * 0.1 - 0.1 : this.gearShare(m, 'optics') * 0.08;
    if (m.defId === 'sector_patrol') find += 0.1;
    if (this.ctx.random() < Math.max(0.05, Math.min(0.9, find))) {
      this.queueRadio(m, 'ied_route');
      return;
    }
    this.ctx.sim.missions.log(m, t('mission.logIedHit'));
    m.mods.casualty += 0.15;
    this.queueRadio(m, m.vehicleIds.length ? 'ied_hit' : 'enc_ied_foot');
  }

  /** À l'arrivée sur l'objectif d'un raid : l'ennemi visé est-il toujours là ? */
  onObjective(m: MissionInstance): void {
    if (m.target.kind !== 'contact' || !m.target.id) return;
    const c = this.ctx.state.region.contacts[m.target.id];
    const e = this.beh.encounter;
    if (c && dist(c.truePos, m.target.pos) <= e.targetMovedKm) return;
    m.targetMoved = true;
    m.mods.success += e.targetMovedSuccess;
    this.ctx.sim.missions.log(m, t('mission.logTargetMoved'));
    if (c) this.ctx.sim.intel.report(c.id, 0.35, 'mission');
    this.queueRadio(m, 'target_absent', c?.id);
  }

  // ------------------------------------------------------------ Lieux et secteurs

  /** Effets d'une mission réussie sur un lieu d'intérêt ou un secteur ; renvoie les gains à afficher. */
  visit(m: MissionInstance, partial: boolean): string[] {
    const out: string[] = [];
    const r = this.region();
    let clearKm = 0;
    if (m.target.kind === 'site' && m.target.id) {
      const site = this.ctx.content.region.sites.find((s) => s.id === m.target.id);
      const kind = site ? this.ctx.content.region.siteKinds[site.kind] : null;
      if (!site || !kind) return out;
      r.sitesVisited![site.id] = this.now;
      const v = kind.visit;
      if (v.revealKm) {
        const n = this.ctx.sim.missions.revealAround(site.pos, v.revealKm * (partial ? 0.6 : 1));
        if (n) out.push(t('fx.revealed', { n }));
      }
      if (!partial && v.cacheChance && v.ammo && this.ctx.random() < v.cacheChance) {
        const ammo = Math.round(this.rand(v.ammo[0], v.ammo[1]));
        gain(this.ctx.state, { ammo });
        this.adjustNear(site.pos, 0, -4);
        out.push(t('fx.cacheFound', { ammo }));
        this.incident(site.pos, t('world.cacheFound', { place: site.name }), 'good');
      }
      if (v.attitude || v.influence) this.adjustNear(site.pos, v.attitude ?? 0, v.influence ?? 0);
      clearKm = v.clearIedKm ?? 0;
    } else if (m.target.kind === 'sector') {
      clearKm = 3.5;
    }
    if (clearKm) {
      const before = r.ieds!.length;
      r.ieds = r.ieds!.filter((i) => dist(i.pos, m.target.pos) > clearKm);
      const n = before - r.ieds.length;
      if (n) out.push(t('fx.iedCleared2', { n }));
    }
    return out;
  }
}
