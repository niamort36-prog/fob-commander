/**
 * SaveSystem — sauvegardes multi-emplacements (localStorage), versionnées avec migrations.
 * Emplacements : « auto » (sauvegarde automatique quotidienne) + N emplacements manuels.
 */
import type { ContentRegistry } from '../core/ContentRegistry';
import type { GameContext } from '../core/GameContext';
import { SAVE_VERSION, emptyCheckpoint, emptyCombat, emptyDiplomacy, emptyRegion, type GameState } from '../core/GameState';
import { carveTrack, entryCell, generateTerrain } from '../utils/terrainGen';
import type { System } from './System';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SaveSummary {
  slot: string;
  savedAt: string;
  day: number;
  minuteOfDay: number;
  siteName: string;
  funds: number;
  version: number;
}

interface SaveFile {
  version: number;
  summary: SaveSummary;
  state: GameState;
}

export const AUTO_SLOT = 'auto';

/** Forme minimale d'un état v1 utilisée par la migration (champs modifiés uniquement). */
interface StateV1 {
  meta: { seed: number; siteId: string };
  fob: { width: number; height: number; terrain: number[]; buildings: Record<string, { pos: { x: number; y: number } }> };
  agents: unknown;
  groups: unknown;
}

/**
 * Migrations : MIGRATIONS[v] transforme une sauvegarde de version v en version v + 1.
 */
