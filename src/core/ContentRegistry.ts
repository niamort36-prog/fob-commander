/**
 * ContentRegistry — charge, valide et indexe tout le contenu JSON.
 * Immuable après construction : les systèmes y lisent les définitions, jamais l'inverse.
 */
import buildingsJson from '../data/buildings.json';
import categoriesJson from '../data/categories.json';
import terrainJson from '../data/terrain.json';
import resourcesJson from '../data/resources.json';
import sitesJson from '../data/sites.json';
import balanceJson from '../data/balance.json';
import personnelJson from '../data/personnel.json';
import skillsJson from '../data/skills.json';
import traitsJson from '../data/traits.json';
import needsJson from '../data/needs.json';
import activitiesJson from '../data/activities.json';
import routinesJson from '../data/routines.json';
import namesJson from '../data/names.json';
import vehiclesJson from '../data/vehicles.json';
import supplyJson from '../data/supply.json';
import eventsJson from '../data/events.json';
import combatJson from '../data/combat.json';
import regionJson from '../data/region.json';
import missionsJson from '../data/missions.json';
import radioJson from '../data/radio.json';
import diplomacyJson from '../data/diplomacy.json';
import campaignJson from '../data/campaign.json';
import ambienceJson from '../data/ambience.json';
import settingsJson from '../data/settings.json';
import audioJson from '../data/audio.json';
import tutorialJson from '../data/tutorial.json';
import visitorsJson from '../data/visitors.json';
import equipmentJson from '../data/equipment.json';
import { validateContent } from '../utils/validate';
import type { NeedId, ResourceId } from './GameState';
import type {
  ActivityDef,
  BalanceDef,
  AmbienceDef,
  AudioDef,
  TutorialDef,
  VisitorsDef,
  EquipmentDef,
  SettingsDef,
  BuildingDef,
  CampaignDef,
  CategoryDef,
  DiploActionDef,
  DiplomacyDef,
  ProjectDef,
  CombatConfig,
  EnemyDef,
  EventDef,
  EventsConfig,
  RegionDef,
  MissionsConfig,
  MissionTypeDef,
  RadioConfig,
  RadioMessageDef,
  NamesDef,
  NeedDef,
  NeedsConfig,
  PersonnelDef,
  RawContent,
  ResourceDef,
  RoutineDef,
  SiteDef,
  SkillDef,
  SupplyConfig,
  SupplyOrderDef,
  TerrainDef,
  TraitDef,
  VehicleDef,
} from './ContentTypes';

export class ContentError extends Error {
  constructor(readonly errors: string[]) {
    super(`Contenu de jeu invalide (${errors.length} erreur(s)) :\n- ${errors.join('\n- ')}`);
    this.name = 'ContentError';
  }
}

/** Recherche par identifiant avec message d'erreur explicite. */
function indexById<T extends { id: string }>(items: readonly T[], kind: string): (id: string) => T {
  const map = new Map(items.map((i) => [i.id, i]));
  return (id: string) => {
    const item = map.get(id);
    if (!item) throw new Error(`${kind} inconnu(e) : ${id}`);
    return item;
  };
}

export class ContentRegistry {
  readonly buildingList: readonly BuildingDef[];
  readonly categories: readonly CategoryDef[];
  readonly terrains: readonly TerrainDef[];
  readonly resources: readonly ResourceDef[];
  readonly sites: readonly SiteDef[];
  readonly balance: BalanceDef;
  readonly personnelList: readonly PersonnelDef[];
  readonly skills: readonly SkillDef[];
  readonly traitList: readonly TraitDef[];
  readonly needs: NeedsConfig;
  readonly activityList: readonly ActivityDef[];
  readonly routineList: readonly RoutineDef[];
  readonly names: NamesDef;
  readonly vehicleList: readonly VehicleDef[];
  readonly supply: SupplyConfig;
  readonly events: EventsConfig;
  readonly combat: CombatConfig;
  readonly region: RegionDef;
  readonly missions: MissionsConfig;
  readonly radio: RadioConfig;
  readonly missionType: (id: string) => MissionTypeDef;
  readonly radioMessage: (id: string) => RadioMessageDef;
  readonly diplomacy: DiplomacyDef;
  readonly campaign: CampaignDef;
  readonly ambience: AmbienceDef;
  readonly settings: SettingsDef;
  readonly audio: AudioDef;
  readonly tutorial: TutorialDef;
  readonly visitors: VisitorsDef;
  readonly equipment: EquipmentDef;
  readonly diploAction: (id: string) => DiploActionDef;
  readonly project: (id: string) => ProjectDef;

  readonly terrainIndex = new Map<string, number>();
  readonly building: (id: string) => BuildingDef;
  readonly site: (id: string) => SiteDef;
  readonly personnel: (id: string) => PersonnelDef;
  readonly trait: (id: string) => TraitDef;
  readonly activity: (id: string) => ActivityDef;
  readonly routine: (id: string) => RoutineDef;
  readonly vehicle: (id: string) => VehicleDef;
  readonly supplyOrder: (id: string) => SupplyOrderDef;
  readonly event: (id: string) => EventDef;
  readonly enemy: (id: string) => EnemyDef;
  private readonly resourceMap: (id: string) => ResourceDef;
  private readonly needMap: (id: string) => NeedDef;
  private readonly buildingIds: Set<string>;

