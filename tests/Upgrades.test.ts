import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import type { BuildingInstance } from '../src/core/GameState';
import { commsPenalty } from '../src/systems/modules';
import { CENTER, buildNow, makeGame, stepUntil } from './helpers';

function install(ctx: GameContext, b: BuildingInstance, moduleId: string): void {
  ctx.state.resources.stock.funds += 50000;
  ctx.state.resources.stock.parts += 200;
  ctx.state.resources.stock.medical += 200;
  expect(ctx.sim.build.installModule(b.id, moduleId)).toBe(true);
  stepUntil(ctx, () => b.modules?.includes(moduleId) === true, 3000);
}

describe('Améliorations des bâtiments', () => {
  it('climatisation et literie améliorent le confort des occupants (la clim consomme du courant)', () => {
    const ctx = makeGame(undefined, { agents: true });
    const tent = buildNow(ctx, 'tent_group', { x: CENTER.x - 8, y: CENTER.y - 8 });
    ctx.sim.agents.markHomesDirty();
    ctx.sim.step();
    const resident = Object.values(ctx.state.agents).find((a) => a.homeId === tent.id)!;
    // Besoins figés : on ne mesure que l'effet des améliorations, pas le temps écoulé pendant les travaux
    const fill = (): void => {
      for (const k of Object.keys(resident.needs) as (keyof typeof resident.needs)[]) if (k !== 'morale') resident.needs[k] = 90;
    };
    fill();
    const before = ctx.sim.needs.moraleTarget(resident);
    install(ctx, tent, 'beds');
    install(ctx, tent, 'ac');
    fill();
    expect(ctx.sim.needs.moraleTarget(resident)).toBeGreaterThan(before);
    ctx.sim.economy.recomputePower();
    expect(ctx.state.resources.power.demand).toBeGreaterThanOrEqual(2);
    expect(ctx.sim.build.moduleCheck(tent, 'ac')).toBe('installed');
  });

  it('une amélioration peut en exiger une autre', () => {
    const ctx = makeGame();
    const toc = buildNow(ctx, 'toc', CENTER);
    expect(ctx.sim.build.moduleCheck(toc, 'satcom')).toBe('requires');
    install(ctx, toc, 'radio_mast');
    expect(ctx.sim.build.moduleCheck(toc, 'satcom')).toBeNull();
  });

  it('l’antenne étend la portée radio, la liaison satellite supprime la pénalité', () => {
    const ctx = makeGame();
    expect(commsPenalty(ctx.content, ctx.state, 30)).toBeGreaterThan(0); // pas de TOC
    const toc = buildNow(ctx, 'toc', CENTER);
    const plain = commsPenalty(ctx.content, ctx.state, 30);
    install(ctx, toc, 'radio_mast');
    expect(commsPenalty(ctx.content, ctx.state, 30)).toBeLessThan(plain);
    install(ctx, toc, 'satcom');
    expect(commsPenalty(ctx.content, ctx.state, 60)).toBe(0);
  });

  it('les murets de sacs de sable protègent les occupants de la tente', () => {
    const ctx = makeGame(undefined, { agents: true });
    const tent = buildNow(ctx, 'tent_group', { x: CENTER.x - 8, y: CENTER.y - 8 });
    const a = Object.values(ctx.state.agents)[0];
    a.activity = { id: 'shelter_home', targetId: tent.id, stage: 'acting', urgent: true, startTick: 0, endTick: 999 } as never;
    const attacks = ctx.sim.attacks as unknown as { protection(x: typeof a): number };
    const before = attacks.protection(a);
    install(ctx, tent, 'sandbags');
    expect(attacks.protection(a)).toBeLessThan(before);
  });
});

describe('Officiers au TOC pendant les missions', () => {
  it('sans officier au TOC, la chance de succès est réduite', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6).map((a) => a.id);
    const plan = { typeId: 'patrol', target, memberIds, vehicleIds: [], loadout: 'standard' };
    for (const a of Object.values(ctx.state.agents)) a.activity = null;
    const est = ctx.sim.missions.estimate(plan);
    expect(est.toc.present).toBe(0);
    expect(est.toc.required).toBe(1);
    expect(est.toc.mod).toBeLessThan(0);
    const officer = Object.values(ctx.state.agents).find((a) => a.defId === 'officer')!;
    officer.activity = { id: 'command', targetId: null, stage: 'acting', urgent: false, startTick: 0, endTick: 9999 } as never;
    const staffed = ctx.sim.missions.estimate(plan);
    expect(staffed.toc.mod).toBeGreaterThan(0);
    expect(staffed.chance).toBeGreaterThan(est.chance);
  });
});

describe('Équipement individuel', () => {
  it('achat au dépôt, distribution aux combattants et récupération', () => {
    const ctx = makeGame(undefined, { agents: true });
    expect(ctx.sim.supply.gearBlock('nvg', 5)).toBe('requires');
    buildNow(ctx, 'ammo_depot', { x: CENTER.x + 6, y: CENTER.y + 6 });
    ctx.state.resources.stock.funds += 20000;
    expect(ctx.sim.supply.buyGear('nvg', 5)).toBe(true);
    expect(ctx.state.equipment.nvg).toBe(5);
    expect(ctx.sim.supply.distributeGear('nvg')).toBe(5);
    expect(ctx.state.equipment.nvg).toBe(0);
    // Attribuée : les soldats vont la percevoir au dépôt
    expect(ctx.sim.supply.gearPendingCount('nvg')).toBe(5);
    stepUntil(ctx, () => ctx.sim.supply.gearPendingCount('nvg') === 0, 24 * 60);
    const equipped = Object.values(ctx.state.agents).filter((a) => a.gear?.includes('nvg'));
    expect(equipped).toHaveLength(5);
    expect(equipped.every((a) => ctx.content.equipment.eligible.includes(a.defId))).toBe(true);
    expect(ctx.sim.supply.recoverGear('nvg')).toBe(5);
    expect(ctx.state.equipment.nvg).toBe(5);
  });

  it('la vision nocturne améliore une mission de nuit et le tir de nuit', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const members = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6);
    const plan = { typeId: 'patrol', target, memberIds: members.map((a) => a.id), vehicleIds: [], loadout: 'standard' };
    while (Math.floor(ctx.state.time.minuteOfDay / 60) !== 18) ctx.sim.step(); // objectif atteint de nuit
    const without = ctx.sim.missions.estimate(plan);
    expect(without.night).toBe(true);
    for (const a of members) a.gear = ['nvg'];
    const withNvg = ctx.sim.missions.estimate(plan);
    expect(withNvg.chance).toBeGreaterThan(without.chance);
    // Tir de nuit : la vision nocturne supprime la pénalité
    while (Math.floor(ctx.state.time.minuteOfDay / 60) !== 23) ctx.sim.step();
    const attacks = ctx.sim.attacks as unknown as { hitChance(s: number, d: number, r: number, c: number, t: boolean, a?: unknown): number };
    const bare = attacks.hitChance(50, 3, 8, 1, false, { ...members[0], gear: [] });
    const nvg = attacks.hitChance(50, 3, 8, 1, false, members[0]);
    expect(nvg).toBeGreaterThan(bare);
  });
});
