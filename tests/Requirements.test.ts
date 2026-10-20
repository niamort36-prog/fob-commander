import { describe, expect, it } from 'vitest';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

describe('Besoins de la base selon l’effectif', () => {
  it('les besoins grandissent avec l’effectif et se couvrent en construisant', () => {
    const ctx = makeGame(undefined, { agents: true });
    const req = ctx.sim.requirements;
    const n = req.headcount();
    const toilet = () => req.status().find((r) => r.def.id === 'toilet')!;
    expect(toilet().required).toBe(Math.ceil(n / 6));
    expect(toilet().state).toBe('short');
    // Deux rangées de latrines améliorées couvrent l'effectif de départ
    for (const x of [0, 3]) buildNow(ctx, 'latrines', { x: CENTER.x + x, y: CENTER.y }).level = 2;
    expect(toilet().capacity).toBe(10);
    expect(toilet().shortfall).toBe(0);
    // Le réfectoire n'est exigé qu'à partir de 8 personnes
    const meal = req.status().find((r) => r.def.id === 'meal')!;
    expect(meal.active).toBe(n >= 8);
  });

  it('une base sous-dimensionnée pèse sur le moral, moins pendant l’installation', () => {
    const ctx = makeGame(undefined, { agents: true });
    const req = ctx.sim.requirements;
    expect(req.ramp()).toBe(0);
    expect(req.moralePenalty()).toBe(0);
    ctx.state.time.day = 6;
    expect(req.ramp()).toBe(1);
    const full = req.moralePenalty();
    expect(full).toBeGreaterThan(5);
    expect(full).toBeLessThanOrEqual(ctx.content.balance.requirements.maxPenalty);
    expect(req.hygieneDecayMult()).toBeGreaterThan(1);
    // Moral visé d'un soldat plus bas qu'avec une base bien équipée (plafond levé pour comparer)
    ctx.content.balance.requirements.maxPenalty = 100;
    const a = Object.values(ctx.state.agents)[0];
    const before = ctx.sim.needs.moraleTarget(a);
    for (const id of ['latrines', 'latrines', 'latrines', 'showers', 'showers', 'showers']) {
      for (let i = 0; i < 30; i++) {
        try {
          buildNow(ctx, id, { x: CENTER.x - 12 + (i % 10) * 3, y: CENTER.y - 12 + Math.floor(i / 10) * 3 });
          break;
        } catch {
          // case occupée
        }
      }
    }
    expect(ctx.sim.needs.moraleTarget(a)).toBeGreaterThan(before);
  });

  it('les soldats vont aux latrines quand le besoin se fait sentir', () => {
    const ctx = makeGame(undefined, { agents: true });
    const lat = buildNow(ctx, 'latrines', { x: CENTER.x, y: CENTER.y + 4 });
    for (const a of Object.values(ctx.state.agents)) a.needs.toilet = 5;
    stepUntil(ctx, () => Object.values(ctx.state.agents).some((a) => a.activity?.id === 'toilet' && a.activity.targetId === lat.id), 120);
  });

  it('service saturé : les soldats font la queue devant la porte, l’attente est mesurée', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'latrines', { x: CENTER.x, y: CENTER.y + 4 });
    for (const a of Object.values(ctx.state.agents)) a.needs.toilet = 5;
    stepUntil(ctx, () => Object.values(ctx.state.agents).some((a) => a.activity?.id === 'queue' && a.activity.queueFor === 'toilet'), 120);
    stepTicks(ctx, 60);
    const toilet = ctx.sim.requirements.status().find((r) => r.def.id === 'toilet')!;
    expect(toilet.waits).toBeGreaterThan(0);
  });

  it('sans latrines, les soldats se soulagent derrière un mur (hygiène et moral en baisse)', () => {
    const ctx = makeGame(undefined, { agents: true });
    for (const a of Object.values(ctx.state.agents)) a.needs.toilet = 5;
    stepUntil(ctx, () => Object.values(ctx.state.agents).some((a) => a.activity?.id === 'toilet_rough'), 60);
  });
});
