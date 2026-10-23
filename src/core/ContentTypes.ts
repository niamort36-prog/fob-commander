/**
 * Types des définitions de contenu (fichiers JSON de /src/data).
 * Le contenu est validé au démarrage (utils/validate.ts) avant d'être typé ainsi.
 */
import type { GameSpeed, GroupKind, NeedId, ResourceBag, ResourceId } from './GameState';

export interface ResourceDef {
  id: ResourceId;
  name: string;
  short: string;
  color: string;
  hud: boolean;
  capped: boolean;
}

export type TerrainDecor = 'none' | 'pebbles' | 'rocks' | 'ruts';

export interface TerrainDef {
  id: string;
  name: string;
  color: string;
  variance: number;
  buildable: boolean;
  decor: TerrainDecor;
}

export interface CategoryDef {
  id: string;
  name: string;
  short: string;
  order: number;
}

export const VISUAL_STYLES = ['box', 'flat', 'hesco', 'tent', 'tank', 'tower', 'building', 'bunker', 'pole', 'howitzer', 'range', 'course', 'killhouse', 'workout', 'gate', 'booth', 'latrine', 'bar', 'bbq'] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

/** Service rendu par un bâtiment aux habitants (couchage, repas, garde…). */
export interface ServiceDef {
  slots: number;
  /** Altitude (px) où se tient l'agent qui utilise le service à l'extérieur (ex. plancher d'une tour). */
  standZ?: number;
  /** Hauteur (px) du parapet qui masque le bas du corps de l'agent posté (sacs de sable d'une tour). */
  hidePx?: number;
}

/** Niveau d'amélioration : remplace les champs indiqués à partir de ce niveau. */
export interface BuildingLevelDef {
  name?: string;
  cost: ResourceBag;
  buildTimeMin: number;
  services?: Record<string, ServiceDef>;
  storage?: ResourceBag;
  productionPerDay?: ResourceBag;
  consumptionPerDay?: ResourceBag;
  upkeepPerDay?: ResourceBag;
  powerSupply?: number;
  powerDemand?: number;
  checkpoint?: CheckpointDef;
}

/** Fouille au poste de garde : chance de déceler une menace, chance qu'un engin démasqué explose malgré tout. */
export interface CheckpointDef {
  detect: number;
  detonate: number;
}

export interface BuildingDef {
  id: string;
  name: string;
  desc: string;
  category: string;
  /** Emprise [largeur en x, profondeur en y] en cases, rotation 0. */
  footprint: [number, number];
  rotatable: boolean;
  placement: {
    /** true : pose en ligne par glisser (murs, routes). */
    line: boolean;
    /** Terrains autorisés ; absent = tout terrain constructible. */
    allowedTerrain?: string[];
  };
  cost: ResourceBag;
  buildTimeMin: number;
  upkeepPerDay: ResourceBag;
  consumptionPerDay?: ResourceBag;
  productionPerDay?: ResourceBag;
  storage?: ResourceBag;
  provides?: Record<string, number>;
  /** Services utilisables par les agents, par identifiant de service (cf. activities.json). */
  services?: Record<string, ServiceDef>;
  /** Ressources que le personnel peut y déposer lors d'un déchargement (en plus du stockage). */
  acceptsCargo?: ResourceId[];
  /** Électricité consommée / produite (kW). */
  powerDemand?: number;
  powerSupply?: number;
  /** Usure gagnée par jour (0..1). */
  wearPerDay?: number;
  /** Améliorations successives (niveau 2, 3…). */
  levels?: BuildingLevelDef[];
  walkSpeedMult?: number;
  hp: number;
  /** Réputation minimale et prix en points de réputation (0 = disponible d'office). */
  unlock: { reputation: number; points?: number };
  light?: LightDef;
  /** Bâtiment à porte : on n'y entre que par le côté de l'entrée (qui tourne avec le bâtiment). */
  entrance?: boolean;
  /** Améliorations installables indépendamment (climatisation, antenne…). */
  modules?: BuildingModuleDef[];
  /** Bruit pendant l'utilisation : gêne le sommeil des occupants des logements à portée. */
  noise?: { radius: number; sleepMult: number; moralePerHour: number };
  /** Stock local à tenir approvisionné par le soutien : capacité et seuil de réapprovisionnement. */
  supplies?: Partial<Record<ResourceId, { capacity: number; refillBelow: number }>>;
  /** Cuisine : les cuisiniers y transforment les rations en repas chauds. */
  kitchen?: { mealCapacity: number };
  /** Se salit à l'usage (douches, latrines, réfectoire) ; le personnel de soutien nettoie. */
  cleaning?: { dirtPerUse: number };
  /** Point de retrait des matériaux de construction (entrepôt, zone de déchargement). */
  materialDepot?: boolean;
  /** Porte dans un mur : franchissable par le personnel (et les véhicules si portail), fermée à l'ennemi. */
  gate?: { vehicles: boolean; leaves: 1 | 2 };
  /** Minutes qu'il faut à un assaillant pour forcer ce bâtiment (porte enfoncée, mur soufflé à l'explosif). */
  breachMin?: number;
  /** Peut se poser à la place d'un tronçon de ce bâtiment (une porte dans un mur hesco). */
  replaces?: string;
  /** Poste de contrôle des civils entrant dans la base (cf. visitors.json → traffic). */
  checkpoint?: CheckpointDef;
  /** Débit de boissons : un autre bar à moins de `radius` cases augmente le risque d'alcoolisme. */
  alcohol?: { radius: number };
  visual: {
    key: string;
    style: VisualStyle;
    color: string;
    accent?: string;
    height: number;
    antenna?: boolean;
    markings?: 'parking' | 'helipad' | 'runway';
  };
}

// ---------------------------------------------------------------- Ravitaillement (Phase 3)

export type VehicleKind = 'road' | 'air' | 'base' | 'plane';