  constructor(raw: RawContent) {
    const errors = validateContent(raw);
    if (errors.length > 0) throw new ContentError(errors);

    this.buildingList = raw.buildings as BuildingDef[];
    this.categories = [...(raw.categories as CategoryDef[])].sort((a, b) => a.order - b.order);
    this.terrains = raw.terrain as TerrainDef[];
    this.resources = raw.resources as ResourceDef[];
    this.sites = raw.sites as SiteDef[];
    this.balance = raw.balance as BalanceDef;
    this.personnelList = raw.personnel as PersonnelDef[];
    this.skills = raw.skills as SkillDef[];
    this.traitList = raw.traits as TraitDef[];
    this.needs = raw.needs as NeedsConfig;
    this.activityList = raw.activities as ActivityDef[];
    this.routineList = raw.routines as RoutineDef[];
    this.names = raw.names as NamesDef;
    this.vehicleList = raw.vehicles as VehicleDef[];
    this.supply = raw.supply as SupplyConfig;
    this.events = raw.events as EventsConfig;
    this.combat = raw.combat as CombatConfig;
    this.region = raw.region as RegionDef;
    this.missions = raw.missions as MissionsConfig;
    this.radio = raw.radio as RadioConfig;
    this.missionType = indexById(this.missions.types, 'Type de mission');
    this.radioMessage = indexById(this.radio.messages, 'Message radio');
    this.diplomacy = raw.diplomacy as DiplomacyDef;
    this.campaign = raw.campaign as CampaignDef;
    this.ambience = raw.ambience as AmbienceDef;
    this.settings = raw.settings as SettingsDef;
    this.audio = raw.audio as AudioDef;
    this.tutorial = raw.tutorial as TutorialDef;
    this.visitors = raw.visitors as VisitorsDef;
    this.equipment = raw.equipment as EquipmentDef;
    this.diploAction = indexById(this.diplomacy.actions, 'Action diplomatique');
    this.project = indexById(this.diplomacy.projects, 'Projet');

    this.terrains.forEach((t, i) => this.terrainIndex.set(t.id, i));
    this.building = indexById(this.buildingList, 'Bâtiment');
    this.site = indexById(this.sites, 'Site');
    this.personnel = indexById(this.personnelList, 'Type de personnel');
    this.trait = indexById(this.traitList, 'Trait');
    this.activity = indexById(this.activityList, 'Activité');
    this.routine = indexById(this.routineList, 'Emploi du temps');
    this.vehicle = indexById(this.vehicleList, 'Véhicule');
    this.supplyOrder = indexById(this.supply.orders, 'Commande');
    this.event = indexById(this.events.events, 'Événement');
    this.enemy = indexById(this.combat.enemies, 'Ennemi');
    this.resourceMap = indexById(this.resources, 'Ressource');
    this.needMap = indexById(this.needs.needs, 'Besoin');
    this.buildingIds = new Set(this.buildingList.map((b) => b.id));
  }

  hasBuilding(id: string): boolean {
    return this.buildingIds.has(id);
  }

  resource(id: ResourceId): ResourceDef {
    return this.resourceMap(id);
  }

  need(id: NeedId): NeedDef {
    return this.needMap(id);
  }

  terrainAt(index: number): TerrainDef {
    return this.terrains[index];
  }

  buildingsInCategory(categoryId: string): BuildingDef[] {
    return this.buildingList.filter((b) => b.category === categoryId);
  }

  /** Bâtiments offrant un service donné. */
  buildingsWithService(service: string): BuildingDef[] {
    return this.buildingList.filter((b) => b.services?.[service]);
  }

  skillName(id: string): string {
    return this.skills.find((s) => s.id === id)?.name ?? id;
  }
}

/** Contenu par défaut, embarqué dans le bundle par Vite. */
export function loadDefaultContent(): ContentRegistry {
  return new ContentRegistry({
    buildings: buildingsJson,
    categories: categoriesJson,
    terrain: terrainJson,
    resources: resourcesJson,
    sites: sitesJson,
    balance: balanceJson,
    personnel: personnelJson,
    skills: skillsJson,
    traits: traitsJson,
    needs: needsJson,
    activities: activitiesJson,
    routines: routinesJson,
    names: namesJson,
    vehicles: vehiclesJson,
    supply: supplyJson,
    events: eventsJson,
    combat: combatJson,
    region: regionJson,
    missions: missionsJson,
    radio: radioJson,
    diplomacy: diplomacyJson,
    campaign: campaignJson,
    ambience: ambienceJson,
    settings: settingsJson,
    audio: audioJson,
    tutorial: tutorialJson,
    visitors: visitorsJson,
    equipment: equipmentJson,
  });
}
