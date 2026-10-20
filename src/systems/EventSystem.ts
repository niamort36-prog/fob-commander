/**
 * EventSystem — événements roguelike pilotés par events.json.
 *
 *  - Chaque heure, une chance de déclencher un événement admissible (conditions, recharge,
 *    écart minimal), tiré au poids ; les attaques sont pondérées par la menace du site.
 *  - Les événements en chaîne sont programmés à une date précise (file d'attente).
 *  - À l'ouverture, le jeu se met en pause ; le joueur choisit, l'issue est tirée
 *    (conditions puis poids) et ses effets appliqués ; à la fermeture, le jeu reprend
 *    et l'attaque éventuelle commence.
 */
import type { EventChoiceDef, EventConditions, EventDef, EventEffects, EventOutcomeDef, SpeakerDef } from '../core/ContentTypes';
import type { Command } from '../core/Commands';
import type { GameContext } from '../core/GameContext';
import type { CombatMode, ResourceId } from '../core/GameState';
import { pushLog } from '../core/Log';
import { bagEntries, gain } from '../core/resources';
import { newId } from '../utils/ids';
import { formatNumber, t } from '../utils/i18n';
import type { System } from './System';

export type ChoiceBlock = 'resources' | 'building' | 'reputation' | 'flag';

export class EventSystem implements System {
  readonly id = 'events';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('time:hour', () => this.maybeTrigger());
  }

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private hoursToTicks(h: number): number {
    return Math.round((h * 60) / this.ctx.content.balance.time.minutesPerTick);
  }

  get active() {
    return this.ctx.state.events.active;
  }

  activeDef(): EventDef | null {
    const a = this.active;
    return a ? this.ctx.content.event(a.eventId) : null;
  }

  speakerOf(def: EventDef): SpeakerDef {
    return this.ctx.content.events.speakers[def.speaker];
  }

  // ------------------------------------------------------------ Admissibilité

  private flag(name: string): boolean {
    return Boolean(this.ctx.state.progression.flags[name]);
  }

  checkConditions(c: EventConditions | undefined): boolean {
    if (!c) return true;
    const s = this.ctx.state;
    if (c.minDay !== undefined && s.time.day < c.minDay) return false;
    if (c.maxDay !== undefined && s.time.day > c.maxDay) return false;
    if (c.minReputation !== undefined && s.progression.reputation < c.minReputation) return false;
    if (c.maxReputation !== undefined && s.progression.reputation > c.maxReputation) return false;
    if (c.minAgents !== undefined && Object.keys(s.agents).length < c.minAgents) return false;
    if (c.flag && !this.flag(c.flag)) return false;
    if (c.infiltrator !== undefined && this.ctx.sim.diplomacy.hasInfiltrator() !== c.infiltrator) return false;
    if (c.notFlag && this.flag(c.notFlag)) return false;
    if (c.requiresBuilding && !Object.values(s.fob.buildings).some((b) => b.defId === c.requiresBuilding && b.state !== 'construction')) return false;
    for (const [id, v] of bagEntries(c.resourceBelow)) if (s.resources.stock[id] >= v) return false;
    for (const [id, v] of bagEntries(c.resourceAbove)) if (s.resources.stock[id] <= v) return false;
    if (c.enemyInPosition && !this.ctx.sim.world.inPosition(c.enemyInPosition)) return false;
    if (c.iedNearKm !== undefined && this.ctx.sim.world.iedsNear(c.iedNearKm).length === 0) return false;
    if (c.hours) {
      const h = Math.floor(s.time.minuteOfDay / 60);
      const [a, b] = c.hours;
      const inside = a <= b ? h >= a && h <= b : h >= a || h <= b;
      if (!inside) return false;
    }
    return true;
  }

  /** Villages compatibles avec l'exigence d'un événement (ami, hostile, neutre, sous emprise). */
  villagesFor(kind: EventDef['village']): string[] {
    const region = this.ctx.state.region.villages;
    return this.ctx.content.region.villages
      .filter((v) => {
        const st = region[v.id];
        if (!st) return false;
        switch (kind) {
          case 'friendly':
            return st.attitude >= 15;
          case 'hostile':
            return st.attitude <= -10;
          case 'neutral':
            return st.attitude > -10 && st.attitude < 15;
          case 'influenced':
            return st.influence >= 40;
          default:
            return true;
        }
      })
      .map((v) => v.id);
  }

  eligible(def: EventDef): boolean {
    const ev = this.ctx.state.events;
    if (def.village && this.villagesFor(def.village).length === 0) return false;
    if (def.trigger === 'chain') return false;
    if (def.once && ev.history.some((h) => h.eventId === def.id)) return false;
    const last = ev.cooldowns[def.id];
    if (last !== undefined && def.cooldownDays && this.now - last < this.hoursToTicks(def.cooldownDays * 24)) return false;
    if (def.category === 'attack' && this.now - ev.lastAttackTick < this.hoursToTicks(this.ctx.content.events.config.attackGapHours)) return false;
    return this.checkConditions(def.conditions);
  }

  /** Déclenche un événement s'il est admissible maintenant (rien d'autre en cours). */
  tryTrigger(eventId: string): boolean {
    const s = this.ctx.state;
    if (s.events.active || s.combat.active || s.radio.pending || s.visit) return false;
    const def = this.ctx.content.event(eventId);
    if (!this.eligible(def)) return false;
    return this.trigger(eventId);
  }

  /** Tirage horaire d'un événement aléatoire. */
  private maybeTrigger(): void {
    const s = this.ctx.state;
    if (s.events.active || s.combat.active || s.radio.pending || s.visit) return;
    const cfg = this.ctx.content.events.config;
    if (this.now - s.events.lastEventTick < this.hoursToTicks(cfg.minGapHours)) return;
    if (this.ctx.random() >= cfg.chancePerHour) return;
    const pool = this.ctx.content.events.events.filter((e) => this.eligible(e));
    if (pool.length === 0) return;
    const threat = this.ctx.site.threat * this.ctx.sim.diplomacy.threatMult();
    const weightOf = (e: EventDef): number => e.weight * (e.category === 'attack' ? threat : 1);
    const total = pool.reduce((sum, e) => sum + weightOf(e), 0);
    let r = this.ctx.random() * total;
    for (const e of pool) {
      r -= weightOf(e);
      if (r <= 0) {
        this.trigger(e.id);
        return;
      }
    }
    this.trigger(pool[pool.length - 1].id);
  }

  onTick(): void {
    const s = this.ctx.state;
    if (s.events.active || s.combat.active || s.radio.pending || s.visit || s.events.queue.length === 0) return;
    const due = s.events.queue.findIndex((q) => q.atTick <= this.now);
    if (due < 0) return;
    const [q] = s.events.queue.splice(due, 1);
    const def = this.ctx.content.event(q.eventId);
    if (this.checkConditions(def.conditions)) this.trigger(q.eventId);
  }

  /** Déclenche un événement : visite physique s'il en décrit une, sinon dialogue immédiat. */
  trigger(eventId: string): boolean {
    const def = this.ctx.content.event(eventId);
    if (def.visit && this.ctx.sim.visits.begin(eventId)) {
      this.ctx.state.events.lastEventTick = this.now;
      return true;
    }
    return this.start(eventId);
  }

  // ------------------------------------------------------------ Ouverture

  /** Ouvre un événement (le jeu se met en pause jusqu'à sa fermeture). */
  start(eventId: string): boolean {
    const s = this.ctx.state;
    if (s.events.active) return false;
    const def = this.ctx.content.event(eventId);
    const speaker = this.speakerOf(def);
    let speakerName = speaker.name ?? speaker.role;
    if (speaker.fromAgent) {
      const pool = Object.values(s.agents).filter((a) => speaker.fromAgent!.includes(a.defId));
      if (pool.length) {
        const a = pool[Math.floor(this.ctx.random() * pool.length)];
        speakerName = `${a.rank} ${a.lastName}`;
      }
    }
    const commander = Object.values(s.agents).find((a) => a.defId === 'commander');
    const vars: Record<string, string> = {
      speaker: speakerName,
      commander: commander ? `mon ${commander.rank.toLowerCase()}` : 'chef',
      base: this.ctx.site.name,
    };
    // Village concerné, tiré selon son attitude
    if (def.village) {
      const ids = this.villagesFor(def.village);
      const id = ids[Math.floor(this.ctx.random() * ids.length)] ?? this.ctx.content.region.villages[0]?.id;
      if (id) {
        vars.villageId = id;
        vars.village = this.ctx.content.region.villages.find((v) => v.id === id)?.name ?? id;
      }
    }
    // Un soldat de la base au hasard, et les listes de mots de events.json
    const onBase = Object.values(s.agents).filter((a) => a.status === 'on_base');
    const soldier = onBase[Math.floor(this.ctx.random() * onBase.length)];
    if (soldier) vars.soldier = `${soldier.rank} ${soldier.lastName}`;
    const texts = JSON.stringify(def);
    for (const [k, list] of Object.entries(this.ctx.content.events.pools ?? {})) {
      if (list.length && texts.includes(`{${k}}`)) vars[k] = list[Math.floor(this.ctx.random() * list.length)];
    }
    s.events.active = {
      eventId,
      startedTick: this.now,
      vars,
      resumeSpeed: s.time.speed === 0 ? 1 : s.time.speed,
      outcome: null,
    };
    if (speaker.personality) this.ctx.sim.intel.meet(speaker.personality);
    // L'engin découvert près de la base est celui qu'une cellule a posé
    if (def.conditions?.iedNearKm !== undefined) this.ctx.sim.world.takeIedNear(def.conditions.iedNearKm);
    s.events.cooldowns[eventId] = this.now;
    s.events.lastEventTick = this.now;
    if (def.category === 'attack') s.events.lastAttackTick = this.now;
    if (s.time.speed !== 0) {
      s.time.speed = 0;
      this.ctx.bus.emit('time:speedChanged', { speed: 0 });
    }
    pushLog(this.ctx, def.category === 'attack' ? 'bad' : 'info', 'log.eventStarted', { title: def.title });
    this.ctx.bus.emit('event:started', { eventId });
    return true;
  }

  /** Remplace les variables {nom} d'un texte. */
  format(text: string): string {
    const vars = this.active?.vars ?? {};
    return text
      .replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
      .replace(/(^|[.!?…] |« )(\p{Ll})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  }

  // ------------------------------------------------------------ Choix

  /** Raison pour laquelle un choix est indisponible, ou null. */
  choiceBlock(choice: EventChoiceDef): ChoiceBlock | null {
    const s = this.ctx.state;
    const r = choice.requires;
    if (r?.building && !Object.values(s.fob.buildings).some((b) => b.defId === r.building && (b.state === 'active' || b.state === 'damaged'))) return 'building';
    if (r?.minReputation !== undefined && s.progression.reputation < r.minReputation) return 'reputation';
    if (r?.flag && !this.flag(r.flag)) return 'flag';
    for (const [id, v] of bagEntries(choice.effects?.resources)) if (v < 0 && s.resources.stock[id] < -v) return 'resources';
    return null;
  }

  private pickOutcome(outcomes: EventOutcomeDef[]): EventOutcomeDef {
    const rating = this.ctx.sim.economy.evaluate().rating;
    const pass = (o: EventOutcomeDef): boolean => {
      const c = o.if;
      if (!c) return true;
      if (c.ratingAbove !== undefined && rating <= c.ratingAbove) return false;
      if (c.ratingBelow !== undefined && rating >= c.ratingBelow) return false;
      if (c.flag && !this.flag(c.flag)) return false;
      if (c.notFlag && this.flag(c.notFlag)) return false;
      return true;
    };
    // Les issues conditionnelles prioritaires d'abord, puis tirage pondéré parmi les autres.
    const conditional = outcomes.find((o) => o.if && pass(o));
    if (conditional) return conditional;
    const pool = outcomes.filter((o) => !o.if);
    if (pool.length === 0) return outcomes[outcomes.length - 1];
    const total = pool.reduce((s, o) => s + (o.weight ?? 1), 0);
    let r = this.ctx.random() * total;
    for (const o of pool) {
      r -= o.weight ?? 1;
      if (r <= 0) return o;
    }
    return pool[pool.length - 1];
  }

  choose(choiceId: string): boolean {
    const a = this.active;
    if (!a || a.outcome) return false;
    const def = this.ctx.content.event(a.eventId);
    const choice = def.choices.find((c) => c.id === choiceId);
    if (!choice || this.choiceBlock(choice)) return false;
    const summary: string[] = [];
    let attack: { id: string; mode: CombatMode } | null = null;
    const apply = (e: EventEffects | undefined): void => {
      if (!e) return;
      summary.push(...this.applyEffects(e));
      if (e.attack) attack = { id: e.attack, mode: e.attackMode ?? 'shelter' };
    };
    apply(choice.effects);
    const outcome = this.pickOutcome(choice.outcomes);
    apply(outcome.effects);
    a.outcome = { choiceId, text: this.format(outcome.text), summary, pendingAttack: attack };
    this.ctx.state.events.history.push({ eventId: a.eventId, tick: this.now, choiceId });
    if (this.ctx.state.events.history.length > 100) this.ctx.state.events.history.shift();
    this.ctx.bus.emit('event:resolved', { eventId: a.eventId, choiceId });
    return true;
  }

  /** Ferme l'événement : reprise du temps et début de l'attaque éventuelle. */
  close(): boolean {
    const s = this.ctx.state;
    const a = s.events.active;
    if (!a || !a.outcome) return false;
    s.events.active = null;
    s.time.speed = a.resumeSpeed;
    this.ctx.bus.emit('time:speedChanged', { speed: a.resumeSpeed });
    this.ctx.bus.emit('event:closed', { eventId: a.eventId });
    const attack = a.outcome.pendingAttack;
    if (attack) this.ctx.sim.attacks.start(attack.id, attack.mode);
    return true;
  }

  handleCommand(cmd: Command): boolean {
    switch (cmd.type) {
      case 'chooseEvent':
        this.choose(cmd.choiceId);
        return true;
      case 'closeEvent':
        this.close();
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------ Effets

  /** Applique des effets et renvoie leur résumé lisible. */
  applyEffects(e: EventEffects): string[] {
    const s = this.ctx.state;
    const out: string[] = [];
    for (const [id, v] of bagEntries(e.resources)) {
      const name = this.ctx.content.resource(id as ResourceId).name;
      if (v < 0) {
        const taken = Math.min(s.resources.stock[id], -v);
        s.resources.stock[id] -= taken;
        s.resources.todayDelta[id] = (s.resources.todayDelta[id] ?? 0) - taken;
      } else gain(s, { [id]: v });
      out.push(t('fx.resource', { name, value: (v > 0 ? '+' : '−') + formatNumber(Math.abs(v)) }));
    }
    if (e.reputation) {
      s.progression.reputation = Math.max(0, Math.min(100, s.progression.reputation + e.reputation));
      out.push(t('fx.reputation', { value: (e.reputation > 0 ? '+' : '−') + Math.abs(e.reputation) }));
    }
    if (e.morale) {
      for (const a of Object.values(s.agents)) a.needs.morale = Math.max(0, Math.min(100, a.needs.morale + e.morale));
      out.push(t('fx.morale', { value: (e.morale > 0 ? '+' : '−') + Math.abs(e.morale) }));
    }
    if (e.injure) {
      const agents = Object.values(s.agents).filter((a) => a.status === 'on_base');
      for (let i = 0; i < e.injure.count && agents.length; i++) {
        const a = agents.splice(Math.floor(this.ctx.random() * agents.length), 1)[0];
        this.ctx.sim.attacks.hurt(a, e.injure.amount, false);
        out.push(t('fx.injured', { name: `${a.rank} ${a.lastName}` }));
      }
    }
    for (const [k, v] of Object.entries(e.setFlags ?? {})) s.progression.flags[k] = v;
    for (const k of e.clearFlags ?? []) delete s.progression.flags[k];
    if (e.chain) s.events.queue.push({ eventId: e.chain.event, atTick: this.now + this.hoursToTicks(e.chain.delayHours) });
    if (e.recruits?.length) {
      const groupId = newId(s, 'grp');
      s.groups[groupId] = { id: groupId, name: `Recrues J${s.time.day}`, kind: 'contractor_team', memberIds: [], missionId: null };
      let n = 0;
      for (const r of e.recruits) {
        for (let i = 0; i < r.count; i++) {
          const agent = this.ctx.sim.agents.createAgent(r.type, groupId, s.fob.entry);
          s.groups[groupId].memberIds.push(agent.id);
          n++;
        }
      }
      this.ctx.sim.agents.markHomesDirty();
      out.push(t('fx.recruits', { count: n }));
    }
    if (e.delayOrders) {
      for (const o of Object.values(s.supply.orders)) if (o.status === 'pending') o.etaTick += this.hoursToTicks(e.delayOrders);
      out.push(t('fx.delay', { hours: e.delayOrders }));
    }
    if (e.village) {
      // « $village » : le village tiré à l'ouverture de l'événement
      const vid = e.village.id === '$village' ? String(this.active?.vars.villageId ?? '') : e.village.id;
      if (vid) this.ctx.sim.intel.adjustVillage(vid, e.village.attitude ?? 0, e.village.influence ?? 0);
      const name = this.ctx.content.region.villages.find((v) => v.id === vid)?.name ?? vid;
      if (e.village.attitude) out.push(t('fx.village', { name, value: (e.village.attitude > 0 ? '+' : '−') + Math.abs(e.village.attitude) }));
    }
    if (e.intel) {
      const id = this.ctx.sim.intel.revealNearest('event');
      if (id) out.push(t('fx.intel', { label: this.ctx.sim.intel.contactDef(id).label }));
    }
    if (e.satisfyNeed) {
      this.ctx.sim.diplomacy.satisfyNeed(e.satisfyNeed.village, e.satisfyNeed.need);
      const name = this.ctx.content.region.villages.find((v) => v.id === e.satisfyNeed!.village)?.name ?? e.satisfyNeed.village;
      out.push(t('fx.needSatisfied', { name, need: t(`need.${e.satisfyNeed.need}`) }));
    }
    if (e.insider) {
      const name = this.ctx.sim.diplomacy.insider(e.insider.action, e.insider.attitude ?? 0);
      if (name) out.push(t(`fx.insider.${e.insider.action}`, { name }));
    }
    if (e.wear) {
      for (const b of Object.values(s.fob.buildings)) if (b.state !== 'construction') this.ctx.sim.build.applyDamage(b, e.wear);
      out.push(t('fx.wear', { value: Math.round(e.wear * 100) }));
    }
    return out;
  }
}
