import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

/** Piste d'aviation posée au nord-ouest du centre (orientation nord-sud). */
function airstrip(ctx: GameContext) {
  const z = ctx.state.fob.zone;
  const b = buildNow(ctx, 'airstrip', { x: z.x + 2, y: z.y + 2 });
  ctx.state.resources.stock.funds += 60000; // la piste a vidé la caisse de départ
  return b;
}

function setHour(ctx: GameContext, hour: number): void {
  while (Math.floor(ctx.state.time.minuteOfDay / 60) !== hour) ctx.sim.step();
}

describe('Piste d’aviation et C-130', () => {
  it('le C-130 se pose, débarque renforts et véhicules, puis redécolle', () => {
    const ctx = makeGame();
    const strip = airstrip(ctx);
    buildNow(ctx, 'vehicle_park', { x: CENTER.x + 6, y: CENTER.y + 4 });
    ctx.state.resources.stock.funds += 100000;
    const order = ctx.sim.supply.placeOrder('c130', { food: 1000, ammo: 500 }, [{ type: 'infantry', count: 6 }], ['humvee', 'mrap'])!;
    expect(order).not.toBeNull();
    expect(order.cost).toBeGreaterThan(9000 + 7000 + 15000);
    stepUntil(ctx, () => order.status === 'en_route', 20 * 60);
    const plane = ctx.state.vehicles[order.vehicleId!];
    expect(plane.altitude).toBeGreaterThan(0);
    expect(plane.targetId).toBe(strip.id);
    stepUntil(ctx, () => plane.state === 'unloading', 240);
    expect(plane.altitude).toBe(0);
    // Posé sur l'axe de la piste
    const axis = ctx.sim.supply.runwayAxis(strip);
    expect(Math.abs(plane.pos.x - axis.start.x)).toBeLessThan(0.01);
    expect(Object.values(ctx.state.agents).filter((a) => a.defId === 'infantry')).toHaveLength(6);
    const delivered = Object.values(ctx.state.vehicles).filter((v) => v.defId === 'humvee' || v.defId === 'mrap');
    expect(delivered).toHaveLength(2);
    expect(delivered.every((v) => v.homeId !== null)).toBe(true);
    // Une fois vidé, il fait demi-tour, décolle et quitte la carte
    plane.cargo = {};
    stepUntil(ctx, () => !ctx.state.vehicles[plane.id], 600);
    expect(order.status).toBe('delivered');
  });

  it('refuse les véhicules au-delà de la place disponible au parc', () => {
    const ctx = makeGame();
    airstrip(ctx);
    ctx.state.resources.stock.funds += 200000;
    expect(ctx.sim.supply.check('c130', {}, [], ['humvee'])).toBe('vehicles'); // pas de parc
    buildNow(ctx, 'vehicle_park', { x: CENTER.x + 6, y: CENTER.y + 4 });
    expect(ctx.sim.supply.check('c130', {}, [], ['humvee', 'mrap'])).toBeNull();
    expect(ctx.sim.supply.check('c130', {}, [], ['humvee', 'mrap', 'mrap'])).toBe('vehicles'); // 2 places en soute
    for (let i = 0; i < 3; i++) ctx.sim.supply.buyVehicle('mrap');
    expect(ctx.sim.supply.check('c130', {}, [], ['humvee', 'humvee'])).toBe('vehicles'); // parc presque plein
    expect(ctx.sim.supply.canBuyVehicle('humvee')).toBeNull();
    ctx.sim.supply.buyVehicle('humvee');
    expect(ctx.sim.supply.canBuyVehicle('humvee')).toBe('limit');
  });
});

