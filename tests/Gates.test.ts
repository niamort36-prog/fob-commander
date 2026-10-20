import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import { CENTER, buildNow, makeGame, stepUntil } from './helpers';

/** Enceinte carrée de hesco autour du centre (rayon r), avec une porte au sud. */
function walledBase(ctx: GameContext, r = 5): { gateId: string } {
  buildNow(ctx, 'toc', { x: CENTER.x - 1, y: CENTER.y - 1 });
  for (let x = CENTER.x - r; x <= CENTER.x + r; x++) {
    for (const y of [CENTER.y - r, CENTER.y + r]) buildNow(ctx, 'hesco', { x, y });
  }
  for (let y = CENTER.y - r + 1; y <= CENTER.y + r - 1; y++) {
    for (const x of [CENTER.x - r, CENTER.x + r]) buildNow(ctx, 'hesco', { x, y });
  }
  const gate = buildNow(ctx, 'gate_small', { x: CENTER.x, y: CENTER.y + r });
  return { gateId: gate.id };
}

describe('Portes, postes de garde et assauts', () => {
  it('une porte se pose à la place d’un tronçon de hesco ; le personnel passe, l’ennemi non', () => {
    const ctx = makeGame();
    const wall = buildNow(ctx, 'hesco', CENTER);
    const gate = buildNow(ctx, 'gate_small', CENTER);
    expect(ctx.state.fob.buildings[wall.id]).toBeUndefined();
    const nav = ctx.sim.agents.nav;
    nav.ensure();
    expect(nav.walkable(CENTER.x, CENTER.y)).toBe(true);
    expect(nav.drivable(CENTER.x, CENTER.y)).toBe(false); // porte piétonne
    expect(nav.enemyPassable(CENTER.x, CENTER.y)).toBe(false);
    expect(nav.breachAt(CENTER.x, CENTER.y)).toBe(gate.id);
  });

  it('le portail laisse passer les véhicules', () => {
    const ctx = makeGame();
    buildNow(ctx, 'gate_double', { x: CENTER.x, y: CENTER.y + 3 });
    const nav = ctx.sim.agents.nav;
    nav.ensure();
    expect(nav.drivable(CENTER.x, CENTER.y + 3)).toBe(true);
    expect(nav.drivable(CENTER.x + 1, CENTER.y + 3)).toBe(true);
    expect(nav.gateAt(CENTER.x + 1, CENTER.y + 3)).not.toBeNull();
  });

  it('un poste de garde occupé contrôle la porte voisine', () => {
    const ctx = makeGame(undefined, { agents: true });
    const gate = buildNow(ctx, 'gate_double', { x: CENTER.x, y: CENTER.y + 3 });
    const post = buildNow(ctx, 'guard_post', { x: CENTER.x + 2, y: CENTER.y + 2 });
    expect(ctx.sim.supply.gateGuarded(gate.id)).toBe(false);
    const guard = Object.values(ctx.state.agents).find((a) => a.defId === 'infantry')!;
    guard.activity = { id: 'guard', targetId: post.id, stage: 'acting', urgent: false, startTick: 0, endTick: ctx.state.time.tick + 600 };
    expect(ctx.sim.supply.gateGuarded(gate.id)).toBe(true);
  });

  it('à l’assaut, l’ennemi force la porte de l’enceinte puis progresse dans la base', () => {
    const ctx = makeGame();
    const { gateId } = walledBase(ctx);
    ctx.sim.attacks.start('assault', 'shelter');
    const z = ctx.state.combat;
    expect(Object.keys(z.enemies).length).toBeGreaterThan(0);
    stepUntil(ctx, () => Object.values(z.enemies).some((e) => e.state === 'breach'), 600);
    const breaching = Object.values(z.enemies).find((e) => e.state === 'breach')!;
    expect(ctx.state.fob.buildings[breaching.breachId!]).toBeDefined();
    stepUntil(ctx, () => !ctx.state.fob.buildings[breaching.breachId!], 400);
    expect(ctx.state.log.some((l) => l.key === 'log.breach')).toBe(true);
    void gateId;
    // Une fois la brèche ouverte, un assaillant entre dans l'enceinte
    const inside = (): boolean => Object.values(z.enemies).some((e) => Math.abs(e.pos.x - CENTER.x) < 5 && Math.abs(e.pos.y - CENTER.y) < 5);
    stepUntil(ctx, inside, 400);
  });

  it('le harcèlement reste à l’extérieur : pas de porte forcée', () => {
    const ctx = makeGame();
    walledBase(ctx);
    const before = Object.keys(ctx.state.fob.buildings).length;
    ctx.sim.attacks.start('harassment', 'shelter');
    for (let i = 0; i < 300 && ctx.state.combat.active; i++) ctx.sim.step();
    expect(Object.values(ctx.state.combat.enemies).every((e) => e.state !== 'breach')).toBe(true);
    expect(Object.keys(ctx.state.fob.buildings).length).toBe(before);
  });
});
