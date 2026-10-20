import { describe, expect, it } from 'vitest';
import { makeGame, stepTicks, stepUntil } from './helpers';

const HOUR = 60;

describe('Monde vivant', () => {
  it('la carte est agrandie, les sites de départ restent dans la vallée centrale', () => {
    const ctx = makeGame();
    const r = ctx.content.region;
    expect(r.size.width).toBe(120);
    expect(r.size.height).toBe(90);
    expect(r.villages.length).toBeGreaterThanOrEqual(16);
    expect(r.sites.length).toBeGreaterThanOrEqual(25);
    const fob = ctx.site.regionPos;
    expect(fob.x).toBeGreaterThan(30);
    expect(fob.x).toBeLessThan(90);
  });

  it('les groupes mobiles se déplacent vers un objectif, les QG restent en place', () => {
    const ctx = makeGame();
    const cell = ctx.state.region.contacts.cell_north;
    const hq = ctx.state.region.contacts.rasoul_hq;
    const start = { ...cell.truePos };
    const hqStart = { ...hq.truePos };
    stepTicks(ctx, 6 * HOUR);
    expect(cell.task).toBeDefined();
    expect(Math.hypot(cell.truePos.x - start.x, cell.truePos.y - start.y)).toBeGreaterThan(0);
    expect(hq.truePos).toEqual(hqStart);
  });

  it('l’équipe mortier vient en position de tir près de la FOB, puis change de place', () => {
    const ctx = makeGame();
    const fob = ctx.site.regionPos;
    stepUntil(ctx, () => ctx.sim.world.inPosition('mortar') !== null, 6 * 24 * HOUR);
    const m = ctx.sim.world.inPosition('mortar')!;
    const d = Math.hypot(m.truePos.x - fob.x, m.truePos.y - fob.y);
    expect(d).toBeGreaterThan(3.5);
    expect(d).toBeLessThan(7);
    // Le tir de mortier sur la base n'est possible qu'avec une équipe en position
    expect(ctx.sim.events.checkConditions(ctx.content.event('mortar_attack').conditions)).toBe(true);
  });

  it('des patrouilles alliées et des civils circulent ; leurs accrochages changent la région', () => {
    const ctx = makeGame();
    stepTicks(ctx, 3 * 24 * HOUR);
    const actors = Object.values(ctx.sim.world.region().actors!);
    expect(actors.some((a) => a.side === 'civilian')).toBe(true);
    stepTicks(ctx, 6 * 24 * HOUR);
    expect(ctx.sim.world.region().incidents!.length + Object.keys(ctx.sim.world.region().actors!).length).toBeGreaterThan(0);
  });

  it('une patrouille alliée qui croise des combattants les affronte', () => {
    const ctx = makeGame();
    const cell = ctx.state.region.contacts.cell_north;
    const r = ctx.sim.world.region();
    cell.task = { type: 'rest', dest: { ...cell.truePos }, arrived: true, until: ctx.state.time.tick + 1000 };
    r.actors!.test = { id: 'test', side: 'allied', kind: 'army', label: 'Patrouille test', pos: { ...cell.truePos }, dest: { ...cell.truePos }, home: { x: 50, y: 50 }, destName: 'test', phase: 'stay', until: ctx.state.time.tick + 1000, strength: 1 };
    const stability = ctx.state.region.stability;
    ctx.random = () => 0.01; // la patrouille l'emporte
    stepTicks(ctx, HOUR + 1);
    expect((cell.strength ?? 1) < 1 || !ctx.state.region.contacts.cell_north).toBe(true);
    expect(ctx.state.region.stability).toBeGreaterThan(stability);
    expect(cell.known || !ctx.state.region.contacts.cell_north).toBe(true); // les alliés renseignent la base
  });

  it('en mission, l’unité qui croise un groupe le repère d’autant mieux qu’elle est équipée', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6).map((a) => a.id);
    const m = ctx.sim.missions.launch({ typeId: 'patrol', target, memberIds, vehicleIds: [], loadout: 'standard' })!;
    const c = ctx.state.region.contacts.cell_north;
    const plain = ctx.sim.world.detection(m, c);
    for (const id of memberIds) ctx.state.agents[id].gear = ['optics', 'thermal', 'nvg'];
    const equipped = ctx.sim.world.detection(m, c);
    expect(equipped.ours).toBeGreaterThan(plain.ours);
    // Motorisé : on se fait repérer plus facilement
    m.vehicleIds = ['veh_fake'];
    expect(ctx.sim.world.detection(m, c).theirs).toBeGreaterThan(equipped.theirs);
  });

  it('une rencontre déclenche un vrai message radio lié au groupe, qui peut le détruire', () => {
    const ctx = makeGame(undefined, { agents: true });
    const target = ctx.sim.missions.targetFrom({ kind: 'village', id: 'sangar' })!;
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6).map((a) => a.id);
    const m = ctx.sim.missions.launch({ typeId: 'patrol', target, memberIds, vehicleIds: [], loadout: 'standard' })!;
    m.radioQueue = [];
    stepUntil(ctx, () => m.phase === 'outbound', 400);
    stepTicks(ctx, 60);
    const cell = ctx.state.region.contacts.cell_north;
    const pos = ctx.sim.missions.position(m);
    cell.truePos = { x: pos.x + 0.3, y: pos.y };
    cell.task = { type: 'rest', dest: { ...cell.truePos }, arrived: true, until: ctx.state.time.tick + 2000 };
    // Bien équipés de jour : on les voit (≈ 0,6), eux pas (≈ 0,45)
    for (const id of memberIds) ctx.state.agents[id].gear = ['optics', 'thermal'];
    ctx.random = () => 0.5;
    stepUntil(ctx, () => ctx.state.radio.pending !== null, 30);
    const p = ctx.state.radio.pending!;
    expect(p.radioId).toBe('enc_spot_cell');
    expect(p.vars?.contactId).toBe('cell_north');
    ctx.commands.push({ type: 'radioChoose', choiceId: 'air' });
    ctx.sim.step();
    expect((ctx.state.region.contacts.cell_north?.strength ?? 0) < 1).toBe(true);
  });

  it('une patrouille de secteur ratisse la zone et neutralise les engins posés', () => {
    const ctx = makeGame(undefined, { agents: true });
    const fob = ctx.site.regionPos;
    const sel = { kind: 'sector' as const, x: fob.x + 6, y: fob.y };
    const target = ctx.sim.missions.targetFrom(sel)!;
    expect(target.kind).toBe('sector');
    expect(ctx.sim.missions.typesFor(target).map((d) => d.id)).toContain('sector_patrol');
    ctx.sim.world.region().ieds!.push({ id: 'ied_t', pos: { ...target.pos }, tick: ctx.state.time.tick, by: 'test' });
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 6).map((a) => a.id);
    const m = ctx.sim.missions.launch({ typeId: 'sector_patrol', target, memberIds, vehicleIds: [], loadout: 'standard' })!;
    m.radioQueue = [];
    ctx.random = () => 0.01;
    stepUntil(ctx, () => m.phase === 'inbound' || m.phase === 'done', 4000);
    expect(ctx.sim.world.region().ieds!.some((i) => i.id === 'ied_t')).toBe(false);
  });

  it('un raid sur un groupe qui s’est déplacé trouve l’objectif vide', () => {
    const ctx = makeGame(undefined, { agents: true });
    const c = ctx.state.region.contacts.cell_north;
    c.known = true;
    c.reliability = 0.8;
    c.estPos = { ...c.truePos };
    const target = ctx.sim.missions.targetFrom({ kind: 'contact', id: 'cell_north' })!;
    const memberIds = ctx.sim.missions.availableAgents().filter((a) => a.defId === 'infantry').slice(0, 8).map((a) => a.id);
    const m = ctx.sim.missions.launch({ typeId: 'raid', target, memberIds, vehicleIds: [], loadout: 'standard' })!;
    m.radioQueue = [];
    c.truePos = { x: c.truePos.x + 8, y: c.truePos.y };
    c.task = { type: 'rest', dest: { ...c.truePos }, arrived: true, until: ctx.state.time.tick + 100000 };
    stepUntil(ctx, () => m.phase === 'objective', 6000);
    expect(m.targetMoved).toBe(true);
  });
});
