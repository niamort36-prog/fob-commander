import { describe, expect, it } from 'vitest';
import { MemoryStorage, makeGame, stepTicks, stepUntil } from './helpers';

const DAY = 1440;

describe('DiplomacySystem — villages', () => {
  it('initialise les relations, la stabilité et la première phase de campagne', () => {
    const ctx = makeGame();
    const d = ctx.state.diplomacy;
    expect(d.initialized).toBe(true);
    expect(Object.keys(d.villages)).toHaveLength(ctx.content.region.villages.length);
    expect(ctx.state.region.stability).toBeGreaterThan(30);
    expect(ctx.state.region.stability).toBeLessThan(80);
    expect(d.campaign.phaseIndex).toBe(0);
    expect(d.campaign.notice?.kind).toBe('start');
    expect(ctx.sim.diplomacy.stance(-60).id).toBe('hostile');
    expect(ctx.sim.diplomacy.stance(60).id).toBe('allied');
  });

  it('sans action, la situation reste proche de l’équilibre', () => {
    const ctx = makeGame();
    const before = { ...ctx.state.region.villages.sangar };
    stepTicks(ctx, 10 * DAY);
    const after = ctx.state.region.villages.sangar;
    expect(Math.abs(after.attitude - before.attitude)).toBeLessThan(5);
    expect(Math.abs(after.influence - before.influence)).toBeLessThan(8);
  });

  it('une action humanitaire améliore l’attitude puis se recharge', () => {
    const ctx = makeGame();
    const food = ctx.state.resources.stock.food;
    const att = ctx.state.region.villages.sangar.attitude;
    expect(ctx.sim.diplomacy.act('sangar', 'aid')).toBe(true);
    expect(ctx.state.resources.stock.food).toBeLessThan(food);
    expect(ctx.state.region.villages.sangar.attitude).toBeGreaterThan(att);
    expect(ctx.sim.diplomacy.actionBlock('sangar', 'aid')).toBe('cooldown');
    expect(ctx.sim.diplomacy.act('sangar', 'aid')).toBe(false);
    // MEDCAP : il faut un personnel médical
    expect(ctx.sim.diplomacy.actionBlock('sangar', 'medcap')).toBe('personnel');
    // Pas de rétribution d'un chef insurgé
    expect(ctx.sim.diplomacy.actionBlock('toor', 'pay_elders')).toBe('leader');
  });

  it('un projet satisfait un besoin du village à son achèvement', () => {
    const ctx = makeGame();
    ctx.state.resources.stock.funds += 20000;
    ctx.state.resources.stock.parts += 100;
    const att = ctx.state.region.villages.sangar.attitude;
    expect(ctx.sim.diplomacy.startProject('sangar', 'well')).toBe(true);
    expect(ctx.sim.diplomacy.projectBlock('sangar', 'well')).toBe('active');
    expect(ctx.sim.diplomacy.needs('sangar').find((n) => n.need === 'water')!.progress).not.toBeNull();
    stepTicks(ctx, ctx.content.project('well').days * DAY + 2);
    expect(ctx.state.diplomacy.villages.sangar.satisfied).toContain('water');
    expect(ctx.state.region.villages.sangar.attitude).toBeGreaterThan(att);
    expect(ctx.state.diplomacy.campaign.stats.projectsDone).toBe(1);
    expect(ctx.sim.diplomacy.projectBlock('sangar', 'well')).toBe('satisfied');
  });

  it('shura → demande → promesse tenue', () => {
    const ctx = makeGame();
    ctx.state.resources.stock.funds += 20000;
    ctx.state.resources.stock.parts += 100;
    ctx.random = () => 0.01;
    ctx.sim.diplomacy.act('sangar', 'shura');
    const v = ctx.state.diplomacy.villages.sangar;
    expect(v.demand).not.toBeNull();
    expect(ctx.state.region.personalities.gul_zaman.met).toBe(true);
    const need = v.demand!.need;
    expect(ctx.sim.diplomacy.answerDemand('sangar', true)).toBe(true);
    expect(v.promise?.need).toBe(need);
    const rep = ctx.state.progression.reputation;
    ctx.sim.diplomacy.startProject('sangar', ctx.sim.diplomacy.projectFor(need)!.id);
    stepUntil(ctx, () => v.promise === null, 10 * DAY);
    expect(ctx.state.diplomacy.campaign.stats.promisesKept).toBe(1);
    expect(ctx.state.progression.reputation).toBeGreaterThan(rep);
  });

  it('une promesse non tenue fait chuter la confiance', () => {
    const ctx = makeGame();
    const v = ctx.state.diplomacy.villages.kandara;
    v.promise = { need: 'school', deadlineTick: ctx.state.time.tick + 60 };
    const att = ctx.state.region.villages.kandara.attitude;
    stepTicks(ctx, 2 * 60 + 1);
    expect(v.promise).toBeNull();
    expect(ctx.state.diplomacy.campaign.stats.promisesBroken).toBe(1);
    expect(ctx.state.region.villages.kandara.attitude).toBeLessThan(att - 15);
  });

  it('recrute des auxiliaires locaux, avec un risque d’infiltration', () => {
    const ctx = makeGame();
    expect(ctx.sim.diplomacy.recruitBlock('gulistan', 1)).toBe('attitude');
    ctx.state.region.villages.gulistan.attitude = 40;
    const avail = ctx.sim.diplomacy.auxiliariesAvailable('gulistan');
    expect(avail).toBeGreaterThan(0);
    ctx.random = () => 0.001; // la recrue est infiltrée
    const [a] = ctx.sim.diplomacy.recruit('gulistan', 1);
    expect(a.defId).toBe('auxiliary');
    expect(a.origin).toBe('gulistan');
    expect(ctx.content.names.afghanLast).toContain(a.lastName);
    expect(a.infiltrator).toBe(true);
    expect(ctx.state.events.queue.some((q) => q.eventId === 'insider_threat')).toBe(true);
    expect(ctx.sim.diplomacy.auxiliariesAvailable('gulistan')).toBe(avail - 1);
    // Démasqué par l'événement
    expect(ctx.sim.events.checkConditions({ infiltrator: true })).toBe(true);
    ctx.sim.diplomacy.insider('expose');
    expect(ctx.state.agents[a.id]).toBeUndefined();
    expect(ctx.sim.diplomacy.hasInfiltrator()).toBe(false);
  });
});

