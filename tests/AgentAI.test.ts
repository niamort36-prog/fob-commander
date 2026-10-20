import { describe, expect, it } from 'vitest';
import { CENTER, makeGame, stepTicks } from './helpers';

describe('AgentAI et NeedsSystem', () => {
  it('déploie la force de départ, organisée en groupes', () => {
    const ctx = makeGame(undefined, { agents: true });
    const agents = Object.values(ctx.state.agents);
    const expected = ctx.content.balance.startingForce.reduce((s, g) => s + g.members.reduce((t, m) => t + m.count, 0), 0);
    expect(agents).toHaveLength(expected);
    expect(Object.keys(ctx.state.groups)).toHaveLength(ctx.content.balance.startingForce.length);
    for (const a of agents) {
      expect(a.firstName.length).toBeGreaterThan(0);
      expect(a.groupId).not.toBeNull();
      expect(ctx.sim.agents.nav.walkable(Math.floor(a.pos.x), Math.floor(a.pos.y))).toBe(true);
    }
  });

  it('génère le même personnel pour la même graine', () => {
    const a = makeGame(undefined, { agents: true });
    const b = makeGame(undefined, { agents: true });
    const names = (ctx: typeof a) => Object.values(ctx.state.agents).map((x) => `${x.rank} ${x.firstName} ${x.lastName} ${x.traits.join()}`);
    expect(names(a)).toEqual(names(b));
  });

  it('attribue les couchages des tentes terminées', () => {
    const ctx = makeGame(undefined, { agents: true });
    for (let i = 0; i < 3; i++) ctx.sim.build.place('tent_group', { x: CENTER.x - 10, y: CENTER.y - 10 + i * 3 }, 0);
    stepTicks(ctx, 6 * 60);
    const beds = ctx.sim.agents.beds();
    expect(beds.total).toBe(24);
    expect(beds.assigned).toBe(Object.keys(ctx.state.agents).length);
  });

  it('les logisticiens rejoignent les chantiers et les accélèrent', () => {
    const ctx = makeGame(undefined, { agents: true });
    const tower = ctx.sim.build.place('watchtower', { x: CENTER.x + 4, y: CENTER.y + 4 }, 0)!;
    let maxBuilders = 0;
    let maxSpeed = 0;
    for (let i = 0; i < 180 && tower.state === 'construction'; i++) {
      ctx.sim.step();
      maxBuilders = Math.max(maxBuilders, ctx.sim.agents.builders(tower.id));
      maxSpeed = Math.max(maxSpeed, ctx.sim.build.constructionSpeed(tower));
    }
    expect(maxBuilders).toBeGreaterThan(0);
    expect(maxSpeed).toBeGreaterThan(ctx.content.balance.build.baseCrewRate);
  });

  it('les agents se déplacent et consomment eau et rations', () => {
    const ctx = makeGame(undefined, { agents: true });
    const start = Object.values(ctx.state.agents).map((a) => ({ ...a.pos }));
    const food = ctx.state.resources.stock.food;
    const water = ctx.state.resources.stock.water;
    stepTicks(ctx, 3 * 60);
    const moved = Object.values(ctx.state.agents).filter((a, i) => a.pos.x !== start[i].x || a.pos.y !== start[i].y);
    expect(moved.length).toBeGreaterThan(0);
    expect(ctx.state.resources.stock.food).toBeLessThan(food);
    expect(ctx.state.resources.stock.water).toBeLessThan(water);
  });

  it('les besoins baissent et le moral pâtit de l’absence de couchage', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = Object.values(ctx.state.agents)[0];
    const sleep = a.needs.sleep;
    stepTicks(ctx, 60);
    expect(a.needs.sleep).toBeLessThan(sleep);
    const homeless = ctx.sim.needs.moraleTarget(a);
    a.homeId = 'fictif';
    expect(ctx.sim.needs.moraleTarget(a)).toBeGreaterThan(homeless);
  });

  it('un besoin critique interrompt une activité planifiée', () => {
    const ctx = makeGame(undefined, { agents: true });
    stepTicks(ctx, 5);
    const a = Object.values(ctx.state.agents).find((x) => x.activity && !x.activity.urgent && !['sleep', 'sleep_rough'].includes(x.activity.id))!;
    a.needs.sleep = 2;
    ctx.sim.step();
    expect(['sleep', 'sleep_rough']).toContain(a.activity!.id);
    expect(a.activity!.urgent).toBe(true);
  });

  it('reste stable sur plusieurs jours (pas de blocage, besoins maintenus)', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.state.region.contacts = {}; // besoins seuls : pas d'attaque ennemie pendant l'essai
    ctx.state.resources.stock.funds += 10000; // de quoi construire tout le nécessaire
    ctx.state.progression.reputation = 20;
    ctx.state.progression.unlocked.push('water_well'); // le puits demande de la réputation
    const z = ctx.state.fob.zone;
    const cx = z.x + 20;
    const cy = z.y + 20;
    for (let i = 0; i < 3; i++) ctx.sim.build.place('tent_group', { x: cx - 6, y: cy - 6 + i * 3 }, 0);
    ctx.sim.build.place('dfac', { x: cx + 2, y: cy - 6 }, 0);
    ctx.sim.build.place('showers', { x: cx + 2, y: cy - 1 }, 0);
    ctx.sim.build.place('water_well', { x: cx + 6, y: cy - 1 }, 0);
    ctx.sim.build.place('water_well', { x: cx + 9, y: cy - 1 }, 0); // 21 personnes : un seul puits ne suffit pas
    stepTicks(ctx, 4 * 24 * 60);
    const agents = Object.values(ctx.state.agents);
    const avg = (k: 'food' | 'sleep' | 'hygiene' | 'morale') => agents.reduce((s, a) => s + a.needs[k], 0) / agents.length;
    expect(avg('food')).toBeGreaterThan(35);
    expect(avg('sleep')).toBeGreaterThan(30);
    expect(avg('hygiene')).toBeGreaterThan(30);
    expect(avg('morale')).toBeGreaterThan(45);
    expect(agents.every((a) => a.health > 90)).toBe(true);
  });

  it('un manque d’eau prolongé dégrade la santé et l’efficacité', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.state.resources.stock.water = 0;
    stepTicks(ctx, 30 * 60);
    const agents = Object.values(ctx.state.agents);
    expect(agents.every((a) => a.needs.water === 0)).toBe(true);
    expect(agents.every((a) => a.health < 100)).toBe(true);
    expect(agents.every((a) => a.efficiency < 0.6)).toBe(true);
    expect(ctx.state.resources.shortages).toContain('water');
  });
});