describe('Appui feu des missions', () => {
  const plan = (ctx: GameContext, support: string) => {
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const memberIds = ctx.sim.missions
      .availableAgents()
      .filter((a) => a.defId === 'infantry')
      .slice(0, 6)
      .map((a) => a.id);
    return { typeId: 'patrol', target, memberIds, vehicleIds: [], loadout: 'standard', support };
  };

  it('l’A-10 exige la piste, vole de jour, améliore la chance et décolle au départ', () => {
    const ctx = makeGame(undefined, { agents: true });
    const p = plan(ctx, 'a10');
    expect(ctx.sim.missions.supportBlock('a10', p.target)).toBe('requires');
    expect(ctx.sim.missions.check(p)).toBe('support');
    airstrip(ctx);
    setHour(ctx, 10);
    expect(ctx.sim.missions.supportBlock('a10', p.target)).toBeNull();
    const without = ctx.sim.missions.estimate({ ...p, support: 'none' });
    const withAir = ctx.sim.missions.estimate(p);
    expect(withAir.chance).toBeGreaterThan(without.chance);
    expect(withAir.costs.funds).toBe(4000);
    const m = ctx.sim.missions.launch(p)!;
    expect(m.support).toBe('a10');
    expect(ctx.sim.missions.supportBlock('a10', p.target)).toBe('cooldown');
    stepUntil(ctx, () => m.phase === 'outbound', 300);
    expect(Object.values(ctx.state.vehicles).filter((v) => v.defId === 'a10').length).toBe(2);
    stepTicks(ctx, 60);
    expect(Object.values(ctx.state.vehicles).filter((v) => v.defId === 'a10').length).toBe(0); // sortis de la carte
  });

  it('l’AC-130 ne vole que de nuit', () => {
    const ctx = makeGame(undefined, { agents: true });
    const p = plan(ctx, 'ac130');
    airstrip(ctx);
    setHour(ctx, 12);
    expect(ctx.sim.missions.supportBlock('ac130', p.target)).toBe('hours');
    setHour(ctx, 22);
    expect(ctx.sim.missions.supportBlock('ac130', p.target)).toBeNull();
  });

  it('l’artillerie de la base appuie les missions à portée et tire des salves', () => {
    const ctx = makeGame(undefined, { agents: true });
    const p = plan(ctx, 'artillery');
    expect(ctx.sim.missions.supportBlock('artillery', p.target)).toBe('requires');
    buildNow(ctx, 'artillery', { x: CENTER.x - 8, y: CENTER.y + 6 });
    const far = ctx.sim.missions.targetFrom({ kind: 'contact', id: 'rasoul_hq' })!;
    expect(ctx.sim.missions.supportBlock('artillery', far)).toBe('range');
    expect(ctx.sim.missions.supportBlock('artillery', p.target)).toBeNull();
    let fired = 0;
    ctx.bus.on('artillery:fire', () => fired++);
    const m = ctx.sim.missions.launch(p)!;
    m.radioQueue = [];
    stepUntil(ctx, () => m.phase === 'objective', 2000);
    stepTicks(ctx, 40);
    expect(fired).toBeGreaterThan(0);
    expect(m.radioLog.some((l) => l.text.includes('Artillerie'))).toBe(true);
  });

  it('avec un appui aérien en alerte, la demande d’appui par radio est gratuite', () => {
    const ctx = makeGame(undefined, { agents: true });
    airstrip(ctx);
    setHour(ctx, 10);
    const m = ctx.sim.missions.launch(plan(ctx, 'a10'))!;
    const air = ctx.content.radioMessage('tic').choices.find((c) => c.id === 'air')!;
    expect(ctx.sim.radio.costOf(air, m.id)).toEqual({});
    const other = ctx.sim.missions.launch({ ...plan(ctx, 'none') })!;
    expect(ctx.sim.radio.costOf(air, other.id).funds).toBeGreaterThan(0);
  });
});

describe('Batterie d’obusiers de la base', () => {
  it('pilonne les assaillants pendant une attaque au sol', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'artillery', { x: CENTER.x - 4, y: CENTER.y - 4 });
    let fired = 0;
    ctx.bus.on('artillery:fire', () => fired++);
    const ammo = ctx.state.resources.stock.ammo;
    ctx.sim.attacks.start('assault', 'engage');
    stepUntil(ctx, () => !ctx.state.combat.active, 900);
    expect(fired).toBeGreaterThan(0);
    expect(ctx.state.resources.stock.ammo).toBeLessThan(ammo);
    expect(ctx.state.log.some((l) => l.key === 'log.artilleryFire')).toBe(true);
  });

  it('riposte aux tirs de mortier (contre-batterie)', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'artillery', { x: CENTER.x - 4, y: CENTER.y - 4 });
    ctx.sim.attacks.start('mortar', 'shelter');
    ctx.random = () => 0.01;
    stepUntil(ctx, () => !ctx.state.combat.active, 400);
    expect(ctx.state.log.some((l) => l.key === 'log.counterBattery')).toBe(true);
  });
});
