import { describe, expect, it } from 'vitest';
import { buildingRotations } from '../src/assets/spriteKeys';
import type { GameContext } from '../src/core/GameContext';
import { CENTER, buildNow, makeGame, stepUntil } from './helpers';

/** Enceinte de hesco autour du centre avec un portail double au sud. */
function compound(ctx: GameContext, r = 5) {
  for (let x = CENTER.x - r; x <= CENTER.x + r; x++) for (const y of [CENTER.y - r, CENTER.y + r]) buildNow(ctx, 'hesco', { x, y });
  for (let y = CENTER.y - r + 1; y <= CENTER.y + r - 1; y++) for (const x of [CENTER.x - r, CENTER.x + r]) buildNow(ctx, 'hesco', { x, y });
  return buildNow(ctx, 'gate_double', { x: CENTER.x, y: CENTER.y + r });
}

describe('Portails, accès des civils et visiteurs', () => {
  it('une porte interdite aux civils ferme la zone derrière elle', () => {
    const ctx = makeGame();
    const gate = compound(ctx);
    const nav = ctx.sim.agents.nav;
    nav.ensure();
    expect(nav.civilAllowed(CENTER.x, CENTER.y)).toBe(true);
    ctx.commands.push({ type: 'setCivilAccess', buildingId: gate.id, allowed: false });
    ctx.sim.step();
    nav.ensure();
    expect(nav.civilAllowed(CENTER.x, CENTER.y)).toBe(false);
    expect(nav.findCivilPath(ctx.state.fob.entry, [CENTER])).toBeNull();
    // Le personnel, lui, passe toujours
    expect(nav.findPath({ x: CENTER.x, y: CENTER.y + 8 }, [CENTER])).not.toBeNull();
  });

  it('une voiture piégée non décelée force le passage d’une porte interdite', () => {
    const ctx = makeGame();
    const gate = compound(ctx);
    buildNow(ctx, 'toc', { x: CENTER.x - 1, y: CENTER.y - 2 });
    ctx.commands.push({ type: 'setCivilAccess', buildingId: gate.id, allowed: false });
    ctx.sim.step();
    ctx.state.checkpoint.nextTick = Number.MAX_SAFE_INTEGER;
    const cp = ctx.sim.checkpoint;
    cp.detectChance = () => 0;
    const e = cp.spawn('vbied', true)!;
    expect(e).not.toBeNull();
    stepUntil(ctx, () => !cp.state.entrants.includes(e), 900);
    const boom = ctx.state.log.find((l) => l.key === 'log.cp.missed.vbied');
    expect(boom).toBeDefined();
  });

  it('les véhicules civils se garent sur la zone de livraison et le conducteur descend', () => {
    const ctx = makeGame();
    buildNow(ctx, 'toc', { x: CENTER.x - 1, y: CENTER.y - 1 });
    const zone = buildNow(ctx, 'unloading_zone', { x: CENTER.x + 6, y: CENTER.y + 4 });
    ctx.state.checkpoint.nextTick = Number.MAX_SAFE_INTEGER;
    const spots = ctx.sim.visits.deliveryParking();
    expect(spots.length).toBeGreaterThan(0);
    const cp = ctx.sim.checkpoint;
    const e = cp.spawn(null, true)!;
    stepUntil(ctx, () => e.phase === 'business', 900);
    const v = ctx.state.vehicles[e.vehicleId!];
    const [w, h] = [4, 3];
    expect(v.pos.x).toBeGreaterThanOrEqual(zone.pos.x - 0.5);
    expect(v.pos.x).toBeLessThanOrEqual(zone.pos.x + w + 0.5);
    expect(v.pos.y).toBeGreaterThanOrEqual(zone.pos.y - 0.5);
    expect(v.pos.y).toBeLessThanOrEqual(zone.pos.y + h + 0.5);
    expect(e.walking).toBe(true);
  });

  it('les orientations des bâtiments carrés orientés sont générées', () => {
    const ctx = makeGame();
    expect(buildingRotations(ctx.content.building('gate_small'))).toHaveLength(2);
    expect(buildingRotations(ctx.content.building('guard_post'))).toHaveLength(4);
    expect(buildingRotations(ctx.content.building('artillery'))).toHaveLength(4);
    expect(buildingRotations(ctx.content.building('water_tank'))).toHaveLength(1);
  });
});

describe('Briefing au TOC et commandes automatiques', () => {
  it('les soldats passent au TOC prendre leurs ordres avant de partir', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'toc', { x: CENTER.x + 3, y: CENTER.y - 6 });
    const ids = ctx.sim.missions.availableAgents().filter((a) => a.defId !== 'sf').slice(0, 4).map((a) => a.id);
    const m = ctx.sim.missions.launch({ typeId: 'patrol', target: ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!, memberIds: ids, vehicleIds: [], loadout: 'standard' })!;
    m.radioQueue = [];
    stepUntil(ctx, () => ids.some((id) => ctx.state.agents[id].activity?.briefing === true && ctx.state.agents[id].activity?.stage === 'acting'), 300);
    expect(m.phase).toBe('assembling');
    stepUntil(ctx, () => m.phase === 'outbound', 400);
    expect(ids.every((id) => m.briefed?.includes(id))).toBe(true);
    expect(m.radioLog.some((l) => l.text.includes('Briefing'))).toBe(true);
  });

  it('une commande automatique se relance quand le stock baisse', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'unloading_zone', CENTER);
    ctx.commands.push({ type: 'setStandingOrder', orderId: 'convoy', cargo: { food: 600 }, belowDays: 4 });
    ctx.sim.step();
    expect(ctx.state.supply.standing?.convoy).toBeDefined();
    ctx.state.resources.stock.food = 30;
    stepUntil(ctx, () => Object.values(ctx.state.supply.orders).some((o) => o.orderId === 'convoy'), 180);
    expect(ctx.state.log.some((l) => l.key === 'log.standingPlaced')).toBe(true);
    // Une seule à la fois : pas de seconde commande tant que la première est en cours
    const n = Object.values(ctx.state.supply.orders).length;
    for (let i = 0; i < 120; i++) ctx.sim.step();
    expect(Object.values(ctx.state.supply.orders).filter((o) => o.orderId === 'convoy' && o.status === 'pending').length).toBeLessThanOrEqual(1);
    void n;
  });
});
