import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import type { BuildingInstance } from '../src/core/GameState';
import { CENTER, buildNow, makeGame, stepUntil } from './helpers';

/** Poste de garde posé près de l'arrivée de la piste dans le périmètre, et TOC au centre. */
function setup(ctx: GameContext, level = 1): BuildingInstance {
  buildNow(ctx, 'toc', { x: CENTER.x - 1, y: CENTER.y - 1 });
  const dp = ctx.sim.missions.departurePoint();
  for (const [dx, dy] of [
    [2, 2],
    [2, -2],
    [-2, 2],
    [3, 0],
    [0, 3],
    [0, -3],
  ]) {
    try {
      const b = buildNow(ctx, 'guard_post', { x: dp.x + dx, y: dp.y + dy });
      b.level = level;
      return b;
    } catch {
      // case occupée : on essaie la suivante
    }
  }
  throw new Error('poste de garde impossible à poser');
}

/** Midi, sans arrivée automatique de civils pendant le test. */
function quiet(ctx: GameContext): void {
  ctx.state.time.minuteOfDay = 9 * 60;
  ctx.state.checkpoint.nextTick = Number.MAX_SAFE_INTEGER;
}

describe('Point de contrôle : fouille des civils', () => {
  it('un civil est fouillé au poste, entre dans la base puis repart', () => {
    const ctx = makeGame();
    setup(ctx);
    quiet(ctx);
    const cp = ctx.sim.checkpoint;
    const e = cp.spawn(null, false)!;
    expect(e).not.toBeNull();
    expect(e.phase).toBe('approach');
    stepUntil(ctx, () => e.phase === 'search', 200);
    stepUntil(ctx, () => e.phase === 'inside', 20);
    expect(cp.state.stats.searched).toBe(1);
    stepUntil(ctx, () => e.phase === 'business', 300);
    stepUntil(ctx, () => !cp.state.entrants.includes(e), 600);
  });

  it('un véhicule civil est fouillé puis repart', () => {
    const ctx = makeGame();
    setup(ctx);
    quiet(ctx);
    const cp = ctx.sim.checkpoint;
    const e = cp.spawn(null, true)!;
    expect(e.vehicleId).not.toBeNull();
    expect(ctx.state.vehicles[e.vehicleId!].civilian).toBe(true);
    stepUntil(ctx, () => e.phase === 'search', 200);
    stepUntil(ctx, () => !cp.state.entrants.includes(e), 800);
    expect(ctx.state.vehicles[e.vehicleId!]).toBeUndefined();
  });

  it('l’amélioration du poste et la sentinelle augmentent la détection', () => {
    const ctx = makeGame(undefined, { agents: true });
    const post = setup(ctx);
    const cp = ctx.sim.checkpoint;
    const unmanned = cp.detectChance(post);
    const guard = Object.values(ctx.state.agents).find((a) => a.defId === 'infantry')!;
    guard.activity = { id: 'guard', targetId: post.id, stage: 'acting', urgent: false, startTick: 0, endTick: ctx.state.time.tick + 600 };
    const l1 = cp.detectChance(post);
    post.level = 3;
    const l3 = cp.detectChance(post);
    expect(unmanned).toBeLessThan(l1);
    expect(l1).toBeLessThan(l3);
    expect(l3).toBeGreaterThan(0.8);
  });

  it('un tireur démasqué est arrêté : prime et moral', () => {
    const ctx = makeGame(undefined, { agents: true });
    setup(ctx);
    quiet(ctx);
    const cp = ctx.sim.checkpoint;
    cp.detectChance = () => 1;
    const funds = ctx.state.resources.stock.funds;
    const e = cp.spawn('gunman', false)!;
    stepUntil(ctx, () => e.phase === 'detained', 300);
    expect(cp.state.stats.caught).toBe(1);
    expect(ctx.state.resources.stock.funds).toBeGreaterThan(funds + 100);
    expect(ctx.state.log.some((l) => l.key === 'log.cp.caught.gunman')).toBe(true);
    expect(ctx.state.combat.active).toBe(false);
  });

  it('un tireur passé au contrôle ouvre le feu dans la base', () => {
    const ctx = makeGame(undefined, { agents: true });
    setup(ctx);
    quiet(ctx);
    const cp = ctx.sim.checkpoint;
    cp.detectChance = () => 0;
    cp.spawn('gunman', false);
    stepUntil(ctx, () => ctx.state.combat.active, 600);
    expect(ctx.state.combat.attackId).toBe('insider');
    expect(cp.state.stats.missed).toBe(1);
  });

  it('une voiture piégée non décelée explose dans la base', () => {
    const ctx = makeGame();
    setup(ctx);
    quiet(ctx);
    const cp = ctx.sim.checkpoint;
    cp.detectChance = () => 0;
    const toc = Object.values(ctx.state.fob.buildings).find((b) => b.defId === 'toc')!;
    const wear = toc.wear;
    const e = cp.spawn('vbied', true)!;
    expect(e.vehicleId).not.toBeNull();
    stepUntil(ctx, () => !cp.state.entrants.includes(e), 900);
    expect(ctx.state.log.some((l) => l.key === 'log.cp.missed.vbied')).toBe(true);
    expect(ctx.state.vehicles[e.vehicleId!]).toBeUndefined();
    expect(toc.wear).toBeGreaterThan(wear);
  });

  it('une ceinture explosive démasquée au poste équipé est le plus souvent désamorcée', () => {
    let detained = 0;
    for (let i = 0; i < 6; i++) {
      const ctx = makeGame();
      setup(ctx, 3);
      quiet(ctx);
      const cp = ctx.sim.checkpoint;
      cp.detectChance = () => 1;
      const e = cp.spawn('vest', false)!;
      for (let k = 0; k < i; k++) ctx.random(); // tirages différents d'une partie à l'autre
      stepUntil(ctx, () => e.phase === 'detained' || !cp.state.entrants.includes(e), 300);
      if (e.phase === 'detained') detained++;
    }
    expect(detained).toBeGreaterThanOrEqual(3);
  });
});
