import { describe, expect, it } from 'vitest';
import { MEALS } from '../src/systems/LogisticsSystem';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

describe('Logistique interne', () => {
  it('un bâtiment terminé reçoit une dotation initiale prise sur le stock libre', () => {
    const ctx = makeGame();
    const tower = buildNow(ctx, 'watchtower', CENTER);
    const cap = ctx.content.building('watchtower').supplies!.ammo!.capacity;
    expect(ctx.sim.logistics.stock(tower, 'ammo')).toBe(cap);
    // Le stock local fait partie du stock global : il n'est plus « libre »
    expect(ctx.sim.logistics.free('ammo')).toBe(ctx.state.resources.stock.ammo - cap);
  });

  it('la tour puise ses munitions dans son stock local, puis tombe à sec', () => {
    const ctx = makeGame();
    const tower = buildNow(ctx, 'watchtower', CENTER);
    tower.inventory!.ammo = 1;
    stepTicks(ctx, 6 * 60);
    expect(ctx.sim.logistics.starved(tower, 'ammo')).toBe(true);
  });

  it('le soutien va chercher les rations à l’entrepôt et les livre au réfectoire', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'warehouse', { x: CENTER.x - 8, y: CENTER.y });
    const dfac = buildNow(ctx, 'dfac', { x: CENTER.x + 4, y: CENTER.y });
    dfac.inventory!.food = 0;
    let runs = 0;
    stepUntil(
      ctx,
      () => {
        runs = Math.max(runs, Object.values(ctx.state.agents).filter((a) => a.activity?.id === 'supply' && a.activity.carry).length);
        return ctx.sim.logistics.stock(dfac, 'food') > 0;
      },
      4 * 60,
    );
    expect(runs).toBeGreaterThan(0);
  });

  it('un groupe électrogène sans carburant livré ne produit plus ; le ravitaillement le relance', () => {
    const ctx = makeGame(undefined, { agents: true });
    const gen = buildNow(ctx, 'generator', CENTER);
    expect(ctx.state.resources.power.supply).toBeGreaterThan(0);
    gen.inventory!.fuel = 0;
    ctx.sim.economy.recomputePower();
    expect(ctx.state.resources.power.supply).toBe(0);
    stepUntil(ctx, () => ctx.state.resources.power.supply > 0, 4 * 60);
    expect(ctx.sim.logistics.stock(gen, 'fuel')).toBeGreaterThan(0);
  });

  it('le cuisinier prépare des repas avec les rations du réfectoire ; sans repas, ration froide', () => {
    const ctx = makeGame(undefined, { agents: true });
    const dfac = buildNow(ctx, 'dfac', CENTER);
    dfac.inventory![MEALS] = 0;
    const food = ctx.sim.logistics.stock(dfac, 'food');
    stepUntil(ctx, () => ctx.sim.logistics.meals(dfac) >= 5, 3 * 60);
    expect(Object.values(ctx.state.agents).some((a) => a.activity?.id === 'cook')).toBe(true);
    expect(ctx.sim.logistics.stock(dfac, 'food')).toBeLessThan(food);

    // Plus de repas ni de rations au réfectoire : les affamés mangent une ration froide
    const ctx2 = makeGame(undefined, { agents: true });
    const dfac2 = buildNow(ctx2, 'dfac', CENTER);
    dfac2.inventory = { food: 0, [MEALS]: 0 };
    for (const a of Object.values(ctx2.state.agents)) a.needs.food = 5;
    stepTicks(ctx2, 20);
    const acts = Object.values(ctx2.state.agents).map((a) => a.activity?.id);
    expect(acts).toContain('eat_mre');
    expect(acts).not.toContain('eat');
  });

  it('les douches se salissent à l’usage et le soutien les nettoie', () => {
    const ctx = makeGame(undefined, { agents: true });
    const showers = buildNow(ctx, 'showers', CENTER);
    showers.cleanliness = 0.2;
    expect(ctx.sim.logistics.dirty(showers)).toBe(true);
    stepUntil(ctx, () => (showers.cleanliness ?? 0) > 0.9, 4 * 60);
    ctx.sim.logistics.soil(showers);
    expect(showers.cleanliness).toBeLessThan(1);
  });

  it('les ouvriers portent les matériaux au chantier avant de les monter', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'warehouse', { x: CENTER.x - 10, y: CENTER.y });
    ctx.state.resources.stock.funds += 10000;
    const toc = ctx.sim.build.place('toc', { x: CENTER.x + 4, y: CENTER.y + 2 }, 0)!;
    const needed = toc.materials!.needed;
    expect(needed).toBeGreaterThan(4);
    let fetched = false;
    let overCap = false;
    for (let i = 0; i < 24 * 60 && toc.state === 'construction'; i++) {
      ctx.sim.step();
      fetched ||= Object.values(ctx.state.agents).some((a) => a.activity?.id === 'fetch_materials' && (a.activity.materials ?? 0) > 0);
      if (toc.materials && toc.buildProgress > ctx.sim.logistics.materialCap(toc) + 1e-6) overCap = true;
    }
    expect(fetched).toBe(true);
    expect(overCap).toBe(false);
    expect(toc.state).toBe('active');
    expect(toc.materials).toBeNull();
    // Plus rapide qu'avec la seule équipe locale
    const crewOnly = ctx.content.building('toc').buildTimeMin / ctx.content.balance.build.baseCrewRate;
    expect(ctx.state.time.tick).toBeLessThan(crewOnly);
  });

  it('sans douches, l’hygiène en berne ne bloque ni les repas ni le sommeil', () => {
    const ctx = makeGame(undefined, { agents: true });
    const food = ctx.state.resources.stock.food;
    stepTicks(ctx, 56 * 60);
    const agents = Object.values(ctx.state.agents);
    const avg = (k: 'food' | 'sleep') => agents.reduce((s, a) => s + a.needs[k], 0) / agents.length;
    expect(avg('food')).toBeGreaterThan(40);
    expect(avg('sleep')).toBeGreaterThan(25);
    // Pas d'emballement de la consommation (repas interrompus et recommencés en boucle)
    expect(food - ctx.state.resources.stock.food).toBeLessThan(600);
  });

  it('les ouvrages en ligne ne demandent pas de matériaux', () => {
    const ctx = makeGame();
    const h = ctx.sim.build.place('hesco', CENTER, 0)!;
    expect(h.materials).toBeNull();
  });
});

