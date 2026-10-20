/**
 * RadioSystem — messages radio des unités en mission.
 *
 * Au lancement, deux à quatre messages sont programmés à des instants aléatoires du trajet et de
 * l'objectif ; la situation est tirée au moment de la réception parmi celles qui collent au
 * contexte (étape, type de mission, nuit, véhicules, hélicoptère, membres de l'équipe, appui,
 * attitude du village…), avec des détails tirés au hasard ({dir}, {terrain}, {leader}…).
 * Le jeu se met en pause jusqu'à la réponse du TOC. Chaque ordre n'est possible que si l'unité
 * en a les moyens (médecin, forces spéciales, véhicules, appui, vision nocturne…) ; son issue est
 * tirée au hasard, les bonnes issues étant favorisées par la compétence de l'équipe, et peut
 * entraîner un message de suite.
 */
import type { RadioChoiceDef, RadioConditions, RadioEffects, RadioMessageDef, RadioOutcomeDef } from '../core/ContentTypes';
import type { Command } from '../core/Commands';
import type { GameContext } from '../core/GameContext';
import type { Agent, MissionInstance, ResourceBag } from '../core/GameState';
import { pushLog } from '../core/Log';
import { bagEntries, canAfford, gain, spend } from '../core/resources';
import { t } from '../utils/i18n';
import type { System } from './System';

export class RadioSystem implements System {
  readonly id = 'radio';

  constructor(private readonly ctx: GameContext) {}

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  get pending() {
    return this.ctx.state.radio.pending;
  }

  /** Programme les messages d'une mission qui vient d'être lancée. */
  schedule(m: MissionInstance): void {
    const def = this.ctx.content.missionType(m.defId);
    const count = 2 + (def.risk >= 0.1 ? 1 : 0) + (this.ctx.random() < 0.4 ? 1 : 0);
    const assembly = Math.round((this.ctx.content.missions.config.assemblyTimeoutMin * 0.5) / this.ctx.content.balance.time.minutesPerTick);
    const span = m.travelTicks * 2 + m.objectiveTicks;
    for (let i = 0; i < count; i++) {
      // Réparti sur toute la mission, après la sortie de la base
      const at = this.now + assembly + Math.round(span * ((i + 0.2 + this.ctx.random() * 0.6) / count));
      m.radioQueue.push({ atTick: at, radioId: '' });
    }
  }

  // ------------------------------------------------------------ Contexte de l'unité

  private members(m: MissionInstance): Agent[] {
    return m.memberIds.map((id) => this.ctx.state.agents[id]).filter(Boolean);
  }

  private villageOf(m: MissionInstance): string | null {
    if (m.target.kind === 'village' && m.target.id) return m.target.id;
    let best: string | null = null;
    let bestD = Infinity;
    for (const v of this.ctx.content.region.villages) {
      const d = Math.hypot(v.pos.x - m.target.pos.x, v.pos.y - m.target.pos.y);
      if (d < bestD) {
        bestD = d;
        best = v.id;
      }
    }
    return best;
  }

  private isNight(): boolean {
    const [a, b] = this.ctx.content.equipment.nightHours;
    const h = Math.floor(this.ctx.state.time.minuteOfDay / 60);
    return a <= b ? h >= a && h < b : h >= a || h < b;
  }

  /** La situation colle-t-elle à l'unité et au contexte ? */
  matches(m: MissionInstance, c: RadioConditions | undefined): boolean {
    if (!c) return true;
    const members = this.members(m);
    const heli = !!m.heliId;
    const motorized = m.vehicleIds.length > 0;
    if (c.night !== undefined && this.isNight() !== c.night) return false;
    if (c.heli !== undefined && heli !== c.heli) return false;
    if (c.motorized !== undefined && motorized !== c.motorized) return false;
    if (c.onFoot !== undefined && (!heli && !motorized) !== c.onFoot) return false;
    if (c.targetKind && !c.targetKind.includes(m.target.kind)) return false;
    if (c.minTeam !== undefined && members.length < c.minTeam) return false;
    if (c.hasType && !members.some((a) => c.hasType!.includes(a.defId))) return false;
    if (c.support && !c.support.includes(m.support ?? 'none')) return false;
    if (c.attitudeBelow !== undefined || c.attitudeAbove !== undefined) {
      const vid = this.villageOf(m);
      const att = vid ? (this.ctx.state.region.villages[vid]?.attitude ?? 0) : 0;
      if (c.attitudeBelow !== undefined && att >= c.attitudeBelow) return false;
      if (c.attitudeAbove !== undefined && att <= c.attitudeAbove) return false;
    }
    return true;
  }

