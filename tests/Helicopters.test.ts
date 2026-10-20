import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import type { Vehicle } from '../src/core/GameState';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

function pad(ctx: GameContext, dx = 6, dy = -8) {
  const b = buildNow(ctx, 'helipad', { x: CENTER.x + dx, y: CENTER.y + dy });
  ctx.state.resources.stock.funds += 200000;
  return b;
}

/** Achète un hélicoptère et attend qu'il se pose. */
function buyHeli(ctx: GameContext, defId: string): Vehicle {
  const v = ctx.sim.supply.buyVehicle(defId)!;
  expect(v).not.toBeNull();
  stepUntil(ctx, () => v.state === 'idle', 600);
  return v;
}

describe('Hélicoptères de la base', () => {
  it('un seul hélicoptère par hélisurface, livré en vol puis posé', () => {
    const ctx = makeGame();
    expect(ctx.sim.supply.canBuyVehicle('attack_helo')).toBe('requires');
    const p = pad(ctx);
    const v = ctx.sim.supply.buyVehicle('attack_helo')!;
    expect(v.state).toBe('mission_back');
    expect(v.altitude).toBeGreaterThan(0);
    stepUntil(ctx, () => v.state === 'idle', 600);
    expect(v.altitude).toBe(0);
    expect(v.homeId).toBe(p.id);
    expect(ctx.sim.supply.canBuyVehicle('transport_helo')).toBe('limit'); // l'hélisurface est prise
    pad(ctx, -10, -8);
    expect(ctx.sim.supply.canBuyVehicle('transport_helo')).toBeNull();
  });

  it('une hélisurface occupée ne reçoit plus les rotations de ravitaillement', () => {
    const ctx = makeGame();
    pad(ctx);
    expect(ctx.sim.supply.check('helo', { food: 100 }, [])).toBeNull();
    buyHeli(ctx, 'transport_helo');
    expect(ctx.sim.supply.check('helo', { food: 100 }, [])).toBe('pad');
  });

  it('l’hélicoptère de combat appuie une mission : il part avec elle et revient se poser', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6).map((a) => a.id);
    const plan = { typeId: 'patrol', target, memberIds, vehicleIds: [], loadout: 'standard', support: 'attack_helo' };
    expect(ctx.sim.missions.supportBlock('attack_helo', target)).toBe('vehicle');
    pad(ctx);
    const heli = buyHeli(ctx, 'attack_helo');
    expect(ctx.sim.missions.supportBlock('attack_helo', target)).toBeNull();
    const m = ctx.sim.missions.launch(plan)!;
    m.radioQueue = [];
    expect(m.supportVehicleId).toBe(heli.id);
    expect(ctx.sim.missions.freeHeli('attack_helo')).toBeNull(); // réservé
    stepUntil(ctx, () => heli.state === 'away', 600);
    stepUntil(ctx, () => m.phase === 'done', 4000);
    stepUntil(ctx, () => heli.state === 'idle', 600);
  });

  it('héliportage : trajet bien plus rapide, 8 places au plus', () => {
    const ctx = makeGame(undefined, { agents: true });
    pad(ctx);
    const heli = buyHeli(ctx, 'transport_helo');
    const target = ctx.sim.missions.targetFrom({ kind: 'contact', id: 'rasoul_hq' })!;
    const inf = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').map((a) => a.id);
    const foot = ctx.sim.missions.estimate({ typeId: 'raid', target, memberIds: inf.slice(0, 8), vehicleIds: [], loadout: 'standard' });
    const air = ctx.sim.missions.estimate({ typeId: 'raid', target, memberIds: inf.slice(0, 8), vehicleIds: [], loadout: 'standard', heliId: heli.id });
    expect(air.heli).toBe(true);
    expect(air.travelHours).toBeLessThan(foot.travelHours / 3);
    expect(ctx.sim.missions.check({ typeId: 'raid', target, memberIds: inf.slice(0, 9), vehicleIds: [], loadout: 'standard', heliId: heli.id })).toBe('helo');
    const m = ctx.sim.missions.launch({ typeId: 'raid', target, memberIds: inf.slice(0, 8), vehicleIds: [], loadout: 'standard', heliId: heli.id })!;
    expect(m.heliId).toBe(heli.id);
  });

  it('Little Bird : plus rapide et discret, assaut éclair, 4 places, mais plus exposé', () => {
    const ctx = makeGame(undefined, { agents: true });
    pad(ctx);
    const bh = buyHeli(ctx, 'transport_helo');
    pad(ctx, -10, -8);
    const lb = buyHeli(ctx, 'little_bird');
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const inf = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').map((a) => a.id).slice(0, 4);
    const plan = (heliId: string) => ({ typeId: 'patrol', target, memberIds: inf, vehicleIds: [], loadout: 'standard', heliId });
    const a = ctx.sim.missions.estimate(plan(bh.id));
    const b = ctx.sim.missions.estimate(plan(lb.id));
    expect(b.travelHours).toBeLessThan(a.travelHours);
    expect(b.objectiveHours).toBeLessThan(a.objectiveHours);
    expect(b.chance).toBeGreaterThan(a.chance);
    expect(b.stealth).toBeGreaterThan(0);
    expect(b.fragile).toBe(true);
    expect(a.fragile).toBe(false);
    expect((b.costs.fuel ?? 0)).toBeLessThan(a.costs.fuel ?? 0);
    const five = ctx.sim.missions.availableAgents().filter((x) => x.defId === 'infantry').map((x) => x.id).slice(0, 5);
    expect(ctx.sim.missions.check({ ...plan(lb.id), memberIds: five })).toBe('helo');
  });

  it('pendant une attaque au sol, l’hélicoptère de combat décolle, tire puis rentre', () => {
    const ctx = makeGame(undefined, { agents: true });
    pad(ctx);
    const heli = buyHeli(ctx, 'attack_helo');
    let shots = 0;
    ctx.bus.on('combat:shot', ({ fromZ }) => {
      if (fromZ > 20) shots++;
    });
    ctx.sim.attacks.start('assault', 'engage');
    stepTicks(ctx, 3);
    expect(heli.state).toBe('sortie');
    stepUntil(ctx, () => !ctx.state.combat.active, 900);
    expect(shots).toBeGreaterThan(0);
    expect(heli.state).toBe('mission_back');
    stepUntil(ctx, () => heli.state === 'idle', 600);
  });
});

describe('Parc de véhicules', () => {
  it('4 véhicules au plus, chacun sur sa place, une place libérée est réattribuée', () => {
    const ctx = makeGame();
    buildNow(ctx, 'vehicle_park', { x: CENTER.x + 6, y: CENTER.y + 4 });
    ctx.state.resources.stock.funds += 200000;
    const vs = [ctx.sim.supply.buyVehicle('mrap')!, ctx.sim.supply.buyVehicle('humvee')!, ctx.sim.supply.buyVehicle('mrap')!, ctx.sim.supply.buyVehicle('humvee')!];
    expect(new Set(vs.map((v) => v.slot)).size).toBe(4);
    expect(ctx.sim.supply.canBuyVehicle('humvee')).toBe('limit');
    const freed = vs[1].slot;
    delete ctx.state.vehicles[vs[1].id];
    const again = ctx.sim.supply.buyVehicle('mrap')!;
    expect(again.slot).toBe(freed);
  });
});
