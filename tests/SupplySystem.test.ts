import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import type { SupplyOrder } from '../src/core/GameState';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

/** Passe une commande et la fait arriver tout de suite, sans embuscade. */
function orderNow(ctx: GameContext, orderId: string, cargo = {}, passengers: { type: string; count: number }[] = []): SupplyOrder {
  ctx.state.resources.stock.funds += 50000;
  const order = ctx.sim.supply.placeOrder(orderId, cargo, passengers);
  if (!order) throw new Error('commande refusée : ' + ctx.sim.supply.check(orderId, cargo, passengers));
  order.ambushed = true; // pas de jet d'embuscade
  order.etaTick = ctx.state.time.tick + 1;
  return order;
}

describe('SupplySystem — ravitaillement', () => {
  it('refuse les commandes impossibles', () => {
    const ctx = makeGame();
    expect(ctx.sim.supply.check('convoy', { food: 100 }, [])).toBe('requires');
    buildNow(ctx, 'unloading_zone', CENTER);
    expect(ctx.sim.supply.check('convoy', { food: 5000 }, [])).toBe('capacity');
    expect(ctx.sim.supply.check('convoy', {}, [])).toBe('empty');
    expect(ctx.sim.supply.check('convoy', {}, [{ type: 'sf', count: 1 }])).toBe('locked');
    expect(ctx.sim.supply.check('convoy', {}, [{ type: 'infantry', count: 20 }])).toBe('passengers');
    expect(ctx.sim.supply.check('convoy', { food: 100 }, [])).toBeNull();
    expect(ctx.sim.supply.check('water', {}, [])).toBe('requires');
  });

  it('calcule le coût : transport + marchandises + renforts', () => {
    const ctx = makeGame();
    const def = ctx.content.supplyOrder('convoy');
    const cost = ctx.sim.supply.orderCost(def, { food: 100, ammo: 50 }, [{ type: 'infantry', count: 2 }]);
    const prices = ctx.content.supply.unitPrices;
    expect(cost).toBe(def.fee + 100 * (prices.food ?? 0) + 50 * (prices.ammo ?? 0) + 2 * 400);
  });

  it('le camion-citerne roule jusqu’à la cuve et la remplit par pompage', () => {
    const ctx = makeGame();
    buildNow(ctx, 'water_tank', CENTER);
    const water = ctx.state.resources.stock.water;
    const order = orderNow(ctx, 'water');
    stepTicks(ctx, 2);
    const v = ctx.state.vehicles[order.vehicleId!];
    expect(v.defId).toBe('water_tanker');
    expect(v.state).toBe('inbound');
    stepUntil(ctx, () => order.status === 'delivered', 3000);
    expect(ctx.state.vehicles[v.id]).toBeUndefined();
    expect(ctx.state.resources.stock.water).toBeCloseTo(water + 3000, 0);
  });

  it('le camion-citerne reste bloqué tant que la cuve est inaccessible', () => {
    const ctx = makeGame();
    const tank = buildNow(ctx, 'water_tank', CENTER);
    // Anneau de HESCO tout autour de la cuve
    const ring: { x: number; y: number }[] = [];
    for (let x = tank.pos.x - 1; x <= tank.pos.x + 2; x++) ring.push({ x, y: tank.pos.y - 1 }, { x, y: tank.pos.y + 2 });
    for (let y = tank.pos.y; y <= tank.pos.y + 1; y++) ring.push({ x: tank.pos.x - 1, y }, { x: tank.pos.x + 2, y });
    const walls = ring.map((c) => buildNow(ctx, 'hesco', c));
    const order = orderNow(ctx, 'water');
    stepTicks(ctx, 3);
    const v = ctx.state.vehicles[order.vehicleId!];
    expect(v.state).toBe('blocked');
    expect(ctx.state.log.some((l) => l.key === 'log.vehicleBlocked')).toBe(true);

    // On ouvre un accès sur un côté (pas un angle) : le camion finit par passer
    const side = walls.find((w) => w.pos.x === tank.pos.x && w.pos.y === tank.pos.y - 1)!;
    ctx.sim.build.demolish(side.id);
    stepUntil(ctx, () => order.status === 'delivered', 4000);
  });

  it('le convoi est déchargé par le personnel (allers-retours jusqu’au stockage)', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'unloading_zone', { x: CENTER.x + 6, y: CENTER.y + 6 });
    buildNow(ctx, 'ammo_depot', { x: CENTER.x - 6, y: CENTER.y + 6 });
    const ammo = ctx.state.resources.stock.ammo;
    const order = orderNow(ctx, 'convoy', { ammo: 200 });
    let maxHaulers = 0;
    stepUntil(
      ctx,
      () => {
        if (order.vehicleId) maxHaulers = Math.max(maxHaulers, ctx.sim.agents.haulers(order.vehicleId));
        return order.status === 'delivered';
      },
      4000,
    );
    expect(maxHaulers).toBeGreaterThan(0);
    expect(ctx.state.resources.stock.ammo).toBe(ammo + 200);
  });

  it('un chariot élévateur décharge seul et bien plus vite', () => {
    const ctx = makeGame();
    const zone = buildNow(ctx, 'unloading_zone', { x: CENTER.x + 6, y: CENTER.y + 6 });
    buildNow(ctx, 'warehouse', { x: CENTER.x - 6, y: CENTER.y + 6 });
    ctx.state.resources.stock.funds = 1000;
    expect(ctx.sim.supply.canBuyVehicle('forklift')).toBe('funds');
    ctx.state.resources.stock.funds = 20000;
    const fl = ctx.sim.supply.buyVehicle('forklift')!;
    expect(fl.homeId).toBe(zone.id);
    const food = ctx.state.resources.stock.food;
    const order = orderNow(ctx, 'convoy', { food: 300 });
    const ticks = stepUntil(ctx, () => order.status === 'delivered', 3000);
    expect(ctx.state.resources.stock.food).toBe(food + 300);
    expect(ticks).toBeLessThan(600);
    expect(ctx.sim.economy.projections().fuel.perDay).toBeLessThanOrEqual(-4);
  });

  it('les renforts débarquent du convoi et sont regroupés', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'unloading_zone', { x: CENTER.x + 6, y: CENTER.y + 6 });
    const before = Object.keys(ctx.state.agents).length;
    const order = orderNow(ctx, 'convoy', {}, [{ type: 'infantry', count: 3 }]);
    stepUntil(ctx, () => order.status === 'delivered' || order.status === 'leaving', 2000);
    expect(Object.keys(ctx.state.agents)).toHaveLength(before + 3);
    expect(Object.values(ctx.state.groups).some((g) => g.name.startsWith('Renforts') && g.memberIds.length === 3)).toBe(true);
  });

  it('une embuscade détruit une partie de la cargaison et retarde le convoi', () => {
    const ctx = makeGame();
    buildNow(ctx, 'unloading_zone', CENTER);
    ctx.state.resources.stock.funds += 50000;
    const order = ctx.sim.supply.placeOrder('convoy', { food: 100 }, [])!;
    order.etaTick = ctx.state.time.tick + 1;
    const random = ctx.random.bind(ctx);
    ctx.random = () => 0; // embuscade certaine, perte minimale (30 %)
    stepTicks(ctx, 2);
    ctx.random = random;
    expect(order.ambushed).toBe(true);
    expect(order.cargo.food).toBe(70);
    expect(order.status).toBe('pending');
    expect(order.etaTick).toBeGreaterThan(ctx.state.time.tick + 60);
  });

  it('l’hélicoptère se pose sur l’hélisurface', () => {
    const ctx = makeGame();
    buildNow(ctx, 'helipad', CENTER);
    buildNow(ctx, 'warehouse', { x: CENTER.x - 8, y: CENTER.y });
    const order = orderNow(ctx, 'helo', { medical: 100 });
    stepTicks(ctx, 2);
    const heli = ctx.state.vehicles[order.vehicleId!];
    expect(heli.altitude).toBeGreaterThan(0);
    stepUntil(ctx, () => heli.state === 'unloading', 500);
    expect(heli.altitude).toBe(0);
  });
});

