/**
 * FobScene — vue isométrique de la base : rendu du monde, saisie (construction, démolition,
 * sélection de bâtiments et d'agents), raccourcis clavier, et avancement de la simulation.
 */
import Phaser from 'phaser';
import { game, type GameContext } from '../core/GameContext';
import type { Selection, ToolMode } from '../core/GameEvents';
import type { BuildingInstance, GridPos, Rotation } from '../core/GameState';
import { AgentRenderer } from '../render/AgentRenderer';
import { PropRenderer } from '../render/PropRenderer';
import { GateRenderer } from '../render/GateRenderer';
import { BuildingRenderer } from '../render/BuildingRenderer';
import { CombatRenderer } from '../render/CombatRenderer';
import { CameraController } from '../render/CameraController';
import { GhostPreview, type GhostNoise } from '../render/GhostPreview';
import { noiseZones } from '../systems/modules';
import type { BuildingDef } from '../core/ContentTypes';
import { IsoMath } from '../render/IsoMath';
import { LightingRenderer } from '../render/LightingRenderer';
import { VisitorRenderer } from '../render/VisitorRenderer';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { VehicleRenderer } from '../render/VehicleRenderer';
import { ZoneRenderer } from '../render/ZoneRenderer';
import { BuildSystem } from '../systems/BuildSystem';
import { audio } from '../audio/AudioManager';

export class FobScene extends Phaser.Scene {
  private ctx!: GameContext;
  private iso!: IsoMath;
  private terrain!: TerrainRenderer;
  private zone!: ZoneRenderer;
  private buildings!: BuildingRenderer;
  private props!: PropRenderer;
  private gates!: GateRenderer;
  private agents!: AgentRenderer;
  private vehicles!: VehicleRenderer;
  private combat!: CombatRenderer;
  private lighting!: LightingRenderer;
  private visitors!: VisitorRenderer;
  private ghost!: GhostPreview;
  private camera!: CameraController;

  private tool: ToolMode = { kind: 'select' };
  private rot: Rotation = 0;
  private lineStart: GridPos | null = null;
  private hover: GridPos | null = null;
  private pointerWorld = { x: 0, y: 0 };
  private selected: Selection | null = null;
  private gridPinned = false;
  private mapOpen = false;
  private unsubs: (() => void)[] = [];

  constructor() {
    super('FobScene');
  }