  /** Raison pour laquelle un ordre est impossible (clé de texte), ou null. */
  choiceBlock(choice: RadioChoiceDef, m?: MissionInstance): string | null {
    const mission = m ?? (this.pending ? this.ctx.state.missions[this.pending.missionId] : undefined);
    const r = choice.requires;
    if (mission && r) {
      const members = this.members(mission);
      if (r.types && !members.some((a) => r.types!.includes(a.defId))) return 'types';
      if (r.vehicles && mission.vehicleIds.length === 0) return 'vehicles';
      if (r.heli && !mission.heliId) return 'heli';
      if (r.support && !r.support.includes(mission.support ?? 'none')) return 'support';
      if (r.gear && !members.some((a) => a.gear?.includes(r.gear!))) return 'gear';
      if (r.night !== undefined && this.isNight() !== r.night) return r.night ? 'night' : 'day';
      if (r.minTeam !== undefined && members.length < r.minTeam) return 'team';
    }
    if (!canAfford(this.ctx.state, this.costOf(choice, mission?.id))) return 'cost';
    return null;
  }

  /** Variables d'un message : indicatif, objectif, membres, village et détails tirés au hasard. */
  private makeVars(m: MissionInstance, msg: RadioMessageDef): Record<string, string> {
    const members = this.members(m);
    const name = (a: Agent | undefined): string => (a ? `${a.rank} ${a.lastName}` : 'le chef de groupe');
    const leader = [...members].sort((a, b) => (b.skills.leadership ?? 0) - (a.skills.leadership ?? 0))[0];
    const others = members.filter((a) => a !== leader);
    const vid = this.villageOf(m);
    const vars: Record<string, string> = {
      callsign: m.callsign,
      target: m.target.name,
      leader: name(leader),
      member: name(others[Math.floor(this.ctx.random() * others.length)] ?? leader),
      medic: members.some((a) => a.defId === 'medic') ? name(members.find((a) => a.defId === 'medic')) : "l'infirmier",
      village: this.ctx.content.region.villages.find((v) => v.id === vid)?.name ?? m.target.name,
      team: String(members.length),
    };
    const pools = this.ctx.content.radio.pools ?? {};
    const texts = [msg.text, ...msg.choices.flatMap((c) => [c.text, c.log, ...(c.outcomes ?? []).map((o) => o.log)])].join(' ');
    for (const [k, list] of Object.entries(pools)) {
      if (list.length && texts.includes(`{${k}}`)) vars[k] = list[Math.floor(this.ctx.random() * list.length)];
    }
    return vars;
  }

  /** Remplace les variables {nom} d'un texte (message en attente par défaut). */
  format(text: string, vars = this.pending?.vars): string {
    if (!vars) return text;
    // Variables, puis majuscule en début de phrase (une variable peut ouvrir une phrase)
    return text.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all).replace(/(^|[.!?…] |« )(\p{Ll})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  }

  private pick(m: MissionInstance): RadioMessageDef | null {
    const phase = m.phase;
    if (phase !== 'outbound' && phase !== 'objective' && phase !== 'inbound') return null;
    const used = new Set(m.radioUsed ?? []);
    const pool = this.ctx.content.radio.messages.filter(
      (r) =>
        !r.followUpOnly &&
        r.phases.includes(phase) &&
        r.types.includes(m.defId) &&
        (!r.requiresVehicles || m.vehicleIds.length > 0) &&
        !used.has(r.id) &&
        this.matches(m, r.when),
    );
    if (pool.length === 0) return null;
    const total = pool.reduce((s, r) => s + r.weight, 0);
    let x = this.ctx.random() * total;
    for (const r of pool) {
      x -= r.weight;
      if (x <= 0) return r;
    }
    return pool[pool.length - 1];
  }

