import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

/** Répond au dialogue de la visite avec le dernier choix possible. */
function answer(ctx: GameContext): void {
  const a = ctx.state.events.active!;
  const def = ctx.content.event(a.eventId);
  const choice = [...def.choices].reverse().find((c) => !ctx.sim.events.choiceBlock(c))!;
  ctx.sim.events.choose(choice.id);
  ctx.sim.events.close();
}

describe('Forces spéciales', () => {
  it('il faut un commandant des forces spéciales pour recruter des opérateurs', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.state.progression.reputation = 100;
    expect(ctx.sim.supply.recruitBlock('sf')).toBe('requires');
    expect(ctx.sim.supply.recruitBlock('sf_commander')).toBeNull();
    ctx.sim.agents.createAgent('sf_commander', null, ctx.state.fob.entry);
    expect(ctx.sim.supply.recruitBlock('sf')).toBeNull();
    expect(ctx.sim.supply.recruitBlock('sf_commander')).toBe('max'); // un seul commandant
  });
});

describe('Visites physiques', () => {
  it('à pied : le visiteur vient au point de rencontre, le dialogue s’ouvre, il reste puis repart', () => {
    const ctx = makeGame();
    buildNow(ctx, 'toc', CENTER, 0);
    expect(ctx.sim.events.trigger('informant')).toBe(true);
    const v = ctx.state.visit!;
    expect(v.phase).toBe('arriving');
    expect(ctx.state.events.active).toBeNull();
    stepUntil(ctx, () => ctx.state.events.active?.eventId === 'informant', 600);
    const leader = v.visitors.find((p) => p.leader)!;
    expect(Math.hypot(leader.pos.x - (v.meet.x + 0.5), leader.pos.y - (v.meet.y + 0.5))).toBeLessThan(0.1);
    answer(ctx);
    expect(v.phase).toBe('staying');
    stepUntil(ctx, () => v.phase === 'leaving', 200);
    stepUntil(ctx, () => ctx.state.visit === null, 600);
  });

  it('en charrette : l’ancien arrive avec son escorte, la charrette repart avec lui', () => {
    const ctx = makeGame();
    ctx.sim.events.trigger('elder_visit');
    const v = ctx.state.visit!;
    const cart = ctx.state.vehicles[v.vehicleId!];
    expect(cart.defId).toBe('cart');
    expect(cart.visit).toBe(true);
    expect(v.visitors.filter((p) => !p.leader)).toHaveLength(3);
    expect(v.visitors.find((p) => p.leader)!.riding).toBe(true);
    stepUntil(ctx, () => ctx.state.events.active?.eventId === 'elder_visit', 1200);
    expect(Math.hypot(cart.pos.x - v.meet.x, cart.pos.y - v.meet.y)).toBeLessThan(7);
    answer(ctx);
    stepUntil(ctx, () => ctx.state.visit === null, 2000);
    expect(ctx.state.vehicles[cart.id]).toBeUndefined();
  });

  it('en hélicoptère : il se pose sur l’hélisurface, le général débarque, puis l’appareil redécolle', () => {
    const ctx = makeGame();
    const pad = buildNow(ctx, 'helipad', { x: CENTER.x + 6, y: CENTER.y - 8 });
    ctx.sim.events.trigger('general_inspection');
    const v = ctx.state.visit!;
    const heli = ctx.state.vehicles[v.vehicleId!];
    expect(heli.defId).toBe('helicopter');
    expect(heli.targetId).toBe(pad.id);
    expect(v.visitors.every((p) => p.riding)).toBe(true);
    stepUntil(ctx, () => heli.state === 'unloading', 300);
    expect(heli.altitude).toBe(0);
    expect(v.visitors.every((p) => !p.riding)).toBe(true);
    stepUntil(ctx, () => ctx.state.events.active?.eventId === 'general_inspection', 400);
    answer(ctx);
    stepUntil(ctx, () => v.phase === 'leaving', 300);
    stepUntil(ctx, () => heli.state === 'outbound', 300);
    stepUntil(ctx, () => ctx.state.visit === null, 400);
    expect(ctx.state.vehicles[heli.id]).toBeUndefined();
  });

  it('une attaque fait partir les visiteurs sans attendre', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.sim.events.trigger('sick_child');
    stepUntil(ctx, () => ctx.state.events.active?.eventId === 'sick_child', 600);
    answer(ctx);
    expect(ctx.state.visit!.phase).toBe('staying');
    ctx.sim.attacks.start('mortar', 'shelter');
    stepTicks(ctx, 2);
    expect(ctx.state.visit!.phase).toBe('leaving');
  });

  it('aucun autre événement ne survient pendant une visite', () => {
    const ctx = makeGame();
    ctx.sim.events.trigger('informant');
    ctx.random = () => 0;
    stepTicks(ctx, 61);
    expect(ctx.state.events.active).toBeNull();
  });
});
