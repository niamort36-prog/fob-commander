import { describe, expect, it } from 'vitest';
import type { GameContext } from '../src/core/GameContext';
import type { Agent, BuildingInstance } from '../src/core/GameState';
import { CENTER, buildNow, makeGame, stepTicks } from './helpers';

type AI = { start(a: Agent, id: string, urgent: boolean, depth: number): void };
const ai = (ctx: GameContext) => ctx.sim.agents as unknown as AI;

function setHour(ctx: GameContext, hour: number): void {
  while (Math.floor(ctx.state.time.minuteOfDay / 60) !== hour) ctx.sim.step();
}

/** Place un soldat en train de tirer au stand. */
function shooter(ctx: GameContext, range: BuildingInstance): Agent {
  const a = Object.values(ctx.state.agents).find((x) => x.defId === 'infantry' && x.activity?.id !== 'shoot')!;
  a.activity = { id: 'shoot', targetId: range.id, stage: 'acting', urgent: false, startTick: ctx.state.time.tick, endTick: ctx.state.time.tick + 9999 };
  (ctx.sim.agents as unknown as { reserve(id: string, key: string): void }).reserve(range.id, 'shooting');
  return a;
}

describe('Structures d’entraînement', () => {
  it('à l’heure d’entraînement, les soldats vont au stand de tir s’il y a de la place', () => {
    const ctx = makeGame(undefined, { agents: true });
    setHour(ctx, 10);
    const range = buildNow(ctx, 'shooting_range', { x: CENTER.x - 4, y: CENTER.y + 8 });
    ctx.sim.agents.nav.ensure();
    const a = Object.values(ctx.state.agents).find((x) => x.defId === 'infantry')!;
    ctx.random = () => 0; // le stand est tenté en premier
    ai(ctx).start(a, 'train', false, 0);
    expect(['shoot', 'drill', 'cqb']).toContain(a.activity!.id);
    expect(a.activity!.targetId).toBe(range.id);
  });

  it('le tir consomme des munitions et fait progresser la compétence de tir', () => {
    const ctx = makeGame(undefined, { agents: true });
    setHour(ctx, 10);
    const range = buildNow(ctx, 'shooting_range', { x: CENTER.x - 4, y: CENTER.y + 8 });
    const a = shooter(ctx, range);
    const skill = a.skills.shooting;
    const ammo = ctx.state.resources.stock.ammo;
    stepTicks(ctx, 120);
    a.activity = null;
    expect(ctx.state.resources.stock.ammo).toBeLessThan(ammo);
    expect(a.skills.shooting).toBeGreaterThan(skill);
  });

  it('pas de tir réel la nuit ni sans munitions', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'shooting_range', { x: CENTER.x - 4, y: CENTER.y + 8 });
    const ais = ctx.sim.agents as unknown as { activityAllowed(d: unknown): boolean };
    setHour(ctx, 23);
    expect(ais.activityAllowed(ctx.content.activity('shoot'))).toBe(false);
    setHour(ctx, 10);
    expect(ais.activityAllowed(ctx.content.activity('shoot'))).toBe(true);
    ctx.state.resources.stock.ammo = 0;
    expect(ais.activityAllowed(ctx.content.activity('shoot'))).toBe(false);
    expect(ais.activityAllowed(ctx.content.activity('drill'))).toBe(true);
  });

  it('un stand de tir trop près des tentes gâche le sommeil ; les merlons antibruit règlent le problème', () => {
    const ctx = makeGame(undefined, { agents: true });
    setHour(ctx, 10);
    const tent = buildNow(ctx, 'tent_group', { x: CENTER.x, y: CENTER.y });
    const range = buildNow(ctx, 'shooting_range', { x: CENTER.x, y: CENTER.y + 4 });
    const sleeper = Object.values(ctx.state.agents).find((x) => x.defId === 'logistics')!;
    const sleep = (): number => {
      sleeper.needs.sleep = 20;
      sleeper.needs.morale = 60;
      sleeper.activity = { id: 'sleep', targetId: tent.id, stage: 'acting', urgent: false, startTick: ctx.state.time.tick, endTick: ctx.state.time.tick + 9999 };
      stepTicks(ctx, 60);
      return sleeper.needs.sleep;
    };
    const quiet = sleep();
    shooter(ctx, range);
    const noisy = sleep();
    expect(sleeper.disturbed).toBe(true);
    expect(noisy).toBeLessThan(quiet);
    range.modules = ['berms'];
    sleep();
    expect(sleeper.disturbed).toBe(false);
  });

  it('le matériel de musculation améliore la salle de sport', () => {
    const ctx = makeGame();
    const gym = buildNow(ctx, 'gym', CENTER);
    expect(ctx.content.building('gym').modules!.map((m) => m.id)).toEqual(['weights', 'cardio', 'boxing', 'ac']);
    ctx.state.resources.stock.funds += 10000;
    ctx.state.resources.stock.parts += 100;
    expect(ctx.sim.build.moduleCheck(gym, 'weights')).toBeNull();
  });
});
