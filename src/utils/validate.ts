/**
 * Validation du contenu JSON au démarrage. Renvoie une liste d'erreurs lisibles
 * (fichier, élément, problème) plutôt que de planter plus tard en pleine partie.
 */
import { NEED_IDS, RESOURCE_IDS, type NeedId, type ResourceId } from '../core/GameState';
import { VISUAL_STYLES, type RawContent } from '../core/ContentTypes';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isColor = (v: unknown): boolean => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

export function validateContent(raw: RawContent): string[] {
  const errors: string[] = [];
  const err = (where: string, msg: string): void => {
    errors.push(`${where} : ${msg}`);
  };

  /** Tableau d'objets à « id » unique. */
  const list = (file: string, value: unknown): Obj[] => {
    if (!Array.isArray(value)) {
      err(file, 'doit être un tableau');
      return [];
    }
    const seen = new Set<string>();
    const out: Obj[] = [];
    value.forEach((item, i) => {
      if (!isObj(item) || !isStr(item.id)) {
        err(`${file}[${i}]`, 'objet avec un champ « id » requis');
        return;
      }
      if (seen.has(item.id)) err(`${file}.${item.id}`, 'id en double');
      seen.add(item.id);
      out.push(item);
    });
    return out;
  };

  const bag = (where: string, value: unknown, required = false): void => {
    if (value === undefined) {
      if (required) err(where, 'champ requis');
      return;
    }
    if (!isObj(value)) {
      err(where, 'doit être un objet { ressource: nombre }');
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (!RESOURCE_IDS.includes(k as ResourceId)) err(where, `ressource inconnue « ${k} »`);
      if (!isNum(v)) err(where, `valeur non numérique pour « ${k} »`);
    }
  };

  const num = (where: string, obj: Obj, key: string, min = -Infinity): void => {
    if (!isNum(obj[key]) || (obj[key] as number) < min) err(`${where}.${key}`, `nombre ≥ ${min} requis`);
  };

  // ---------------------------------------------------------- resources.json
  const resources = list('resources.json', raw.resources);
  const resIds = new Set(resources.map((r) => r.id as string));
  for (const id of RESOURCE_IDS) if (!resIds.has(id)) err('resources.json', `ressource « ${id} » manquante`);
  for (const r of resources) {
    if (!RESOURCE_IDS.includes(r.id as ResourceId)) err(`resources.json.${r.id}`, 'id non géré par le moteur');
    if (!isStr(r.name)) err(`resources.json.${r.id}.name`, 'texte requis');
    if (!isColor(r.color)) err(`resources.json.${r.id}.color`, 'couleur #rrggbb requise');
  }

  // ---------------------------------------------------------- terrain.json
  const terrains = list('terrain.json', raw.terrain);
  const terrainIds = new Set(terrains.map((t) => t.id as string));
  for (const t of terrains) {
    if (!isColor(t.color)) err(`terrain.json.${t.id}.color`, 'couleur #rrggbb requise');
    if (typeof t.buildable !== 'boolean') err(`terrain.json.${t.id}.buildable`, 'booléen requis');
    if (!['none', 'pebbles', 'rocks', 'ruts'].includes(t.decor as string)) err(`terrain.json.${t.id}.decor`, 'none | pebbles | rocks | ruts');
  }
  if (!terrainIds.has('track')) err('terrain.json', 'terrain « track » (piste des convois) requis');

  // ---------------------------------------------------------- categories.json
  const categories = list('categories.json', raw.categories);
  const categoryIds = new Set(categories.map((c) => c.id as string));

  // ---------------------------------------------------------- buildings.json
  const buildings = list('buildings.json', raw.buildings);
  const buildingIds = new Set(buildings.map((b) => b.id as string));
  const services = (where: string, value: unknown): void => {
    if (value === undefined) return;
    if (!isObj(value)) err(where, 'objet { service: { slots } } requis');
    else for (const [k, sv] of Object.entries(value)) {
      if (!isObj(sv) || !Number.isInteger(sv.slots) || (sv.slots as number) < 1) err(`${where}.${k}`, '{ slots: entier ≥ 1 } requis');
    }
  };
  for (const b of buildings) {
    const w = `buildings.json.${b.id}`;
    if (!isStr(b.name)) err(`${w}.name`, 'texte requis');
    if (!categoryIds.has(b.category as string)) err(`${w}.category`, `catégorie inconnue « ${String(b.category)} »`);
    const fp = b.footprint;
    if (!Array.isArray(fp) || fp.length !== 2 || !fp.every((n) => Number.isInteger(n) && n > 0)) {
      err(`${w}.footprint`, '[largeur, profondeur] entiers > 0 requis');
    }
    if (!isObj(b.placement) || typeof b.placement.line !== 'boolean') {
      err(`${w}.placement`, '{ line: booléen } requis');
    } else if (b.placement.allowedTerrain !== undefined) {
      const at = b.placement.allowedTerrain;
      if (!Array.isArray(at)) err(`${w}.placement.allowedTerrain`, 'tableau requis');
      else for (const tId of at) if (!terrainIds.has(tId as string)) err(`${w}.placement.allowedTerrain`, `terrain inconnu « ${String(tId)} »`);
    }
    bag(`${w}.cost`, b.cost, true);
    bag(`${w}.upkeepPerDay`, b.upkeepPerDay, true);
    bag(`${w}.consumptionPerDay`, b.consumptionPerDay);
    bag(`${w}.productionPerDay`, b.productionPerDay);
    bag(`${w}.storage`, b.storage);
    num(w, b, 'buildTimeMin', 0);
    num(w, b, 'hp', 1);
    if (!isObj(b.unlock) || !isNum(b.unlock.reputation) || (b.unlock.points !== undefined && (!isNum(b.unlock.points) || (b.unlock.points as number) < 0))) err(`${w}.unlock`, '{ reputation: nombre, points?: nombre ≥ 0 } requis');
    if (!isObj(b.visual)) {
      err(`${w}.visual`, 'objet requis');
    } else {
      if (!isStr(b.visual.key)) err(`${w}.visual.key`, 'clé de sprite requise');
      if (!VISUAL_STYLES.includes(b.visual.style as never)) err(`${w}.visual.style`, `style parmi ${VISUAL_STYLES.join(', ')}`);
      if (!isColor(b.visual.color)) err(`${w}.visual.color`, 'couleur #rrggbb requise');
      if (b.visual.accent !== undefined && !isColor(b.visual.accent)) err(`${w}.visual.accent`, 'couleur #rrggbb requise');
      num(`${w}.visual`, b.visual, 'height', 0);
    }
    if (typeof b.rotatable !== 'boolean') err(`${w}.rotatable`, 'booléen requis');
    services(`${w}.services`, b.services);
    if (b.acceptsCargo !== undefined) {
      if (!Array.isArray(b.acceptsCargo)) err(`${w}.acceptsCargo`, 'tableau de ressources requis');
      else for (const r of b.acceptsCargo) if (!RESOURCE_IDS.includes(r as ResourceId)) err(`${w}.acceptsCargo`, `ressource inconnue « ${String(r)} »`);
    }
    for (const k of ['powerDemand', 'powerSupply', 'wearPerDay']) if (b[k] !== undefined) num(w, b, k, 0);
    if (b.levels !== undefined) {
      if (!Array.isArray(b.levels)) err(`${w}.levels`, 'tableau requis');
      else (b.levels as unknown[]).forEach((lv, i) => {
        const lw = `${w}.levels[${i}]`;
        if (!isObj(lv)) return err(lw, 'objet requis');
        bag(`${lw}.cost`, lv.cost, true);
        num(lw, lv, 'buildTimeMin', 1);
        services(`${lw}.services`, lv.services);
        for (const k of ['storage', 'productionPerDay', 'consumptionPerDay', 'upkeepPerDay']) bag(`${lw}.${k}`, lv[k]);
      });
    }
  }

  // ---------------------------------------------------------- sites.json
  const sites = list('sites.json', raw.sites);
  if (sites.length === 0) err('sites.json', 'au moins un site requis');
  for (const s of sites) {
    const w = `sites.json.${s.id}`;
    if (!isStr(s.name)) err(`${w}.name`, 'texte requis');
    bag(`${w}.startResources`, s.startResources, true);
    num(w, s, 'budgetMult', 0);
    if (!isObj(s.zone)) err(`${w}.zone`, '{ width, height } requis');
    else {
      num(`${w}.zone`, s.zone, 'width', 8);
      num(`${w}.zone`, s.zone, 'height', 8);
    }
    if (!isObj(s.entry) || !['north', 'south', 'east', 'west'].includes(s.entry.side as string)) err(`${w}.entry`, '{ side: north | south | east | west } requis');
    num(w, s, 'roadRisk', 0);
    num(w, s, 'threat', 0);
    if (!isObj(s.terrain)) {
      err(`${w}.terrain`, 'objet requis');
      continue;
    }
    num(`${w}.terrain`, s.terrain, 'noiseScale', 1);
    num(`${w}.terrain`, s.terrain, 'edgeRock', 0);
    num(`${w}.terrain`, s.terrain, 'clearRadius', 0);
    const bands = s.terrain.bands;
    if (!Array.isArray(bands) || bands.length === 0) {
      err(`${w}.terrain.bands`, 'tableau non vide requis');
      continue;
    }
    let prev = -Infinity;
    for (const band of bands) {
      if (!isObj(band) || !terrainIds.has(band.terrain as string) || !isNum(band.max)) {
        err(`${w}.terrain.bands`, '{ terrain: id connu, max: nombre } requis');
        continue;
      }
      if ((band.max as number) <= prev) err(`${w}.terrain.bands`, 'les seuils « max » doivent être croissants');
      prev = band.max as number;
    }
    if (prev < 1) err(`${w}.terrain.bands`, 'le dernier seuil doit valoir 1');
  }

  // ---------------------------------------------------------- balance.json
  const bal = raw.balance;
  if (!isObj(bal)) {
    err('balance.json', 'objet requis');
  } else {
    const section = (name: string, keys: string[]): void => {
      const sec = bal[name];
      if (!isObj(sec)) {
        err(`balance.json.${name}`, 'section requise');
        return;
      }
      for (const k of keys) num(`balance.json.${name}`, sec, k);
    };
    section('time', ['ticksPerSecondAtX1', 'minutesPerTick', 'startHour', 'maxTicksPerFrame']);
    section('map', ['width', 'height', 'tileWidth', 'tileHeight']);
    section('zone', ['step', 'baseCost', 'costGrowth']);
    section('build', ['refundRatio', 'refundRatioUnderConstruction', 'baseCrewRate', 'workerRate', 'maxWorkersPerSite']);
    section('supply', ['pickupMinutes', 'dropMinutes', 'carryCapacity', 'maxHaulersPerVehicle', 'blockedRetryTicks', 'maxWaitHours', 'maxUnloadHours', 'ambushDelayHours']);
    section('power', ['unpoweredServiceFactor']);
    section('wear', ['damagedAt', 'disabledAt', 'repairStartAt', 'repairDoneAt', 'repairPerHourPerWorker', 'partsPerWear', 'workshopRepairMult']);
    section('command', ['guardPostsWanted', 'reputationPerPoint', 'budgetMin', 'budgetMax']);
    section('agents', ['pathRequestsPerTick', 'maxPathNodes', 'wanderRadius', 'spawnSpread', 'minWalkSpeedFactor', 'mealsPerDayEstimate', 'hygienePerDayEstimate']);
    section('economy', ['dailyBudget', 'lowStockDays']);
    section('progression', ['startReputation']);
    section('save', ['slots', 'autosaveEveryDays']);
    section('camera', ['minZoom', 'maxZoom', 'zoomStep', 'startZoom', 'panSpeed', 'edgeSize']);
    section('log', ['maxEntries']);
    if (isObj(bal.economy)) bag('balance.json.economy.baseCapacity', bal.economy.baseCapacity, true);
  }

  // ---------------------------------------------------------- skills.json / traits.json
  const skillIds = new Set(list('skills.json', raw.skills).map((s) => s.id as string));
  const traits = list('traits.json', raw.traits);
  for (const tr of traits) {
    const w = `traits.json.${tr.id}`;
    if (!isStr(tr.name)) err(`${w}.name`, 'texte requis');
    if (tr.needDecay !== undefined) needRecord(`${w}.needDecay`, tr.needDecay);
    if (isObj(tr.skills)) for (const k of Object.keys(tr.skills)) if (!skillIds.has(k)) err(`${w}.skills`, `compétence inconnue « ${k} »`);
  }

  // ---------------------------------------------------------- needs.json
  const needsCfg = raw.needs;
  if (!isObj(needsCfg) || !Array.isArray(needsCfg.needs)) {
    err('needs.json', '{ needs: [...] } requis');
  } else {
    const ids = new Set<string>();
    for (const n of needsCfg.needs as unknown[]) {
      if (!isObj(n) || !NEED_IDS.includes(n.id as NeedId)) {
        err('needs.json.needs', `besoin inconnu (attendus : ${NEED_IDS.join(', ')})`);
        continue;
      }
      ids.add(n.id as string);
      for (const k of ['decayPerHour', 'low', 'critical', 'lowEfficiency', 'criticalEfficiency', 'healthLossPerHourAtZero']) num(`needs.json.${n.id}`, n, k);
      if (isObj(n.passive)) bag(`needs.json.${n.id}.passive.consumesPerHour`, n.passive.consumesPerHour, true);
    }
    for (const id of NEED_IDS) if (!ids.has(id)) err('needs.json', `besoin « ${id} » manquant`);
    for (const k of ['morale', 'health', 'incidents']) if (!isObj(needsCfg[k])) err(`needs.json.${k}`, 'section requise');
  }

  // ---------------------------------------------------------- activities.json
  const activities = list('activities.json', raw.activities);
  const activityIds = new Set(activities.map((a) => a.id as string));
  for (const a of activities) {
    const w = `activities.json.${a.id}`;
    if (!isStr(a.name)) err(`${w}.name`, 'texte requis');
    if (a.mode !== 'need' && a.mode !== 'schedule') err(`${w}.mode`, 'need | schedule');
    if (typeof a.inside !== 'boolean') err(`${w}.inside`, 'booléen requis');
    num(w, a, 'durationMin', 1);
    needRecord(`${w}.effectsPerHour`, a.effectsPerHour);
    bag(`${w}.consumes`, a.consumes);
    if (a.endWhenFull !== undefined && !NEED_IDS.includes(a.endWhenFull as NeedId)) err(`${w}.endWhenFull`, 'besoin inconnu');
  }
  for (const a of activities) {
    if (a.fallback !== undefined && !activityIds.has(a.fallback as string)) err(`activities.json.${a.id}.fallback`, `activité inconnue « ${String(a.fallback)} »`);
  }
  if (isObj(needsCfg) && isObj(needsCfg.needActivities)) {
    for (const [need, act] of Object.entries(needsCfg.needActivities)) {
      if (!activityIds.has(act as string)) err(`needs.json.needActivities.${need}`, `activité inconnue « ${String(act)} »`);
    }
  }

  // ---------------------------------------------------------- routines.json
  const routines = list('routines.json', raw.routines);
  const routineIds = new Set(routines.map((r) => r.id as string));
  for (const r of routines) {
    const w = `routines.json.${r.id}`;
    num(w, r, 'shifts', 1);
    if (!Array.isArray(r.hours) || r.hours.length !== 24) err(`${w}.hours`, '24 activités requises (une par heure)');
    else for (const h of r.hours) if (!activityIds.has(h as string)) err(`${w}.hours`, `activité inconnue « ${String(h)} »`);
  }

  // ---------------------------------------------------------- personnel.json
  const personnel = list('personnel.json', raw.personnel);
  const personnelIds = new Set(personnel.map((p) => p.id as string));
  for (const p of personnel) {
    const w = `personnel.json.${p.id}`;
    if (!isStr(p.name)) err(`${w}.name`, 'texte requis');
    if (!routineIds.has(p.routine as string)) err(`${w}.routine`, `emploi du temps inconnu « ${String(p.routine)} »`);
    if (!Array.isArray(p.ranks) || p.ranks.length === 0) err(`${w}.ranks`, 'au moins un grade requis');
    num(w, p, 'walkSpeed', 0.01);
    num(w, p, 'salaryPerDay', 0);
    if (!isObj(p.skills)) err(`${w}.skills`, 'objet requis');
    else for (const [k, v] of Object.entries(p.skills)) {
      if (!skillIds.has(k)) err(`${w}.skills`, `compétence inconnue « ${k} »`);
      if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) err(`${w}.skills.${k}`, '[min, max] requis');
    }
    if (!isObj(p.visual) || !isColor(p.visual.color)) err(`${w}.visual.color`, 'couleur #rrggbb requise');
  }
  if (isObj(bal) && Array.isArray(bal.startingForce)) {
    for (const g of bal.startingForce as unknown[]) {
      if (!isObj(g) || !isStr(g.group) || !Array.isArray(g.members)) {
        err('balance.json.startingForce', '{ group, kind, members: [...] } requis');
        continue;
      }
      for (const m of g.members as unknown[]) {
        if (!isObj(m) || !personnelIds.has(m.type as string)) err(`balance.json.startingForce.${g.group}`, 'type de personnel inconnu');
      }
    }
  } else {
    err('balance.json.startingForce', 'tableau requis');
  }

  // ---------------------------------------------------------- vehicles.json / supply.json
  const vehicles = list('vehicles.json', raw.vehicles);
  const vehicleIds = new Set(vehicles.map((v) => v.id as string));
  for (const v of vehicles) {
    const w = `vehicles.json.${v.id}`;
    if (!isStr(v.name)) err(`${w}.name`, 'texte requis');
    if (!['road', 'air', 'base', 'plane'].includes(v.kind as string)) err(`${w}.kind`, 'road | air | base | plane');
    num(w, v, 'speed', 0.01);
    if (v.requires !== undefined && !buildingIds.has(v.requires as string)) err(`${w}.requires`, `bâtiment inconnu « ${String(v.requires)} »`);
    bag(`${w}.upkeepPerDay`, v.upkeepPerDay);
    if (!isObj(v.visual) || !['truck', 'tanker', 'helicopter', 'forklift', 'mrap', 'humvee', 'c130', 'a10', 'cart', 'attack_helo', 'blackhawk', 'chinook', 'suv', 'littlebird'].includes(v.visual.style as string)) err(`${w}.visual.style`, 'truck | tanker | helicopter | forklift | mrap | humvee | c130 | a10 | cart | attack_helo | blackhawk | chinook | suv | littlebird');
    else if (!isColor(v.visual.color)) err(`${w}.visual.color`, 'couleur #rrggbb requise');
  }
  const sup = raw.supply;
  if (!isObj(sup)) {
    err('supply.json', 'objet requis');
  } else {
    bag('supply.json.unitPrices', sup.unitPrices, true);
    num('supply.json', sup, 'cargoStep', 1);
    num('supply.json', sup, 'maxActiveOrders', 1);
    for (const o of list('supply.json.orders', sup.orders)) {
      const w = `supply.json.orders.${o.id}`;
      if (!vehicleIds.has(o.vehicle as string)) err(`${w}.vehicle`, `véhicule inconnu « ${String(o.vehicle)} »`);
      if (!buildingIds.has(o.requires as string)) err(`${w}.requires`, `bâtiment inconnu « ${String(o.requires)} »`);
      num(w, o, 'fee', 0);
      num(w, o, 'risk', 0);
      if (!Array.isArray(o.delayHours) || o.delayHours.length !== 2) err(`${w}.delayHours`, '[min, max] requis');
      if (o.cargo === undefined && o.fixed === undefined) err(w, '« cargo » (au choix) ou « fixed » (cargaison fixe) requis');
      if (Array.isArray(o.cargo)) for (const r of o.cargo) if (!RESOURCE_IDS.includes(r as ResourceId)) err(`${w}.cargo`, `ressource inconnue « ${String(r)} »`);
      bag(`${w}.fixed`, o.fixed);
    }
    if (!Array.isArray(sup.recruits)) err('supply.json.recruits', 'tableau requis');
    else for (const r of sup.recruits as unknown[]) {
      if (!isObj(r) || !personnelIds.has(r.type as string)) err('supply.json.recruits', 'type de personnel inconnu');
    }
  }

  // ---------------------------------------------------------- combat.json
  const combat = raw.combat;
  const attackIds = new Set<string>();
  if (!isObj(combat) || !isObj(combat.config) || !isObj(combat.attacks)) {
    err('combat.json', '{ config, enemies, attacks } requis');
  } else {
    for (const k of ['baseHitChance', 'ammoPerShot', 'retreatAtLosses', 'spawnDistance', 'defenderRange', 'towerRangeBonus']) num('combat.json.config', combat.config, k, 0);
    const enemies = list('combat.json.enemies', combat.enemies);
    if (enemies.length === 0) err('combat.json.enemies', 'au moins un type d’ennemi requis');
    for (const e of enemies) {
      num(`combat.json.enemies.${e.id}`, e, 'health', 1);
      num(`combat.json.enemies.${e.id}`, e, 'range', 1);
    }
    for (const [id, a] of Object.entries(combat.attacks)) {
      attackIds.add(id);
      if (!isObj(a) || !['indirect', 'ground'].includes(a.type as string)) err(`combat.json.attacks.${id}`, 'type indirect | ground requis');
      else if (a.type === 'indirect' && (!Array.isArray(a.shells) || !Array.isArray(a.intervalMin))) err(`combat.json.attacks.${id}`, 'shells et intervalMin requis');
      else if (a.type === 'ground' && (!Array.isArray(a.enemies) || !isNum(a.durationMin))) err(`combat.json.attacks.${id}`, 'enemies et durationMin requis');
    }
  }

  // ---------------------------------------------------------- events.json
  const ev = raw.events;
  if (!isObj(ev) || !isObj(ev.config) || !isObj(ev.speakers)) {
    err('events.json', '{ config, speakers, events } requis');
  } else {
    num('events.json.config', ev.config, 'chancePerHour', 0);
    num('events.json.config', ev.config, 'minGapHours', 0);
    const speakerIds = new Set(Object.keys(ev.speakers));
    for (const [id, sp] of Object.entries(ev.speakers)) {
      if (!isObj(sp) || !isObj(sp.portrait) || (!isStr(sp.name) && !Array.isArray(sp.fromAgent))) err(`events.json.speakers.${id}`, '{ name | fromAgent, role, portrait } requis');
      else if (Array.isArray(sp.fromAgent)) for (const t of sp.fromAgent) if (!personnelIds.has(t as string)) err(`events.json.speakers.${id}.fromAgent`, `type inconnu « ${String(t)} »`);
    }
    const events = list('events.json.events', ev.events);
    const eventIds = new Set(events.map((e) => e.id as string));
    const effects = (where: string, e: unknown): void => {
      if (e === undefined) return;
      if (!isObj(e)) return err(where, 'objet requis');
      bag(`${where}.resources`, e.resources);
      if (e.attack !== undefined && !attackIds.has(e.attack as string)) err(`${where}.attack`, `attaque inconnue « ${String(e.attack)} »`);
      if (isObj(e.chain) && !eventIds.has(e.chain.event as string)) err(`${where}.chain`, `événement inconnu « ${String(e.chain.event)} »`);
      if (Array.isArray(e.recruits)) for (const r of e.recruits) if (!isObj(r) || !personnelIds.has(r.type as string)) err(`${where}.recruits`, 'type de personnel inconnu');
    };
    for (const e of events) {
      const w = `events.json.${e.id}`;
      if (!isStr(e.title)) err(`${w}.title`, 'texte requis');
      if (!isStr(e.text)) err(`${w}.text`, 'texte requis');
      if (!speakerIds.has(e.speaker as string)) err(`${w}.speaker`, `personnage inconnu « ${String(e.speaker)} »`);
      if (!['visit', 'threat', 'personnel', 'environment', 'logistics', 'attack'].includes(e.category as string)) err(`${w}.category`, 'catégorie inconnue');
      num(w, e, 'weight', 0);
      if (isObj(e.conditions) && e.conditions.requiresBuilding !== undefined && !buildingIds.has(e.conditions.requiresBuilding as string)) err(`${w}.conditions.requiresBuilding`, 'bâtiment inconnu');
      const choices = list(`${w}.choices`, e.choices);
      if (choices.length === 0) err(`${w}.choices`, 'au moins un choix requis');
      for (const c of choices) {
        const cw = `${w}.choices.${c.id}`;
        if (!isStr(c.text)) err(`${cw}.text`, 'texte requis');
        if (isObj(c.requires) && c.requires.building !== undefined && !buildingIds.has(c.requires.building as string)) err(`${cw}.requires.building`, 'bâtiment inconnu');
        effects(`${cw}.effects`, c.effects);
        if (!Array.isArray(c.outcomes) || c.outcomes.length === 0) err(`${cw}.outcomes`, 'au moins une issue requise');
        else (c.outcomes as unknown[]).forEach((o, i) => {
          if (!isObj(o) || !isStr(o.text)) return err(`${cw}.outcomes[${i}]`, '{ text } requis');
          effects(`${cw}.outcomes[${i}].effects`, o.effects);
        });
      }
    }
  }

  // ---------------------------------------------------------- region.json
  const rg = raw.region;
  if (!isObj(rg) || !isObj(rg.size) || !isObj(rg.relief) || !isObj(rg.intel) || !isObj(rg.contactKinds)) {
    err('region.json', '{ size, relief, contactKinds, villages, personalities, contacts, intel } requis');
  } else {
    const W = rg.size.width as number;
    const H = rg.size.height as number;
    num('region.json.size', rg.size, 'width', 10);
    num('region.json.size', rg.size, 'height', 10);
    const inMap = (where: string, p: unknown): void => {
      if (!isObj(p) || !isNum(p.x) || !isNum(p.y) || p.x < 0 || p.y < 0 || p.x > W || p.y > H) err(where, `position { x, y } dans la carte (0..${W}, 0..${H}) requise`);
    };
    const villages = list('region.json.villages', rg.villages);
    const villageIds = new Set(villages.map((v) => v.id as string));
    const persons = list('region.json.personalities', rg.personalities);
    const personIds = new Set(persons.map((pp) => pp.id as string));
    for (const v of villages) {
      inMap(`region.json.villages.${v.id}.pos`, v.pos);
      num(`region.json.villages.${v.id}`, v, 'attitude', -100);
      num(`region.json.villages.${v.id}`, v, 'influence', 0);
      if (v.leader !== null && !personIds.has(v.leader as string)) err(`region.json.villages.${v.id}.leader`, 'personnalité inconnue');
    }
    for (const pp of persons) {
      if (!villageIds.has(pp.village as string)) err(`region.json.personalities.${pp.id}.village`, 'village inconnu');
      if (!isObj(pp.portrait)) err(`region.json.personalities.${pp.id}.portrait`, 'portrait requis');
    }
    for (const u of list('region.json.friendlyUnits', rg.friendlyUnits)) inMap(`region.json.friendlyUnits.${u.id}.pos`, u.pos);
    for (const c of list('region.json.contacts', rg.contacts)) {
      inMap(`region.json.contacts.${c.id}.pos`, c.pos);
      if (!(c.kind as string in (rg.contactKinds as Obj))) err(`region.json.contacts.${c.id}.kind`, `type de contact inconnu « ${String(c.kind)} »`);
    }
    for (const r of [...((rg.rivers as unknown[]) ?? []), ...((rg.roads as unknown[]) ?? [])]) {
      if (!isObj(r) || !Array.isArray(r.points) || r.points.length < 2) err('region.json', 'rivière/route : au moins deux points requis');
    }
    if (Array.isArray(raw.sites)) for (const st of raw.sites as Obj[]) if (isObj(st)) inMap(`sites.json.${st.id}.regionPos`, st.regionPos);
    if (isObj(ev) && Array.isArray(ev.events)) {
      for (const e of ev.events as Obj[]) for (const c of (e.choices as Obj[]) ?? []) for (const o of (c.outcomes as Obj[]) ?? []) {
        const vf = isObj(o.effects) ? o.effects.village : undefined;
        if (isObj(vf) && vf.id !== '$village' && !villageIds.has(vf.id as string)) err(`events.json.${e.id}`, `village inconnu « ${String(vf.id)} »`);
        if (isObj(vf) && vf.id === '$village' && !e.village) err(`events.json.${e.id}`, '« $village » sans village tiré (champ village)');
      }
      if (isObj(ev.speakers)) for (const [id, sp] of Object.entries(ev.speakers)) {
        if (isObj(sp) && sp.personality !== undefined && !personIds.has(sp.personality as string)) err(`events.json.speakers.${id}.personality`, 'personnalité inconnue');
      }
    }
  }

  // ---------------------------------------------------------- missions.json / radio.json
  const ms = raw.missions;
  const missionIds = new Set<string>();
  if (!isObj(ms) || !isObj(ms.config) || !Array.isArray(ms.callsigns) || ms.callsigns.length === 0) {
    err('missions.json', '{ config, callsigns, loadouts, types } requis');
  } else {
    for (const k of ['footSpeedKmh', 'vehicleSpeedKmh', 'vehicleCapacity', 'minHealth', 'maxActive']) num('missions.json.config', ms.config, k, 0.01);
    const loadouts = list('missions.json.loadouts', ms.loadouts);
    for (const l of loadouts) {
      bag(`missions.json.loadouts.${l.id}.consumes`, l.consumes, true);
      num(`missions.json.loadouts.${l.id}`, l, 'speed', 0.1);
    }
    for (const m of list('missions.json.types', ms.types)) {
      missionIds.add(m.id as string);
      const w = `missions.json.types.${m.id}`;
      if (!Array.isArray(m.targets) || m.targets.length === 0) err(`${w}.targets`, 'au moins une cible (contact | village | fob)');
      num(w, m, 'minMembers', 1);
      num(w, m, 'maxMembers', 1);
      num(w, m, 'objectiveHours', 0.1);
      num(w, m, 'difficulty', 0);
      if (!isObj(m.rewards) || !isObj(m.rewards.success) || !isObj(m.rewards.partial) || !isObj(m.rewards.failure)) err(`${w}.rewards`, '{ success, partial, failure } requis');
      if (!isObj(m.texts)) err(`${w}.texts`, '{ success, partial, failure } requis');
      if (isObj(m.skills)) for (const k of Object.keys(m.skills)) if (!skillIds.has(k)) err(`${w}.skills`, `compétence inconnue « ${k} »`);
    }
  }
  const rd = raw.radio;
  if (!isObj(rd)) err('radio.json', '{ messages } requis');
  else {
    const radioIds = new Set(((rd.messages as Obj[]) ?? []).map((m) => m.id as string));
    for (const m of list('radio.json.messages', rd.messages)) {
      const w = `radio.json.messages.${m.id}`;
      if (!isStr(m.text)) err(`${w}.text`, 'texte requis');
      if (Array.isArray(m.types)) for (const tId of m.types) if (!missionIds.has(tId as string)) err(`${w}.types`, `type de mission inconnu « ${String(tId)} »`);
      const choices = list(`${w}.choices`, m.choices);
      if (choices.length === 0) err(`${w}.choices`, 'au moins un choix requis');
      const ids = new Set<string>();
      for (const c of choices) {
        if (ids.has(c.id as string)) err(`${w}.choices`, `identifiant en double « ${String(c.id)} »`);
        ids.add(c.id as string);
        if (!isStr(c.text) || !isStr(c.log)) err(`${w}.choices.${c.id}`, '{ text, log } requis');
        if (!isObj(c.effects)) err(`${w}.choices.${c.id}.effects`, 'objet requis');
        else {
          bag(`${w}.choices.${c.id}.effects.cost`, c.effects.cost);
          bag(`${w}.choices.${c.id}.effects.resources`, c.effects.resources);
        }
        const follow = [c.followUp, ...(Array.isArray(c.outcomes) ? (c.outcomes as Obj[]).map((o) => o.followUp) : [])];
        for (const f of follow) if (isObj(f) && !radioIds.has(f.radio as string)) err(`${w}.choices.${c.id}`, `suite radio inconnue « ${String(f.radio)} »`);
        if (Array.isArray(c.outcomes)) for (const o of c.outcomes as Obj[]) if (!isStr(o.log)) err(`${w}.choices.${c.id}.outcomes`, '{ log } requis');
      }
    }
  }

  // ---------------------------------------------------------- diplomacy.json / campaign.json
  const dp = raw.diplomacy;
  if (!isObj(dp) || !isObj(dp.config)) err('diplomacy.json', '{ config, actions, projects } requis');
  else {
    const cfg = dp.config;
    if (!Array.isArray(cfg.stances) || cfg.stances.length === 0) err('diplomacy.json.config.stances', 'au moins un palier requis');
    else for (const st of cfg.stances) if (!isObj(st) || !isNum(st.max) || !isStr(st.label) || !isColor(st.color)) err('diplomacy.json.config.stances', '{ id, max, label, color } requis');
    for (const k of ['attitudeMemoryPerDay', 'needBonus', 'contactInfluenceKm', 'patrolMemoryDays']) num('diplomacy.json.config', cfg, k, 0);
    for (const k of ['shura', 'promise', 'sabotage', 'roadRisk', 'threat', 'budget', 'stability', 'incidents', 'auxiliary', 'insurgency']) if (!isObj(cfg[k])) err(`diplomacy.json.config.${k}`, 'objet requis');
    if (isObj(cfg.auxiliary) && !personnelIds.has(cfg.auxiliary.type as string)) err('diplomacy.json.config.auxiliary.type', `type de personnel inconnu « ${String(cfg.auxiliary.type)} »`);
    const evIds = new Set(isObj(raw.events) && Array.isArray(raw.events.events) ? (raw.events.events as Obj[]).map((e) => e.id as string) : []);
    if (isObj(cfg.auxiliary) && !evIds.has(cfg.auxiliary.insiderEvent as string)) err('diplomacy.json.config.auxiliary.insiderEvent', 'événement inconnu');
    if (isObj(cfg.insurgency) && Array.isArray(cfg.insurgency.templates)) {
      const kinds = isObj(raw.region) && isObj(raw.region.contactKinds) ? Object.keys(raw.region.contactKinds) : [];
      for (const tp of cfg.insurgency.templates) if (!isObj(tp) || !kinds.includes(tp.kind as string) || !isStr(tp.label)) err('diplomacy.json.config.insurgency.templates', '{ kind (connu), label, drift, weight } requis');
    }
    for (const a of list('diplomacy.json.actions', dp.actions)) {
      const w = `diplomacy.json.actions.${a.id}`;
      if (!isStr(a.name)) err(`${w}.name`, 'texte requis');
      bag(`${w}.cost`, a.cost, true);
      num(w, a, 'cooldownDays', 0);
      if (a.requiresPersonnel !== undefined && !personnelIds.has(a.requiresPersonnel as string)) err(`${w}.requiresPersonnel`, 'type de personnel inconnu');
    }
    for (const pr of list('diplomacy.json.projects', dp.projects)) {
      const w = `diplomacy.json.projects.${pr.id}`;
      if (!isStr(pr.name) || !isStr(pr.need)) err(w, '{ name, need } requis');
      bag(`${w}.cost`, pr.cost, true);
      num(w, pr, 'days', 0.1);
    }
  }
  const cp = raw.campaign;
  if (!isObj(cp) || !isObj(cp.defeat) || !isObj(cp.texts)) err('campaign.json', '{ phases, defeat, texts } requis');
  else {
    const contactIds = new Set(isObj(raw.region) && Array.isArray(raw.region.contacts) ? (raw.region.contacts as Obj[]).map((c) => c.id as string) : []);
    const types = ['stability', 'villagesAttitude', 'villagesInfluence', 'missionsSuccess', 'projects', 'promisesKept', 'auxiliaries', 'contactsNeutralized', 'neutralize', 'reputation'];
    const phases = list('campaign.json.phases', cp.phases);
    if (phases.length === 0) err('campaign.json.phases', 'au moins une phase requise');
    for (const ph of phases) {
      const w = `campaign.json.phases.${ph.id}`;
      if (!isStr(ph.name)) err(`${w}.name`, 'texte requis');
      num(w, ph, 'days', 1);
      if (!isObj(ph.rewards) || !isObj(ph.penalty)) err(w, '{ rewards, penalty } requis');
      const objs = list(`${w}.objectives`, ph.objectives);
      if (objs.length === 0) err(`${w}.objectives`, 'au moins un objectif requis');
      for (const o of objs) {
        if (!types.includes(o.type as string)) err(`${w}.objectives.${o.id}.type`, `type inconnu « ${String(o.type)} »`);
        if (!isStr(o.text)) err(`${w}.objectives.${o.id}.text`, 'texte requis');
        if (o.type === 'neutralize' && !contactIds.has(o.contact as string)) err(`${w}.objectives.${o.id}.contact`, 'contact inconnu');
      }
    }
  }

  // ---------------------------------------------------------- entraînement : bruit, activités spécialisées
  for (const bd of buildings) {
    const nz = bd.noise;
    if (nz !== undefined && (!isObj(nz) || !isNum(nz.radius) || !isNum(nz.sleepMult) || !isNum(nz.moralePerHour))) err(`buildings.json.${String(bd.id)}.noise`, '{ radius, sleepMult, moralePerHour } requis');
  }
  if (Array.isArray(raw.activities)) {
    const actIds = new Set((raw.activities as Obj[]).map((x) => x.id as string));
    for (const act of raw.activities as Obj[]) {
      if (Array.isArray(act.options)) for (const o of act.options) if (!actIds.has(o as string)) err(`activities.json.${String(act.id)}.options`, `activité inconnue « ${String(o)} »`);
      bag(`activities.json.${String(act.id)}.consumesPerHour`, act.consumesPerHour);
      if (isObj(act.skillsPerHour)) for (const k of Object.keys(act.skillsPerHour)) if (!skillIds.has(k)) err(`activities.json.${String(act.id)}.skillsPerHour`, `compétence inconnue « ${k} »`);
    }
  }

  // ---------------------------------------------------------- logistique interne
  for (const bd of buildings) {
    const w = `buildings.json.${String(bd.id)}`;
    if (bd.supplies !== undefined) {
      if (!isObj(bd.supplies)) err(`${w}.supplies`, 'objet requis');
      else
        for (const [k, s] of Object.entries(bd.supplies)) {
          if (!RESOURCE_IDS.includes(k as ResourceId)) err(`${w}.supplies`, `ressource inconnue « ${k} »`);
          if (!isObj(s) || !isNum(s.capacity) || !isNum(s.refillBelow) || (s.refillBelow as number) > (s.capacity as number)) err(`${w}.supplies.${k}`, '{ capacity, refillBelow ≤ capacity } requis');
        }
    }
    if (bd.kitchen !== undefined && (!isObj(bd.kitchen) || !isNum(bd.kitchen.mealCapacity))) err(`${w}.kitchen`, '{ mealCapacity } requis');
    if (bd.kitchen !== undefined && !(isObj(bd.services) && isObj(bd.services.kitchen))) err(`${w}.kitchen`, 'service « kitchen » requis');
    if (bd.cleaning !== undefined && (!isObj(bd.cleaning) || !isNum(bd.cleaning.dirtPerUse))) err(`${w}.cleaning`, '{ dirtPerUse } requis');
  }
  for (const p of personnel) {
    if (p.duties === undefined) continue;
    if (!Array.isArray(p.duties)) err(`personnel.json.${String(p.id)}.duties`, 'liste requise');
    else for (const d of p.duties) if (!['supply', 'cook', 'clean'].includes(d as string)) err(`personnel.json.${String(p.id)}.duties`, `corvée inconnue « ${String(d)} »`);
  }
  for (const a of activities) {
    if (a.work !== undefined && !['build', 'haul', 'defend', 'deploy', 'supply', 'materials', 'clean', 'rearm', 'gear', 'march'].includes(a.work as string)) err(`activities.json.${String(a.id)}.work`, 'travail inconnu');
  }
  for (const id of ['supply', 'fetch_materials', 'cook', 'clean', 'eat_mre', 'rearm', 'collect_gear']) if (!activityIds.has(id)) err('activities.json', `activité « ${id} » requise`);

  // ---------------------------------------------------------- améliorations des bâtiments, équipement
  const visualsOk = ['ac', 'sandbags', 'mast', 'dish', 'servers', 'chimney', 'roof_tank', 'redcross'];
  for (const bd of buildings) {
    if (bd.modules === undefined) continue;
    const mods = list(`buildings.json.${String(bd.id)}.modules`, bd.modules);
    const ids = new Set(mods.map((m) => m.id as string));
    for (const m of mods) {
      const w = `buildings.json.${String(bd.id)}.modules.${m.id}`;
      if (!isStr(m.name)) err(`${w}.name`, 'texte requis');
      bag(`${w}.cost`, m.cost, true);
      num(w, m, 'buildTimeMin', 1);
      if (m.visual !== undefined && !visualsOk.includes(m.visual as string)) err(`${w}.visual`, visualsOk.join(' | '));
      if (m.requires !== undefined && !ids.has(m.requires as string)) err(`${w}.requires`, 'amélioration inconnue');
    }
  }
  const eq = raw.equipment;
  if (!isObj(eq) || !Array.isArray(eq.eligible) || !Array.isArray(eq.nightHours)) err('equipment.json', '{ storageBuilding, eligible, nightHours, items } requis');
  else {
    if (!buildingIds.has(eq.storageBuilding as string)) err('equipment.json.storageBuilding', 'bâtiment inconnu');
    for (const tp of eq.eligible as unknown[]) if (!personnelIds.has(tp as string)) err('equipment.json.eligible', `type inconnu « ${String(tp)} »`);
    for (const it of list('equipment.json.items', eq.items)) {
      if (!isStr(it.name) || !isStr(it.short)) err(`equipment.json.items.${it.id}`, '{ name, short } requis');
      num(`equipment.json.items.${it.id}`, it, 'price', 0);
    }
  }

  // ---------------------------------------------------------- visites physiques
  const vis = raw.visitors;
  const visuals = isObj(vis) && isObj(vis.visuals) ? (vis.visuals as Obj) : null;
  if (!isObj(vis) || !isObj(vis.config) || !visuals) err('visitors.json', '{ config, visuals } requis');
  else for (const [id, v] of Object.entries(visuals)) if (!isObj(v) || !isColor(v.color)) err(`visitors.json.visuals.${id}`, '{ color (#rrggbb), ... } requis');
  if (isObj(raw.events) && Array.isArray((raw.events as Obj).events)) {
    const vehicleIds = new Set(Array.isArray(raw.vehicles) ? (raw.vehicles as Obj[]).map((v) => v.id as string) : []);
    for (const ev of (raw.events as Obj).events as Obj[]) {
      const vs = ev.visit;
      if (vs === undefined) continue;
      const w = `events.json.${String(ev.id)}.visit`;
      if (!isObj(vs) || !['foot', 'cart', 'vehicle', 'helicopter'].includes(vs.mode as string)) {
        err(w, '{ mode: foot | cart | vehicle | helicopter, leader, escort, stayMinutes } requis');
        continue;
      }
      if (visuals && !(String(vs.leader) in visuals)) err(`${w}.leader`, `apparence inconnue « ${String(vs.leader)} »`);
      if (!Array.isArray(vs.escort)) err(`${w}.escort`, 'tableau requis');
      else for (const e of vs.escort as unknown[]) if (!isObj(e) || !visuals || !(String(e.visual) in visuals) || !isNum(e.count)) err(`${w}.escort`, '{ visual (connue), count } requis');
      if ((vs.mode === 'cart' || vs.mode === 'vehicle') && !vehicleIds.has(vs.vehicle as string)) err(`${w}.vehicle`, 'véhicule inconnu');
      num(w, vs, 'stayMinutes', 0);
    }
  }

  // ---------------------------------------------------------- appuis feu des missions
  if (isObj(raw.missions)) {
    for (const sp of list('missions.json.support', (raw.missions as Obj).support)) {
      const w = `missions.json.support.${sp.id}`;
      if (!isStr(sp.name)) err(`${w}.name`, 'texte requis');
      bag(`${w}.cost`, sp.cost, true);
      if (sp.requires !== undefined && !buildingIds.has(sp.requires as string)) err(`${w}.requires`, 'bâtiment inconnu');
      if (sp.flyover !== undefined && !(Array.isArray(raw.vehicles) && (raw.vehicles as Obj[]).some((v) => v.id === sp.flyover))) err(`${w}.flyover`, 'véhicule inconnu');
      if (sp.hours !== undefined && (!Array.isArray(sp.hours) || sp.hours.length !== 2)) err(`${w}.hours`, '[début, fin] requis');
    }
  }
  if (isObj(raw.combat) && isObj((raw.combat as Obj).config) && !isObj(((raw.combat as Obj).config as Obj).artillery)) err('combat.json.config.artillery', 'objet requis');

  // ---------------------------------------------------------- ambience / settings / audio / tutorial (Phase 8)
  const am = raw.ambience;
  if (!isObj(am) || !Array.isArray(am.keyframes) || am.keyframes.length < 2) err('ambience.json', '{ keyframes (≥ 2), ... } requis');
  else {
    let prev = -1;
    for (const k of am.keyframes) {
      if (!isObj(k) || !isNum(k.hour) || !isColor(k.color) || !isNum(k.night)) err('ambience.json.keyframes', '{ hour, color (#rrggbb), night } requis');
      else if ((k.hour as number) < prev) err('ambience.json.keyframes', 'heures croissantes requises');
      else prev = k.hour as number;
    }
    for (const fx of ['headlights', 'explosion', 'muzzle', 'cannon']) if (!isObj(am[fx]) || !isColor((am[fx] as Obj).color)) err(`ambience.json.${fx}`, '{ radius, color } requis');
  }
  for (const b of buildings) {
    if (b.light === undefined) continue;
    if (!isObj(b.light) || !isNum(b.light.radius) || !isColor(b.light.color)) err(`buildings.json.${String(b.id)}.light`, '{ radius, color (#rrggbb), power? } requis');
  }
  const stg = raw.settings;
  if (!isObj(stg) || !isStr(stg.storageKey) || !Array.isArray(stg.groups)) err('settings.json', '{ storageKey, groups, options } requis');
  else {
    const groups = new Set((stg.groups as Obj[]).map((g) => g.id as string));
    for (const o of list('settings.json.options', stg.options)) {
      const w = `settings.json.options.${o.id}`;
      if (!groups.has(o.group as string)) err(`${w}.group`, 'groupe inconnu');
      if (o.type === 'toggle' && typeof o.default !== 'boolean') err(`${w}.default`, 'booléen requis');
      else if (o.type === 'slider' && (!isNum(o.default) || !isNum(o.min) || !isNum(o.max))) err(w, '{ min, max, default } numériques requis');
      else if (o.type !== 'toggle' && o.type !== 'slider') err(`${w}.type`, 'slider | toggle');
    }
  }
  const au = raw.audio;
  if (!isObj(au) || !isObj(au.sounds) || !isObj(au.events) || !isObj(au.ambient)) err('audio.json', '{ sounds, events, ambient } requis');
  else {
    const sounds = au.sounds as Obj;
    for (const [id, snd] of Object.entries(sounds)) {
      const w = `audio.json.sounds.${id}`;
      if (!isObj(snd) || !['sfx', 'radio', 'ui'].includes(snd.cat as string) || !Array.isArray(snd.layers) || snd.layers.length === 0) {
        err(w, '{ cat: sfx | radio | ui, layers } requis');
        continue;
      }
      for (const l of snd.layers as unknown[]) {
        if (!isObj(l) || (l.type !== 'tone' && l.type !== 'noise') || !isNum(l.dur) || !isNum(l.gain)) err(`${w}.layers`, '{ type: tone | noise, dur, gain } requis');
        else if (l.type === 'tone' && !isNum(l.freq)) err(`${w}.layers`, 'freq requis pour une couche tone');
      }
    }
    for (const [ev, snd] of Object.entries(au.events as Obj)) if (!(String(snd) in sounds)) err(`audio.json.events.${ev}`, `son inconnu « ${String(snd)} »`);
  }
  const tu = raw.tutorial;
  if (!isObj(tu)) err('tutorial.json', '{ steps } requis');
  else {
    for (const st of list('tutorial.json.steps', tu.steps)) {
      const w = `tutorial.json.steps.${st.id}`;
      if (!isStr(st.title) || !isStr(st.text)) err(w, '{ title, text } requis');
      const done = st.done;
      if (!isObj(done) || !['ack', 'building', 'event'].includes(done.type as string)) err(`${w}.done`, '{ type: ack | building | event } requis');
      else if (done.type === 'building' && !buildingIds.has(done.defId as string)) err(`${w}.done.defId`, 'bâtiment inconnu');
      else if (done.type === 'event' && !isStr(done.event)) err(`${w}.done.event`, 'événement requis');
    }
  }

  // ---------------------------------------------------------- names.json
  if (!isObj(raw.names) || !Array.isArray(raw.names.first) || !Array.isArray(raw.names.last) || raw.names.first.length === 0 || raw.names.last.length === 0) {
    err('names.json', '{ first: [...], last: [...] } non vides requis');
  }

  return errors;

  function needRecord(where: string, value: unknown): void {
    if (value === undefined) return;
    if (!isObj(value)) {
      err(where, 'objet { besoin: nombre } requis');
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (!NEED_IDS.includes(k as NeedId)) err(where, `besoin inconnu « ${k} »`);
      if (!isNum(v)) err(where, `valeur non numérique pour « ${k} »`);
    }
  }
}
