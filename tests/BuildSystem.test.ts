import { describe, expect, it } from 'vitest';
import { BuildSystem } from '../src/systems/BuildSystem';
import type { PlacementReason } from '../src/core/GameEvents';
import { CENTER, buildNow, makeGame, stepTicks, ticksToBuild } from './helpers';

describe('BuildSystem', () => {
  it('pose une tente, débite le coût et occupe les cases', () => {
    const ctx = makeGame();
    const funds = ctx.state.resources.stock.funds;
    const b = ctx.sim.build.place('tent_group', CENTER, 0);
    expect(b).not.toBeNull();
    expect(ctx.state.resources.stock.funds).toBe(funds - ctx.content.building('tent_group').cost.funds!);
    expect(b!.state).toBe('construction');
    // Emprise 3×2
    expect(ctx.sim.build.buildingAt({ x: CENTER.x + 2, y: CENTER.y + 1 })?.id).toBe(b!.id);
    expect(ctx.sim.build.buildingAt({ x: CENTER.x + 3, y: CENTER.y })).toBeNull();
  });

  it('applique la rotation à l’emprise', () => {
    const ctx = makeGame();
    const b = ctx.sim.build.place('tent_group', CENTER, 1)!;
    expect(ctx.sim.build.buildingAt({ x: CENTER.x + 1, y: CENTER.y + 2 })?.id).toBe(b.id);
    expect(ctx.sim.build.buildingAt({ x: CENTER.x + 2, y: CENTER.y })).toBeNull();
  });

  it('refuse un emplacement occupé, hors carte, hors périmètre ou sans fonds', () => {
    const ctx = makeGame();
    const rejections: PlacementReason[] = [];
    ctx.bus.on('build:rejected', ({ reason }) => rejections.push(reason));
    ctx.sim.build.place('tent_group', CENTER, 0);
    expect(ctx.sim.build.place('water_tank', { x: CENTER.x + 1, y: CENTER.y }, 0)).toBeNull();
    expect(ctx.sim.build.place('water_tank', { x: 159, y: 159 }, 0)).toBeNull();
    expect(ctx.sim.build.place('water_tank', { x: 40, y: 40 }, 0)).toBeNull();
    ctx.state.resources.stock.funds = 10;
    expect(ctx.sim.build.place('watchtower', { x: CENTER.x - 5, y: CENTER.y }, 0)).toBeNull();
    expect(rejections).toEqual(['occupied', 'bounds', 'zone', 'funds']);
  });

  it('refuse un terrain non constructible', () => {
    const ctx = makeGame();
    const fob = ctx.state.fob;
    fob.terrain[CENTER.y * fob.width + CENTER.x] = ctx.content.terrainIndex.get('rock')!;
    expect(ctx.sim.build.check('hesco', CENTER, 0)).toEqual({ ok: false, reason: 'terrain' });
  });

  it('termine le chantier (sans ouvrier) après la durée prévue', () => {
    const ctx = makeGame();
    const b = ctx.sim.build.place('tent_group', CENTER, 0)!;
    let completed = 0;
    ctx.bus.on('building:completed', () => completed++);
    const ticks = ticksToBuild(ctx, 'tent_group');
    stepTicks(ctx, ticks - 1);
    expect(b.state).toBe('construction');
    stepTicks(ctx, 1);
    expect(b.state).toBe('active');
    expect(completed).toBe(1);
  });

  it('rembourse 100 % en chantier et 50 % une fois construit', () => {
    const ctx = makeGame();
    const start = ctx.state.resources.stock.funds;
    const a = ctx.sim.build.place('watchtower', CENTER, 0)!;
    ctx.sim.build.demolish(a.id);
    expect(ctx.state.resources.stock.funds).toBe(start);
    expect(ctx.sim.build.buildingAt(CENTER)).toBeNull();

    const b = ctx.sim.build.place('watchtower', CENTER, 0)!;
    stepTicks(ctx, ticksToBuild(ctx, 'watchtower'));
    expect(b.state).toBe('active');
    const before = ctx.state.resources.stock.funds;
    ctx.sim.build.demolish(b.id);
    expect(ctx.state.resources.stock.funds).toBe(before + ctx.content.building('watchtower').cost.funds! / 2);
  });

  it('trace des lignes droites selon l’axe dominant', () => {
    expect(BuildSystem.lineCells({ x: 0, y: 0 }, { x: 3, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(BuildSystem.lineCells({ x: 5, y: 5 }, { x: 4, y: 2 })).toHaveLength(4);
  });

  it('pose une ligne de HESCO jusqu’à épuisement des fonds', () => {
    const ctx = makeGame();
    ctx.state.resources.stock.funds = 150 * 3 + 50;
    const cells = BuildSystem.lineCells(CENTER, { x: CENTER.x + 9, y: CENTER.y });
    expect(ctx.sim.build.checkLine('hesco', cells).filter((r) => r.ok)).toHaveLength(3);
    expect(ctx.sim.build.placeLine('hesco', cells)).toBe(3);
    expect(ctx.state.resources.stock.funds).toBe(50);
  });

  it('passe par la file de commandes', () => {
    const ctx = makeGame();
    ctx.commands.push({ type: 'placeBuilding', defId: 'water_tank', pos: CENTER, rot: 0 });
    ctx.sim.step();
    expect(Object.keys(ctx.state.fob.buildings)).toHaveLength(1);
  });

  it('agrandit le périmètre contre paiement, de plus en plus cher', () => {
    const ctx = makeGame();
    const zone = { ...ctx.state.fob.zone };
    const step = ctx.content.balance.zone.step;
    const cost = ctx.sim.build.expansionCost()!;
    expect(cost).toBe(ctx.content.balance.zone.baseCost);
    const funds = ctx.state.resources.stock.funds;
    expect(ctx.sim.build.expandZone()).toBe(true);
    expect(ctx.state.resources.stock.funds).toBe(funds - cost);
    expect(ctx.state.fob.zone).toMatchObject({ x: zone.x - step, y: zone.y - step, width: zone.width + 2 * step, height: zone.height + 2 * step, expansions: 1 });
    expect(ctx.sim.build.expansionCost()!).toBeGreaterThan(cost);
    // La case précédemment hors périmètre devient constructible
    expect(ctx.sim.build.check('hesco', { x: zone.x - 1, y: zone.y - 1 }, 0).reason).not.toBe('zone');

    ctx.state.resources.stock.funds = 0;
    expect(ctx.sim.build.expandZone()).toBe(false);
  });

  it('ne dépasse jamais les limites de la carte', () => {
    const ctx = makeGame();
    ctx.state.resources.stock.funds = 1e12;
    while (ctx.sim.build.expansionCost() !== null) ctx.sim.build.expandZone();
    expect(ctx.state.fob.zone).toMatchObject({ x: 0, y: 0, width: 160, height: 160 });
  });
});

describe('Entrée des bâtiments', () => {
  it('l’entrée tourne avec le bâtiment et les soldats passent par la porte', () => {
    const ctx = makeGame();
    const def = ctx.content.building('dfac');
    const sides = [0, 1, 2, 3].map((r) => BuildSystem.entranceSide(def, r as 0 | 1 | 2 | 3));
    expect(new Set(sides.map((s) => `${s!.x},${s!.y}`)).size).toBe(4);
    expect(BuildSystem.entranceSide(ctx.content.building('hesco'), 0)).toBeNull();
    const b = buildNow(ctx, 'dfac', CENTER, 0);
    ctx.sim.agents.nav.ensure();
    const access = ctx.sim.agents.nav.accessCells(b);
    const door = BuildSystem.entranceCells(def, b.pos, b.rot);
    expect(access.length).toBeGreaterThan(0);
    expect(access.every((c) => door.some((d) => d.x === c.x && d.y === c.y))).toBe(true);
  });

  it('si la porte est murée, on accède par les autres côtés', () => {
    const ctx = makeGame();
    const def = ctx.content.building('showers');
    const b = buildNow(ctx, 'showers', CENTER, 0);
    for (const c of BuildSystem.entranceCells(def, b.pos, b.rot)) buildNow(ctx, 'hesco', c);
    ctx.sim.agents.nav.ensure();
    expect(ctx.sim.agents.nav.accessCells(b).length).toBeGreaterThan(0);
  });
});