export interface VehicleDef {
  id: string;
  name: string;
  desc?: string;
  kind: VehicleKind;
  /** Véhicules de la base : chariot élévateur ou véhicule de patrouille (missions). */
  role?: 'forklift' | 'patrol' | 'attack' | 'transport';
  speed: number; // cases par minute de jeu
  capacity?: number; // palettes (unités de ressources)
  passengers?: number;
  pumpPerMinute?: number; // camions-citernes
  carryCapacity?: number; // chariot élévateur
  price?: number; // véhicules achetables
  upkeepPerDay?: ResourceBag;
  requires?: string; // bâtiment requis pour l'achat
  maxPerZone?: number;
  /** Protection des passagers en mission (multiplicateur du risque, 1 = aucune). */
  protection?: number;
  /** Avions : vitesse au roulage sur la piste et au taxi (cases/minute). */
  groundSpeed?: number;
  taxiSpeed?: number;
  /** Véhicules transportables en soute. */
  vehicleSlots?: number;
  /** Héliportage : vitesse de croisière (km/h), consommation relative, discrétion et assaut éclair. */
  heliSpeedKmh?: number;
  heliFuelMult?: number;
  /** Bonus de réussite d'une mission héliportée par cet appareil (approche discrète). */
  stealthBonus?: number;
  /** Multiplicateur de la durée sur l'objectif (assaut rapide). */
  objectiveMult?: number;
  /** Porteurs simultanés au déchargement (sinon valeur par défaut). */
  haulers?: number;
  visual: {
    style: 'truck' | 'tanker' | 'helicopter' | 'forklift' | 'mrap' | 'humvee' | 'c130' | 'a10' | 'cart' | 'attack_helo' | 'blackhawk' | 'chinook' | 'suv' | 'littlebird';
    /** Rotors (hélicoptères) : position le long du fuselage, hauteur du moyeu, rayon, nombre de pales. */
    rotors?: { u: number; z: number; radius: number; blades: number }[];
    /** Rotor de queue (absent sur les birotors en tandem) et sa position. */
    tailRotor?: boolean;
    tailRotorPos?: { u: number; z: number };
    /** Largeur en cases (envergure des avions), 1 par défaut. */
    width?: number;
    color: string;
    accent?: string;
    /** Couleur de la plaque de danger (camions-citernes). */
    placard?: string;
    /** Longueur en cases (2 par défaut) et hauteur du sprite en pixels. */
    length?: number;
    height?: number;
  };
}

export interface SupplyOrderDef {
  id: string;
  name: string;
  desc: string;
  vehicle: string;
  fee: number;
  delayHours: [number, number];
  risk: number;
  requires: string; // bâtiment de destination
  /** Ressources au choix (palettes) ; sinon cargaison fixe. */
  cargo?: ResourceId[];
  fixed?: ResourceBag;
  fixedPrice?: number;
  passengers?: boolean;
  /** Peut livrer des véhicules achetables (en soute). */
  vehicles?: boolean;
}

export interface RecruitDef {
  type: string;
  price: number;
  reputation: number;
  /** Personnel qui doit être présent à la base (ex. commandant des forces spéciales). */
  requires?: string;
  /** Nombre maximal à la base. */
  max?: number;
}

export interface SupplyConfig {
  unitPrices: ResourceBag;
  cargoStep: number;
  maxActiveOrders: number;
  orders: SupplyOrderDef[];
  recruits: RecruitDef[];
}

// ---------------------------------------------------------------- Personnel (Phase 2)

export interface PersonnelDef {
  id: string;
  name: string;
  routine: string; // → routines.json
  ranks: string[];
  /** Grades successifs du métier et XP requise (promotion automatique). */
  career: CareerStep[];
  walkSpeed: number; // cases par minute de jeu
  salaryPerDay: number;
  traitCount: [number, number];
  skills: Record<string, [number, number]>;
  visual: {
    color: string;
    accent?: string;
    helmet: boolean;
    /** Tenue et équipement dessinés (casque, gilet, gilet haute visibilité…). */
    kit?: 'infantry' | 'sf' | 'officer' | 'commander' | 'logistics' | 'cook' | 'medic' | 'contractor' | 'cia' | 'auxiliary';
    vest?: string;
    /** Couleur de l'insigne de rôle affiché au-dessus du personnage. */
    badge?: string;
  };
  /** Jeu de noms (par défaut : noms occidentaux). */
  names?: 'afghan';
  /** Corvées assurées pendant les heures de travail, par ordre de priorité (supply, cook, clean). */
  duties?: string[];
  /** Munitions individuelles emportées (unités) ; à recompléter au dépôt. */
  ammoCapacity?: number;
}

export interface SkillDef {
  id: string;
  name: string;
}

export interface TraitDef {
  id: string;
  name: string;
  desc: string;
  needDecay?: Partial<Record<NeedId, number>>;
  efficiency?: number;
  moraleBase?: number;
  moraleDrift?: number;
  skills?: Record<string, number>;
  xpMult?: number;
  incidentMult?: number;
}

export interface NeedDef {
  id: NeedId;
  name: string;
  decayPerHour: number;
  low: number;
  critical: number;
  lowEfficiency: number;
  criticalEfficiency: number;
  healthLossPerHourAtZero: number;
  color: string;
  /** Besoin satisfait automatiquement chaque heure si la ressource est disponible (ex. boire). */
  passive?: { consumesPerHour: ResourceBag; restorePerHour: number };
}

export interface IncidentDef {
  id: string;
  text: string;
  morale?: number;
  health?: number;
  resources?: ResourceBag;
}

export interface NeedsConfig {
  needs: NeedDef[];
  /** Activité qui satisfait chaque besoin actif. */
  needActivities: Partial<Record<NeedId, string>>;
  morale: {
    baseTarget: number;
    driftPerHour: number;
    bedBonus: number;
    noBedPenalty: number;
    lowNeedPenalty: number;
    criticalNeedPenalty: number;
  };
  health: { regenPerHour: number };
  incidents: { moraleThreshold: number; chancePerHour: number; types: IncidentDef[] };
}

