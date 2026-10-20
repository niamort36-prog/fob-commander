/**
 * GameState — état central, entièrement sérialisable en JSON.
 *
 * Règles :
 *  - uniquement des données (pas de classes, pas de fonctions, pas de références circulaires) ;
 *  - entités normalisées en Record<Id, T>, références par id ;
 *  - les définitions (bâtiments, terrains…) vivent dans le ContentRegistry, l'état ne stocke que des `defId`.
 */
import type { ContentRegistry } from './ContentRegistry';
import { carveTrack, entryCell, generateTerrain } from '../utils/terrainGen';

/** Version du format de sauvegarde (incrémenter + ajouter une migration dans SaveSystem en cas de changement). */
export const SAVE_VERSION = 13;

export type Id = string;

export const RESOURCE_IDS = ['funds', 'water', 'food', 'ammo', 'fuel', 'parts', 'medical', 'power'] as const;
export type ResourceId = (typeof RESOURCE_IDS)[number];
export type ResourceBag = Partial<Record<ResourceId, number>>;

export interface GridPos {
  x: number;
  y: number;
}

/** Quarts de tour. */
export type Rotation = 0 | 1 | 2 | 3;
export type GameSpeed = 0 | 1 | 2 | 4 | 8;

// ---------------------------------------------------------------- Bâtiments

export type BuildingStatus = 'construction' | 'active' | 'damaged' | 'disabled';

export interface BuildingInstance {
  id: Id;
  defId: string;
  pos: GridPos; // case en haut (coin nord) de l'emprise
  rot: Rotation;
  level: number;
  state: BuildingStatus;
  buildProgress: number; // 0..1
  hp: number;
  wear: number; // 0..1 (usure)
  /** Chantier d'amélioration en cours (le bâtiment reste en service). */
  upgrade: { progress: number } | null;
  /** Améliorations installées (buildings.json → modules). */
  modules?: string[];
  /** Installation d'amélioration en cours. */
  moduleWork?: { id: string; progress: number } | null;
  /** Stock local livré par le soutien (rations, munitions, carburant, médical) et repas préparés (« meals »). */
  inventory?: Record<string, number>;
  /** Propreté des sanitaires et du réfectoire (0..1, 1 = impeccable). */
  cleanliness?: number;
  /** Matériaux du chantier en cours (construction, amélioration, module) : nécessaires et livrés. */
  materials?: { needed: number; delivered: number } | null;
}

// ---------------------------------------------------------------- Journal

export type LogType = 'info' | 'good' | 'warn' | 'bad';

export interface LogEntry {
  tick: number;
  day: number;
  minute: number;
  type: LogType;
  key: string; // clé de strings.fr.json
  params?: Record<string, string | number>;
}

// ---------------------------------------------------------------- Personnel (Phase 2)

export const NEED_IDS = ['food', 'water', 'sleep', 'hygiene', 'morale'] as const;
export type NeedId = (typeof NEED_IDS)[number];

export interface AgentActivity {
  id: string; // → activities.json
  targetId: Id | null; // bâtiment visé (service ou chantier)
  stage: 'moving' | 'acting';
  /** Déclenchée par un besoin critique (et non par l'emploi du temps). */
  urgent: boolean;
  startTick: number;
  endTick: number;
  /** Déchargement : véhicule servi, étape en cours et charge portée. */
  vehicleId?: Id | null;
  phase?: 'pickup' | 'drop';
  carry?: Load | null;
  /** Ravitaillement interne : ressource et quantité prévues pour le bâtiment visé. */
  supply?: Load | null;
  /** Lieu de prise en charge (dépôt, entrepôt) d'un ravitaillement ou de matériaux. */
  sourceId?: Id | null;
  /** Matériaux de construction portés (unités). */
  materials?: number;
  /** Repas : qualité du repas servi (1 = cuisinier, moins pour une cuisine de fortune). */
  quality?: number;
}

/** Charge portée par un agent ou un chariot élévateur. */
export interface Load {
  resource: ResourceId;
  amount: number;
}

