/**
 * GroupSystem — organisation du personnel en groupes (escouades, équipes, sections) :
 * renommer, créer, dissoudre un groupe, changer un soldat de groupe.
 * Un groupe vidé par un transfert disparaît (sauf s'il vient d'être créé par le joueur).
 */
import type { Command } from '../core/Commands';
import type { GameContext } from '../core/GameContext';
import type { Id, UnitGroup } from '../core/GameState';
import { pushLog } from '../core/Log';
import { t } from '../utils/i18n';
import { newId } from '../utils/ids';
import type { System } from './System';

export const GROUP_NAME_MAX = 32;
export const AGENT_NAME_MAX = 20;

export class GroupSystem implements System {
  readonly id = 'groups';

  constructor(private readonly ctx: GameContext) {}

  private clean(name: string): string {
    return name.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX);
  }

  /** Nom par défaut d'un nouveau groupe (« Groupe 3 »…). */
  defaultName(): string {
    const names = new Set(Object.values(this.ctx.state.groups).map((g) => g.name));
    let n = 1;
    while (names.has(t('group.defaultName', { n }))) n++;
    return t('group.defaultName', { n });
  }

  rename(groupId: Id, name: string): boolean {
    const g = this.ctx.state.groups[groupId];
    const clean = this.clean(name);
    if (!g || !clean) return false;
    g.name = clean;
    this.ctx.bus.emit('group:changed', { groupId });
    return true;
  }

  /** Crée un groupe, éventuellement avec des premiers membres. */
  create(name: string | undefined, memberIds: Id[] = []): UnitGroup {
    const s = this.ctx.state;
    const id = newId(s, 'grp');
    const g: UnitGroup = { id, name: this.clean(name ?? '') || this.defaultName(), kind: 'squad', memberIds: [], missionId: null };
    s.groups[id] = g;
    for (const a of memberIds) this.move(a, id, false);
    pushLog(this.ctx, 'info', 'log.groupCreated', { name: g.name });
    this.ctx.bus.emit('group:changed', { groupId: id });
    return g;
  }

  /** Change un soldat de groupe (null = sans groupe). */
  move(agentId: Id, groupId: Id | null, cleanup = true): boolean {
    const s = this.ctx.state;
    const a = s.agents[agentId];
    if (!a || (groupId && !s.groups[groupId]) || a.groupId === groupId) return false;
    const from = a.groupId ? s.groups[a.groupId] : undefined;
    if (from) from.memberIds = from.memberIds.filter((id) => id !== agentId);
    a.groupId = groupId;
    if (groupId) s.groups[groupId].memberIds.push(agentId);
    // Groupe d'origine vidé : il disparaît
    if (cleanup && from && from.memberIds.length === 0) delete s.groups[from.id];
    this.ctx.bus.emit('group:changed', { groupId: groupId ?? '' });
    return true;
  }

  /** Dissout un groupe : ses membres deviennent « sans groupe ». */
  disband(groupId: Id): boolean {
    const s = this.ctx.state;
    const g = s.groups[groupId];
    if (!g) return false;
    for (const id of g.memberIds) if (s.agents[id]) s.agents[id].groupId = null;
    delete s.groups[groupId];
    pushLog(this.ctx, 'info', 'log.groupDisbanded', { name: g.name });
    this.ctx.bus.emit('group:changed', { groupId });
    return true;
  }

  /** Renomme un soldat (prénom et nom, nettoyés et limités) ; un champ vide garde l'ancien nom. */
  renameAgent(agentId: Id, firstName: string, lastName: string): void {
    const a = this.ctx.state.agents[agentId];
    if (!a) return;
    const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, AGENT_NAME_MAX);
    a.firstName = clean(firstName) || a.firstName;
    a.lastName = clean(lastName) || a.lastName;
    this.ctx.bus.emit('group:changed', { groupId: a.groupId ?? '' });
  }

  handleCommand(cmd: Command): boolean {
    switch (cmd.type) {
      case 'renameGroup':
        this.rename(cmd.groupId, cmd.name);
        return true;
      case 'renameAgent':
        this.renameAgent(cmd.agentId, cmd.firstName, cmd.lastName);
        return true;
      case 'createGroup':
        this.create(cmd.name, cmd.memberIds ?? []);
        return true;
      case 'moveAgent':
        this.move(cmd.agentId, cmd.groupId);
        return true;
      case 'disbandGroup':
        this.disband(cmd.groupId);
        return true;
      default:
        return false;
    }
  }
}