describe('Munitions individuelles, cuisine de fortune, équipement', () => {
  it('le tireur puise dans ses munitions et va se rééquiper au dépôt', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'ammo_depot', { x: CENTER.x + 6, y: CENTER.y + 6 });
    const soldier = Object.values(ctx.state.agents).find((a) => a.defId === 'infantry')!;
    const cap = ctx.content.personnel('infantry').ammoCapacity!;
    expect(soldier.ammo).toBe(cap);
    soldier.ammo = 0.5;
    soldier.activity = null;
    const stock = ctx.state.resources.stock.ammo;
    stepUntil(ctx, () => (soldier.ammo ?? 0) >= cap - 1e-6, 4 * 60);
    expect(ctx.state.resources.stock.ammo).toBeLessThan(stock);
  });

  it('sans cuisinier, un soldat cuisine : des repas moins nourrissants', () => {
    const ctx = makeGame(undefined, { agents: true });
    for (const a of Object.values(ctx.state.agents)) if (a.defId === 'cook') delete ctx.state.agents[a.id];
    const dfac = buildNow(ctx, 'dfac', CENTER);
    dfac.inventory![MEALS] = 0;
    stepUntil(ctx, () => ctx.sim.logistics.meals(dfac) >= 3, 12 * 60);
    expect(ctx.sim.logistics.mealQuality(dfac)).toBeCloseTo(ctx.content.balance.logistics.amateurMealQuality, 5);
    expect(ctx.sim.logistics.takeMeal(dfac)).toBeCloseTo(ctx.content.balance.logistics.amateurMealQuality, 5);
  });
});