const MIGRATIONS: Record<number, (file: SaveFile, content: ContentRegistry) => SaveFile> = {
  /**
   * v1 → v2 : carte agrandie et périmètre constructible. L'ancienne base (64×64) est recentrée
   * dans la nouvelle carte et devient le périmètre ; le terrain autour est régénéré avec la même graine.
   * Le personnel (inexistant en v1) sera déployé au chargement.
   */
  1: (file, content) => {
    const old = file.state as unknown as StateV1;
    const { width, height } = content.balance.map;
    const ow = old.fob.width;
    const oh = old.fob.height;
    const ox = Math.max(0, Math.floor((width - ow) / 2));
    const oy = Math.max(0, Math.floor((height - oh) / 2));
    const site = content.site(old.meta.siteId);
    const terrain = generateTerrain(width, height, old.meta.seed, site.terrain, content.terrainIndex);
    for (let y = 0; y < Math.min(oh, height); y++) {
      for (let x = 0; x < Math.min(ow, width); x++) terrain[(y + oy) * width + x + ox] = old.fob.terrain[y * ow + x];
    }
    for (const b of Object.values(old.fob.buildings)) {
      b.pos.x += ox;
      b.pos.y += oy;
    }
    const fob = old.fob as unknown as GameState['fob'];
    fob.width = width;
    fob.height = height;
    fob.terrain = terrain;
    fob.occupancy = [];
    fob.zone = { x: ox, y: oy, width: Math.min(ow, width), height: Math.min(oh, height), expansions: 0 };
    old.agents = {};
    old.groups = {};
    return { ...file, version: 2, state: old as unknown as GameState };
  },

  /**
   * v2 → v3 : ravitaillement. Piste des convois tracée depuis le bord de carte, véhicules,
   * électricité, améliorations et évaluation du commandement initialisés.
   */
  2: (file, content) => {
    const st = file.state;
    const site = content.site(st.meta.siteId);
    const fob = st.fob;
    fob.entry = entryCell(site.entry.side, fob.width, fob.height);
    carveTrack(fob.terrain, fob.width, fob.height, fob.entry, fob.zone, st.meta.seed, content.terrainIndex.get('track') ?? 0);
    for (const b of Object.values(fob.buildings)) b.upgrade ??= null;
    st.vehicles = {};
    st.supply = { orders: {} };
    st.resources.power = { supply: 0, demand: 0 };
    st.progression.lastRating ??= null;
    return { ...file, version: 3, state: st };
  },

  /** v3 → v4 : événements (file d'attente datée, recharges), combat et mémorial. */
  3: (file) => {
    const st = file.state;
    const old = (st.events ?? {}) as Partial<GameState['events']>;
    st.events = {
      active: null,
      queue: [],
      history: Array.isArray(old.history) ? old.history : [],
      cooldowns: {},
      lastEventTick: -100000,
      lastAttackTick: -100000,
    };
    st.combat = emptyCombat();
    st.memorial = [];
    return { ...file, version: 4, state: st };
  },

  /** v4 → v5 : carte régionale ; la région sera initialisée au chargement. */
  4: (file) => {
    file.state.region = emptyRegion();
    return { ...file, version: 5, state: file.state };
  },

  /** v5 → v6 : missions, radio et comptes rendus. */
  5: (file) => {
    const st = file.state;
    for (const a of Object.values(st.agents)) a.missionId ??= null;
    st.missions = {};
    st.radio = { pending: null, queue: [] };
    st.missionReports = [];
    return { ...file, version: 6, state: st };
  },
  /** v6 → v7 : géopolitique (relations détaillées, projets, campagne) ; initialisée au chargement. */
  6: (file) => {
    const st = file.state;
    st.diplomacy = emptyDiplomacy();
    return { ...file, version: 7, state: st };
  },
  /**
   * v7 → v8 : points de réputation et bâtiments à acheter. Les bâtiments déjà accessibles
   * avec l'ancien système (seuil de réputation) restent débloqués.
   */
  7: (file, content) => {
    const st = file.state;
    st.progression.points = content.balance.progression.startPoints ?? 0;
    st.progression.unlocked ??= [];
    for (const b of content.buildingList) {
      if ((b.unlock.points ?? 0) > 0 && b.unlock.reputation <= st.progression.reputation && Object.values(st.fob.buildings).some((x) => x.defId === b.id)) {
        st.progression.unlocked.push(b.id);
      }
    }
    for (const m of Object.values(st.missions)) m.support ??= null;
    return { ...file, version: 8, state: st };
  },
  /** v8 → v9 : visites physiques des événements. */
  8: (file) => {
    const st = file.state;
    st.visit = null;
    return { ...file, version: 9, state: st };
  },
  /** v9 → v10 : améliorations des bâtiments et équipement individuel. */
  9: (file) => {
    const st = file.state;
    for (const b of Object.values(st.fob.buildings)) {
      b.modules ??= [];
      b.moduleWork ??= null;
    }
    for (const a of Object.values(st.agents)) a.gear ??= [];
    st.equipment ??= {};
    return { ...file, version: 10, state: st };
  },
  /** v10 → v11 : logistique interne (stocks locaux, repas, propreté, matériaux de chantier). */
  10: (file, content) => {
    const st = file.state;
    const left = { ...st.resources.stock };
    for (const b of Object.values(st.fob.buildings)) {
      const def = content.hasBuilding(b.defId) ? content.building(b.defId) : null;
      b.materials ??= null;
      if (!def || b.state === 'construction') continue;
      b.inventory ??= {};
      for (const [res, s] of Object.entries(def.supplies ?? {}) as [keyof typeof left, { capacity: number }][]) {
        const n = Math.max(0, Math.min(s.capacity, Math.floor(left[res])));
        b.inventory[res] = n;
        left[res] -= n;
      }
      if (def.kitchen) b.inventory.meals = Math.floor(def.kitchen.mealCapacity / 2);
      if (def.cleaning) b.cleanliness = 1;
    }
    return { ...file, version: 11, state: st };
  },
  /** v11 → v12 : munitions individuelles, équipement à percevoir au dépôt. */
  11: (file, content) => {
    const st = file.state;
    for (const a of Object.values(st.agents)) {
      a.gearPending ??= [];
      a.ammo ??= content.personnelList.find((p) => p.id === a.defId)?.ammoCapacity ?? 0;
    }
    return { ...file, version: 12, state: st };
  },
  /** v12 → v13 : carte régionale agrandie (décalage de 30 / 22 km), monde vivant. */
  12: (file) => {
    const st = file.state;
    const shift = (p: { x: number; y: number } | undefined): void => {
      if (!p) return;
      p.x += 30;
      p.y += 22;
    };
    for (const c of Object.values(st.region.contacts)) {
      shift(c.truePos);
      shift(c.estPos);
      shift(c.dyn?.home);
    }
    for (const m of Object.values(st.missions)) shift(m.target.pos);
    st.region.actors ??= {};
    st.region.ieds ??= [];
    st.region.incidents ??= [];
    st.region.sitesVisited ??= {};
    return { ...file, version: 13, state: st };
  },
  /** v13 → v14 : civils fouillés au poste de garde. */
  13: (file) => {
    const st = file.state;
    st.checkpoint ??= emptyCheckpoint();
    return { ...file, version: 14, state: st };
  },
  /** v14 → v15 : besoin « toilettes » (latrines). */
  14: (file) => {
    const st = file.state;
    for (const a of Object.values(st.agents)) a.needs.toilet ??= 100;
    return { ...file, version: 15, state: st };
  },
  /** v15 → v16 : besoin « amusement » (bar, tente de détente, barbecue). */
  15: (file) => {
    const st = file.state;
    for (const a of Object.values(st.agents)) a.needs.fun ??= 70;
    return { ...file, version: 16, state: st };
  },
};

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // stockage bloqué (navigation privée stricte, iframe…)
  }
}

