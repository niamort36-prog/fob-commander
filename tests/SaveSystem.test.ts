import { describe, expect, it } from 'vitest';
import { SAVE_VERSION } from '../src/core/GameState';
import { AUTO_SLOT } from '../src/systems/SaveSystem';
import { CENTER, MemoryStorage, makeGame, stepTicks } from './helpers';

describe('SaveSystem', () => {
  it('sauvegarde puis recharge un état identique', () => {
    const storage = new MemoryStorage();
    const ctx = makeGame(storage);
    ctx.sim.build.place('tent_group', CENTER, 1);
    stepTicks(ctx, 90);
    const snapshot = JSON.parse(JSON.stringify(ctx.state));

    expect(ctx.sim.save.save('1')).toBe(true);
    ctx.sim.build.place('water_tank', { x: CENTER.x - 4, y: CENTER.y - 4 }, 0);
    stepTicks(ctx, 50);

    const loaded = ctx.sim.save.load('1');
    expect(loaded).not.toBeNull();
    ctx.loadState(loaded!);
    // Une partie reprise démarre en pause ; le reste de l'état est identique
    expect(ctx.state.time.speed).toBe(0);
    ctx.state.time.speed = snapshot.time.speed;
    const { log: _a, ...restLoaded } = ctx.state;
    const { log: _b, ...restSnapshot } = snapshot;
    // prevPos des véhicules : valeur d'interpolation, réinitialisée au chargement
    for (const st of [restLoaded, restSnapshot]) for (const v of Object.values(st.vehicles) as { prevPos?: unknown }[]) delete v.prevPos;
    expect(restLoaded).toEqual(restSnapshot);
    expect(ctx.sim.build.buildingAt({ x: CENTER.x + 1, y: CENTER.y + 2 })).not.toBeNull();
  });

  it('liste les emplacements avec leur résumé', () => {
    const ctx = makeGame();
    ctx.sim.save.save('2');
    const list = ctx.sim.save.list();
    expect(list.map((s) => s.slot)).toEqual([AUTO_SLOT, '1', '2', '3']);
    expect(list[2].summary?.siteName).toBe('Plaine de Dasht-e Gol');
    expect(list[1].summary).toBeNull();
    expect(ctx.sim.save.latest()).toBe('2');
  });

  it('sauvegarde automatiquement à chaque nouveau jour', () => {
    const ctx = makeGame();
    stepTicks(ctx, 18 * 60);
    expect(ctx.sim.save.summary(AUTO_SLOT)?.day).toBe(2);
  });

  it('refuse une sauvegarde d’une version future ou corrompue', () => {
    const storage = new MemoryStorage();
    const ctx = makeGame(storage);
    ctx.sim.save.save('1');
    const key = ctx.content.balance.save.storagePrefix + '1';
    const file = JSON.parse(storage.getItem(key)!);
    file.version = SAVE_VERSION + 1;
    storage.setItem(key, JSON.stringify(file));
    expect(ctx.sim.save.load('1')).toBeNull();

    storage.setItem(key, '{pas du json');
    expect(ctx.sim.save.load('1')).toBeNull();
  });

  it('migre une sauvegarde v1 (carte 64×64) vers la grande carte avec périmètre', () => {
    const storage = new MemoryStorage();
    const ctx = makeGame(storage);
    // Fabrique un état au format v1 à partir d'un état neuf.
    const v1 = JSON.parse(JSON.stringify(ctx.state));
    v1.meta.version = 1;
    v1.fob = {
      width: 64,
      height: 64,
      terrain: new Array(64 * 64).fill(0),
      occupancy: [],
      buildings: { bld_9000: { id: 'bld_9000', defId: 'tent_group', pos: { x: 10, y: 12 }, rot: 0, level: 1, state: 'active', buildProgress: 1, hp: 100, wear: 0 } },
    };
    v1.agents = {};
    v1.groups = {};
    v1.progression.flags = {};
    const key = ctx.content.balance.save.storagePrefix + '3';
    storage.setItem(key, JSON.stringify({ version: 1, summary: { slot: '3', savedAt: '', day: 1, minuteOfDay: 360, siteName: 'x', funds: 0, version: 1 }, state: v1 }));

    const migrated = ctx.sim.save.load('3')!;
    expect(migrated).not.toBeNull();
    expect(migrated.fob.width).toBe(160);
    expect(migrated.fob.terrain).toHaveLength(160 * 160);
    expect(migrated.fob.zone).toMatchObject({ x: 48, y: 48, width: 64, height: 64 });
    expect(migrated.fob.buildings.bld_9000.pos).toEqual({ x: 58, y: 60 });

    ctx.loadState(migrated);
    expect(ctx.sim.build.buildingAt({ x: 60, y: 61 })?.id).toBe('bld_9000');
    expect(Object.keys(ctx.state.agents).length).toBeGreaterThan(0); // personnel déployé au chargement
  });

  it('migre une sauvegarde v2 : piste des convois, véhicules et électricité initialisés', () => {
    const storage = new MemoryStorage();
    const ctx = makeGame(storage);
    ctx.sim.build.place('tent_group', CENTER, 0);
    const v2 = JSON.parse(JSON.stringify(ctx.state));
    v2.meta.version = 2;
    delete v2.vehicles;
    delete v2.resources.power;
    delete v2.fob.entry;
    delete v2.progression.lastRating;
    const track = ctx.content.terrainIndex.get('track')!;
    v2.fob.terrain = v2.fob.terrain.map((t: number) => (t === track ? 0 : t));
    for (const b of Object.values(v2.fob.buildings) as { upgrade?: unknown }[]) delete b.upgrade;
    const key = ctx.content.balance.save.storagePrefix + '2';
    storage.setItem(key, JSON.stringify({ version: 2, summary: { slot: '2', savedAt: '', day: 1, minuteOfDay: 360, siteName: 'x', funds: 0, version: 2 }, state: v2 }));

    const st = ctx.sim.save.load('2')!;
    expect(st.meta.version).toBe(16);
    expect(st.checkpoint.entrants).toEqual([]);
    expect(st.region.initialized).toBe(false);
    expect(st.diplomacy.initialized).toBe(false);
    expect(st.combat.active).toBe(false);
    expect(st.fob.entry).toEqual({ x: 0, y: 80 }); // Dasht-e Gol : arrivée par l'ouest
    expect(st.fob.terrain[st.fob.entry.y * st.fob.width + st.fob.entry.x]).toBe(track);
    expect(st.vehicles).toEqual({});
    expect(st.resources.power).toEqual({ supply: 0, demand: 0 });
    expect(Object.values(st.fob.buildings).every((b) => b.upgrade === null)).toBe(true);
    ctx.loadState(st);
    expect(ctx.sim.supply.check('water', {}, [])).toBe('requires');
  });

  it('fonctionne sans stockage disponible', () => {
    const ctx = makeGame(null);
    expect(ctx.sim.save.available).toBe(false);
    expect(ctx.sim.save.save('1')).toBe(false);
  });
});