export interface ActivityDef {
  id: string;
  name: string;
  /** Service de bâtiment requis ; à défaut on bascule sur `fallback`. */
  service?: string;
  /** Travail particulier (« build » : chantiers et réparations ; « haul » : décharger un véhicule). */
  work?: 'build' | 'haul' | 'defend' | 'deploy' | 'supply' | 'materials' | 'clean' | 'rearm' | 'gear' | 'march';
  /** Repas pris au réfectoire : consomme un repas préparé par les cuisiniers (sinon ration froide). */
  usesMeals?: boolean;
  /** Créneau de travail du soutien : l'agent enchaîne les corvées de sa spécialité (cf. personnel.duties). */
  chores?: boolean;
  /** Activité d'alerte (abri, défense) : terminée à la fin de l'attaque. */
  combat?: boolean;
  /** L'agent vient prêter main-forte quand un véhicule attend d'être déchargé. */
  helpUnload?: boolean;
  fallback?: string;
  /** L'agent disparaît à l'intérieur du bâtiment pendant l'activité. */
  inside: boolean;
  /** Se déplace vers un point aléatoire proche (détente, entraînement…). */
  wander?: boolean;
  /** need : durée fixe ; schedule : jusqu'au prochain changement d'emploi du temps (plafonné). */
  mode: 'need' | 'schedule';
  durationMin: number;
  effectsPerHour: Partial<Record<NeedId, number>>;
  consumes?: ResourceBag;
  /** Si l'activité a été déclenchée en urgence, elle s'arrête quand ce besoin est comblé. */
  endWhenFull?: NeedId;
  xpPerHour?: number;
  /** Activités spécialisées tentées d'abord (dans un ordre aléatoire) si leur service est libre. */
  options?: string[];
  /** Plage horaire autorisée [début, fin] (ex. pas de tir réel la nuit). */
  hours?: [number, number];
  /** Ressources consommées pendant l'activité (par heure et par agent). */
  consumesPerHour?: ResourceBag;
  /** Progression des compétences (points par heure, ralentie près du maximum). */
  skillsPerHour?: Record<string, number>;
  /** Service saturé : l'agent fait la queue devant le bâtiment (activité « queue ») avant de se rabattre sur le repli. */
  queue?: boolean;
}

export interface RoutineDef {
  id: string;
  name: string;
  shifts: number;
  hours: string[]; // 24 identifiants d'activité
}

export interface NamesDef {
  first: string[];
  last: string[];
  afghanFirst?: string[];
  afghanLast?: string[];
}

export interface StartingGroupDef {
  group: string;
  kind: GroupKind;
  members: { type: string; count: number }[];
}

export interface TerrainBand {
  terrain: string;
  max: number;
}

export interface SiteTerrainParams {
  noiseScale: number;
  edgeRock: number;
  clearRadius: number;
  bands: TerrainBand[];
}

export interface SiteDef {
  id: string;
  name: string;
  desc: string;
  pros: string[];
  cons: string[];
  startResources: ResourceBag;
  budgetMult: number;
  /** Taille du périmètre initial (centré sur la carte). */
  zone: { width: number; height: number };
  /** Bord de carte d'où arrivent les convois. */
  entry: { side: 'north' | 'south' | 'east' | 'west' };
  /** Multiplicateur du risque d'embuscade sur la route. */
  roadRisk: number;
  /** Multiplicateur de la fréquence des attaques contre la base. */
  threat: number;
  /** Position de la FOB sur la carte régionale (km). */
  regionPos: { x: number; y: number };
  terrain: SiteTerrainParams;
}

/** Expérience gagnée hors activités, et effets d'une promotion. */
export interface CareerConfig {
  missionFailureXp: number;
  missionWoundedXp: number;
  combatSurvivedXp: number;
  killXp: number;
  checkpointCatchXp: number;
  promotionMorale: number;
  promotionSkills: Record<string, number>;
}

/** Besoin de la base proportionnel à l'effectif : places d'un service ou spécialistes. */
export interface RequirementDef {
  id: string;
  name: string;
  service?: string[];
  personnel?: string;
  perAgents: number;
  minHeadcount: number;
  moralePenalty: number;
  hygieneDecayMult?: number;
  advice: string;
}

/** Grade d'une carrière et XP requise pour l'atteindre. */
export interface CareerStep {
  rank: string;
  xp: number;
}

export interface BalanceDef {
  time: {
    ticksPerSecondAtX1: number;
    minutesPerTick: number;
    startHour: number;
    speeds: GameSpeed[];
    maxTicksPerFrame: number;
  };
  map: { width: number; height: number; tileWidth: number; tileHeight: number };
  zone: { step: number; baseCost: number; costGrowth: number };
  build: {
    refundRatio: number;
    refundRatioUnderConstruction: number;
    /** Vitesse d'un chantier sans ouvrier (équipe locale), en fraction de la vitesse nominale. */
    baseCrewRate: number;
    /** Vitesse ajoutée par ouvrier pleinement efficace. */
    workerRate: number;
    maxWorkersPerSite: number;
  };
  /** Logistique interne : ravitaillement des bâtiments, cuisine, nettoyage, matériaux de chantier. */
  logistics: {
    carryCapacity: number;
    pickupMinutes: number;
    dropMinutes: number;
    mealsPerCookHour: number;
    foodPerMeal: number;
    cookBelow: number;
    cleanPerHour: number;
    cleanBelow: number;
    dirtyBelow: number;
    dirtyMoralePerHour: number;
    materials: { fundsPerUnit: number; maxUnits: number; perTrip: number; maxFetchersPerSite: number };
    /** Recomplètement des munitions individuelles sous cette fraction (hors combat). */
    rearmBelow: number;
    rearmMinutes: number;
    gearMinutes: number;
    /** Qualité d'un repas préparé par un soldat sans être cuisinier. */
    amateurMealQuality: number;
  };
  agents: {
    pathRequestsPerTick: number;
    maxPathNodes: number;
    wanderRadius: number;
    spawnSpread: number;
    minWalkSpeedFactor: number;
    mealsPerDayEstimate: number;
    hygienePerDayEstimate: number;
  };
  supply: {
    pickupMinutes: number;
    dropMinutes: number;
    carryCapacity: number;
    maxHaulersPerVehicle: number;
    blockedRetryTicks: number;
    maxWaitHours: number;
    maxUnloadHours: number;
    ambushLoss: [number, number];
    ambushDelayHours: number;
  };
  power: { unpoweredServiceFactor: number };
  wear: {
    damagedAt: number;
    disabledAt: number;
    repairStartAt: number;
    repairDoneAt: number;
    repairPerHourPerWorker: number;
    partsPerWear: number;
    workshopRepairMult: number;
  };
  command: {
    weights: { morale: number; housing: number; guard: number; supply: number };
    guardPostsWanted: number;
    reputationPerPoint: number;
    budgetMin: number;
    budgetMax: number;
  };
  startingForce: StartingGroupDef[];
  economy: { dailyBudget: number; lowStockDays: number; baseCapacity: ResourceBag };
  progression: {
    startReputation: number;
    startPoints?: number;
    pointsPerDay?: number;
    pointsMissionSuccess?: number;
    pointsMissionPartial?: number;
    pointsProject?: number;
  };
  career: CareerConfig;
  requirements: { maxPenalty: number; graceDays: number; items: RequirementDef[] };
  /** Incidents liés à l'alcool autour des bars trop rapprochés. */
  leisure: { basePerHour: number; perNeighbourPerHour: number; brawlHealth: [number, number]; hangoverSleep: number; damageParts: number };
  save: { slots: number; autosaveEveryDays: number; storagePrefix: string };
  camera: {
    minZoom: number;
    maxZoom: number;
    zoomStep: number;
    startZoom: number;
    panSpeed: number;
    edgeScroll: boolean;
    edgeSize: number;
  };
  log: { maxEntries: number };
}