/** Habitant de la base. Position en coordonnées de grille continues (centre d'une case = x + 0,5). */
export interface Agent {
  id: Id;
  defId: string; // → personnel.json
  firstName: string;
  lastName: string;
  rank: string;
  skills: Record<string, number>; // 0..100
  traits: string[]; // → traits.json
  needs: Record<NeedId, number>; // 0..100 (100 = pleinement satisfait)
  health: number; // 0..100
  xp: number;
  efficiency: number; // dérivée des besoins et traits (cache)
  groupId: Id | null;
  homeId: Id | null; // tente où un couchage lui est attribué
  missionId: Id | null; // mission en cours (préparation, hors base, retour)
  shift: number; // quart (décalage de l'emploi du temps)
  pos: { x: number; y: number };
  prevPos: { x: number; y: number }; // position au tick précédent (interpolation du rendu)
  path: GridPos[];
  activity: AgentActivity | null;
  status: 'on_base' | 'on_mission' | 'wounded' | 'kia';
  /** Équipement individuel distribué (equipment.json). */
  gear?: string[];
  /** Équipement attribué, à aller percevoir au dépôt. */
  gearPending?: string[];
  /** Munitions individuelles portées (unités de munitions). */
  ammo?: number;
  /** Dérangé par le bruit pendant son sommeil (état du moment, pour l'affichage). */
  disturbed?: boolean;
  /** Auxiliaire local : village d'origine. */
  origin?: string | null;
  /** Auxiliaire infiltré par l'insurrection (caché au joueur). */
  infiltrator?: boolean;
}

export type GroupKind = 'hq' | 'squad' | 'support' | 'sf_team' | 'contractor_team';

/** Escouade, équipe SF, équipe contractor, section de soutien… */
export interface UnitGroup {
  id: Id;
  name: string;
  kind: GroupKind;
  memberIds: Id[];
  missionId: Id | null;
}

/** Périmètre possédé, rectangle de cases à l'intérieur de la carte. */
export interface Zone {
  x: number;
  y: number;
  width: number;
  height: number;
  expansions: number;
}

// ---------------------------------------------------------------- Phases suivantes (formes figées dès maintenant)

// ---------------------------------------------------------------- Ravitaillement (Phase 3)

export interface PassengerRequest {
  type: string; // → personnel.json
  count: number;
}

export type OrderStatus = 'pending' | 'en_route' | 'unloading' | 'leaving' | 'delivered' | 'cancelled';

/** Commande de ravitaillement passée au commandement. */
export interface SupplyOrder {
  id: Id;
  orderId: string; // → supply.json
  cargo: ResourceBag;
  passengers: PassengerRequest[];
  cost: number;
  placedTick: number;
  etaTick: number; // arrivée en bordure de carte
  status: OrderStatus;
  vehicleId: Id | null;
  ambushed: boolean;
  /** Véhicules achetés livrés en soute (C-130). */
  vehicles?: string[];
}

export type VehicleState =
  | 'inbound' // en route vers sa destination
  | 'blocked' // destination inaccessible : nouvel essai plus tard
  | 'waiting' // attend une place de stationnement
  | 'unloading' // garé, déchargé par le personnel / les chariots
  | 'pumping' // camion-citerne branché sur une cuve
  | 'outbound' // repart vers la bordure de carte
  | 'idle' // chariot élévateur au repos
  | 'toPickup' // chariot élévateur vers un camion
  | 'toDrop' // chariot élévateur vers un stockage
  | 'mission_out' // véhicule blindé partant en mission
  | 'away' // hors de la carte (en mission)
  | 'mission_back' // véhicule blindé rentrant de mission
  | 'sortie'; // hélicoptère de combat en défense de la base

/** Véhicule présent sur la carte (camion, hélicoptère, chariot élévateur). */
export interface Vehicle {
  id: Id;
  defId: string; // → vehicles.json
  /** Contrôle à une porte gardée : arrêt jusqu'à ce tick, porte déjà contrôlée. */
  gateWaitUntil?: number;
  gateChecked?: Id | null;
  pos: { x: number; y: number };
  prevPos: { x: number; y: number };
  path: GridPos[];
  /** Orientation du sprite : 0 = axe x, 1 = axe y ; flip = sens inverse. */
  axis: 0 | 1;
  flip: boolean;
  altitude: number; // hélicoptère (px)
  state: VehicleState;
  orderId: Id | null;
  cargo: ResourceBag;
  passengers: PassengerRequest[];
  targetId: Id | null; // bâtiment visé
  slot: number; // place de stationnement
  timer: number; // tick de la prochaine action (nouvel essai, fin d'attente…)
  homeId: Id | null; // chariot élévateur : zone de rattachement
  carry: Load | null; // chariot élévateur
  warned: boolean;
  /** Véhicule d'une délégation en visite (piloté par VisitSystem). */
  visit?: boolean;
  /** Avions : points de passage (position, altitude en px, vitesse en cases/minute). */
  route?: { x: number; y: number; alt: number; speed: number }[];
}