  create(): void {
    // Phaser réutilise l'instance de scène au redémarrage : on réinitialise tout ici.
    this.ctx = game();
    this.tool = { kind: 'select' };
    this.rot = 0;
    this.lineStart = null;
    this.hover = null;
    this.selected = null;
    this.mapOpen = false;
    this.unsubs = [];

    const { balance } = this.ctx.content;
    const fob = this.ctx.state.fob;
    this.iso = new IsoMath(balance.map.tileWidth, balance.map.tileHeight);
    this.terrain = new TerrainRenderer(this, this.ctx, this.iso);
    this.zone = new ZoneRenderer(this, this.ctx, this.iso);
    this.buildings = new BuildingRenderer(this, this.ctx, this.iso);
    this.props = new PropRenderer(this, this.ctx, this.iso);
    this.gates = new GateRenderer(this, this.ctx, this.iso);
    this.agents = new AgentRenderer(this, this.ctx, this.iso);
    this.vehicles = new VehicleRenderer(this, this.ctx, this.iso);
    this.combat = new CombatRenderer(this, this.ctx, this.iso);
    this.lighting = new LightingRenderer(this, this.ctx, this.iso);
    this.visitors = new VisitorRenderer(this, this.ctx, this.iso);
    this.ghost = new GhostPreview(this, this.iso);
    this.camera = new CameraController(this, this.iso, fob.width, fob.height, balance.camera);
    this.camera.edgeScrollEnabled = () => this.ctx.settings.bool('edgeScroll');
    this.camera.centerOnGrid(fob.zone.x + fob.zone.width / 2, fob.zone.y + fob.zone.height / 2);
    this.terrain.setGridVisible(this.gridPinned);

    this.bindPointer();
    this.bindKeyboard();
    this.bindBus();

    audio()?.setListener(() => {
      const v = this.cameras.main.worldView;
      const g = this.iso.toGridFloat(v.centerX, v.centerY);
      return { x: g.x, y: g.y, mapOpen: this.mapOpen };
    });
    this.scene.launch('UIScene');
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  override update(time: number, delta: number): void {
    this.ctx.sim.update(delta);
    this.camera.update(delta);
    this.terrain.cull(this.camera.worldView);
    this.refreshPreview();
    this.buildings.sync();
    this.props.sync();
    this.gates.sync(time);
    this.agents.sync(this.ctx.sim.alpha);
    this.vehicles.sync(this.ctx.sim.alpha, time);
    this.combat.sync(this.ctx.sim.alpha);
    this.visitors.sync(this.ctx.sim.alpha);
    this.lighting.sync(this.ctx.sim.alpha);
  }

  // ------------------------------------------------------------ Outils et sélection

  private setTool(tool: ToolMode): void {
    this.tool = tool;
    this.lineStart = null;
    if (tool.kind === 'build' && !this.ctx.content.building(tool.defId).rotatable) this.rot = 0;
    this.terrain.setGridVisible(tool.kind === 'build' || this.gridPinned);
    this.ctx.bus.emit('ui:toolChanged', { tool });
  }

  private select(target: Selection | null): void {
    this.ctx.bus.emit('ui:select', { target });
  }

  /**
   * Zones de bruit à montrer pendant le placement : celle du bâtiment bruyant posé (et les
   * logements qu'elle touche), ou celles des stands existants quand on pose un logement.
   */
  private noiseFor(def: BuildingDef, pos: GridPos): GhostNoise[] {
    const content = this.ctx.content;
    const homes = Object.values(this.ctx.state.fob.buildings).filter((b) => content.building(b.defId).services?.sleep);
    const rect = (b: BuildingInstance) => {
      const [w, h] = BuildSystem.footprint(content.building(b.defId), b.rot);
      return { x: b.pos.x, y: b.pos.y, w, h };
    };
    if (def.noise) {
      const [w, h] = BuildSystem.footprint(def, this.rot);
      const x = pos.x + w / 2;
      const y = pos.y + h / 2;
      const exposed = homes.map(rect).filter((r) => Math.hypot(r.x + r.w / 2 - x, r.y + r.h / 2 - y) <= def.noise!.radius);
      return [{ x, y, radius: def.noise.radius, exposed }];
    }
    if (def.services?.sleep) return noiseZones(content, this.ctx.state).map((z) => ({ x: z.x, y: z.y, radius: z.radius }));
    return [];
  }

  private cellAt(p: Phaser.Input.Pointer): GridPos | null {
    const cell = this.iso.toGrid(p.worldX, p.worldY);
    return this.ctx.sim.build.inBounds(cell) ? cell : null;
  }

  /** Position d'un bâtiment multi-cases centrée sur le curseur. */
  private anchoredPos(defId: string, cell: GridPos): GridPos {
    const [w, h] = BuildSystem.footprint(this.ctx.content.building(defId), this.rot);
    return { x: cell.x - Math.floor((w - 1) / 2), y: cell.y - Math.floor((h - 1) / 2) };
  }

  // ------------------------------------------------------------ Entrées

  private bindPointer(): void {
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      this.hover = this.cellAt(p);
      this.pointerWorld = { x: p.worldX, y: p.worldY };
    });

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.button !== 0) return;
      const cell = this.cellAt(p);
      const build = this.ctx.sim.build;
      switch (this.tool.kind) {
        case 'build': {
          if (!cell) return;
          const def = this.ctx.content.building(this.tool.defId);
          if (def.placement.line) this.lineStart = cell;
          else this.ctx.commands.push({ type: 'placeBuilding', defId: def.id, pos: this.anchoredPos(def.id, cell), rot: this.rot });
          break;
        }
        case 'demolish': {
          const b = cell ? build.buildingAt(cell) : null;
          if (b) this.ctx.commands.push({ type: 'demolish', buildingId: b.id });
          break;
        }
        case 'select': {
          // Les agents passent devant les bâtiments pour la sélection.
          const agentId = this.agents.pick(p.worldX, p.worldY);
          if (agentId) {
            this.select({ kind: 'agent', id: agentId });
            break;
          }
          const vehicleId = this.vehicles.pick(p.worldX, p.worldY);
          if (vehicleId) {
            this.select({ kind: 'vehicle', id: vehicleId });
            break;
          }
          const b = cell ? build.buildingAt(cell) : null;
          this.select(b ? { kind: 'building', id: b.id } : null);
          break;
        }
      }
    });

    // Relâchement au-dessus d'un panneau DOM : Phaser émet « pointerupoutside ».
    const onUp = (p: Phaser.Input.Pointer): void => {
      if (p.button === 0 && this.lineStart && this.tool.kind === 'build') {
        const end = this.hover ?? this.lineStart;
        this.ctx.commands.push({ type: 'placeLine', defId: this.tool.defId, cells: BuildSystem.lineCells(this.lineStart, end) });
        this.lineStart = null;
      } else if (p.button === 2 && !this.camera.wasDrag) {
        this.cancel();
      }
    };
    this.input.on('pointerup', onUp);
    this.input.on('pointerupoutside', onUp);
  }

  private bindKeyboard(): void {
    const kb = this.input.keyboard!;
    kb.addCapture('SPACE');
    kb.on('keydown-R', () => {
      if (this.tool.kind === 'build' && this.ctx.content.building(this.tool.defId).rotatable) this.rot = ((this.rot + 1) % 4) as Rotation;
    });
    kb.on('keydown-ESC', () => this.cancel());
    kb.on('keydown-SPACE', () => this.ctx.commands.push({ type: 'togglePause' }));
    kb.on('keydown-ONE', () => this.ctx.commands.push({ type: 'setSpeed', speed: 1 }));
    kb.on('keydown-TWO', () => this.ctx.commands.push({ type: 'setSpeed', speed: 2 }));
    kb.on('keydown-THREE', () => this.ctx.commands.push({ type: 'setSpeed', speed: 4 }));
    kb.on('keydown-FOUR', () => this.ctx.commands.push({ type: 'setSpeed', speed: 8 }));
    kb.on('keydown-X', () => this.setTool({ kind: 'demolish' }));
    kb.on('keydown-P', () => this.ctx.bus.emit('ui:toggleRoster', {}));
    kb.on('keydown-L', () => this.ctx.bus.emit('ui:toggleLogistics', {}));
    kb.on('keydown-M', () => this.ctx.bus.emit('ui:toggleMap', {}));
    kb.on('keydown-O', () => this.ctx.bus.emit('ui:toggleOps', {}));
    kb.on('keydown-C', () => this.ctx.bus.emit('ui:toggleCampaign', {}));
    kb.on('keydown-G', () => {
      this.gridPinned = !this.gridPinned;
      this.terrain.setGridVisible(this.tool.kind === 'build' || this.gridPinned);
    });
    kb.on('keydown-DELETE', () => {
      if (this.selected?.kind === 'building') this.ctx.commands.push({ type: 'demolish', buildingId: this.selected.id });
    });
  }

  private bindBus(): void {
    const bus = this.ctx.bus;
    this.unsubs.push(
      bus.on('ui:setTool', ({ tool }) => this.setTool(tool)),
      bus.on('ui:select', ({ target }) => {
        this.selected = target;
        this.buildings.setSelected(target?.kind === 'building' ? target.id : null);
        this.agents.setSelected(target?.kind === 'agent' ? target.id : null);
        this.vehicles.setSelected(target?.kind === 'vehicle' ? target.id : null);
      }),
      bus.on('ui:focus', ({ pos }) => this.camera.panToGrid(pos.x, pos.y)),
      bus.on('ui:toggleMap', () => this.setMapOpen(!this.mapOpen)),
      bus.on('building:removed', ({ id }) => {
        if (this.selected?.kind === 'building' && this.selected.id === id) this.select(null);
      }),
      bus.on('zone:expanded', () => {
        this.zone.redraw();
        this.terrain.redrawGrid();
      }),
    );
  }

  /**
   * Carte tactique : la vue FOB est masquée et ne reçoit plus les entrées, mais elle continue
   * de faire tourner la simulation (le temps s'écoule pendant qu'on consulte la carte).
   */
  private setMapOpen(open: boolean): void {
    if (open === this.mapOpen) return;
    this.mapOpen = open;
    if (open) {
      this.setTool({ kind: 'select' });
      this.select(null);
      this.scene.launch('MapScene');
    } else {
      this.scene.stop('MapScene');
    }
    this.scene.setVisible(!open);
    this.input.enabled = !open;
    if (this.input.keyboard) this.input.keyboard.enabled = !open;
    this.ctx.bus.emit('ui:mapToggled', { open });
  }

  /** Échap / clic droit : annule la ligne en cours, puis l'outil, puis la sélection. */
  private cancel(): void {
    if (this.lineStart) this.lineStart = null;
    else if (this.tool.kind !== 'select') this.setTool({ kind: 'select' });
    else if (this.selected) this.select(null);
  }

  // ------------------------------------------------------------ Aperçu

  private refreshPreview(): void {
    const hover = this.hover;
    const build = this.ctx.sim.build;
    this.buildings.setHover(null);
    this.agents.setHover(null);
    this.vehicles.setHover(null);

    if (this.tool.kind === 'build') {
      this.terrain.setHover(null);
      if (!hover) {
        this.ghost.hide();
        return;
      }
      const def = this.ctx.content.building(this.tool.defId);
      if (def.placement.line) {
        const cells = this.lineStart ? BuildSystem.lineCells(this.lineStart, hover) : [hover];
        this.ghost.showLine(def, cells, build.checkLine(def.id, cells).map((r) => r.ok));
      } else {
        const pos = this.anchoredPos(def.id, hover);
        const nav = this.ctx.sim.agents.nav;
        const doorClear = BuildSystem.entranceCells(def, pos, this.rot).some((c) => nav.walkable(c.x, c.y));
        this.ghost.showSingle(def, pos, this.rot, build.check(def.id, pos, this.rot).ok, doorClear, this.noiseFor(def, pos));
      }
      return;
    }

    this.ghost.hide();
    if (!hover) {
      this.terrain.setHover(null);
      return;
    }
    const b = build.buildingAt(hover);
    if (this.tool.kind === 'demolish') {
      this.terrain.setHover(hover, 0xe0533f);
      if (b) this.buildings.setHover(b.id, 0xff8a70);
      return;
    }
    const agentId = this.agents.pick(this.pointerWorld.x, this.pointerWorld.y);
    if (agentId) {
      this.terrain.setHover(null);
      this.agents.setHover(agentId);
      return;
    }
    const vehicleId = this.vehicles.pick(this.pointerWorld.x, this.pointerWorld.y);
    if (vehicleId) {
      this.terrain.setHover(null);
      this.vehicles.setHover(vehicleId);
      return;
    }
    this.terrain.setHover(hover);
    if (b) this.buildings.setHover(b.id, 0xfff6d0);
  }

  private cleanup(): void {
    audio()?.setListener(null);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // Les écouteurs d'entrée de la scène sont retirés par Phaser à l'arrêt.
    this.terrain.destroy();
    this.lighting.destroy();
    this.visitors.destroy();
    this.zone.destroy();
    this.buildings.destroy();
    this.props.destroy();
    this.gates.destroy();
    this.agents.destroy();
    this.vehicles.destroy();
    this.combat.destroy();
    this.ghost.destroy();
    this.scene.stop('MapScene');
    this.scene.stop('UIScene');
  }
}
