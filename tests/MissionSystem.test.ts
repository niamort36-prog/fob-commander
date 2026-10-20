import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import type { MissionTarget } from '../src/core/GameState';
import type { MissionPlan } from '../src/systems/MissionSystem';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

const contactTarget = (ctx: GameContext, id: string): MissionTarget => ctx.sim.missions.targetFrom({ kind: 'contact', id })!;
const villageTarget = (ctx: GameContext, id: string): MissionTarget => ctx.sim.missions.targetFrom({ kind: 'village', id })!;

/** Plan avec les n premiers fantassins disponibles. */
function plan(ctx: GameContext, typeId: string, target: MissionTarget, n: number, extra: Partial<MissionPlan> = {}): MissionPlan {
  const members = ctx.sim.missions
    .availableAgents()
    .filter((a) => a.defId !== 'sf')
    .slice(0, n)
    .map((a) => a.id);
  return { typeId, target, memberIds: members, vehicleIds: [], loadout: 'standard', ...extra };
}

/** Lance une mission sans messages radio (pour tester la résolution seule). */
function launchQuiet(ctx: GameContext, p: MissionPlan) {
  const m = ctx.sim.missions.launch(p)!;
  expect(m).not.toBeNull();
  m.radioQueue = [];
  m.mods.casualty = -1; // aucune perte : le hasard forcé ne sert qu'au résultat
  return m;
}

describe('MissionSystem — préparation', () => {
  it('estime une chance bornée, croissante avec l’effectif et la dotation', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = contactTarget(ctx, 'rasoul_hq');
    const small = ctx.sim.missions.estimate(plan(ctx, 'raid', target, 6));
    const big = ctx.sim.missions.estimate(plan(ctx, 'raid', target, 12));
    const heavy = ctx.sim.missions.estimate(plan(ctx, 'raid', target, 12, { loadout: 'heavy' }));
    for (const e of [small, big, heavy]) {
      expect(e.chance).toBeGreaterThanOrEqual(0.05);
      expect(e.chance).toBeLessThanOrEqual(0.95);
      expect(e.low).toBeLessThanOrEqual(e.chance);
      expect(e.high).toBeGreaterThanOrEqual(e.chance);
      expect(e.distanceKm).toBeGreaterThan(0);
    }
    expect(big.chance).toBeGreaterThan(small.chance);
    expect(heavy.chance).toBeGreaterThanOrEqual(big.chance);
    expect(heavy.costs.ammo ?? 0).toBeGreaterThan(big.costs.ammo ?? 0);
  });

  it('propose les missions selon la cible et refuse les plans invalides', () => {
    const ctx = makeGame(undefined, { agents: true });
    const village = villageTarget(ctx, 'sangar');
    const ids = ctx.sim.missions.typesFor(village).map((d) => d.id);
    expect(ids).toContain('patrol');
    expect(ids).not.toContain('raid');
    expect(ctx.sim.missions.typesFor(ctx.sim.missions.targetFrom({ kind: 'fob' })!).map((d) => d.id)).toContain('convoy_escort');
    // Contact inconnu
    expect(ctx.sim.missions.targetFrom({ kind: 'contact', id: 'mortar_hills' })).toBeNull();
    const target = contactTarget(ctx, 'rasoul_hq');
    expect(ctx.sim.missions.check(plan(ctx, 'raid', target, 3))).toBe('members');
    expect(ctx.sim.missions.check(plan(ctx, 'patrol', target, 6))).toBe('target');
    expect(ctx.sim.missions.check(plan(ctx, 'special_op', target, 6))).toBe('requires');
    ctx.state.resources.stock.ammo = 0;
    expect(ctx.sim.missions.check(plan(ctx, 'raid', target, 6))).toBe('resources');
  });
});