// ---------------------------------------------------------------- Événements et combat (Phase 4)

export type CombatMode = 'shelter' | 'engage';

/** Résultat d'un choix, affiché jusqu'à la fermeture du dialogue. */
export interface EventOutcomeState {
  choiceId: string;
  text: string;
  summary: string[];
  pendingAttack: { id: string; mode: CombatMode } | null;
}

/** Événement en cours (le jeu est en pause tant qu'il est ouvert). */
export interface ActiveEvent {
  eventId: string;
  startedTick: number;
  vars: Record<string, string | number | boolean>;
  resumeSpeed: GameSpeed;
  outcome: EventOutcomeState | null;
}

export interface QueuedEvent {
  eventId: string;
  atTick: number;
}

export interface EventRecord {
  eventId: string;
  tick: number;
  choiceId: string;
}

export interface Enemy {
  id: Id;
  defId: string; // → combat.json enemies
  pos: { x: number; y: number };
  prevPos: { x: number; y: number };
  path: GridPos[];
  health: number;
  skill: number;
  state: 'approach' | 'engage' | 'retreat' | 'breach';
  cooldown: number; // tick du prochain tir
  /** Bâtiment (porte, mur) que l'assaillant est en train de forcer. */
  breachId?: Id | null;
}

export interface CombatStats {
  kia: number;
  wounded: number;
  enemyKilled: number;
  damaged: number;
}

/** Attaque en cours contre la base. */
export interface CombatState {
  active: boolean;
  attackId: string | null;
  mode: CombatMode;
  startedTick: number;
  endsTick: number;
  origin: GridPos;
  enemies: Record<Id, Enemy>;
  initialEnemies: number;
  shellsLeft: number;
  nextShellTick: number;
  stats: CombatStats;
}

export interface FallenSoldier {
  name: string;
  day: number;
}

export function emptyCombat(): CombatState {
  return {
    active: false,
    attackId: null,
    mode: 'shelter',
    startedTick: 0,
    endsTick: 0,
    origin: { x: 0, y: 0 },
    enemies: {},
    initialEnemies: 0,
    shellsLeft: 0,
    nextShellTick: 0,
    stats: { kia: 0, wounded: 0, enemyKilled: 0, damaged: 0 },
  };
}

// ---------------------------------------------------------------- Région (Phases 5 & 7)

/** Position sur la carte régionale, en kilomètres. */
export interface KmPos {
  x: number;
  y: number;
}

export interface VillageState {
  attitude: number; // -100 (hostile) … +100 (allié)
  influence: number; // emprise insurgée 0..100
}

export type IntelSource = 'initial' | 'observation' | 'village' | 'analysis' | 'attack' | 'event' | 'cia' | 'mission' | 'allied';

/** Contact ennemi : position réelle (cachée) et ce que la base en sait. */
export interface ContactState {
  id: string; // → region.json contacts
  truePos: KmPos;
  estPos: KmPos;
  error: number; // rayon d'incertitude (km)
  reliability: number; // 0..1
  lastSeenTick: number;
  known: boolean;
  source: IntelSource;
  /** Groupe apparu en cours de partie (réaction de l'insurrection) : sa définition. */
  dyn?: { kind: string; label: string; drift: number; home: KmPos };
  /** Effectifs restants (1 = complet, détruit à 0). */
  strength?: number;
  /** Ce que fait le groupe : se déplacer vers un but, y rester jusqu'à une date. */
  task?: EnemyTask;
}

export interface EnemyTask {
  type: 'patrol' | 'rest' | 'approach' | 'firing' | 'hide' | 'plant';
  dest: KmPos;
  arrived: boolean;
  until: number;
}

/** Acteur du monde : patrouille alliée ou civils en déplacement. */
export interface WorldActor {
  id: string;
  side: 'allied' | 'civilian';
  kind: string;
  label: string;
  pos: KmPos;
  dest: KmPos;
  /** Unité ou village d'origine (retour), destination nommée. */
  home: KmPos;
  destName: string;
  phase: 'out' | 'stay' | 'back';
  until: number;
  strength: number;
}

/** Engin explosif posé sur une route par une cellule IED. */
export interface PlantedIed {
  id: string;
  pos: KmPos;
  tick: number;
  by: string;
}