describe('DiplomacySystem — stabilité et conséquences', () => {
  it('la stabilité module le budget, la menace et le risque routier', () => {
    const ctx = makeGame();
    const d = ctx.sim.diplomacy;
    ctx.state.region.stability = 90;
    const highBudget = ctx.sim.economy.dailyBudget(0.5);
    const lowThreat = d.threatMult();
    ctx.state.region.stability = 20;
    expect(ctx.sim.economy.dailyBudget(0.5)).toBeLessThan(highBudget);
    expect(d.threatMult()).toBeGreaterThan(lowThreat);
    const risk = d.roadRiskMult();
    for (const v of Object.values(ctx.state.region.villages)) v.influence = 5;
    expect(d.roadRiskMult()).toBeLessThan(risk);
  });

  it('les incidents (attaques, bavures) font baisser la stabilité', () => {
    const calm = makeGame();
    const tense = makeGame();
    for (let i = 0; i < 5; i++) tense.sim.diplomacy.incident('collateral');
    stepTicks(calm, DAY);
    stepTicks(tense, DAY);
    expect(tense.state.region.stability).toBeLessThan(calm.state.region.stability);
  });

  it('l’insurrection se reconstitue près des villages tenus', () => {
    const ctx = makeGame();
    for (const v of Object.values(ctx.state.region.villages)) v.influence = 90;
    ctx.random = () => 0.01;
    const n = Object.keys(ctx.state.region.contacts).length;
    stepTicks(ctx, DAY + 1);
    const dyn = Object.values(ctx.state.region.contacts).filter((c) => c.dyn);
    expect(Object.keys(ctx.state.region.contacts).length).toBeGreaterThan(n);
    expect(dyn.length).toBeGreaterThan(0);
    expect(ctx.sim.intel.contactDef(dyn[0].id).label).toContain('(');
  });

  it('les opérations nourrissent le bilan de campagne', () => {
    const ctx = makeGame();
    ctx.sim.diplomacy.onContactNeutralized('rasoul_hq', 'hq');
    delete ctx.state.region.contacts.rasoul_hq;
    const stats = ctx.state.diplomacy.campaign.stats;
    expect(stats.contactsNeutralized).toBe(1);
    const hq = ctx.content.campaign.phases[2].objectives.find((o) => o.type === 'neutralize')!;
    expect(ctx.sim.diplomacy.objectiveProgress(hq).done).toBe(true);
  });
});