describe('Progression, améliorations, usure', () => {
  it('améliore une tente : paiement, chantier, couchages supplémentaires', () => {
    const ctx = makeGame();
    const tent = buildNow(ctx, 'tent_group', CENTER);
    const funds = ctx.state.resources.stock.funds;
    expect(ctx.sim.build.startUpgrade(tent.id)).toBe(true);
    expect(ctx.state.resources.stock.funds).toBe(funds - ctx.content.building('tent_group').levels![0].cost.funds!);
    expect(ctx.sim.build.upgradeCheck(tent)).toBe('busy');
    stepUntil(ctx, () => tent.level === 2, 400);
    expect(ctx.sim.build.stats(tent).services.sleep.slots).toBe(10);
    expect(ctx.sim.build.upgradeCheck(tent)).toBe('max');
  });

  it('l’usure endommage les bâtiments ; le soutien les répare avec des pièces', () => {
    const ctx = makeGame(undefined, { agents: true });
    const gen = buildNow(ctx, 'generator', CENTER);
    gen.wear = 0.75;
    stepTicks(ctx, 60);
    expect(gen.state).toBe('damaged');
    const parts = ctx.state.resources.stock.parts;
    stepUntil(ctx, () => gen.wear < 0.05, 8 * 60);
    expect(gen.state).toBe('active');
    expect(ctx.state.resources.stock.parts).toBeLessThan(parts);
  });

  it('le forage s’achète avec des points de réputation, une fois la réputation suffisante', () => {
    const ctx = makeGame();
    const def = ctx.content.building('water_well');
    expect(ctx.sim.build.check('water_well', CENTER, 0).reason).toBe('locked');
    expect(ctx.sim.build.lockReason(def)).toBe('level');
    ctx.state.progression.points = 100;
    expect(ctx.sim.build.unlock('water_well')).toBe(false); // réputation trop basse
    ctx.state.progression.reputation = def.unlock.reputation;
    expect(ctx.sim.build.lockReason(def)).toBe('points');
    ctx.state.progression.points = (def.unlock.points ?? 0) - 1;
    expect(ctx.sim.build.unlock('water_well')).toBe(false); // points insuffisants
    ctx.state.progression.points = 100;
    ctx.commands.push({ type: 'unlockBuilding', defId: 'water_well' });
    ctx.sim.step();
    expect(ctx.state.progression.points).toBe(100 - (def.unlock.points ?? 0));
    expect(ctx.sim.build.check('water_well', CENTER, 0).ok).toBe(true);
  });

  it('gagne des points de réputation chaque jour selon l’évaluation', () => {
    const ctx = makeGame();
    const before = ctx.state.progression.points;
    stepTicks(ctx, 24 * 60);
    expect(ctx.state.progression.points).toBeGreaterThan(before);
  });
});