/** Contenu brut tel que lu dans les JSON, avant validation. */
export interface RawContent {
  buildings: unknown;
  categories: unknown;
  terrain: unknown;
  resources: unknown;
  sites: unknown;
  balance: unknown;
  personnel: unknown;
  skills: unknown;
  traits: unknown;
  needs: unknown;
  activities: unknown;
  routines: unknown;
  names: unknown;
  vehicles: unknown;
  supply: unknown;
  events: unknown;
  combat: unknown;
  region: unknown;
  missions: unknown;
  radio: unknown;
  diplomacy: unknown;
  campaign: unknown;
  ambience: unknown;
  settings: unknown;
  audio: unknown;
  tutorial: unknown;
  visitors: unknown;
  equipment: unknown;
}

// ---------------------------------------------------------------- Finitions (Phase 8)

export interface AmbienceKeyframe {
  hour: number;
  color: string;
  night: number;
}

export interface LightFx {
  radius: number;
  color: string;
  durationMs?: number;
  ahead?: number;
}

export interface AmbienceDef {
  keyframes: AmbienceKeyframe[];
  glowAlpha: number;
  flicker: number;
  headlights: LightFx;
  explosion: LightFx;
  muzzle: LightFx;
  cannon: LightFx;
  /** Projecteurs des tours de garde occupées la nuit (portée en cases, demi-angle du faisceau). */
  searchlight?: { length: number; color: string; sweep: number };
  /** Lampe au-dessus des portes des bâtiments alimentés. */
  doorLamp?: { radius: number; color: string };
  /** Assombrissement des bords de l'écran la nuit (0..1). */
  vignette?: number;
}

export interface TutorialStepDef {
  id: string;
  title: string;
  text: string;
  highlight?: string;
  done: { type: 'ack' | 'building' | 'event'; defId?: string; count?: number; event?: string };
}

export interface TutorialDef {
  steps: TutorialStepDef[];
}

export interface SoundLayer {
  type: 'tone' | 'noise';
  wave?: OscillatorType;
  freq?: number;
  freqEnd?: number;
  dur: number;
  attack?: number;
  gain: number;
  delay?: number;
  filter?: { type: BiquadFilterType; freq: number; freqEnd?: number; q?: number };
}

export interface SoundDef {
  cat: 'sfx' | 'radio' | 'ui';
  minGapMs?: number;
  repeat?: number;
  interval?: number;
  layers: SoundLayer[];
}

export interface AudioDef {
  maxVoices: number;
  hearingTiles: number;
  mapMuffle: number;
  sounds: Record<string, SoundDef>;
  events: Record<string, string>;
  ambient: {
    wind: { gain: number; filterFreq: number; gustEverySec: number };
    crickets: { gain: number; freq: number; everySec: number };
    generator: { gain: number; freq: number };
    nightFrom: number;
    nightTo: number;
  };
}

export interface SettingOptionDef {
  id: string;
  group: string;
  type: 'slider' | 'toggle';
  label: string;
  min?: number;
  max?: number;
  step?: number;
  default: number | boolean;
}

export interface SettingsDef {
  storageKey: string;
  groups: { id: string; label: string }[];
  options: SettingOptionDef[];
}

/** Source de lumière d'un bâtiment (la nuit). */
export interface LightDef {
  radius: number; // cases
  color: string;
  power?: boolean; // éteinte sans électricité
  /** Rangée de feux le long du grand axe (espacement en cases), par exemple un balisage de piste. */
  spacing?: number;
}

// ---------------------------------------------------------------- Géopolitique (Phase 7)

export interface StanceDef {
  id: string;
  max: number;
  label: string;
  color: string;
}

export interface InsurgentTemplate {
  kind: string;
  label: string;
  drift: number;
  weight: number;
}

export interface DiplomacyConfig {
  stances: StanceDef[];
  attitudeMemoryPerDay: number;
  needBonus: number;
  influencePressure: number;
  influenceAttitudePerDay: number;
  influenceAttitudeAbove: number;
  contactInfluenceKm: number;
  contactInfluencePerDay: Record<string, number>;
  influenceMemoryPerDay: number;
  contactPressureMult: number;
  favorableReliefPerDay: number;
  patrolMemoryDays: number;
  patrolInfluencePerDay: number;
  checkpointInfluencePerDay: number;
  shura: {
    base: number;
    attitudeWeight: number;
    reputationWeight: number;
    influenceWeight: number;
    metBonus: number;
    successAttitude: number;
    failureAttitude: number;
    revealKm: number;
    revealChance: number;
    cooldownDays: number;
  };
  promise: {
    days: number;
    attitude: number;
    keptAttitude: number;
    keptReputation: number;
    brokenAttitude: number;
    brokenReputation: number;
    brokenInfluence: number;
    refuseAttitude: number;
    demandHours: number;
  };
  sabotage: { influenceAbove: number; chancePerDay: number; attitude: number };
  roadRisk: { min: number; max: number; roadKm: number; projectMult: number };
  threat: { min: number; max: number; nearKm: number };
  budget: { min: number; max: number };
  stability: {
    weights: { attitude: number; influence: number; enemy: number; incidents: number };
    enemyStrengthScale: number;
    smoothing: number;
    historyDays: number;
  };
  incidents: {
    initial: number;
    decayPerDay: number;
    attack: number;
    kia: number;
    collateral: number;
    missionFailure: number;
    missionSuccess: number;
    brokenPromise: number;
    sabotage: number;
    hqNeutralized: number;
    contactNeutralized: number;
  };
  auxiliary: {
    type: string;
    minAttitude: number;
    per1000: number;
    maxPerVillage: number;
    price: number;
    attitudeCost: number;
    infiltrationBase: number;
    infiltrationPerInfluence: number;
    insiderEvent: string;
    insiderDelayHours: [number, number];
  };
  insurgency: {
    spawnChancePerDay: number;
    minAverageInfluence: number;
    maxContacts: number;
    spawnKm: [number, number];
    templates: InsurgentTemplate[];
  };
}