/** Fait marquant du monde affiché quelque temps sur la carte. */
export interface WorldIncident {
  pos: KmPos;
  tick: number;
  text: string;
  tone: 'good' | 'bad' | 'info';
}

export interface PersonalityState {
  known: boolean;
  met: boolean;
}

export interface RegionState {
  initialized: boolean;
  villages: Record<string, VillageState>;
  contacts: Record<string, ContactState>;
  personalities: Record<string, PersonalityState>;
  stability: number;
  /** Heures-officier passées au TOC aujourd'hui (analyse du renseignement). */
  tocHoursToday: number;
  /** Monde vivant : patrouilles alliées, civils, engins posés, faits marquants, lieux visités. */
  actors?: Record<string, WorldActor>;
  ieds?: PlantedIed[];
  incidents?: WorldIncident[];
  sitesVisited?: Record<string, number>;
}

export function emptyRegion(): RegionState {
  return { initialized: false, villages: {}, contacts: {}, personalities: {}, stability: 50, tocHoursToday: 0, actors: {}, ieds: [], incidents: [], sitesVisited: {} };
}

// ---------------------------------------------------------------- Visites physiques

export interface Visitor {
  id: Id;
  visual: string; // → visitors.json visuals
  name: string | null; // chef de délégation
  pos: { x: number; y: number };
  prevPos: { x: number; y: number };
  path: GridPos[];
  leader: boolean;
  /** À bord du véhicule de la délégation (masqué). */
  riding: boolean;
  /** Reparti (hors de la carte). */
  gone: boolean;
  nextWander: number;
}

export interface VisitState {
  eventId: string;
  mode: 'foot' | 'cart' | 'vehicle' | 'helicopter';
  phase: 'arriving' | 'meeting' | 'staying' | 'leaving';
  name: string;
  vehicleId: Id | null;
  visitors: Visitor[];
  meet: GridPos;
  landing: GridPos | null;
  untilTick: number;
  startedTick: number;
}

// ---------------------------------------------------------------- Géopolitique (Phase 7)

/** Relations avec un village, au-delà de l'attitude et de l'emprise (RegionState.villages). */
export interface VillageDiplomacy {
  /** Besoins satisfaits par un projet. */
  satisfied: string[];
  /** Dernière présence de la coalition (patrouille, sécurisation…). */
  lastPatrolTick: number;
  /** Action → tick de dernière utilisation. */
  cooldowns: Record<string, number>;
  /** Demande formulée par le chef lors d'une shura, en attente de réponse. */
  demand: { need: string; untilTick: number } | null;
  /** Promesse faite au chef. */
  promise: { need: string; deadlineTick: number } | null;
  /** Auxiliaires recrutés dans ce village. */
  auxiliaries: number;
  /** Valeurs de la veille (tendance). */
  prevAttitude: number;
  prevInfluence: number;
}

export interface ProjectState {
  id: Id;
  projectId: string; // → diplomacy.json projects
  villageId: string;
  startTick: number;
  endTick: number;
}

export interface CampaignStats {
  missionsSuccess: number;
  projectsDone: number;
  promisesKept: number;
  promisesBroken: number;
  contactsNeutralized: number;
  auxiliaries: number;
  neutralized: string[];
}

export type CampaignNoticeKind = 'start' | 'phaseDone' | 'missed' | 'victory' | 'defeat' | 'warning';

export interface CampaignState {
  phaseIndex: number;
  phaseStartTick: number;
  deadlineTick: number;
  status: 'active' | 'won' | 'lost' | 'sandbox';
  missed: number;
  lowStabilityDays: number;
  stats: CampaignStats;
  /** Compteurs au début de la phase (les objectifs comptent depuis le début de la phase). */
  base: Record<string, number>;
  /** Annonce à afficher (fenêtre de campagne). */
  notice: { kind: CampaignNoticeKind; phaseIndex: number } | null;
}

export interface DiplomacyState {
  initialized: boolean;
  villages: Record<string, VillageDiplomacy>;
  projects: Record<Id, ProjectState>;
  /** Tension due aux incidents récents (attaques, pertes, bavures), décroît chaque jour. */
  incidents: number;
  /** Stabilité régionale des derniers jours (la plus récente en dernier). */
  history: number[];
  /** Composantes de la dernière évaluation de stabilité (0..100). */
  components: { attitude: number; influence: number; enemy: number; incidents: number };
  campaign: CampaignState;
  nextDyn: number;
}

