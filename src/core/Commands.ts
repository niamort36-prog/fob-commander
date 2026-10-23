/**
 * Commandes du joueur. L'interface ne modifie jamais l'état directement :
 * elle pousse des commandes sérialisables, que les systèmes valident et appliquent.
 */
import type { GameSpeed, GridPos, Id, MissionTarget, PassengerRequest, ResourceBag, Rotation } from './GameState';

export type Command =
  | { type: 'placeBuilding'; defId: string; pos: GridPos; rot: Rotation }
  | { type: 'placeLine'; defId: string; cells: GridPos[] }
  | { type: 'demolish'; buildingId: Id }
  | { type: 'expandZone' }
  | { type: 'upgradeBuilding'; buildingId: Id }
  | { type: 'unlockBuilding'; defId: string }
  | { type: 'renameGroup'; groupId: Id; name: string }
  | { type: 'renameAgent'; agentId: Id; firstName: string; lastName: string }
  | { type: 'createGroup'; name?: string; memberIds?: Id[] }
  | { type: 'moveAgent'; agentId: Id; groupId: Id | null }
  | { type: 'disbandGroup'; groupId: Id }
  | { type: 'installModule'; buildingId: Id; moduleId: string }
  | { type: 'buyGear'; itemId: string; count: number }
  | { type: 'distributeGear'; itemId: string }
  | { type: 'recoverGear'; itemId: string }
  | { type: 'orderSupply'; orderId: string; cargo: ResourceBag; passengers: PassengerRequest[]; vehicles?: string[] }
  | { type: 'buyVehicle'; defId: string }
  | { type: 'setCivilAccess'; buildingId: Id; allowed: boolean }
  | { type: 'setStandingOrder'; orderId: string; cargo: ResourceBag; belowDays: number }
  | { type: 'clearStandingOrder'; orderId: string }
  | { type: 'chooseEvent'; choiceId: string }
  | { type: 'closeEvent' }
  | { type: 'launchMission'; typeId: string; target: MissionTarget; memberIds: Id[]; vehicleIds: Id[]; loadout: string; support?: string; heliId?: string }
  | { type: 'radioChoose'; choiceId: string }
  | { type: 'radioClose' }
  | { type: 'diplomacyAction'; villageId: string; actionId: string }
  | { type: 'startProject'; villageId: string; projectId: string }
  | { type: 'answerDemand'; villageId: string; accept: boolean }
  | { type: 'recruitAuxiliaries'; villageId: string; count: number }
  | { type: 'campaignAck'; continueSandbox?: boolean }
  | { type: 'setSpeed'; speed: GameSpeed }
  | { type: 'togglePause' };

export class CommandQueue {
  private queue: Command[] = [];

  push(cmd: Command): void {
    this.queue.push(cmd);
  }

  /** Vide la file et renvoie les commandes en attente, dans l'ordre. */
  drain(): Command[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  get size(): number {
    return this.queue.length;
  }
}
