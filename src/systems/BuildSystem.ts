/**
 * BuildSystem — placement, validation, chantiers et démolition des bâtiments.
 * Maintient l'index d'occupation de la grille (state.fob.occupancy).
 */
import type { Command } from '../core/Commands';
import type { BuildingDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { PlacementReason } from '../core/GameEvents';
import type { BuildingInstance, GridPos, Id, ResourceBag, Rotation } from '../core/GameState';
import { buildingStats, levelName, nextLevel } from '../core/buildingStats';
import { pushLog } from '../core/Log';
import { bagEntries, canAfford, gain, scaleBag, spend } from '../core/resources';
import { newId } from '../utils/ids';
import type { System } from './System';

export interface PlacementCheck {
  ok: boolean;
  reason?: PlacementReason;
}

export class BuildSystem implements System {
  readonly id = 'build';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('time:hour', () => this.applyWear());
  }

  // ------------------------------------------------------------ Géométrie

  /** Emprise [w, h] après rotation. */
  static footprint(def: BuildingDef, rot: Rotation): [number, number] {
    const [w, h] = def.footprint;
    return rot % 2 === 0 ? [w, h] : [h, w];
  }

  static cells(def: BuildingDef, pos: GridPos, rot: Rotation): GridPos[] {
    const [w, h] = BuildSystem.footprint(def, rot);
    const out: GridPos[] = [];
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push({ x: pos.x + dx, y: pos.y + dy });
    return out;
  }

  /** Cases d'une ligne droite de a vers b, selon l'axe dominant (murs, routes). */
  static lineCells(a: GridPos, b: GridPos): GridPos[] {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const out: GridPos[] = [];
    if (Math.abs(dx) >= Math.abs(dy)) {
      const step = Math.sign(dx) || 1;
      for (let i = 0; i <= Math.abs(dx); i++) out.push({ x: a.x + i * step, y: a.y });
    } else {
      const step = Math.sign(dy);
      for (let i = 0; i <= Math.abs(dy); i++) out.push({ x: a.x, y: a.y + i * step });
    }
    return out;
  }

  inBounds(p: GridPos): boolean {
    const fob = this.ctx.state.fob;
    return p.x >= 0 && p.y >= 0 && p.x < fob.width && p.y < fob.height;
  }

  buildingAt(p: GridPos): BuildingInstance | null {
    if (!this.inBounds(p)) return null;
    const fob = this.ctx.state.fob;
    const id = fob.occupancy[p.y * fob.width + p.x];
    return id ? (fob.buildings[id] ?? null) : null;
  }

  /**
   * Côté de l'entrée d'un bâtiment à porte (vecteur unitaire vers l'extérieur), ou null.
   * Les tentes s'ouvrent sur un pignon, les autres sur la grande façade ; la rotation fait tourner l'entrée.
   */
  static entranceSide(def: BuildingDef, rot: Rotation): GridPos | null {
    if (!def.entrance) return null;
    const sides: GridPos[] = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
    ];
    const base = def.visual.style === 'tent' ? 0 : 1;
    return sides[(base + rot) % 4];
  }

  /** Cases situées devant la porte (le long du côté de l'entrée, à l'extérieur de l'emprise). */
  static entranceCells(def: BuildingDef, pos: GridPos, rot: Rotation): GridPos[] {
    const side = BuildSystem.entranceSide(def, rot);
    if (!side) return [];
    const [w, h] = BuildSystem.footprint(def, rot);
    const out: GridPos[] = [];
    if (side.x !== 0) {
      const x = side.x > 0 ? pos.x + w : pos.x - 1;
      for (let y = pos.y; y < pos.y + h; y++) out.push({ x, y });
    } else {
      const y = side.y > 0 ? pos.y + h : pos.y - 1;
      for (let x = pos.x; x < pos.x + w; x++) out.push({ x, y });
    }
    return out;
  }

  /** Raison du verrouillage : réputation insuffisante ou bâtiment pas encore acheté. */
  lockReason(def: BuildingDef): 'level' | 'points' | null {
    const p = this.ctx.state.progression;
    if (def.unlock.reputation > p.reputation) return 'level';
    if ((def.unlock.points ?? 0) > 0 && !p.unlocked.includes(def.id)) return 'points';
    return null;
  }

  isLocked(def: BuildingDef): boolean {
    return this.lockReason(def) !== null;
  }

  /** Achète le déblocage d'un bâtiment avec des points de réputation. */
  unlock(defId: string): boolean {
    const def = this.ctx.content.building(defId);
    const p = this.ctx.state.progression;
    const reason = this.lockReason(def);
    if (reason !== 'points') {
      if (reason) this.ctx.bus.emit('progression:unlockRejected', { defId, reason });
      return false;
    }
    const cost = def.unlock.points ?? 0;
    if (p.points < cost) {
      this.ctx.bus.emit('progression:unlockRejected', { defId, reason: 'points' });
      return false;
    }
    p.points -= cost;
    p.unlocked.push(defId);
    pushLog(this.ctx, 'good', 'log.purchased', { name: def.name, pts: cost });
    this.ctx.bus.emit('progression:purchased', { defId });
    return true;
  }

  /** Case à l'intérieur du périmètre possédé. */
  inZone(p: GridPos): boolean {
    const z = this.ctx.state.fob.zone;
    return p.x >= z.x && p.y >= z.y && p.x < z.x + z.width && p.y < z.y + z.height;
  }

  // ------------------------------------------------------------ Périmètre

  /** Coût du prochain agrandissement, ou null si le périmètre couvre déjà toute la carte. */
  expansionCost(): number | null {
    const { zone, width, height } = this.ctx.state.fob;
    if (zone.width >= width && zone.height >= height) return null;
    const cfg = this.ctx.content.balance.zone;
    return Math.round((cfg.baseCost * Math.pow(cfg.costGrowth, zone.expansions)) / 100) * 100;
  }

  /** Agrandit le périmètre de `zone.step` cases de chaque côté (dans les limites de la carte). */
  expandZone(): boolean {
    const state = this.ctx.state;
    const cost = this.expansionCost();
    if (cost === null) {
      this.ctx.bus.emit('zone:rejected', { reason: 'max' });
      return false;
    }
    if (state.resources.stock.funds < cost) {
      this.ctx.bus.emit('zone:rejected', { reason: 'funds' });
      return false;
    }
    spend(state, { funds: cost });
    const { zone, width, height } = state.fob;
    const step = this.ctx.content.balance.zone.step;
    const x0 = Math.max(0, zone.x - step);
    const y0 = Math.max(0, zone.y - step);
    const x1 = Math.min(width, zone.x + zone.width + step);
    const y1 = Math.min(height, zone.y + zone.height + step);
    state.fob.zone = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, expansions: zone.expansions + 1 };
    pushLog(this.ctx, 'good', 'log.zoneExpanded', { width: x1 - x0, height: y1 - y0, cost });
    this.ctx.bus.emit('zone:expanded', { zone: state.fob.zone, cost });
    return true;
  }

  // ------------------------------------------------------------ Validation

  /** Contrôle d'emplacement hors coût (verrou, limites, périmètre, terrain, occupation). */
  private checkCells(def: BuildingDef, cells: GridPos[]): PlacementReason | null {
    if (this.isLocked(def)) return 'locked';
    const { fob } = this.ctx.state;
    const allowed = def.placement.allowedTerrain;
    if (!cells.every((c) => this.inBounds(c))) return 'bounds';
    if (!cells.every((c) => this.inZone(c))) return 'zone';
    for (const c of cells) {
      const i = c.y * fob.width + c.x;
      const terrain = this.ctx.content.terrainAt(fob.terrain[i]);
      if (!terrain.buildable || (allowed && !allowed.includes(terrain.id))) return 'terrain';
      if (fob.occupancy[i] !== null) return 'occupied';
    }
    return null;
  }

  check(defId: string, pos: GridPos, rot: Rotation): PlacementCheck {
    if (!this.ctx.content.hasBuilding(defId)) return { ok: false, reason: 'unknown' };
    const def = this.ctx.content.building(defId);
    const reason = this.checkCells(def, BuildSystem.cells(def, pos, rot));
    if (reason) return { ok: false, reason };
    if (!canAfford(this.ctx.state, def.cost)) return { ok: false, reason: 'funds' };
    return { ok: true };
  }

  /** Contrôle case par case d'une ligne, en cumulant le coût. */
  checkLine(defId: string, cells: GridPos[]): PlacementCheck[] {
    if (!this.ctx.content.hasBuilding(defId)) return cells.map(() => ({ ok: false, reason: 'unknown' }));
    const def = this.ctx.content.building(defId);
    const budget = { ...this.ctx.state.resources.stock };
    return cells.map((c) => {
      const reason = this.checkCells(def, [c]);
      if (reason) return { ok: false, reason };
      const affordable = bagEntries(def.cost).every(([id, v]) => budget[id] >= v);
      if (!affordable) return { ok: false, reason: 'funds' };
      for (const [id, v] of bagEntries(def.cost)) budget[id] -= v;
      return { ok: true };
    });
  }

  // ------------------------------------------------------------ Actions

  place(defId: string, pos: GridPos, rot: Rotation, quiet = false): BuildingInstance | null {
    const res = this.check(defId, pos, rot);
    if (!res.ok) {
      if (!quiet) this.ctx.bus.emit('build:rejected', { defId, reason: res.reason ?? 'unknown' });
      return null;
    }
    const def = this.ctx.content.building(defId);
    const state = this.ctx.state;
    const effectiveRot: Rotation = def.rotatable ? rot : 0;
    const b: BuildingInstance = {
      id: newId(state, 'bld'),
      defId,
      pos: { x: pos.x, y: pos.y },
      rot: effectiveRot,
      level: 1,
      state: def.buildTimeMin > 0 ? 'construction' : 'active',
      buildProgress: def.buildTimeMin > 0 ? 0 : 1,
      hp: def.hp,
      wear: 0,
      upgrade: null,
      modules: [],
      moduleWork: null,
    };
    spend(state, def.cost);
    if (b.state === 'construction') this.ctx.sim.logistics.startMaterials(b, def.cost);
    state.fob.buildings[b.id] = b;
    this.setOccupancy(b, b.id);
    this.ctx.bus.emit('building:placed', { id: b.id, defId });
    if (b.state === 'active') this.ctx.bus.emit('building:completed', { id: b.id, defId });
    return b;
  }

  /** Pose une ligne ; s'arrête aux cases invalides, continue jusqu'à épuisement des fonds. Renvoie le nombre posé. */
  placeLine(defId: string, cells: GridPos[]): number {
    if (!this.ctx.content.hasBuilding(defId)) return 0;
    let placed = 0;
    let firstFailure: PlacementReason | null = null;
    let fundsFailure = false;
    for (const c of cells) {
      const res = this.check(defId, c, 0);
      if (!res.ok) {
        firstFailure ??= res.reason ?? 'unknown';
        if (res.reason === 'funds') fundsFailure = true;
        continue;
      }
      if (this.place(defId, c, 0, true)) placed++;
    }
    if (placed === 0 && firstFailure) {
      this.ctx.bus.emit('build:rejected', { defId, reason: firstFailure });
    } else if (fundsFailure) {
      this.ctx.bus.emit('build:rejected', { defId, reason: 'funds' });
    }
    if (placed > 1) {
      pushLog(this.ctx, 'info', 'log.lineStarted', { count: placed, name: this.ctx.content.building(defId).name });
    }
    return placed;
  }

  refundFor(b: BuildingInstance): ResourceBag {
    const def = this.ctx.content.building(b.defId);
    const { refundRatio, refundRatioUnderConstruction } = this.ctx.content.balance.build;
    return scaleBag(def.cost, b.state === 'construction' ? refundRatioUnderConstruction : refundRatio);
  }

  demolish(id: Id): boolean {
    const state = this.ctx.state;
    const b = state.fob.buildings[id];
    if (!b) return false;
    const refund = this.refundFor(b);
    gain(state, refund);
    this.setOccupancy(b, null);
    delete state.fob.buildings[id];
    const def = this.ctx.content.building(b.defId);
    if (!def.placement.line) pushLog(this.ctx, 'info', 'log.demolished', { name: def.name, refund: refund.funds ?? 0 });
    this.ctx.bus.emit('building:removed', { id, defId: b.defId, refund });
    return true;
  }

  // ------------------------------------------------------------ Simulation

  /**
   * Multiplicateur de vitesse d'un chantier : équipe locale de base + ouvriers présents
   * (efficacité et mécanique). 1 = durée nominale `buildTimeMin`.
   */
  constructionSpeed(b: BuildingInstance): number {
    const cfg = this.ctx.content.balance.build;
    return cfg.baseCrewRate + cfg.workerRate * this.ctx.sim.agents.builderPower(b.id);
  }

  // ------------------------------------------------------------ Améliorations, usure, réparations

  /**
   * Le bâtiment a-t-il besoin d'ouvriers ? Chantier, amélioration, ou réparation
   * (démarrée au-delà de `repairStartAt`, poursuivie jusqu'à `repairDoneAt`).
   */
  /**
   * Avancement d'un chantier pendant un tick : l'équipe locale apporte et monte sa part ;
   * les ouvriers ne peuvent monter que les matériaux déjà livrés sur place.
   */
  private advance(b: BuildingInstance, progress: number, buildTimeMin: number): number {
    const cfg = this.ctx.content.balance.build;
    const minutes = this.ctx.content.balance.time.minutesPerTick;
    const T = Math.max(1, buildTimeMin);
    const logistics = this.ctx.sim.logistics;
    logistics.crewDeliver(b, (minutes * cfg.baseCrewRate) / T);
    const wanted = progress + (minutes * this.constructionSpeed(b)) / T;
    return Math.min(1, Math.max(progress, Math.min(wanted, logistics.materialCap(b) + 1e-12)));
  }

  /** Ouvriers bloqués faute de matériaux sur place. */
  waitingForMaterials(b: BuildingInstance): boolean {
    const m = b.materials;
    if (!m || this.ctx.sim.agents.builderPower(b.id) <= 0) return false;
    return m.delivered < m.needed - 1e-6 && this.ctx.sim.logistics.onSite(b) < 0.05;
  }

  needsWork(b: BuildingInstance, continuing: boolean): boolean {
    if (b.state === 'construction' || b.upgrade || b.moduleWork) return true;
    const wear = this.ctx.content.balance.wear;
    return b.wear >= (continuing ? wear.repairDoneAt : wear.repairStartAt);
  }

  upgradeCheck(b: BuildingInstance): 'max' | 'funds' | 'busy' | null {
    const lv = nextLevel(this.ctx.content.building(b.defId), b.level);
    if (!lv) return 'max';
    if (b.upgrade || b.moduleWork || b.state === 'construction' || b.state === 'disabled') return 'busy';
    if (!canAfford(this.ctx.state, lv.cost)) return 'funds';
    return null;
  }

  /** Raison pour laquelle une amélioration ne peut pas être installée, ou null. */
  moduleCheck(b: BuildingInstance, moduleId: string): 'installed' | 'requires' | 'busy' | 'funds' | 'unknown' | null {
    const m = this.ctx.content.building(b.defId).modules?.find((x) => x.id === moduleId);
    if (!m) return 'unknown';
    if (b.modules?.includes(moduleId)) return 'installed';
    if (m.requires && !b.modules?.includes(m.requires)) return 'requires';
    if (b.upgrade || b.moduleWork || b.state === 'construction' || b.state === 'disabled') return 'busy';
    if (!canAfford(this.ctx.state, m.cost)) return 'funds';
    return null;
  }

  /** Lance l'installation : paiement immédiat, travaux réalisés par les ouvriers. */
  installModule(id: Id, moduleId: string): boolean {
    const b = this.ctx.state.fob.buildings[id];
    if (!b || this.moduleCheck(b, moduleId)) return false;
    const def = this.ctx.content.building(b.defId);
    const m = def.modules!.find((x) => x.id === moduleId)!;
    spend(this.ctx.state, m.cost);
    b.moduleWork = { id: moduleId, progress: 0 };
    this.ctx.sim.logistics.startMaterials(b, m.cost);
    pushLog(this.ctx, 'info', 'log.moduleStarted', { name: m.name, building: def.name });
    return true;
  }

  /** Lance l'amélioration : paiement immédiat, chantier réalisé par les ouvriers, bâtiment toujours en service. */
  startUpgrade(id: Id): boolean {
    const b = this.ctx.state.fob.buildings[id];
    if (!b) return false;
    const reason = this.upgradeCheck(b);
    if (reason) {
      this.ctx.bus.emit('upgrade:rejected', { reason });
      return false;
    }
    const def = this.ctx.content.building(b.defId);
    const lv = nextLevel(def, b.level)!;
    spend(this.ctx.state, lv.cost);
    b.upgrade = { progress: 0 };
    this.ctx.sim.logistics.startMaterials(b, lv.cost);
    pushLog(this.ctx, 'info', 'log.upgradeStarted', { name: levelName(def, b.level + 1) });
    return true;
  }

  /** Usure horaire et changements d'état (endommagé, hors service). */
  private applyWear(): void {
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      if (b.state === 'construction') continue;
      const def = this.ctx.content.building(b.defId);
      if (def.wearPerDay) b.wear = Math.min(1, b.wear + def.wearPerDay / 24);
      this.updateCondition(b);
    }
  }

  /** Dégâts (tirs, explosions, tempête) : augmente l'usure et met à jour l'état du bâtiment. */
  applyDamage(b: BuildingInstance, amount: number): void {
    if (b.state === 'construction' || amount <= 0) return;
    b.wear = Math.min(1, b.wear + amount);
    this.updateCondition(b);
  }

  updateCondition(b: BuildingInstance): void {
    const cfg = this.ctx.content.balance.wear;
    const def = this.ctx.content.building(b.defId);
    const before = b.state;
    b.state = b.wear >= cfg.disabledAt ? 'disabled' : b.wear >= cfg.damagedAt ? 'damaged' : 'active';
    if (b.state === before) return;
    if (b.state === 'damaged' && before === 'active') pushLog(this.ctx, 'warn', 'log.damaged', { name: def.name });
    if (b.state === 'disabled') pushLog(this.ctx, 'bad', 'log.disabled', { name: def.name });
    if (b.state === 'active') pushLog(this.ctx, 'good', 'log.repaired', { name: def.name });
    this.ctx.bus.emit('building:completed', { id: b.id, defId: b.defId }); // capacités et services à recalculer
  }

  private hasWorkshop(): boolean {
    return Object.values(this.ctx.state.fob.buildings).some(
      (b) => (b.state === 'active' || b.state === 'damaged') && (this.ctx.content.building(b.defId).provides?.maintenance ?? 0) > 0,
    );
  }

  onTick(): void {
    const minutesPerTick = this.ctx.content.balance.time.minutesPerTick;
    const wearCfg = this.ctx.content.balance.wear;
    let workshop: boolean | null = null;
    for (const b of Object.values(this.ctx.state.fob.buildings)) {
      const def = this.ctx.content.building(b.defId);
      if (b.state === 'construction') {
        b.buildProgress = this.advance(b, b.buildProgress, def.buildTimeMin);
        // Tolérance : la somme de N fois 1/N n'atteint pas toujours exactement 1 en flottant.
        if (b.buildProgress >= 1 - 1e-9) {
          b.buildProgress = 1;
          b.state = 'active';
          b.materials = null;
          if (!def.placement.line) pushLog(this.ctx, 'good', 'log.built', { name: def.name });
          this.ctx.bus.emit('building:completed', { id: b.id, defId: b.defId });
        }
        continue;
      }
      if (b.moduleWork) {
        const m = def.modules?.find((x) => x.id === b.moduleWork!.id);
        if (!m) {
          b.moduleWork = null;
          continue;
        }
        b.moduleWork.progress = this.advance(b, b.moduleWork.progress, m.buildTimeMin);
        if (b.moduleWork.progress >= 1 - 1e-9) {
          b.materials = null;
          b.modules = [...(b.modules ?? []), m.id];
          b.moduleWork = null;
          pushLog(this.ctx, 'good', 'log.moduleDone', { name: m.name, building: def.name });
          this.ctx.bus.emit('building:moduleInstalled', { id: b.id, defId: b.defId, moduleId: m.id });
        }
        continue;
      }
      if (b.upgrade) {
        const lv = nextLevel(def, b.level);
        if (!lv) {
          b.upgrade = null;
          continue;
        }
        b.upgrade.progress = this.advance(b, b.upgrade.progress, lv.buildTimeMin);
        if (b.upgrade.progress >= 1 - 1e-9) {
          b.materials = null;
          b.upgrade = null;
          b.level += 1;
          pushLog(this.ctx, 'good', 'log.upgraded', { name: levelName(def, b.level) });
          this.ctx.bus.emit('building:upgraded', { id: b.id, defId: b.defId, level: b.level });
        }
        continue;
      }
      // Réparation par les ouvriers présents (consomme des pièces)
      const power = this.ctx.sim.agents.builderPower(b.id);
      if (power <= 0 || b.wear <= 0) continue;
      workshop ??= this.hasWorkshop();
      const delta = Math.min(b.wear, (wearCfg.repairPerHourPerWorker / 60) * minutesPerTick * power * (workshop ? wearCfg.workshopRepairMult : 1));
      const parts = delta * wearCfg.partsPerWear;
      if (this.ctx.state.resources.stock.parts < parts) {
        this.ctx.sim.economy.flagShortage('parts');
        continue;
      }
      spend(this.ctx.state, { parts });
      b.wear -= delta;
      this.updateCondition(b);
    }
  }

  /** Caractéristiques effectives (niveau compris). */
  stats(b: BuildingInstance) {
    return buildingStats(this.ctx.content.building(b.defId), b.level);
  }

  onStateLoaded(): void {
    const fob = this.ctx.state.fob;
    fob.occupancy = new Array<Id | null>(fob.width * fob.height).fill(null);
    for (const b of Object.values(fob.buildings)) {
      if (!this.ctx.content.hasBuilding(b.defId)) {
        console.warn(`[BuildSystem] bâtiment « ${b.defId} » absent du contenu : retiré`);
        delete fob.buildings[b.id];
        continue;
      }
      this.setOccupancy(b, b.id);
    }
  }

  handleCommand(cmd: Command): boolean {
    switch (cmd.type) {
      case 'placeBuilding':
        this.place(cmd.defId, cmd.pos, cmd.rot);
        return true;
      case 'placeLine':
        this.placeLine(cmd.defId, cmd.cells);
        return true;
      case 'demolish':
        this.demolish(cmd.buildingId);
        return true;
      case 'expandZone':
        this.expandZone();
        return true;
      case 'upgradeBuilding':
        this.startUpgrade(cmd.buildingId);
        return true;
      case 'unlockBuilding':
        this.unlock(cmd.defId);
        return true;
      case 'installModule':
        this.installModule(cmd.buildingId, cmd.moduleId);
        return true;
      default:
        return false;
    }
  }

  private setOccupancy(b: BuildingInstance, value: Id | null): void {
    const fob = this.ctx.state.fob;
    const def = this.ctx.content.building(b.defId);
    for (const c of BuildSystem.cells(def, b.pos, b.rot)) {
      if (this.inBounds(c)) fob.occupancy[c.y * fob.width + c.x] = value;
    }
  }
}