export class SaveSystem implements System {
  readonly id = 'save';
  private readonly storage: StorageLike | null;

  constructor(
    private readonly ctx: GameContext,
    storage?: StorageLike | null,
  ) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    ctx.bus.on('time:newDay', ({ day }) => {
      const every = ctx.content.balance.save.autosaveEveryDays;
      if (every > 0 && (day - 1) % every === 0 && ctx.settings.bool('autosave')) this.save(AUTO_SLOT, true);
    });
  }

  get available(): boolean {
    return this.storage !== null;
  }

  slots(): string[] {
    const manual = Array.from({ length: this.ctx.content.balance.save.slots }, (_, i) => String(i + 1));
    return [AUTO_SLOT, ...manual];
  }

  save(slot: string, auto = false): boolean {
    if (!this.storage) {
      this.ctx.bus.emit('save:failed', { slot, error: 'stockage indisponible' });
      return false;
    }
    const state = this.ctx.state;
    const file: SaveFile = {
      version: SAVE_VERSION,
      summary: {
        slot,
        savedAt: new Date().toISOString(),
        day: state.time.day,
        minuteOfDay: state.time.minuteOfDay,
        siteName: this.ctx.site.name,
        funds: Math.floor(state.resources.stock.funds),
        version: SAVE_VERSION,
      },
      state,
    };
    try {
      this.storage.setItem(this.key(slot), JSON.stringify(file));
      this.ctx.bus.emit('save:done', { slot, auto });
      return true;
    } catch (e) {
      this.ctx.bus.emit('save:failed', { slot, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** Lit et migre une sauvegarde ; renvoie l'état prêt à être passé à ctx.loadState, ou null. */
  load(slot: string): GameState | null {
    const file = this.read(slot);
    if (!file) return null;
    try {
      const migrated = this.migrate(file);
      this.assertValid(migrated.state);
      return migrated.state;
    } catch (e) {
      console.error(`[SaveSystem] sauvegarde « ${slot} » illisible`, e);
      return null;
    }
  }

  summary(slot: string): SaveSummary | null {
    return this.read(slot)?.summary ?? null;
  }

  list(): { slot: string; summary: SaveSummary | null }[] {
    return this.slots().map((slot) => ({ slot, summary: this.summary(slot) }));
  }

  /** Emplacement de la sauvegarde la plus récente, ou null. */
  latest(): string | null {
    let best: SaveSummary | null = null;
    for (const { summary } of this.list()) {
      if (summary && (!best || summary.savedAt > best.savedAt)) best = summary;
    }
    return best?.slot ?? null;
  }

  remove(slot: string): void {
    this.storage?.removeItem(this.key(slot));
  }

  private key(slot: string): string {
    return this.ctx.content.balance.save.storagePrefix + slot;
  }

  private read(slot: string): SaveFile | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.key(slot));
      if (!raw) return null;
      const file = JSON.parse(raw) as SaveFile;
      if (typeof file?.version !== 'number' || !file.state || !file.summary) return null;
      return file;
    } catch {
      return null;
    }
  }

  private migrate(file: SaveFile): SaveFile {
    if (file.version > SAVE_VERSION) {
      throw new Error(`sauvegarde en version ${file.version}, plus récente que le jeu (${SAVE_VERSION})`);
    }
    let current = file;
    while (current.version < SAVE_VERSION) {
      const step = MIGRATIONS[current.version];
      if (!step) throw new Error(`aucune migration depuis la version ${current.version}`);
      current = step(current, this.ctx.content);
    }
    current.state.meta.version = SAVE_VERSION;
    return current;
  }

  private assertValid(state: GameState): void {
    const fob = state?.fob;
    if (!state?.meta || !state.time || !state.resources || !fob) throw new Error('structure incomplète');
    if (!Array.isArray(fob.terrain) || fob.terrain.length !== fob.width * fob.height) throw new Error('terrain corrompu');
    if (!this.ctx.content.sites.some((s) => s.id === state.meta.siteId)) throw new Error(`site inconnu ${state.meta.siteId}`);
  }
}
