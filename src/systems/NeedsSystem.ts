/**
 * NeedsSystem — besoins des habitants (nourriture, eau, sommeil, hygiène, moral),
 * effets des activités, santé, efficacité, expérience et incidents liés au moral.
 */
import type { GameContext } from '../core/GameContext';
import { NEED_IDS, type Agent, type ResourceBag } from '../core/GameState';
import { pushLog } from '../core/Log';
import { bagEntries, canAfford, spend } from '../core/resources';
import type { System } from './System';
import { distanceToZone, installedModules, modulesOfType, noiseZones, serviceBonus } from './modules';

const clamp = (v: number, min = 0, max = 100): number => Math.min(max, Math.max(min, v));

export class NeedsSystem implements System {
  readonly id = 'needs';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('time:hour', () => this.hourly());
  }

  onStateLoaded(): void {
    for (const a of Object.values(this.ctx.state.agents)) a.efficiency = this.computeEfficiency(a);
  }

  onTick(): void {
    const content = this.ctx.content;
    const minutes = content.balance.time.minutesPerTick;
    // Bâtiments bruyants en cours d'utilisation (stand de tir, maison de combat)
    const zones = noiseZones(content, this.ctx.state, (b) => {
      const svc = Object.keys(content.building(b.defId).services ?? {})[0];
      return svc ? this.ctx.sim.agents.occupancy(b.id, svc) > 0 : false;
    });
    // Latrines insuffisantes : l'hygiène se dégrade plus vite pour tous
    const hygieneMult = this.ctx.sim.requirements.hygieneDecayMult();
    for (const a of Object.values(this.ctx.state.agents)) {
      if (a.status !== 'on_base') continue;
      a.disturbed = false;
      const act = a.activity && a.activity.stage === 'acting' ? content.activity(a.activity.id) : null;

      for (const nd of content.needs.needs) {
        if (nd.id === 'morale') continue;
        const crowd = nd.id === 'hygiene' ? hygieneMult : 1;
        a.needs[nd.id] -= (nd.decayPerHour * this.decayMult(a, nd.id) * crowd * minutes) / 60;
      }
      // Le moral tend vers une cible qui dépend des conditions de vie.
      const drift = content.needs.morale.driftPerHour * this.moraleDriftMult(a);
      a.needs.morale += ((this.moraleTarget(a) - a.needs.morale) * drift * minutes) / 60;

      if (act) {
        // Un service rendu par un bâtiment endommagé ou mal alimenté est moins efficace.
        const target = a.activity?.targetId ? this.ctx.state.fob.buildings[a.activity.targetId] : undefined;
        let eff = target && act.service ? this.ctx.sim.economy.buildingEfficiency(target) : 1;
        // Activité consommatrice (munitions du stand de tir) : sans stock, l'entraînement n'a pas lieu
        let supplied = true;
        if (act.consumesPerHour) {
          // Puisé dans le stock local du stand (munitions livrées par le soutien), sinon au stock global
          const logistics = this.ctx.sim.logistics;
          const ok = bagEntries(act.consumesPerHour).every(([id, v]) => {
            const n = (v * minutes) / 60;
            return target && logistics.supplied(target).includes(id) ? logistics.stock(target, id) >= n && this.ctx.state.resources.stock[id] >= n : this.ctx.state.resources.stock[id] >= n;
          });
          if (ok) for (const [id, v] of bagEntries(act.consumesPerHour)) logistics.consume(target, id, (v * minutes) / 60);
          else {
            supplied = false;
            for (const [id] of bagEntries(act.consumesPerHour)) this.ctx.sim.economy.flagShortage(id);
          }
        }
        // Sanitaires ou réfectoire sales : service moins efficace et moral en berne
        if (target && act.service) {
          const logistics = this.ctx.sim.logistics;
          eff *= logistics.cleanFactor(target);
          if (logistics.dirty(target)) a.needs.morale += (content.balance.logistics.dirtyMoralePerHour * minutes) / 60;
        }
        // Sommeil sous une tente proche d'un stand de tir en activité
        let noiseMult = 1;
        let noiseMorale = 0;
        if (target && act.service === 'sleep' && zones.length) {
          const tdef = content.building(target.defId);
          for (const z of zones) {
            if (distanceToZone(tdef, target, z) > z.radius) continue;
            noiseMult = Math.min(noiseMult, z.sleepMult);
            noiseMorale = Math.min(noiseMorale, z.moralePerHour);
          }
          if (noiseMult < 1) a.disturbed = true;
        }
        // Repas d'une cuisine de fortune : moins rassasiant et moins réconfortant
        const quality = a.activity?.quality ?? 1;
        for (const [need, v] of Object.entries(act.effectsPerHour)) {
          const value = v ?? 0;
          const mult = (need === 'sleep' && value > 0 ? noiseMult : 1) * (need === 'food' || need === 'morale' ? quality : 1);
          a.needs[need as keyof Agent['needs']] += ((value > 0 ? value * eff * mult : value) * minutes) / 60;
        }
        if (noiseMorale) a.needs.morale += (noiseMorale * minutes) / 60;
        // Progression des compétences (stand de tir, parcours…), ralentie près du maximum
        if (act.skillsPerHour && supplied) {
          const mult = target ? installedModules(content.building(target.defId), target).reduce((m, x) => m * (x.skillMult ?? 1), 1) : 1;
          for (const [skill, v] of Object.entries(act.skillsPerHour)) {
            const cur = a.skills[skill] ?? 0;
            a.skills[skill] = Math.min(100, cur + (v * eff * mult * Math.max(0, 1 - cur / 110) * minutes) / 60);
          }
        }
        // Améliorations du bâtiment (climatisation, vrais lits, cuisine…), selon son rendement
        if (target && act.service) {
          for (const [need, v] of Object.entries(serviceBonus(content, target, act.service))) {
            a.needs[need as keyof Agent['needs']] += ((v ?? 0) * eff * minutes) / 60;
          }
        }
        if (act.xpPerHour) a.xp += (act.xpPerHour * this.xpMult(a) * minutes) / 60;
      }
      for (const n of NEED_IDS) a.needs[n] = clamp(a.needs[n]);
      a.efficiency = this.computeEfficiency(a);
    }
  }

  // ------------------------------------------------------------ Calculs

  private traitsOf(a: Agent) {
    return a.traits.map((t) => this.ctx.content.trait(t));
  }

  private decayMult(a: Agent, need: keyof Agent['needs']): number {
    return this.traitsOf(a).reduce((m, t) => m * (t.needDecay?.[need] ?? 1), 1);
  }

  private moraleDriftMult(a: Agent): number {
    return this.traitsOf(a).reduce((m, t) => m * (t.moraleDrift ?? 1), 1);
  }

  private xpMult(a: Agent): number {
    return this.traitsOf(a).reduce((m, t) => m * (t.xpMult ?? 1), 1);
  }

  /** Moral visé : base + traits + couchage − besoins insatisfaits. */
  moraleTarget(a: Agent): number {
    const cfg = this.ctx.content.needs.morale;
    let target = cfg.baseTarget + this.traitsOf(a).reduce((s, t) => s + (t.moraleBase ?? 0), 0);
    target += a.homeId ? cfg.bedBonus : -cfg.noBedPenalty;
    // Base sous-dimensionnée pour son effectif (réfectoire, douches, latrines…)
    target -= this.ctx.sim.requirements.moralePenalty();
    // Confort du logement (climatisation, literie), réduit si le courant manque
    const home = a.homeId ? this.ctx.state.fob.buildings[a.homeId] : undefined;
    if (home) {
      const eff = this.ctx.sim.economy.buildingEfficiency(home);
      for (const m of installedModules(this.ctx.content.building(home.defId), home)) target += (m.residentMorale ?? 0) * (m.powerDemand ? eff : 1);
    }
    for (const nd of this.ctx.content.needs.needs) {
      if (nd.id === 'morale') continue;
      const v = a.needs[nd.id];
      if (v < nd.critical) target -= cfg.criticalNeedPenalty;
      else if (v < nd.low) target -= cfg.lowNeedPenalty;
    }
    return clamp(target);
  }

  computeEfficiency(a: Agent): number {
    let eff = this.traitsOf(a).reduce((m, t) => m * (t.efficiency ?? 1), 1);
    for (const nd of this.ctx.content.needs.needs) {
      const v = a.needs[nd.id];
      if (v < nd.critical) eff *= nd.criticalEfficiency;
      else if (v < nd.low) eff *= nd.lowEfficiency;
    }
    if (a.health < 50) eff *= 0.5 + a.health / 100;
    return Math.max(0.2, Math.min(1.3, eff));
  }

  /** Consommation journalière estimée du personnel (projections du tableau de bord). */
  dailyConsumptionEstimate(): ResourceBag {
    const content = this.ctx.content;
    const agents = Object.values(this.ctx.state.agents).filter((a) => a.status === 'on_base');
    const n = agents.length;
    const out: ResourceBag = {};
    const add = (bag: ResourceBag | undefined, factor: number): void => {
      for (const [id, v] of bagEntries(bag)) out[id] = (out[id] ?? 0) + v * factor;
    };
    for (const nd of content.needs.needs) if (nd.passive) add(nd.passive.consumesPerHour, n * 24);
    const eat = content.needs.needActivities.food;
    if (eat) add(content.activity(eat).consumes, n * content.balance.agents.mealsPerDayEstimate);
    const wash = content.needs.needActivities.hygiene;
    const hasShowers = Object.values(this.ctx.state.fob.buildings).some(
      (b) => (b.state === 'active' || b.state === 'damaged') && content.building(b.defId).services?.hygiene,
    );
    if (wash && hasShowers) add(content.activity(wash).consumes, n * content.balance.agents.hygienePerDayEstimate);
    return out;
  }

  // ------------------------------------------------------------ Horaire

  private hourly(): void {
    const content = this.ctx.content;
    const state = this.ctx.state;
    const healthCfg = content.needs.health;
    const combatCfg = content.combat.config;
    // Infirmerie tenue par un soignant : guérison accélérée, au prix de matériel médical
    const station = Object.values(state.agents).find((x) => x.activity?.id === 'medical' && x.activity.stage === 'acting')?.activity?.targetId;
    const infirmary = station ? state.fob.buildings[station] : undefined;
    const staffed = !!station;
    for (const a of Object.values(state.agents)) {
      if (a.status === 'kia') continue;
      // Besoins passifs (boire) : servis automatiquement si la ressource est en stock.
      for (const nd of content.needs.needs) {
        if (!nd.passive) continue;
        if (canAfford(state, nd.passive.consumesPerHour)) {
          spend(state, nd.passive.consumesPerHour);
          a.needs[nd.id] = clamp(a.needs[nd.id] + nd.passive.restorePerHour);
        } else {
          for (const [id] of bagEntries(nd.passive.consumesPerHour)) this.ctx.sim.economy.flagShortage(id);
        }
      }
      // Santé
      let loss = 0;
      for (const nd of content.needs.needs) if (a.needs[nd.id] <= 0) loss += nd.healthLossPerHourAtZero;
      let regen = healthCfg.regenPerHour;
      if (staffed && a.health < 90 && loss === 0 && this.ctx.sim.logistics.consume(infirmary, 'medical', combatCfg.medicalPerHealHour)) {
        regen *= combatCfg.healingMult * this.surgeryMult();
      }
      a.health = clamp(loss > 0 ? a.health - loss : a.health + regen);
      this.maybeIncident(a);
    }
  }

  /** Bloc de soins avancés : guérison encore plus rapide à l'infirmerie. */
  private surgeryMult(): number {
    return modulesOfType(this.ctx.content, this.ctx.state, 'infirmary').reduce((m, x) => Math.max(m, x.healingMult ?? 1), 1);
  }

  private maybeIncident(a: Agent): void {
    const cfg = this.ctx.content.needs.incidents;
    if (a.needs.morale >= cfg.moraleThreshold || cfg.types.length === 0) return;
    const mult = this.traitsOf(a).reduce((m, t) => m * (t.incidentMult ?? 1), 1);
    if (this.ctx.random() >= cfg.chancePerHour * mult) return;
    const incident = cfg.types[Math.floor(this.ctx.random() * cfg.types.length)];
    const name = `${a.rank} ${a.lastName}`;
    if (incident.morale) a.needs.morale = clamp(a.needs.morale + incident.morale);
    if (incident.health) a.health = clamp(a.health + incident.health);
    if (incident.resources) {
      const res = this.ctx.state.resources;
      for (const [id, v] of bagEntries(incident.resources)) res.stock[id] = Math.max(0, res.stock[id] + v);
    }
    const text = incident.text.replace('{name}', name);
    pushLog(this.ctx, 'warn', 'log.incident', { text });
    this.ctx.bus.emit('agent:incident', { id: a.id, text });
  }
}
