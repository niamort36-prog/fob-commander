import { describe, expect, it } from 'vitest';
import { makeGame } from './helpers';

describe('Organisation des groupes', () => {
  it('renomme un groupe', () => {
    const ctx = makeGame(undefined, { agents: true });
    const g = Object.values(ctx.state.groups)[1];
    ctx.commands.push({ type: 'renameGroup', groupId: g.id, name: '  Équipe   Alpha  ' });
    ctx.sim.step();
    expect(g.name).toBe('Équipe Alpha');
    ctx.commands.push({ type: 'renameGroup', groupId: g.id, name: '   ' });
    ctx.sim.step();
    expect(g.name).toBe('Équipe Alpha'); // nom vide refusé
  });

  it('renomme un soldat (nom nettoyé, champ vide ignoré)', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = Object.values(ctx.state.agents)[0];
    const first = a.firstName;
    ctx.commands.push({ type: 'renameAgent', agentId: a.id, firstName: '   ', lastName: '  Du   Breuil ' });
    ctx.sim.step();
    expect(a.firstName).toBe(first);
    expect(a.lastName).toBe('Du Breuil');
    ctx.commands.push({ type: 'renameAgent', agentId: a.id, firstName: 'Marc', lastName: 'x'.repeat(40) });
    ctx.sim.step();
    expect(a.firstName).toBe('Marc');
    expect(a.lastName.length).toBeLessThanOrEqual(20);
  });

  it('change un soldat de groupe ; un groupe vidé disparaît', () => {
    const ctx = makeGame(undefined, { agents: true });
    const [hq, squad] = Object.values(ctx.state.groups);
    const a = ctx.state.agents[squad.memberIds[0]];
    ctx.commands.push({ type: 'moveAgent', agentId: a.id, groupId: hq.id });
    ctx.sim.step();
    expect(a.groupId).toBe(hq.id);
    expect(hq.memberIds).toContain(a.id);
    expect(squad.memberIds).not.toContain(a.id);
    // Vider complètement l'escouade
    for (const id of [...squad.memberIds]) ctx.sim.groups.move(id, hq.id);
    expect(ctx.state.groups[squad.id]).toBeUndefined();
  });

  it('crée un groupe avec un nouveau venu, puis le dissout', () => {
    const ctx = makeGame(undefined, { agents: true });
    const recruit = ctx.sim.agents.createAgent('infantry', null, ctx.state.fob.entry);
    ctx.commands.push({ type: 'createGroup', memberIds: [recruit.id] });
    ctx.sim.step();
    const g = ctx.state.groups[recruit.groupId!];
    expect(g.name).toMatch(/Groupe/);
    expect(g.memberIds).toEqual([recruit.id]);
    ctx.commands.push({ type: 'disbandGroup', groupId: g.id });
    ctx.sim.step();
    expect(recruit.groupId).toBeNull();
    expect(ctx.state.groups[g.id]).toBeUndefined();
  });

  it('les groupes servent au planificateur de mission (groupe entier)', () => {
    const ctx = makeGame(undefined, { agents: true });
    const g = ctx.sim.groups.create('Section Bravo');
    const ids = Object.values(ctx.state.agents).filter((a) => a.defId === 'infantry').slice(0, 4).map((a) => a.id);
    for (const id of ids) ctx.sim.groups.move(id, g.id);
    expect(ctx.state.groups[g.id].memberIds).toEqual(ids);
  });
});