describe('Campagne', () => {
  it('une phase réussie rapporte récompenses et passe à la suivante', () => {
    const ctx = makeGame();
    const c = ctx.state.diplomacy.campaign;
    const funds = ctx.state.resources.stock.funds;
    ctx.state.region.villages.sangar.attitude = 40;
    ctx.state.region.villages.kandara.attitude = 40;
    c.stats.missionsSuccess += 3;
    ctx.state.region.stability = 70;
    stepTicks(ctx, 61);
    expect(c.phaseIndex).toBe(1);
    expect(c.notice?.kind).toBe('phaseDone');
    expect(ctx.state.resources.stock.funds).toBeGreaterThanOrEqual(funds + ctx.content.campaign.phases[0].rewards.funds!);
    // Les compteurs repartent de zéro pour la nouvelle phase
    const missions = ctx.content.campaign.phases[1].objectives.find((o) => o.type === 'projects')!;
    expect(ctx.sim.diplomacy.objectiveProgress(missions).value).toBe(0);
    ctx.commands.push({ type: 'campaignAck' });
    ctx.sim.step();
    expect(c.notice).toBeNull();
  });

  it('un délai dépassé coûte de la réputation et accorde un sursis', () => {
    const ctx = makeGame();
    const c = ctx.state.diplomacy.campaign;
    ctx.state.progression.reputation = 50;
    c.deadlineTick = ctx.state.time.tick + 10;
    stepTicks(ctx, 61);
    expect(c.missed).toBe(1);
    expect(ctx.state.progression.reputation).toBeLessThan(50);
    expect(c.deadlineTick).toBeGreaterThan(ctx.state.time.tick);
  });

  it('une stabilité effondrée trop longtemps entraîne la relève', () => {
    const ctx = makeGame();
    const c = ctx.state.diplomacy.campaign;
    for (const v of Object.values(ctx.state.region.villages)) {
      v.attitude = -100;
      v.influence = 100;
    }
    ctx.state.region.stability = 5;
    for (let day = 0; day <= ctx.content.campaign.defeat.days; day++) {
      ctx.state.diplomacy.incidents = 100; // attaques et bavures à répétition
      stepTicks(ctx, DAY);
    }
    expect(c.status).toBe('lost');
    expect(c.notice?.kind).toBe('defeat');
    ctx.commands.push({ type: 'campaignAck', continueSandbox: true });
    ctx.sim.step();
    expect(c.status).toBe('sandbox');
  });

  it('la géopolitique est sauvegardée et rechargée', () => {
    const storage = new MemoryStorage();
    const ctx = makeGame(storage);
    ctx.sim.diplomacy.act('sangar', 'aid');
    ctx.state.diplomacy.campaign.stats.missionsSuccess = 2;
    ctx.sim.save.save('1');
    const st = ctx.sim.save.load('1')!;
    expect(st.diplomacy.villages.sangar.cooldowns.aid).toBeDefined();
    expect(st.diplomacy.campaign.stats.missionsSuccess).toBe(2);
  });
});