export interface DiploActionDef {
  id: string;
  name: string;
  desc: string;
  cost: ResourceBag;
  requiresPersonnel?: string;
  requiresLeader?: boolean;
  attitude?: number;
  influence?: number;
  reputation?: number;
  shura?: boolean;
  cooldownDays: number;
}

export interface ProjectDef {
  id: string;
  name: string;
  need: string;
  desc: string;
  cost: ResourceBag;
  days: number;
  attitude: number;
  influence: number;
  roadSafety?: boolean;
  checkpoint?: boolean;
}

export interface DiplomacyDef {
  config: DiplomacyConfig;
  actions: DiploActionDef[];
  projects: ProjectDef[];
}

export type CampaignObjectiveType =
  | 'stability'
  | 'villagesAttitude'
  | 'villagesInfluence'
  | 'missionsSuccess'
  | 'projects'
  | 'promisesKept'
  | 'auxiliaries'
  | 'contactsNeutralized'
  | 'neutralize'
  | 'reputation';

export interface CampaignObjectiveDef {
  id: string;
  type: CampaignObjectiveType;
  text: string;
  min?: number;
  max?: number;
  count?: number;
  contact?: string;
}

export interface CampaignPhaseDef {
  id: string;
  name: string;
  brief: string;
  days: number;
  objectives: CampaignObjectiveDef[];
  rewards: { funds?: number; reputation?: number; points?: number };
  penalty: { reputation?: number; graceDays: number };
}

export interface CampaignDef {
  phases: CampaignPhaseDef[];
  defeat: { stabilityBelow: number; days: number; warnBelow: number };
  texts: Record<'phaseDone' | 'phaseNext' | 'phaseMissed' | 'victory' | 'defeat' | 'lowStability', string>;
}

// ---------------------------------------------------------------- Missions et radio (Phase 6)

export interface MissionEffects {
  funds?: number;
  reputation?: number;
  villageAttitude?: number;
  villageInfluence?: number;
  intelTarget?: number;
  revealRadiusKm?: number;
  neutralize?: boolean;
  escort?: boolean;
  clearIed?: boolean;
  meet?: boolean;
  enemyKilled?: [number, number];
}

export interface MissionTypeDef {
  id: string;
  name: string;
  desc: string;
  targets: ('contact' | 'village' | 'fob' | 'sector' | 'site')[];
  contactKinds?: string[];
  requires?: { leader?: boolean; routine?: string; sf?: number };
  minMembers: number;
  maxMembers: number;
  objectiveHours: number;
  difficulty: number;
  influenceDifficulty?: boolean;
  risk: number;
  skills: Record<string, number>;
  specialistBonus?: Record<string, number>;
  rewards: { success: MissionEffects; partial: MissionEffects; failure: MissionEffects };
  texts: { success: string; partial: string; failure: string };
}

export interface LoadoutDef {
  id: string;
  name: string;
  desc: string;
  consumes: ResourceBag;
  success: number;
  casualty: number;
  speed: number;
}

export interface MissionsConfig {
  config: {
    footSpeedKmh: number;
    vehicleSpeedKmh: number;
    vehicleCapacity: number;
    minHealth: number;
    assemblyTimeoutMin: number;
  /** Durée du briefing au TOC avant le départ (minutes). */
  briefingMin?: number;
    fuelPerKmPerVehicle: number;
    vehicleProtection: number;
    vehicleSuccessBonus: number;
    estimateSpread: number;
    maxActive: number;
    kiaShare: number;
    successMorale: number;
    kiaMorale: number;
    escortHours: number;
    escortRiskMult: number;
    xpSuccess: number;
    xpPartial: number;
    abortSuccessMult: number;
    collateralReputation: number;
    collateralAttitude: number;
    toc: { officersPerMission: number; understaffedPenalty: number; staffedBonus: number; officerTypes: string[] };
    comms: { baseRangeKm: number; noTocRangeKm: number; penaltyPer10Km: number; maxPenalty: number };
    heli: { speedKmh: number; fuelPerKm: number };
  };
  callsigns: string[];
  loadouts: LoadoutDef[];
  types: MissionTypeDef[];
  support: SupportDef[];
}

/** Appui feu d'une mission (artillerie de la base, A-10, AC-130). */
export interface SupportDef {
  id: string;
  name: string;
  desc: string;
  requires?: string;
  rangeKm?: number;
  cost: ResourceBag;
  success?: number;
  casualty?: number;
  collateral?: number;
  cooldownHours?: number;
  /** Plage horaire de disponibilité [début, fin] (peut passer minuit). */
  hours?: [number, number];
  /** Avion qui survole la base au départ (vehicles.json). */
  flyover?: string;
  /** Salves tirées depuis la base (artillerie). */
  salvos?: number;
  /** Appareil de la base engagé (hélicoptère de combat), qui part et revient avec la mission. */
  vehicle?: string;
}

