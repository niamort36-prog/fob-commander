import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import { CENTER, buildNow, makeGame, stepUntil } from './helpers';

/** Avance l'horloge jusqu'à l'heure voulue (l'heure se déduit du nombre de ticks). */
function setHour(ctx: GameContext, hour: number): void {
  const { startHour, minutesPerTick } = ctx.content.balance.time;
  const t = ctx.state.time;
  let total = (t.day - 1) * 1440 + hour * 60;
  if (total < startHour * 60 + t.tick * minutesPerTick) total += 1440;
  t.tick = Math.round((total - startHour * 60) / minutesPerTick) - 1;
  ctx.sim.time.onTick();
}

describe('Amusement, bar et tente de détente', () => {
  it('un manque d’amusement rend moins efficace et fait baisser le moral visé', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = Object.values(ctx.state.agents)[0];
    for (const k of Object.keys(a.needs) as (keyof typeof a.needs)[]) if (k !== 'morale') a.needs[k] = 90;
    const effOk = ctx.sim.needs.computeEfficiency(a);
    const moraleOk = ctx.sim.needs.moraleTarget(a);
    a.needs.fun = 5;
    expect(ctx.sim.needs.computeEfficiency(a)).toBeLessThan(effOk);
    expect(ctx.sim.needs.moraleTarget(a)).toBeLessThan(moraleOk);
  });

  it('les soldats en manque d’amusement vont à la tente de détente', () => {
    const ctx = makeGame(undefined, { agents: true });
    const rec = buildNow(ctx, 'rec_tent', { x: CENTER.x, y: CENTER.y + 4 });
    for (const a of Object.values(ctx.state.agents)) a.needs.fun = 5;
    stepUntil(ctx, () => Object.values(ctx.state.agents).some((a) => a.activity?.id === 'hangout' && a.activity.targetId === rec.id), 120);
  });

  it('le bar n’ouvre qu’en soirée', () => {
    const ctx = makeGame(undefined, { agents: true });
    const bar = buildNow(ctx, 'bar', { x: CENTER.x, y: CENTER.y + 4 });
    setHour(ctx, 10);
    for (const a of Object.values(ctx.state.agents)) a.needs.fun = 5;
    for (let i = 0; i < 30; i++) ctx.sim.step();
    expect(Object.values(ctx.state.agents).some((a) => a.activity?.id === 'drink')).toBe(false);
    setHour(ctx, 20);
    for (const a of Object.values(ctx.state.agents)) {
      a.needs.fun = 5;
      a.activity = null;
    }
    stepUntil(ctx, () => Object.values(ctx.state.agents).some((a) => a.activity?.id === 'drink' && a.activity.targetId === bar.id), 120);
  });

  it('des bars trop rapprochés font grimper le risque d’alcoolisme', () => {
    const ctx = makeGame();
    const b1 = buildNow(ctx, 'bar', { x: CENTER.x, y: CENTER.y });
    const alone = ctx.sim.leisure.riskPerHour(b1);
    expect(ctx.sim.leisure.neighbourBars(b1)).toHaveLength(0);
    const b2 = buildNow(ctx, 'bar', { x: CENTER.x + 5, y: CENTER.y });
    expect(ctx.sim.leisure.neighbourBars(b1)).toHaveLength(1);
    expect(ctx.sim.leisure.riskPerHour(b1)).toBeGreaterThan(alone * 5);
    // Un bar loin des autres reste sans risque supplémentaire
    const far = buildNow(ctx, 'bar', { x: CENTER.x - 20, y: CENTER.y - 18 });
    expect(ctx.sim.leisure.neighbourBars(far)).toHaveLength(0);
    void b2;
  });

  it('un soir de beuverie entre bars voisins finit mal', () => {
    const ctx = makeGame(undefined, { agents: true });
    const b1 = buildNow(ctx, 'bar', { x: CENTER.x, y: CENTER.y + 4 });
    buildNow(ctx, 'bar', { x: CENTER.x + 4, y: CENTER.y + 4 });
    buildNow(ctx, 'bar', { x: CENTER.x - 4, y: CENTER.y + 4 });
    expect(ctx.sim.leisure.riskPerHour(b1)).toBeGreaterThan(0.1);
    setHour(ctx, 18);
    for (const a of Object.values(ctx.state.agents)) a.needs.fun = 5;
    stepUntil(ctx, () => ctx.state.log.some((l) => l.key.startsWith('log.alcohol.')), 900);
  });

  it('télévision et consoles rendent la tente de détente plus distrayante', () => {
    const ctx = makeGame();
    const def = ctx.content.building('rec_tent');
    const tv = def.modules!.find((m) => m.id === 'tv')!;
    const consoles = def.modules!.find((m) => m.id === 'consoles')!;
    expect(tv.serviceEffects?.lounge?.fun).toBeGreaterThan(0);
    expect(consoles.requires).toBe('tv');
    expect(consoles.serviceEffects?.lounge?.fun).toBeGreaterThan(tv.serviceEffects!.lounge!.fun!);
  });

  it('le repas au réfectoire distrait aussi', () => {
    const ctx = makeGame();
    expect(ctx.content.activity('eat').effectsPerHour.fun).toBeGreaterThan(0);
  });
});
