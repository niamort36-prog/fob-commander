/**
 * IntelSystem — renseignement et brouillard de guerre sur la carte régionale.
 *
 * Chaque contact ennemi a une position réelle (cachée, qui dérive pour les groupes mobiles)
 * et ce que la base en sait : position estimée, rayon d'incertitude, fiabilité, date.
 * Sources :
 *  - observation : tout contact dans le rayon de surveillance de la FOB (étendu par les
 *    tours de garde occupées) est vu avec précision, chaque heure ;
 *  - informateurs : les villages favorables signalent chaque jour les contacts proches ;
 *  - analyse : des officiers au TOC affinent un contact connu par jour (bonus avec un agent CIA,
 *    qui peut aussi révéler un contact inconnu) ;
 *  - attaques et événements : révèlent le groupe ennemi impliqué / le plus proche.
 * Sans nouvelles, la fiabilité baisse et l'incertitude grandit ; un contact trop ancien est perdu.
 */
import type { ContactDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { ContactState, IntelSource, KmPos } from '../core/GameState';
import { pushLog } from '../core/Log';
import type { System } from './System';
import { modulesOfType } from './modules';

const dist = (a: KmPos, b: KmPos): number => Math.hypot(a.x - b.x, a.y - b.y);

export class IntelSystem implements System {
  readonly id = 'intel';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('time:hour', () => this.hourly());
    ctx.bus.on('time:newDay', () => this.daily());
    ctx.bus.on('combat:ended', () => this.afterAttack());
  }

  private get cfg() {
    return this.ctx.content.region.intel;
  }

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  /** Position de la FOB sur la carte régionale. */
  fobPos(): KmPos {
    return this.ctx.site.regionPos;
  }

  contactDef(id: string): ContactDef {
    const dyn = this.ctx.state.region.contacts[id]?.dyn;
    if (dyn) return { id, kind: dyn.kind, label: dyn.label, pos: dyn.home, drift: dyn.drift };
    const d = this.ctx.content.region.contacts.find((c) => c.id === id);
    if (!d) throw new Error(`Contact inconnu : ${id}`);
    return d;
  }

  // ------------------------------------------------------------ Initialisation

  onStateLoaded(): void {
    const region = this.ctx.state.region;
    if (region.initialized) return;
    const def = this.ctx.content.region;
    for (const v of def.villages) region.villages[v.id] = { attitude: v.attitude, influence: v.influence };
    for (const p of def.personalities) region.personalities[p.id] = { known: p.known, met: false };
    for (const c of def.contacts) {
      region.contacts[c.id] = {
        id: c.id,
        truePos: { ...c.pos },
        estPos: { ...c.pos },
        error: c.known ? 1 : 0,
        reliability: c.known ? (c.reliability ?? 0.5) : 0,
        lastSeenTick: this.now,
        known: c.known === true,
        source: 'initial',
      };
    }
    region.initialized = true;
    this.hourly(); // ce que la base voit dès son installation
  }

  // ------------------------------------------------------------ Requêtes

  /** Rayon de surveillance de la FOB (km), selon les tours de garde occupées. */
  observationKm(): number {
    const towers = Object.values(this.ctx.state.agents).filter((a) => a.activity?.id === 'guard' && a.activity.stage === 'acting').length;
    return Math.min(this.cfg.maxObservationKm, this.cfg.observationKm + towers * this.cfg.perTowerKm);
  }

  /** Villages qui renseignent la base (attitude suffisante). */
  informantVillages(): string[] {
    const region = this.ctx.state.region;
    return this.ctx.content.region.villages.filter((v) => (region.villages[v.id]?.attitude ?? -100) >= this.cfg.informantAttitude).map((v) => v.id);
  }

  knownContacts(): ContactState[] {
    return Object.values(this.ctx.state.region.contacts).filter((c) => c.known);
  }

  /** Âge du renseignement en heures. */
  ageHours(c: ContactState): number {
    return ((this.now - c.lastSeenTick) * this.ctx.content.balance.time.minutesPerTick) / 60;
  }

  /** Cote de fiabilité façon OTAN (A = sûre … F = inconnue). */
  grade(c: ContactState): string {
    const r = c.reliability;
    return r >= 0.85 ? 'A' : r >= 0.65 ? 'B' : r >= 0.45 ? 'C' : r >= 0.3 ? 'D' : r >= 0.15 ? 'E' : 'F';
  }

  // ------------------------------------------------------------ Mise à jour des contacts

  /** Nouvelle information sur un contact : la meilleure fiabilité l'emporte. */
  report(id: string, reliability: number, source: IntelSource): void {
    const c = this.ctx.state.region.contacts[id];
    if (!c) return;
    const rel = Math.min(0.98, Math.max(reliability, c.known ? c.reliability : 0));
    const error = Math.max(0.15, 2.2 * (1 - rel));
    const a = this.ctx.random() * Math.PI * 2;
    const r = this.ctx.random() * error * 0.8;
    const wasKnown = c.known;
    c.estPos = { x: c.truePos.x + Math.cos(a) * r, y: c.truePos.y + Math.sin(a) * r };
    c.error = error;
    c.reliability = rel;
    c.lastSeenTick = this.now;
    c.known = true;
    c.source = source;
    if (!wasKnown) {
      pushLog(this.ctx, 'warn', 'log.contactDetected', { label: this.contactDef(id).label, source: sourceLabel(source) });
      this.ctx.bus.emit('intel:contact', { id });
    }
  }

  /** Révèle le contact inconnu le plus proche de la FOB (renseignement d'un événement). */
  revealNearest(source: IntelSource = 'event'): string | null {
    const fob = this.fobPos();
    const hidden = Object.values(this.ctx.state.region.contacts).filter((c) => !c.known || c.reliability < 0.3);
    hidden.sort((a, b) => dist(a.truePos, fob) - dist(b.truePos, fob));
    const c = hidden[0];
    if (!c) return null;
    this.report(c.id, this.cfg.eventRevealReliability, source);
    return c.id;
  }

  private hourly(): void {
    const region = this.ctx.state.region;
    if (!region.initialized) return;
    const fob = this.fobPos();
    const radius = this.observationKm();
    for (const c of Object.values(region.contacts)) {
      if (dist(c.truePos, fob) <= radius) this.report(c.id, 0.92, 'observation');
    }
    // Analyse au TOC : heures-officier cumulées dans la journée
    region.tocHoursToday += Object.values(this.ctx.state.agents).filter((a) => a.activity?.id === 'command' && a.activity.stage === 'acting').length;
  }

  private daily(): void {
    const region = this.ctx.state.region;
    if (!region.initialized) return;
    const cfg = this.cfg;
    const def = this.ctx.content.region;

    // Déplacement des groupes mobiles
    for (const c of Object.values(region.contacts)) {
      const d = this.contactDef(c.id).drift;
      if (!d) continue;
      const home = this.contactDef(c.id).pos;
      const a = this.ctx.random() * Math.PI * 2;
      let x = c.truePos.x + Math.cos(a) * d * this.ctx.random();
      let y = c.truePos.y + Math.sin(a) * d * this.ctx.random();
      // Les groupes restent dans leur secteur (rappel vers leur zone d'origine)
      x += (home.x - x) * 0.25;
      y += (home.y - y) * 0.25;
      c.truePos = { x: Math.min(def.size.width, Math.max(0, x)), y: Math.min(def.size.height, Math.max(0, y)) };
    }

    // Vieillissement du renseignement
    for (const c of Object.values(region.contacts)) {
      if (!c.known || c.source === 'observation') continue;
      c.reliability -= cfg.decayPerDay;
      c.error += cfg.errorGrowthPerDay;
      if (c.reliability < cfg.lostBelow) {
        c.known = false;
        c.reliability = 0;
        pushLog(this.ctx, 'info', 'log.contactLost', { label: this.contactDef(c.id).label });
      }
    }
    for (const c of Object.values(region.contacts)) if (c.source === 'observation') c.source = 'initial';

    // Informateurs des villages favorables
    for (const vid of this.informantVillages()) {
      const vdef = def.villages.find((v) => v.id === vid)!;
      const att = region.villages[vid].attitude;
      for (const c of Object.values(region.contacts)) {
        if (dist(c.truePos, vdef.pos) > cfg.villageReportKm || this.ctx.random() >= cfg.villageReportChance) continue;
        const wasKnown = c.known;
        this.report(c.id, 0.35 + att / 200, 'village');
        if (!wasKnown) pushLog(this.ctx, 'good', 'log.villageReport', { village: vdef.name });
      }
    }

    // Analyse au TOC (et agent CIA)
    const cia = Object.values(this.ctx.state.agents).some((a) => a.defId === 'cia');
    if (region.tocHoursToday >= cfg.tocMinHours) {
      // Informatique et cartographie numérique : analyse plus fine, parfois un second dossier
      const it = modulesOfType(this.ctx.content, this.ctx.state, 'toc').reduce(
        (acc, m) => ({ refine: acc.refine + (m.intel?.refine ?? 0), extra: acc.extra + (m.intel?.extraAnalysis ?? 0) }),
        { refine: 0, extra: 0 },
      );
      const analyses = 1 + (this.ctx.random() < it.extra ? 1 : 0);
      for (let i = 0; i < analyses; i++) {
        const known = this.knownContacts().filter((c) => c.reliability < 0.9);
        if (!known.length) break;
        const c = known[Math.floor(this.ctx.random() * known.length)];
        this.report(c.id, c.reliability + cfg.tocRefine + it.refine + (cia ? cfg.ciaBonus : 0), 'analysis');
      }
    }
    if (cia) {
      const fob = this.fobPos();
      const hidden = Object.values(region.contacts).filter((c) => !c.known && dist(c.truePos, fob) <= cfg.ciaRevealKm);
      if (hidden.length && this.ctx.random() < 0.5) this.report(hidden[Math.floor(this.ctx.random() * hidden.length)].id, 0.5, 'cia');
    }
    region.tocHoursToday = 0;
  }

  /** Après une attaque : le groupe ennemi le plus proche du type impliqué est localisé (approximativement). */
  private afterAttack(): void {
    const region = this.ctx.state.region;
    const fob = this.fobPos();
    const candidates = Object.values(region.contacts)
      .filter((c) => ['mortar', 'cell'].includes(this.contactDef(c.id).kind))
      .sort((a, b) => dist(a.truePos, fob) - dist(b.truePos, fob));
    const c = candidates[0];
    if (c) this.report(c.id, this.cfg.attackRevealReliability, 'attack');
  }

  // ------------------------------------------------------------ Villages et personnalités

  adjustVillage(id: string, attitude = 0, influence = 0): void {
    const v = this.ctx.state.region.villages[id];
    if (!v) return;
    v.attitude = Math.max(-100, Math.min(100, v.attitude + attitude));
    v.influence = Math.max(0, Math.min(100, v.influence + influence));
  }

  meet(personalityId: string): void {
    const p = this.ctx.state.region.personalities[personalityId];
    if (!p) return;
    if (!p.known) {
      const def = this.ctx.content.region.personalities.find((x) => x.id === personalityId);
      if (def) pushLog(this.ctx, 'info', 'log.personalityMet', { name: def.name });
    }
    p.known = true;
    p.met = true;
  }
}

export function sourceLabel(source: IntelSource): string {
  const labels: Record<IntelSource, string> = {
    initial: 'renseignement initial',
    observation: 'observation directe',
    village: 'informateurs',
    analysis: 'analyse du TOC',
    attack: 'analyse post-attaque',
    event: 'source humaine',
    cia: 'agent de liaison',
    mission: 'unité en mission',
  };
  return labels[source];
}