describe('MissionSystem — déroulement', () => {
  it('rassemble l’équipe, part, résout, revient et rédige un compte rendu', () => {
    const ctx = makeGame(undefined, { agents: true });
    const p = plan(ctx, 'patrol', villageTarget(ctx, 'sangar'), 6);
    const ammo = ctx.state.resources.stock.ammo;
    const m = launchQuiet(ctx, p);
    expect(ctx.state.resources.stock.ammo).toBeLessThan(ammo);
    expect(m.phase).toBe('assembling');
    for (const id of p.memberIds) expect(ctx.state.agents[id].missionId).toBe(m.id);
    // Les membres déjà en mission ne sont plus disponibles
    expect(ctx.sim.missions.availableAgents().some((a) => p.memberIds.includes(a.id))).toBe(false);

    stepUntil(ctx, () => m.phase === 'outbound', 200);
    // À pied : ils marchent d'abord jusqu'au bord de la carte, puis disparaissent
    for (const id of p.memberIds) expect(ctx.state.agents[id].activity?.id).toBe('march_out');
    stepUntil(ctx, () => p.memberIds.every((id) => ctx.state.agents[id].status === 'on_mission'), 400);
    expect(p.memberIds.every((id) => ctx.state.agents[id].activity === null)).toBe(true);
    const start = ctx.sim.missions.position(m);
    stepTicks(ctx, Math.floor(m.travelTicks / 2));
    const mid = ctx.sim.missions.position(m);
    expect(Math.hypot(mid.x - start.x, mid.y - start.y)).toBeGreaterThan(0);

    ctx.random = () => 0.01; // succès garanti, aucune perte
    stepUntil(ctx, () => m.phase === 'inbound', m.travelTicks + m.objectiveTicks + 10);
    expect(m.result).toBe('success');
    stepUntil(ctx, () => m.phase === 'done', m.travelTicks + 10);
    // Retour à pied depuis le bord de la carte
    for (const id of p.memberIds) expect(ctx.state.agents[id].activity?.id).toBe('march_in');
    const entry = ctx.state.fob.entry;
    expect(p.memberIds.some((id) => Math.hypot(ctx.state.agents[id].pos.x - entry.x, ctx.state.agents[id].pos.y - entry.y) < 4)).toBe(true);
    for (const id of p.memberIds) {
      const a = ctx.state.agents[id];
      expect(a.missionId).toBeNull();
      expect(a.status).toBe('on_base');
      expect(a.xp).toBeGreaterThan(0);
    }
    const report = ctx.state.missionReports.find((r) => r.id === m.reportId)!;
    expect(report).toBeDefined();
    expect(report.result).toBe('success');
    expect(report.lines.join('\n')).toContain(m.callsign);
    expect(ctx.sim.missions.active()).toHaveLength(0);
  });

  it('un raid réussi neutralise le contact et rapporte des fonds', () => {
    const ctx = makeGame(undefined, { agents: true });
    const funds = ctx.state.resources.stock.funds;
    const m = launchQuiet(ctx, plan(ctx, 'raid', contactTarget(ctx, 'rasoul_hq'), 10));
    ctx.random = () => 0.01;
    stepUntil(ctx, () => m.phase === 'inbound', 2000);
    expect(m.result).toBe('success');
    expect(ctx.state.region.contacts.rasoul_hq).toBeUndefined();
    expect(ctx.state.resources.stock.funds).toBeGreaterThan(funds - 1000);
    expect(m.enemyKilled).toBeGreaterThan(0);
  });

  it('une reconnaissance confirme la cible et révèle les environs', () => {
    const ctx = makeGame(undefined, { agents: true });
    const c = ctx.state.region.contacts.rasoul_hq;
    c.reliability = 0.4;
    const hidden = ctx.state.region.contacts.cache_karez; // cache immobile, placée près de l'objectif
    hidden.truePos = { x: c.truePos.x + 1, y: c.truePos.y };
    const m = launchQuiet(ctx, plan(ctx, 'recon', contactTarget(ctx, 'rasoul_hq'), 4));
    ctx.random = () => 0.01;
    stepUntil(ctx, () => m.phase === 'inbound', 2000);
    expect(c.reliability).toBeGreaterThan(0.9);
    expect(hidden.known).toBe(true);
  });

  it('un abandon résout la mission immédiatement et ramène l’unité', () => {
    const ctx = makeGame(undefined, { agents: true });
    const p = plan(ctx, 'raid', contactTarget(ctx, 'rasoul_hq'), 8);
    const m = launchQuiet(ctx, p);
    stepUntil(ctx, () => m.phase === 'outbound', 200);
    ctx.random = () => 0.99; // échec certain
    ctx.sim.missions.abort(m);
    expect(m.aborted).toBe(true);
    expect(m.result).toBe('failure');
    expect(m.phase).toBe('inbound');
    ctx.random = () => 0.5;
    stepUntil(ctx, () => m.phase === 'done', m.travelTicks + 10);
    expect(ctx.state.missionReports[0].lines.join('\n')).toContain('interrompue');
  });

  it('les pertes tuent des membres et figurent au compte rendu', () => {
    const ctx = makeGame(undefined, { agents: true });
    const count = Object.keys(ctx.state.agents).length;
    const m = ctx.sim.missions.launch(plan(ctx, 'raid', contactTarget(ctx, 'rasoul_hq'), 8))!;
    m.radioQueue = [];
    m.mods.casualty = 5; // risque maximal
    ctx.random = () => 0.01; // toutes les pertes sont mortelles
    stepUntil(ctx, () => m.phase === 'inbound', 2000);
    expect(m.casualties.kia.length).toBeGreaterThan(0);
    expect(Object.keys(ctx.state.agents).length).toBe(count - m.casualties.kia.length);
    ctx.random = () => 0.5;
    stepUntil(ctx, () => m.phase === 'done', m.travelTicks + 10);
    expect(ctx.state.missionReports[0].lines.join('\n')).toContain(m.casualties.kia[0]);
  });
});