  onTick(): void {
    const s = this.ctx.state;
    // Messages arrivés à échéance
    for (const m of Object.values(s.missions)) {
      if (m.phase === 'done' || m.phase === 'assembling') continue;
      const due = m.radioQueue.filter((q) => q.atTick <= this.now);
      if (!due.length) continue;
      m.radioQueue = m.radioQueue.filter((q) => q.atTick > this.now);
      for (const q of due) {
        // Suite imposée d'un message précédent, sinon situation tirée selon le contexte
        const msg = q.radioId ? this.ctx.content.radio.messages.find((r) => r.id === q.radioId) ?? null : this.pick(m);
        if (msg) {
          s.radio.queue.push({ missionId: m.id, radioId: msg.id });
          m.radioUsed = [...(m.radioUsed ?? []), msg.id];
        }
      }
    }
    // Réception (une à la fois, jamais pendant un dialogue d'événement)
    if (!s.radio.pending && !s.events.active && s.radio.queue.length) {
      const next = s.radio.queue.shift()!;
      const m = s.missions[next.missionId];
      if (!m || m.phase === 'done') return;
      const msgDef = this.ctx.content.radioMessage(next.radioId);
      s.radio.pending = { missionId: m.id, radioId: next.radioId, resumeSpeed: s.time.speed === 0 ? 1 : s.time.speed, answer: null, vars: this.makeVars(m, msgDef) };
      if (s.time.speed !== 0) {
        s.time.speed = 0;
        this.ctx.bus.emit('time:speedChanged', { speed: 0 });
      }
      pushLog(this.ctx, 'warn', 'log.radioIn', { callsign: m.callsign });
      this.ctx.bus.emit('radio:message', { missionId: m.id });
    }
  }

  /** Coût réel d'une réponse : l'appui aérien est déjà en alerte si la mission en dispose. */
  costOf(choice: RadioChoiceDef, missionId?: string): ResourceBag {
    const m = missionId ? this.ctx.state.missions[missionId] : this.pending ? this.ctx.state.missions[this.pending.missionId] : undefined;
    if (choice.id === 'air' && (m?.support === 'a10' || m?.support === 'ac130')) return {};
    return choice.effects.cost ?? {};
  }

  /** Une réponse est-elle possible (moyens de l'unité, ressources disponibles) ? */
  canChoose(choice: RadioChoiceDef): boolean {
    return this.choiceBlock(choice) === null;
  }

  /** Compétence moyenne de l'équipe (0..100). */
  private teamSkill(m: MissionInstance, skill: string): number {
    const members = this.members(m);
    if (!members.length) return 40;
    return members.reduce((sum, a) => sum + (a.skills[skill] ?? 30) * a.efficiency, 0) / members.length;
  }

  /** Tire l'issue d'un ordre : poids des bonnes issues augmenté par la compétence, des mauvaises réduit. */
  private pickOutcome(m: MissionInstance, choice: RadioChoiceDef): RadioOutcomeDef | null {
    const outs = choice.outcomes;
    if (!outs?.length) return null;
    const s = choice.skill ? this.teamSkill(m, choice.skill) / 100 : 0.45;
    const w = (o: RadioOutcomeDef): number => (o.weight ?? 1) * (o.kind === 'good' ? 0.4 + 1.3 * s : o.kind === 'bad' ? 1.6 - 1.3 * s : 1);
    const total = outs.reduce((sum, o) => sum + Math.max(0.05, w(o)), 0);
    let x = this.ctx.random() * total;
    for (const o of outs) {
      x -= Math.max(0.05, w(o));
      if (x <= 0) return o;
    }
    return outs[outs.length - 1];
  }

  choose(choiceId: string): boolean {
    const p = this.pending;
    if (!p || p.answer) return false;
    const m = this.ctx.state.missions[p.missionId];
    const msg = this.ctx.content.radioMessage(p.radioId);
    const choice = msg.choices.find((c) => c.id === choiceId);
    if (!m || !choice || !this.canChoose(choice)) return false;
    const outcome = this.pickOutcome(m, choice);
    const log = this.format(outcome ? outcome.log : choice.log);
    this.ctx.sim.missions.log(m, log);
    const notes = this.apply(m, { ...choice.effects, cost: this.costOf(choice, m.id) });
    if (outcome?.effects) notes.push(...this.apply(m, outcome.effects));
    const follow = outcome?.followUp ?? choice.followUp;
    if (follow && m.phase !== 'done') m.radioQueue.push({ atTick: this.now + Math.round(follow.delayMin / this.ctx.content.balance.time.minutesPerTick), radioId: follow.radio });
    p.answer = notes.length ? `${log} (${notes.join(', ')})` : log;
    this.ctx.bus.emit('radio:answered', { missionId: m.id });
    return true;
  }