export function emptyDiplomacy(): DiplomacyState {
  return {
    initialized: false,
    villages: {},
    projects: {},
    incidents: 0,
    history: [],
    components: { attitude: 50, influence: 50, enemy: 50, incidents: 100 },
    campaign: {
      phaseIndex: 0,
      phaseStartTick: 0,
      deadlineTick: 0,
      status: 'active',
      missed: 0,
      lowStabilityDays: 0,
      stats: { missionsSuccess: 0, projectsDone: 0, promisesKept: 0, promisesBroken: 0, contactsNeutralized: 0, auxiliaries: 0, neutralized: [] },
      base: {},
      notice: null,
    },
    nextDyn: 0,
  };
}

// ---------------------------------------------------------------- Missions (Phase 6)

export type MissionPhase = 'assembling' | 'outbound' | 'objective' | 'inbound' | 'returning' | 'done';
export type MissionResult = 'success' | 'partial' | 'failure';
export type MissionTargetKind = 'contact' | 'village' | 'fob' | 'sector' | 'site';

export interface MissionTarget {
  kind: MissionTargetKind;
  id: string | null;
  pos: KmPos;
  name: string;
}

export interface MissionInstance {
  id: Id;
  defId: string; // → missions.json types
  callsign: string;
  target: MissionTarget;
  memberIds: Id[];
  vehicleIds: Id[];
  loadout: string;
  phase: MissionPhase;
  startTick: number;
  phaseStartTick: number;
  phaseEndTick: number;
  travelTicks: number;
  objectiveTicks: number;
  distanceKm: number;
  estimate: number; // chance de succès estimée au départ
  mods: { success: number; casualty: number };
  radioQueue: { atTick: number; radioId: string }[];
  radioLog: { tick: number; text: string }[];
  /** Messages radio déjà reçus (pas deux fois la même situation). */
  radioUsed?: string[];
  /** Groupes ennemis et engins déjà rencontrés pendant la mission. */
  encountered?: string[];
  /** L'ennemi visé n'était plus sur l'objectif à l'arrivée. */
  targetMoved?: boolean;
  result: MissionResult | null;
  aborted: boolean;
  casualties: { kia: string[]; wounded: string[] };
  enemyKilled: number;
  gains: string[];
  reportId: Id | null;
  /** Appui feu engagé (missions.json support), null si aucun. */
  support?: string | null;
  /** Salves d'artillerie restant à tirer depuis la base (effet visuel). */
  salvos?: number;
  /** Chance estimée hors effet du TOC (remplacé à la résolution par le suivi réel). */
  estimateBase?: number;
  /** Suivi depuis le TOC : relevés horaires et part du temps avec assez d'officiers. */
  tocSamples?: number;
  tocStaffed?: number;
  /** Pénalité de liaison radio au lancement (distance). */
  commsPenalty?: number;
  /** Objectif atteint de nuit (bonus des équipements de vision nocturne). */
  night?: boolean;
  /** Hélicoptère de transport de la base (héliportage) et appareil d'appui engagé. */
  heliId?: string | null;
  supportVehicleId?: string | null;
}

export interface MissionReport {
  id: Id;
  missionId: Id;
  callsign: string;
  title: string;
  day: number;
  minute: number;
  result: MissionResult;
  lines: string[];
  read: boolean;
}

/** Message radio en attente de réponse (le jeu est en pause). */
export interface PendingRadio {
  missionId: Id;
  radioId: string;
  resumeSpeed: GameSpeed;
  answer: string | null; // accusé de réception affiché après le choix
  /** Variables tirées pour ce message ({dir}, {terrain}, {leader}…). */
  vars?: Record<string, string>;
}

export interface RadioState {
  pending: PendingRadio | null;
  queue: { missionId: Id; radioId: string; contactId?: string }[];
}

// ---------------------------------------------------------------- Racine