export interface RadioEffects {
  success?: number;
  casualty?: number;
  duration?: number;
  abort?: boolean;
  /** Blesse immédiatement ce nombre de membres de l'unité. */
  wound?: number;
  /** Moral de toute la base. */
  morale?: number;
  /** Expérience gagnée par chaque membre. */
  xp?: number;
  /** Pertes infligées au groupe ennemi concerné (0..1 de ses effectifs ; détruit à zéro). */
  enemyDamage?: number;
  /** Position du groupe ennemi concerné transmise au TOC avec cette fiabilité. */
  revealEnemy?: number;
  cost?: ResourceBag;
  resources?: ResourceBag;
  reputation?: number;
  villageAttitude?: number;
  villageInfluence?: number;
  reveal?: 'nearest';
  revealRadiusKm?: number;
  collateral?: number;
}

/** Situation compatible avec l'unité et le contexte (toutes les conditions données doivent être vraies). */
export interface RadioConditions {
  night?: boolean;
  /** Unité en véhicules (convoi motorisé). */
  motorized?: boolean;
  /** Unité héliportée. */
  heli?: boolean;
  /** Unité à pied (ni véhicule ni hélicoptère). */
  onFoot?: boolean;
  targetKind?: ('contact' | 'village' | 'fob' | 'sector' | 'site')[];
  minTeam?: number;
  /** Au moins un membre de l'un de ces types (medic, sf, cia, auxiliary…). */
  hasType?: string[];
  /** Appui feu engagé parmi ceux-ci. */
  support?: string[];
  /** Attitude du village visé (ou du plus proche). */
  attitudeBelow?: number;
  attitudeAbove?: number;
  /** Un vrai groupe ennemi (de ces types) se trouve à moins de tant de km de l'unité. */
  enemyNearKm?: number;
  enemyKinds?: string[];
}

/** Ordre possible seulement si l'unité en a les moyens. */
export interface RadioRequires {
  types?: string[];
  vehicles?: boolean;
  heli?: boolean;
  support?: string[];
  gear?: string;
  night?: boolean;
  minTeam?: number;
}

/** Issue tirée au hasard d'un ordre : les « bonnes » sont favorisées par la compétence de l'équipe. */
export interface RadioOutcomeDef {
  weight?: number;
  kind?: 'good' | 'bad';
  log: string;
  effects?: RadioEffects;
  /** Message radio de suite, reçu après ce délai (minutes de jeu). */
  followUp?: { radio: string; delayMin: number };
}

export interface RadioChoiceDef {
  id: string;
  text: string;
  effects: RadioEffects;
  /** Compte rendu (sans issues aléatoires). */
  log: string;
  requires?: RadioRequires;
  /** Compétence de l'équipe qui pèse sur l'issue (shooting, medical, stealth, radio, leadership, mechanics). */
  skill?: string;
  outcomes?: RadioOutcomeDef[];
  followUp?: { radio: string; delayMin: number };
}

export interface RadioMessageDef {
  id: string;
  phases: ('outbound' | 'objective' | 'inbound')[];
  types: string[];
  requiresVehicles?: boolean;
  /** Conditions de contexte (nuit, motorisé, médecin dans l'équipe, village hostile…). */
  when?: RadioConditions;
  /** Reçu seulement comme suite d'un autre message. */
  followUpOnly?: boolean;
  weight: number;
  text: string;
  choices: RadioChoiceDef[];
}

export interface RadioConfig {
  /** Listes de mots tirés au hasard pour les variables {nom} des textes. */
  pools?: Record<string, string[]>;
  messages: RadioMessageDef[];
}

// ---------------------------------------------------------------- Carte régionale (Phase 5)

export interface Km {
  x: number;
  y: number;
}

export interface MountainDef {
  name: string;
  x: number;
  y: number;
  rx: number;
  ry: number;
  h: number;
}

export interface PolylineDef {
  name?: string;
  type?: 'highway' | 'track';
  width?: number;
  points: [number, number][];
}

export type MapIcon = 'hq' | 'infantry' | 'mortar' | 'ied' | 'camp' | 'cache' | 'installation' | 'police' | 'mechanized';

export interface ContactKindDef {
  label: string;
  icon: MapIcon;
  echelon: string;
  /** Difficulté ajoutée pour les missions visant ce type de contact. */
  strength: number;
  /** Ce qu'une unité voit de ce groupe (textes des rencontres). */
  sightings?: string[];
}

/** Lieu d'intérêt de la carte (grottes, fort, campement nomade…). */
export interface SiteKindDef {
  label: string;
  code: string;
  hideout?: boolean;
  desc: string;
  visit: { revealKm?: number; cacheChance?: number; ammo?: [number, number]; attitude?: number; influence?: number; clearIedKm?: number };
}

export interface MapSiteDef {
  id: string;
  kind: string;
  name: string;
  pos: Km;
}

/** Comportement des groupes ennemis mobiles et des rencontres. */
export interface BehaviourDef {
  cell: { speedKmh: number; rangeKm: number; restHours: [number, number]; approachChance: number; approachKm: [number, number]; approachHours: [number, number] };
  mortar: { speedKmh: number; rangeKm: number; firingKm: [number, number]; firingHours: [number, number]; hideHours: [number, number] };
  ied: { speedKmh: number; rangeKm: number; roadKm: number; plantHours: number; hideHours: [number, number]; iedLifeHours: number; maxIeds: number };
  encounter: {
    footKm: number;
    motorizedKm: number;
    iedKm: number;
    checkEveryMin: number;
    ourBase: number;
    theirBase: number;
    nightPenalty: number;
    enemyNightPenalty: number;
    motorizedExposure: number;
    heliExposure: number;
    knownBonus: number;
    sweepBonus: number;
    gear: Record<string, { night?: number; day?: number }>;
    ambushCasualty: number;
    spottedSuccess: number;
    iedFindBase: number;
    targetMovedKm: number;
    targetMovedSuccess: number;
  };
}

/** Acteurs du monde : patrouilles alliées et circulation civile. */
export interface WorldDef {
  allied: Record<string, { label: string; indef?: string; speedKmh: number; power: number; patrolKm: number; restHours: [number, number]; spawnChancePerHour: number }>;
  civilians: { max: number; spawnChancePerHour: number; kinds: Record<string, { label: string; indef?: string; speedKmh: number; weight: number }> };
  encounterKm: number;
  intelKm: number;
  incidentHours: number;
  visibleKm: number;
}

