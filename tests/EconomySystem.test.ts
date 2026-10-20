import { describe, expect, it } from 'vitest';
import type { ResourceId } from '../src/core/GameState';
import { UNCAPPED } from '../src/systems/EconomySystem';
import { CENTER, buildNow, makeGame, stepTicks, ticksToBuild } from './helpers';

describe('EconomySystem', () => {
  it('calcule les capacités de base et ajoute le stockage des citernes terminées', () => {
    const ctx = makeGame();
    const base = ctx.content.balance.economy.baseCapacity.water!;
    expect(ctx.state.resources.capacity.water).toBe(base);
    expect(ctx.state.resources.capacity.funds).toBe(UNCAPPED);
    const tank = ctx.sim.build.place('water_tank', CENTER, 0)!;
    expect(ctx.state.resources.capacity.water).toBe(base); // pas avant la fin du chantier
    stepTicks(ctx, ticksToBuild(ctx, 'water_tank'));
    expect(tank.state).toBe('active');
    expect(ctx.state.resources.capacity.water).toBe(base + 5000);
  });

  it('applique production (selon l’électricité) et consommation heure par heure', () => {
    const ctx = makeGame();
    buildNow(ctx, 'water_well', CENTER);
    buildNow(ctx, 'watchtower', { x: CENTER.x - 4, y: CENTER.y });
    // Sans groupe électrogène, le forage tourne à mi-régime
    const water0 = ctx.state.resources.stock.water;
    stepTicks(ctx, 24 * 60);
    expect(ctx.state.resources.stock.water).toBeCloseTo(water0 + 75, 5);

    buildNow(ctx, 'generator', { x: CENTER.x + 4, y: CENTER.y });
    const water = ctx.state.resources.stock.water;
    const ammo = ctx.state.resources.stock.ammo;
    stepTicks(ctx, 24 * 60);
    expect(ctx.state.resources.stock.water).toBeCloseTo(water + 150, 5);
    expect(ctx.state.resources.stock.ammo).toBeCloseTo(ammo - 5, 5);
  });

  it('verse un budget modulé par l’évaluation du commandement', () => {
    const ctx = makeGame();
    const funds = ctx.state.resources.stock.funds;
    stepTicks(ctx, 18 * 60); // 06:00 → 00:00 du jour 2
    expect(ctx.state.time.day).toBe(2);
    const rating = ctx.state.progression.lastRating!;
    expect(rating).toBeGreaterThan(0);
    expect(ctx.state.resources.stock.funds).toBe(funds + ctx.sim.economy.dailyBudget(rating));
    expect(ctx.state.progression.reputation).toBeCloseTo((rating - 0.5) * ctx.content.balance.command.reputationPerPoint, 5);
  });

  it('signale une pénurie une seule fois tant qu’elle dure', () => {
    const ctx = makeGame();
    buildNow(ctx, 'watchtower', CENTER);
    ctx.state.resources.stock.ammo = 0.1;
    const shortages: ResourceId[] = [];
    ctx.bus.on('resource:shortage', ({ resource }) => shortages.push(resource));
    stepTicks(ctx, 5 * 60);
    expect(shortages.filter((r) => r === 'ammo')).toEqual(['ammo']);
    expect(ctx.state.resources.stock.ammo).toBe(0);
    expect(ctx.state.resources.shortages).toContain('ammo');
  });

  it('projette le flux journalier, salaires et consommation du personnel compris', () => {
    const ctx = makeGame();
    buildNow(ctx, 'water_well', CENTER);
    buildNow(ctx, 'generator', { x: CENTER.x + 4, y: CENTER.y });
    const p = ctx.sim.economy.projections();
    expect(p.water.perDay).toBe(150);
    expect(p.fuel.perDay).toBe(-30);
    expect(p.funds.perDay).toBe(ctx.sim.economy.dailyBudget() - 20 - 10);

    const withAgents = makeGame(undefined, { agents: true });
    const agents = Object.values(withAgents.state.agents);
    const proj = withAgents.sim.economy.projections();
    const salaries = agents.reduce((s, a) => s + withAgents.content.personnel(a.defId).salaryPerDay, 0);
    expect(withAgents.sim.economy.dailySalaries()).toBe(salaries);
    expect(proj.water.perDay).toBeCloseTo(-0.2 * 24 * agents.length, 5); // boire, pas encore de douches
    expect(proj.food.perDay).toBeCloseTo(-3 * agents.length, 5);
    expect(proj.funds.perDay).toBe(withAgents.sim.economy.dailyBudget() - salaries);
  });

  it('électricité : rendement réduit sans courant, pénurie signalée', () => {
    const ctx = makeGame();
    const dfac = buildNow(ctx, 'dfac', CENTER);
    expect(ctx.sim.economy.powerRatio()).toBe(0);
    expect(ctx.sim.economy.buildingEfficiency(dfac)).toBeCloseTo(0.5, 5);
    buildNow(ctx, 'generator', { x: CENTER.x + 6, y: CENTER.y });
    expect(ctx.state.resources.power.supply).toBe(60);
    expect(ctx.sim.economy.buildingEfficiency(dfac)).toBe(1);
    ctx.state.resources.stock.fuel = 0;
    stepTicks(ctx, 60);
    expect(ctx.state.resources.power.supply).toBe(0);
    expect(ctx.state.resources.shortages).toContain('power');
  });
});
