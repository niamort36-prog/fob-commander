import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/core/GameState';
import { makeGame, stepTicks } from './helpers';

function soldier(agents: Record<string, Agent>, rank = 'Soldat'): Agent {
  const a = Object.values(agents).find((x) => x.defId === 'infantry' && x.rank === rank) ?? Object.values(agents).find((x) => x.defId === 'infantry')!;
  a.rank = rank;
  a.xp = 0;
  return a;
}

describe('Expérience et grades', () => {
  it('chaque métier a une carrière qui contient ses grades de départ', () => {
    const ctx = makeGame();
    for (const p of ctx.content.personnelList) {
      expect(p.career.length).toBeGreaterThan(0);
      for (const r of p.ranks) expect(p.career.some((s) => s.rank === r)).toBe(true);
    }
  });

  it('une recrue gradée a déjà l’expérience de son grade', () => {
    const ctx = makeGame(undefined, { agents: true });
    for (const a of Object.values(ctx.state.agents)) {
      const step = ctx.content.personnel(a.defId).career.find((s) => s.rank === a.rank)!;
      expect(a.xp).toBeGreaterThanOrEqual(step.xp);
    }
  });

  it('l’expérience gagnée fait monter en grade : moral, compétences, journal', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = soldier(ctx.state.agents);
    a.needs.morale = 50;
    const leadership = a.skills.leadership ?? 0;
    ctx.sim.career.gain(a, 29);
    expect(a.rank).toBe('Soldat');
    ctx.sim.career.gain(a, 1);
    expect(a.rank).toBe('Soldat de 1re classe');
    expect(a.needs.morale).toBeGreaterThan(50);
    expect(a.skills.leadership).toBeGreaterThan(leadership);
    expect(ctx.state.log.some((l) => l.key === 'log.promotion')).toBe(true);
    // Un gros gain peut sauter plusieurs grades d'un coup
    ctx.sim.career.gain(a, 260); // 290 XP : au-delà du seuil de Sergent (280)
    expect(a.rank).toBe('Sergent');
    const pg = ctx.sim.career.progress(a);
    expect(pg.next?.rank).toBe('Sergent-chef');
    expect(pg.ratio).toBeGreaterThanOrEqual(0);
    expect(pg.ratio).toBeLessThan(1);
  });

  it('l’XP des activités (garde, chantier…) mène aussi à la promotion', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = soldier(ctx.state.agents);
    a.xp = 31; // accumulée heure après heure par les activités
    stepTicks(ctx, 12);
    expect(a.rank).toBe('Soldat de 1re classe');
  });

  it('au sommet de sa carrière, plus de promotion', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = soldier(ctx.state.agents, 'Adjudant');
    ctx.sim.career.gain(a, 5000);
    expect(a.rank).toBe('Adjudant');
    expect(ctx.sim.career.progress(a).next).toBeNull();
  });

  it('une ancienne sauvegarde aligne l’XP sur le grade', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = soldier(ctx.state.agents, 'Caporal');
    a.xp = 0;
    ctx.sim.onStateLoaded();
    expect(a.xp).toBe(90);
    expect(a.rank).toBe('Caporal');
  });
});
