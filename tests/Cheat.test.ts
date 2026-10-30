import { describe, expect, it } from 'vitest';
import { makeGame } from './helpers';

describe('Codes de triche', () => {
  it('NoWeaponSway donne 20 000 $ à chaque saisie', () => {
    const ctx = makeGame();
    const funds = ctx.state.resources.stock.funds;
    ctx.commands.push({ type: 'cheatCode', code: 'NoWeaponSway' });
    ctx.sim.step();
    expect(ctx.state.resources.stock.funds).toBeCloseTo(funds + 20000, -2);
    // Insensible à la casse et aux espaces autour, cumulable
    ctx.commands.push({ type: 'cheatCode', code: '  noweaponsway ' });
    ctx.sim.step();
    expect(ctx.state.resources.stock.funds).toBeCloseTo(funds + 40000, -2);
    expect(ctx.state.log.some((l) => l.key === 'log.cheat')).toBe(true);
  });

  it('un code inconnu ne donne rien', () => {
    const ctx = makeGame();
    const funds = ctx.state.resources.stock.funds;
    ctx.commands.push({ type: 'cheatCode', code: 'ArgentFacile' });
    ctx.sim.step();
    expect(ctx.state.resources.stock.funds).toBeLessThan(funds + 1000);
  });
});
