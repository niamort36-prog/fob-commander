import { describe, expect, it } from 'vitest';
import { makeGame, stepTicks } from './helpers';

describe('IntelSystem — carte tactique et renseignement', () => {
  it('initialise villages, personnalités et contacts (la plupart cachés)', () => {
    const ctx = makeGame();
    const region = ctx.state.region;
    expect(region.initialized).toBe(true);
    expect(Object.keys(region.villages)).toHaveLength(ctx.content.region.villages.length);
    expect(region.contacts.rasoul_hq.known).toBe(true);
    expect(region.contacts.mortar_hills.known).toBe(false);
    expect(region.personalities.rasoul.known).toBe(true);
    expect(region.personalities.shirin.known).toBe(false);
  });

  it('voit précisément tout contact entrant dans le rayon de surveillance', () => {
    const ctx = makeGame();
    const fob = ctx.sim.intel.fobPos();
    const c = ctx.state.region.contacts.cell_dasht;
    c.truePos = { x: fob.x + 1, y: fob.y };
    stepTicks(ctx, 61);
    expect(c.known).toBe(true);
    expect(c.reliability).toBeGreaterThan(0.9);
    expect(c.error).toBeLessThan(0.3);
  });

  it('le renseignement vieillit puis se perd faute de nouvelles', () => {
    const ctx = makeGame();
    const c = ctx.state.region.contacts.rasoul_hq;
    const rel = c.reliability;
    const err = c.error;
    stepTicks(ctx, 24 * 60);
    expect(c.reliability).toBeLessThan(rel);
    expect(c.error).toBeGreaterThan(err);
    stepTicks(ctx, 10 * 24 * 60);
    expect(c.known).toBe(false);
    expect(ctx.state.log.some((l) => l.key === 'log.contactLost')).toBe(true);
  });

  it('un village favorable renseigne sur les groupes proches', () => {
    const ctx = makeGame();
    ctx.state.region.villages.sangar.attitude = 80;
    const c = ctx.state.region.contacts.mortar_hills; // à ~9 km de Sangar : on le rapproche
    c.truePos = { x: 22, y: 21 };
    ctx.random = () => 0.01;
    stepTicks(ctx, 18 * 60 + 1);
    expect(c.known).toBe(true);
    expect(['village', 'analysis']).toContain(c.source);
    expect(ctx.sim.intel.informantVillages()).toContain('sangar');
  });

  it('un événement modifie l’attitude d’un village, fait rencontrer une personnalité et révèle un contact', () => {
    const ctx = makeGame(undefined, { agents: true });
    const before = ctx.state.region.villages.sangar.attitude;
    ctx.sim.events.start('elder_visit');
    expect(ctx.state.region.personalities.gul_zaman.met).toBe(true);
    ctx.sim.events.choose('aid');
    ctx.sim.events.close();
    expect(ctx.state.region.villages.sangar.attitude).toBe(before + 10);

    const known = ctx.sim.intel.knownContacts().length;
    ctx.state.time.day = 3;
    ctx.random = () => 0;
    ctx.sim.events.start('informant');
    ctx.sim.events.choose('pay');
    expect(ctx.sim.intel.knownContacts().length).toBe(known + 1);
  });

  it('après une attaque, le groupe le plus proche est localisé approximativement', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.sim.attacks.start('mortar', 'shelter');
    ctx.state.combat.shellsLeft = 0;
    ctx.sim.step();
    expect(ctx.state.combat.active).toBe(false);
    expect(ctx.sim.intel.knownContacts().some((c) => c.source === 'attack')).toBe(true);
  });

  it('cote de fiabilité A à F', () => {
    const ctx = makeGame();
    const c = { ...ctx.state.region.contacts.rasoul_hq };
    for (const [r, g] of [[0.9, 'A'], [0.7, 'B'], [0.5, 'C'], [0.35, 'D'], [0.2, 'E'], [0.05, 'F']] as [number, string][]) {
      c.reliability = r;
      expect(ctx.sim.intel.grade(c)).toBe(g);
    }
  });
});