  close(): boolean {
    const s = this.ctx.state;
    const p = s.radio.pending;
    if (!p || !p.answer) return false;
    s.radio.pending = null;
    s.time.speed = p.resumeSpeed;
    this.ctx.bus.emit('time:speedChanged', { speed: p.resumeSpeed });
    this.ctx.bus.emit('radio:closed', { missionId: p.missionId });
    return true;
  }

  handleCommand(cmd: Command): boolean {
    switch (cmd.type) {
      case 'radioChoose':
        this.choose(cmd.choiceId);
        return true;
      case 'radioClose':
        this.close();
        return true;
      default:
        return false;
    }
  }

  /** Applique les effets d'une réponse ; renvoie les faits marquants (blessés…) pour le compte rendu. */
  private apply(m: MissionInstance, e: RadioEffects): string[] {
    const s = this.ctx.state;
    const missions = this.ctx.sim.missions;
    const notes: string[] = [];
    if (e.wound) {
      const pool = this.members(m).filter((a) => a.health > 20);
      for (let i = 0; i < e.wound && pool.length; i++) {
        const a = pool.splice(Math.floor(this.ctx.random() * pool.length), 1)[0];
        a.health = Math.max(5, a.health - (30 + this.ctx.random() * 25));
        const name = `${a.rank} ${a.lastName}`;
        if (!m.casualties.wounded.includes(name)) m.casualties.wounded.push(name);
        notes.push(t('radio.wounded', { name }));
      }
    }
    if (e.morale) for (const a of Object.values(s.agents)) a.needs.morale = Math.max(0, Math.min(100, a.needs.morale + e.morale));
    if (e.xp) for (const a of this.members(m)) a.xp += e.xp;
    if (e.success) m.mods.success += e.success;
    if (e.casualty) m.mods.casualty += e.casualty;
    // Coût (une issue aléatoire ne peut pas faire passer un stock sous zéro)
    if (e.cost) {
      const bag: ResourceBag = {};
      for (const [id, v] of bagEntries(e.cost)) bag[id] = Math.min(v, Math.max(0, s.resources.stock[id]));
      spend(s, bag);
    }
    for (const [id, v] of bagEntries(e.resources)) gain(s, { [id]: v });
    if (e.reputation) s.progression.reputation = Math.max(0, Math.min(100, s.progression.reputation + e.reputation));
    const vid = m.target.kind === 'village' ? m.target.id : null;
    if (vid && (e.villageAttitude || e.villageInfluence)) this.ctx.sim.intel.adjustVillage(vid, e.villageAttitude ?? 0, e.villageInfluence ?? 0);
    if (e.reveal) this.ctx.sim.intel.revealNearest('mission');
    if (e.revealRadiusKm) missions.revealAround(m.target.pos, e.revealRadiusKm);
    if (e.collateral && this.ctx.random() < e.collateral) {
      const cfg = this.ctx.content.missions.config;
      s.progression.reputation = Math.max(0, s.progression.reputation + cfg.collateralReputation);
      const near = vid ?? this.ctx.content.region.villages.reduce((best, v) => (Math.hypot(v.pos.x - m.target.pos.x, v.pos.y - m.target.pos.y) < Math.hypot(best.pos.x - m.target.pos.x, best.pos.y - m.target.pos.y) ? v : best)).id;
      this.ctx.sim.intel.adjustVillage(near, cfg.collateralAttitude, 5);
      missions.log(m, t('mission.logCollateral'));
      pushLog(this.ctx, 'bad', 'log.collateral', { callsign: m.callsign });
      this.ctx.sim.diplomacy.incident('collateral');
    }
    if (e.duration) missions.extend(m, e.duration);
    if (e.abort) missions.abort(m);
    return notes;
  }
}