export interface VillageDef {
  id: string;
  name: string;
  type: 'village' | 'town' | 'hamlet';
  pos: Km;
  population: number;
  tribe: string;
  leader: string | null;
  attitude: number;
  influence: number;
  needs: string[];
  desc: string;
}

export interface PersonalityDef {
  id: string;
  name: string;
  role: string;
  village: string;
  stance: 'friendly' | 'neutral' | 'hostile';
  known: boolean;
  desc: string;
  portrait: PortraitDef;
}

export interface FriendlyUnitDef {
  id: string;
  name: string;
  faction: 'friendly' | 'allied';
  icon: MapIcon;
  echelon: string;
  pos: Km;
}

export interface ContactDef {
  id: string;
  kind: string;
  label: string;
  pos: Km;
  drift: number;
  known?: boolean;
  reliability?: number;
}

export interface IntelConfig {
  observationKm: number;
  perTowerKm: number;
  maxObservationKm: number;
  informantAttitude: number;
  villageCoverKm: number;
  villageReportKm: number;
  villageReportChance: number;
  decayPerDay: number;
  errorGrowthPerDay: number;
  lostBelow: number;
  tocRefine: number;
  tocMinHours: number;
  ciaBonus: number;
  ciaRevealKm: number;
  attackRevealReliability: number;
  eventRevealReliability: number;
}

export interface RegionDef {
  name: string;
  province: string;
  size: { width: number; height: number };
  gridKm: number;
  seed: number;
  relief: {
    baseSouth: number;
    baseNorth: number;
    noiseAmp: number;
    noiseScaleKm: number;
    riverCarve: number;
    riverCarveKm: number;
    contourStep: number;
    indexContour: number;
    fieldsKm: number;
  };
  mountains: MountainDef[];
  rivers: PolylineDef[];
  roads: PolylineDef[];
  contactKinds: Record<string, ContactKindDef>;
  villages: VillageDef[];
  personalities: PersonalityDef[];
  friendlyUnits: FriendlyUnitDef[];
  contacts: ContactDef[];
  intel: IntelConfig;
  behaviour: BehaviourDef;
  siteKinds: Record<string, SiteKindDef>;
  sites: MapSiteDef[];
  world: WorldDef;
}

// ---------------------------------------------------------------- Événements (Phase 4)

export interface PortraitDef {
  skin: string;
  hair: string;
  beard: 'none' | 'stubble' | 'short' | 'long' | 'mustache';
  beardColor?: string;
  headwear: 'none' | 'turban' | 'pakol' | 'helmet' | 'cap' | 'patrol_cap' | 'headscarf';
  headwearColor?: string;
  clothes: string;
  accessory?: 'none' | 'glasses' | 'press' | 'medic';
}

export interface SpeakerDef {
  name?: string;
  /** Personnalité de la carte régionale incarnée (devient « connue » et « rencontrée »). */
  personality?: string;
  /** Le nom est pris parmi les agents de ces types (ex. une sentinelle). */
  fromAgent?: string[];
  role: string;
  portrait: PortraitDef;
}

export interface EventConditions {
  minDay?: number;
  maxDay?: number;
  minReputation?: number;
  maxReputation?: number;
  minAgents?: number;
  requiresBuilding?: string;
  flag?: string;
  notFlag?: string;
  resourceBelow?: ResourceBag;
  resourceAbove?: ResourceBag;
  /** Plage horaire [début, fin] (peut passer minuit). */
  hours?: [number, number];
  /** Un auxiliaire infiltré est présent dans la base. */
  infiltrator?: boolean;
  /** Un groupe ennemi de ce type est arrivé en position près de la FOB (mortier en batterie…). */
  enemyInPosition?: string;
  /** Un engin explosif a été posé à moins de tant de km de la FOB. */
  iedNearKm?: number;
}

export interface EventEffects {
  resources?: ResourceBag;
  reputation?: number;
  morale?: number;
  injure?: { count: number; amount: number };
  setFlags?: Record<string, boolean | number>;
  clearFlags?: string[];
  chain?: { event: string; delayHours: number };
  attack?: string;
  attackMode?: 'shelter' | 'engage';
  recruits?: { type: string; count: number }[];
  delayOrders?: number;
  wear?: number;
  /** Variation d'attitude / d'emprise insurgée d'un village. */
  village?: { id: string; attitude?: number; influence?: number };
  /** Renseignement : révèle le contact ennemi caché le plus proche de la base. */
  intel?: 'nearest';
  /** Un besoin du village est satisfait (projet financé par un événement). */
  satisfyNeed?: { village: string; need: string };
  /** Sort de l'auxiliaire infiltré : démasqué, passage à l'acte ou désertion. */
  insider?: { action: 'expose' | 'strike' | 'desert'; attitude?: number };
}

export interface EventOutcomeDef {
  weight?: number;
  if?: { ratingAbove?: number; ratingBelow?: number; flag?: string; notFlag?: string };
  text: string;
  effects?: EventEffects;
}

export interface EventChoiceDef {
  id: string;
  text: string;
  requires?: { building?: string; minReputation?: number; flag?: string };
  /** Effets immédiats du choix (coûts) ; les ressources négatives doivent être disponibles. */
  effects?: EventEffects;
  outcomes: EventOutcomeDef[];
}

export type EventCategory = 'visit' | 'threat' | 'personnel' | 'environment' | 'logistics' | 'attack';

export interface EventDef {
  id: string;
  title: string;
  category: EventCategory;
  /**
   * Village concerné, tiré au hasard à l'ouverture selon son attitude (variable {village},
   * et « $village » dans les effets) : tout village, ami, hostile, neutre ou sous emprise insurgée.
   */
  village?: 'any' | 'friendly' | 'hostile' | 'neutral' | 'influenced';
  trigger?: 'random' | 'chain';
  weight: number;
  cooldownDays?: number;
  once?: boolean;
  conditions?: EventConditions;
  speaker: string;
  text: string;
  choices: EventChoiceDef[];
  /** Visite physique : la délégation vient à la base avant l'ouverture du dialogue. */
  visit?: EventVisitDef;
}

