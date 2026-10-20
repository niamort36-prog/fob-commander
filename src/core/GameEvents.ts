/**
 * Catalogue des événements du bus. Préfixes :
 *  - time:, building:, build:, zone:, agent:, resource:, save:, state:, log: → émis par la simulation ;
 *  - ui: → échanges entre scènes de rendu et interface (jamais lus par la simulation).
 */
import type { CombatMode, CombatStats, GameSpeed, GridPos, Id, LogEntry, ResourceBag, ResourceId, Zone } from './GameState';

export type PlacementReason = 'locked' | 'bounds' | 'zone' | 'terrain' | 'occupied' | 'funds' | 'unknown';

export type ToolMode = { kind: 'select' } | { kind: 'demolish' } | { kind: 'build'; defId: string };

export type ToastKind = 'info' | 'good' | 'warn' | 'error';

/** Objet sélectionné dans la vue FOB. */
export type Selection = { kind: 'building'; id: Id } | { kind: 'agent'; id: Id } | { kind: 'vehicle'; id: Id };

/** Objet sélectionné sur la carte tactique. */
export type MapSelection =
  | { kind: 'village'; id: string }
  | { kind: 'contact'; id: string }
  | { kind: 'personality'; id: string }
  | { kind: 'friendly'; id: string }
  | { kind: 'fob' }
  | { kind: 'mission'; id: string }
  | { kind: 'site'; id: string }
  | { kind: 'sector'; x: number; y: number }
  | { kind: 'actor'; id: string };

export type SupplyRejection = 'requires' | 'capacity' | 'passengers' | 'funds' | 'limit' | 'locked' | 'empty' | 'unknown' | 'vehicles' | 'pad';

export interface GameEvents {
  'time:hour': { day: number; hour: number };
  'time:newDay': { day: number };
  'time:speedChanged': { speed: GameSpeed };

  'building:placed': { id: Id; defId: string };
  'building:completed': { id: Id; defId: string };
  'building:removed': { id: Id; defId: string; refund: ResourceBag };
  'build:rejected': { defId: string; reason: PlacementReason };
  'building:upgraded': { id: Id; defId: string; level: number };
  'building:moduleInstalled': { id: Id; defId: string; moduleId: string };
  'gear:changed': Record<string, never>;
  'group:changed': { groupId: Id };
  'upgrade:rejected': { reason: 'max' | 'funds' | 'busy' };

  'supply:ordered': { orderId: Id };
  'supply:rejected': { reason: SupplyRejection };
  'supply:arrived': { orderId: Id; vehicleId: Id };
  'supply:ambushed': { orderId: Id; lossPct: number };
  'supply:blocked': { vehicleId: Id };
  'supply:delivered': { orderId: Id };
  'vehicle:bought': { vehicleId: Id };

  'progression:evaluated': { rating: number; reputation: number; budget: number };
  'progression:unlocked': { defId: string };
  'progression:purchased': { defId: string };
  'progression:unlockRejected': { defId: string; reason: 'level' | 'points' };
  'artillery:fire': { x: number; y: number };
  'aircraft:flyover': { vehicleId: Id };
  'aircraft:landing': { vehicleId: Id };

  'zone:expanded': { zone: Zone; cost: number };
  'zone:rejected': { reason: 'max' | 'funds' };

  'agent:spawned': { id: Id };
  /** Promotion au grade supérieur (CareerSystem). */
  'agent:promoted': { id: Id; rank: string };
  'agent:removed': { id: Id };

  'event:started': { eventId: string };
  'event:resolved': { eventId: string; choiceId: string };
  'event:closed': { eventId: string };
  'visit:started': { eventId: string };
  'visit:ended': { eventId: string };
  /** Menace démasquée à la fouille du poste de garde. */
  'checkpoint:caught': { x: number; y: number };

  'combat:started': { attackId: string; mode: CombatMode };
  'combat:ended': { stats: CombatStats };
  'combat:impact': { x: number; y: number; radius: number };
  'combat:shot': { fromX: number; fromY: number; fromZ: number; toX: number; toY: number; toZ: number; hit: boolean; friendly: boolean };
  'combat:death': { x: number; y: number; friendly: boolean };
  'combat:spotted': Record<string, never>;

  'intel:contact': { id: string };

  'mission:launched': { id: Id };
  'mission:rejected': { reason: string };
  'mission:phase': { id: Id; phase: string };
  'mission:done': { id: Id; reportId: Id };
  'radio:message': { missionId: Id };
  'radio:answered': { missionId: Id };
  'radio:closed': { missionId: Id };
  'ui:planMission': { target: MapSelection };
  'ui:openReport': { id: Id };
  'ui:toggleOps': Record<string, never>;
  'ui:toggleCampaign': Record<string, never>;
  'ui:toggleNeeds': Record<string, never>;
  'ui:quitToMenu': Record<string, never>;
  'ui:openOptions': Record<string, never>;
  'ui:openVillage': { id: string };
  'diplomacy:changed': { villageId: string };
  'diplomacy:shura': { villageId: string; success: boolean; need: string | null };
  'diplomacy:project': { villageId: string; projectId: string };
  'diplomacy:stability': { value: number };
  'campaign:notice': { kind: string };
  'ui:mapToggled': { open: boolean };
  'ui:toggleMap': Record<string, never>;
  'ui:mapLayers': Record<string, never>;
  'ui:mapFocus': { x: number; y: number };
  'ui:mapSelect': { target: MapSelection | null };
  'agent:incident': { id: Id; text: string };

  'resource:shortage': { resource: ResourceId };

  'log:added': { entry: LogEntry };
  'state:loaded': Record<string, never>;
  'save:done': { slot: string; auto: boolean };
  'save:failed': { slot: string; error: string };

  'ui:setTool': { tool: ToolMode };
  'ui:toolChanged': { tool: ToolMode };
  'ui:select': { target: Selection | null };
  'ui:focus': { pos: GridPos };
  'ui:toggleRoster': Record<string, never>;
  'ui:toggleLogistics': Record<string, never>;
  'ui:toast': { text: string; kind: ToastKind };
}