describe('RadioSystem', () => {
  it('met le jeu en pause, applique la réponse puis reprend', () => {
    const ctx = makeGame(undefined, { agents: true });
    const m = ctx.sim.missions.launch(plan(ctx, 'raid', contactTarget(ctx, 'rasoul_hq'), 8))!;
    stepUntil(ctx, () => m.phase === 'outbound', 200);
    m.radioQueue = [{ atTick: ctx.state.time.tick, radioId: '' }];
    ctx.state.time.speed = 2;
    stepUntil(ctx, () => ctx.state.radio.pending !== null, 5);
    const pending = ctx.state.radio.pending!;
    expect(ctx.state.time.speed).toBe(0);
    const msg = ctx.content.radioMessage(pending.radioId);
    const choice = msg.choices.find((c) => !c.effects.abort && ctx.sim.radio.canChoose(c))!;
    const before = { ...m.mods };
    const end = m.phaseEndTick;
    ctx.commands.push({ type: 'radioChoose', choiceId: choice.id });
    ctx.sim.step();
    // Compte rendu : issue fixe ou tirée parmi les issues possibles de l'ordre
    const logs = [choice.log, ...(choice.outcomes ?? []).map((o) => o.log)].map((l) => ctx.sim.radio.format(l, pending.vars));
    expect(logs.some((l) => pending.answer!.startsWith(l))).toBe(true);
    expect(m.radioLog.some((l) => logs.includes(l.text))).toBe(true);
    if (choice.effects.success) expect(m.mods.success).not.toBe(before.success);
    if (choice.effects.duration) expect(m.phaseEndTick).toBeGreaterThan(end);
    ctx.commands.push({ type: 'radioClose' });
    ctx.sim.step();
    expect(ctx.state.radio.pending).toBeNull();
    expect(ctx.state.time.speed).toBe(2);
  });
});