export interface EventVisitDef {
  mode: 'foot' | 'cart' | 'vehicle' | 'helicopter';
  vehicle?: string;
  leader: string; // → visitors.json visuals
  escort: { visual: string; count: number }[];
  stayMinutes: number;
}

export type ModuleVisual = 'ac' | 'sandbags' | 'mast' | 'dish' | 'servers' | 'chimney' | 'roof_tank' | 'redcross';

/** Amélioration installable sur un bâtiment. */
export interface BuildingModuleDef {
  id: string;
  name: string;
  desc: string;
  cost: ResourceBag;
  buildTimeMin: number;
  /** Élément visible ajouté sur le bâtiment. */
  visual?: ModuleVisual;
  /** Autre amélioration du même bâtiment requise. */
  requires?: string;
  powerDemand?: number;
  upkeepPerDay?: ResourceBag;
  /** Effets supplémentaires (par heure) pour les agents qui utilisent ce service ici. */
  serviceEffects?: Record<string, Partial<Record<NeedId, number>>>;
  /** Bonus de moral visé pour les occupants (tente où ils dorment). */
  residentMorale?: number;
  /** Part des dégâts d'explosion évités par les occupants et le bâtiment. */
  blastProtection?: number;
  comms?: { rangeKm?: number; global?: boolean; success?: number };
  intel?: { refine?: number; extraAnalysis?: number };
  healingMult?: number;
  /** Multiplicateur de la progression des compétences pour les agents qui s'y entraînent. */
  skillMult?: number;
  /** Multiplicateur du rayon de bruit du bâtiment. */
  noiseMult?: number;
}

export interface EquipmentItemDef {
  id: string;
  name: string;
  short: string;
  desc: string;
  price: number;
  mission?: { success?: number; night?: number; nightCasualty?: number };
  combat?: { hitMult?: number; night?: number; spot?: number };
}

export interface EquipmentDef {
  storageBuilding: string;
  eligible: string[];
  nightHours: [number, number];
  items: EquipmentItemDef[];
}

export interface VisitorVisual {
  color: string;
  accent?: string;
  helmet?: boolean;
  headwear?: 'turban' | 'pakol' | 'headscarf' | 'cap' | 'none';
  beard?: string;
  rifle?: boolean;
}

export type ThreatKind = 'gunman' | 'vest' | 'vbied';

export interface BlastDef {
  radius: number;
  agentDamage: [number, number];
  buildingDamage: [number, number];
}

/** Va-et-vient des civils fouillés au poste de garde, et menaces cachées parmi eux. */
export interface TrafficDef {
  hours: [number, number];
  intervalMin: [number, number];
  maxEntrants: number;
  graceDays: number;
  threatChance: number;
  searchMin: { foot: number; vehicle: number };
  stayMin: [number, number];
  approachCells: { foot: number; vehicle: number };
  detainMin: number;
  detectNoPost: number;
  unmannedMult: number;
  vehicleChance: number;
  vehicles: string[];
  walkers: string[];
  threats: Record<ThreatKind, { weight: number; foot: boolean }>;
  vest: BlastDef & { triggerAgents: number; waitMin: number };
  vbied: BlastDef;
  caughtBlastMult: number;
  reward: Record<ThreatKind, { funds: number; morale: number }>;
  missedMorale: number;
  pressure: PressureDef;
}

/** Pression ennemie autour de la FOB et ses effets sur les infiltrations. */
export interface PressureDef {
  nearKm: number;
  contactKm: number;
  contactWeights: Record<string, number>;
  contactsFull: number;
  influenceShare: number;
  freqMult: [number, number];
  powerMult: [number, number];
  stealth: [number, number];
  gunmen: [number, number];
  /** Seuils des niveaux faible / moyenne / forte. */
  levels: [number, number];
}

export interface VisitorsDef {
  config: { walkSpeed: number; meetBuilding: string; wanderEveryMin: number; wanderRadius: number; heliVehicle: string; maxWaitHours: number };
  traffic: TrafficDef;
  visuals: Record<string, VisitorVisual>;
}

export interface EventsConfig {
  config: { chancePerHour: number; minGapHours: number; attackGapHours: number };
  /** Listes de mots tirés au hasard pour les variables {nom} des textes. */
  pools?: Record<string, string[]>;
  speakers: Record<string, SpeakerDef>;
  events: EventDef[];
}

// ---------------------------------------------------------------- Combat (Phase 4)

export interface EnemyDef {
  id: string;
  name: string;
  health: number;
  skill: [number, number];
  speed: number;
  range: number;
  visual: { color: string; accent?: string; headwear: 'turban' | 'pakol' | 'none' };
}

export interface AttackDef {
  type: 'indirect' | 'ground';
  name: string;
  shells?: [number, number];
  intervalMin?: [number, number];
  radius?: number;
  buildingDamage?: [number, number];
  agentDamage?: [number, number];
  enemies?: [number, number];
  durationMin?: number;
  /** Les assaillants cherchent à entrer dans la base (brèches, portes et murs forcés). */
  penetrate?: boolean;
}

export interface CombatConfig {
  config: {
    shotCooldown: [number, number];
    baseHitChance: number;
    nightHitMult: number;
    floodlightsWanted: number;
    heli: { burstMin: [number, number]; damage: [number, number]; ammoPerBurst: number; range: number; counterBatteryChance: number };
    artillery: {
      intervalMin: [number, number];
      ammoPerSalvo: number;
      damage: [number, number];
      radius: number;
      dangerClose: number;
      counterBatteryChance: number;
      flightTicks: number;
    };
    coverMult: number;
    proneMult: number;
    towerBonus: number;
    towerRangeBonus: number;
    defenderRange: number;
    ammoPerShot: number;
    damage: [number, number];
    buildingDamagePerHit: number;
    retreatAtLosses: number;
    spawnDistance: number;
    fearMorale: number;
    victoryMorale: number;
    lossMorale: number;
    spotChancePerImpact: number;
    spotEngageMult: number;
    insideProtection: number;
    proneProtection: number;
    healingMult: number;
    medicalPerHealHour: number;
  };
  enemies: EnemyDef[];
  attacks: Record<string, AttackDef>;
}