export interface GameState {
  meta: {
    version: number;
    seed: number;
    rngState: number;
    createdAt: string;
    playtimeSec: number;
    siteId: string;
    nextId: number;
  };
  time: {
    tick: number;
    day: number; // commence à 1
    minuteOfDay: number; // 0..1439
    speed: GameSpeed;
  };
  resources: {
    stock: Record<ResourceId, number>;
    /** Électricité : production et demande instantanées (kW). */
    power: { supply: number; demand: number };
    capacity: Record<ResourceId, number>; // recalculée par l'EconomySystem
    todayDelta: ResourceBag; // variation cumulée de la journée en cours
    lastDayDelta: ResourceBag; // variation de la veille
    shortages: ResourceId[]; // ressources actuellement en rupture
  };
  fob: {
    width: number;
    height: number;
    zone: Zone; // périmètre constructible, agrandissable
    entry: GridPos; // arrivée des convois (bordure de carte, au bout de la piste)
    terrain: number[]; // index dans terrain.json, ligne par ligne (y * width + x)
    occupancy: (Id | null)[]; // index dérivé, reconstruit au chargement
    buildings: Record<Id, BuildingInstance>;
  };
  agents: Record<Id, Agent>;
  groups: Record<Id, UnitGroup>;
  supply: { orders: Record<Id, SupplyOrder> };
  vehicles: Record<Id, Vehicle>;
  progression: {
    reputation: number;
    /** Points de réputation à dépenser (déblocage de bâtiments). */
    points: number;
    /** Dernière évaluation quotidienne du commandement (0..1), null avant la première. */
    lastRating: number | null;
    unlocked: string[];
    flags: Record<string, boolean | number>;
  };
  events: {
    active: ActiveEvent | null;
    queue: QueuedEvent[];
    history: EventRecord[];
    cooldowns: Record<string, number>; // id → tick du dernier déclenchement
    lastEventTick: number;
    lastAttackTick: number;
  };
  combat: CombatState;
  /** Soldats tombés au combat. */
  memorial: FallenSoldier[];
  radio: RadioState;
  missionReports: MissionReport[];
  region: RegionState;
  missions: Record<Id, MissionInstance>;
  diplomacy: DiplomacyState;
  /** Délégation en visite à la base (une à la fois). */
  visit: VisitState | null;
  /** Équipement individuel en stock (non distribué). */
  equipment: Record<string, number>;
  log: LogEntry[];
}

export function emptyResourceRecord(): Record<ResourceId, number> {
  const rec = {} as Record<ResourceId, number>;
  for (const id of RESOURCE_IDS) rec[id] = 0;
  return rec;
}

/** Périmètre initial d'un site, centré sur la carte. */
export function initialZone(width: number, height: number, zoneW: number, zoneH: number): Zone {
  const w = Math.min(width, zoneW);
  const h = Math.min(height, zoneH);
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), width: w, height: h, expansions: 0 };
}

/** Crée l'état d'une nouvelle partie sur le site choisi (le personnel est déployé par AgentAI). */
export function createInitialState(content: ContentRegistry, siteId: string, seed: number): GameState {
  const site = content.site(siteId);
  const { width, height } = content.balance.map;
  const terrain = generateTerrain(width, height, seed, site.terrain, content.terrainIndex);
  const zone = initialZone(width, height, site.zone.width, site.zone.height);
  const entry = entryCell(site.entry.side, width, height);
  carveTrack(terrain, width, height, entry, zone, seed, content.terrainIndex.get('track') ?? 0);

  const stock = emptyResourceRecord();
  for (const [id, value] of Object.entries(site.startResources)) stock[id as ResourceId] = value ?? 0;

  return {
    meta: {
      version: SAVE_VERSION,
      seed,
      rngState: seed,
      createdAt: new Date().toISOString(),
      playtimeSec: 0,
      siteId,
      nextId: 0,
    },
    time: {
      tick: 0,
      day: 1,
      minuteOfDay: content.balance.time.startHour * 60,
      speed: 1,
    },
    resources: {
      stock,
      power: { supply: 0, demand: 0 },
      capacity: emptyResourceRecord(),
      todayDelta: {},
      lastDayDelta: {},
      shortages: [],
    },
    fob: {
      width,
      height,
      zone,
      entry,
      terrain,
      occupancy: new Array<Id | null>(width * height).fill(null),
      buildings: {},
    },
    agents: {},
    groups: {},
    supply: { orders: {} },
    vehicles: {},
    progression: {
      reputation: content.balance.progression.startReputation,
      points: content.balance.progression.startPoints ?? 0,
      lastRating: null,
      unlocked: [],
      flags: {},
    },
    events: { active: null, queue: [], history: [], cooldowns: {}, lastEventTick: -100000, lastAttackTick: -100000 },
    combat: emptyCombat(),
    memorial: [],
    radio: { pending: null, queue: [] },
    missionReports: [],
    region: emptyRegion(),
    missions: {},
    diplomacy: emptyDiplomacy(),
    visit: null,
    equipment: {},
    log: [],
  };
}