describe('Véhicules et escorte', () => {
  it('un MRAP part en mission puis rejoint son parc', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'vehicle_park', { x: CENTER.x + 6, y: CENTER.y - 8 });
    ctx.state.resources.stock.funds += 50000;
    const mrap = ctx.sim.supply.buyVehicle('mrap')!;
    expect(mrap).not.toBeNull();
    expect(ctx.sim.missions.availableVehicles().map((v) => v.id)).toContain(mrap.id);
    const p = plan(ctx, 'patrol', villageTarget(ctx, 'sangar'), 5, { vehicleIds: [mrap.id] });
    const onFoot = ctx.sim.missions.estimate({ ...p, vehicleIds: [] });
    const est = ctx.sim.missions.estimate(p);
    expect(est.motorized).toBe(true);
    expect(est.travelHours).toBeLessThan(onFoot.travelHours);
    const m = launchQuiet(ctx, p);
    stepUntil(ctx, () => mrap.state === 'away', 600);
    expect(ctx.sim.missions.availableVehicles()).toHaveLength(0);
    ctx.random = () => 0.01;
    stepUntil(ctx, () => m.phase === 'done', 3000);
    stepUntil(ctx, () => mrap.state === 'idle', 600);
  });

  it('une escorte réussie réduit le risque des convois', () => {
    const ctx = makeGame(undefined, { agents: true });
    const m = launchQuiet(ctx, plan(ctx, 'convoy_escort', ctx.sim.missions.targetFrom({ kind: 'fob' })!, 4));
    ctx.random = () => 0.01;
    stepUntil(ctx, () => m.phase === 'inbound', 2000);
    expect(Number(ctx.state.progression.flags.escort_until)).toBeGreaterThan(ctx.state.time.tick);
  });
});

describe('Radio : situations selon le contexte, ordres selon les moyens', () => {
  it('ne tire que des situations compatibles et bloque les ordres sans les moyens requis', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6).map((a) => a.id);
    const m = ctx.sim.missions.launch({ typeId: 'patrol', target, memberIds, vehicleIds: [], loadout: 'standard' })!;
    m.radioQueue = [];
    const radio = ctx.content.radio;
    // Pas de véhicule, pas d'hélicoptère, pas de médecin, pas de forces spéciales
    expect(ctx.sim.radio.matches(m, { motorized: true })).toBe(false);
    expect(ctx.sim.radio.matches(m, { onFoot: true })).toBe(true);
    expect(ctx.sim.radio.matches(m, { hasType: ['sf'] })).toBe(false);
    const wounded = radio.messages.find((r) => r.id === 'wounded')!;
    expect(ctx.sim.radio.choiceBlock(wounded.choices.find((c) => c.id === 'medic')!, m)).toBe('types');
    expect(ctx.sim.radio.choiceBlock(wounded.choices.find((c) => c.id === 'heli')!, m)).toBe('heli');
    expect(ctx.sim.radio.choiceBlock(wounded.choices.find((c) => c.id === 'rtb')!, m)).toBeNull();
    // Les suites ne sont jamais tirées au hasard ; les situations sont variées
    expect(radio.messages.length).toBeGreaterThan(40);
  });

  it('une issue favorable peut entraîner un message de suite', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6).map((a) => a.id);
    const m = ctx.sim.missions.launch({ typeId: 'patrol', target, memberIds, vehicleIds: [], loadout: 'standard' })!;
    m.radioQueue = [];
    stepUntil(ctx, () => m.phase === 'outbound', 300);
    ctx.state.radio.queue.push({ missionId: m.id, radioId: 'tic' });
    stepUntil(ctx, () => ctx.state.radio.pending !== null, 5);
    ctx.random = () => 0.01; // première issue (favorable)
    ctx.commands.push({ type: 'radioChoose', choiceId: 'push' });
    ctx.sim.step();
    expect(m.radioQueue.some((q) => q.radioId === 'ambush_followup')).toBe(true);
  });
});
