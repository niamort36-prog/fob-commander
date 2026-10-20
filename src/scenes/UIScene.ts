/**
 * UIScene — interface DOM superposée à la FOB. Lancée en parallèle de FobScene ;
 * rafraîchit les panneaux quelques fois par seconde (inutile de le faire à 60 Hz).
 */
import Phaser from 'phaser';
import { game } from '../core/GameContext';
import type { GameState } from '../core/GameState';
import { AgentPanel } from '../ui/AgentPanel';
import { AlertBanner } from '../ui/AlertBanner';
import { BuildMenu } from '../ui/BuildMenu';
import { el, uiRoot } from '../ui/dom';
import { Hud } from '../ui/Hud';
import { InfoPanel } from '../ui/InfoPanel';
import { LogPanel } from '../ui/LogPanel';
import { LogisticsPanel } from '../ui/LogisticsPanel';
import { MapPanel } from '../ui/MapPanel';
import { MissionPlanner } from '../ui/MissionPlanner';
import { OpsPanel } from '../ui/OpsPanel';
import { RadioPanel } from '../ui/RadioPanel';
import { VillagePanel } from '../ui/VillagePanel';
import { CampaignPanel } from '../ui/CampaignPanel';
import { VehiclePanel } from '../ui/VehiclePanel';
import { RosterPanel } from '../ui/RosterPanel';
import { SaveMenu } from '../ui/SaveMenu';
import { Toasts } from '../ui/Toasts';
import { OptionsPanel } from '../ui/OptionsPanel';
import { TutorialPanel } from '../ui/TutorialPanel';
import { t } from '../utils/i18n';

const REFRESH_MS = 150;

interface UiPart {
  update?(): void;
  destroy(): void;
}

export class UIScene extends Phaser.Scene {
  private layer!: HTMLElement;
  private parts: UiPart[] = [];
  private elapsed = 0;

  constructor() {
    super('UIScene');
  }

  create(): void {
    const ctx = game();
    this.layer = el('div', { class: 'ui-layer' });
    uiRoot().append(this.layer);
    this.elapsed = 0;

    const hud = new Hud(this.layer, ctx, {
      save: () => new SaveMenu(this.layer, ctx, 'save', () => {}),
      load: () => new SaveMenu(this.layer, ctx, 'load', (state) => this.loadGame(state)),
      menu: () => this.quitToMenu(),
    });
    this.parts = [
      hud,
      new BuildMenu(this.layer, ctx),
      new InfoPanel(this.layer, ctx),
      new AgentPanel(this.layer, ctx),
      new RosterPanel(this.layer, ctx),
      new VehiclePanel(this.layer, ctx),
      new LogisticsPanel(this.layer, ctx),
      new LogPanel(this.layer, ctx),
      new Toasts(this.layer, ctx),
      new AlertBanner(this.layer, ctx),
      new MapPanel(this.layer, ctx),
      new OpsPanel(this.layer, ctx),
      new MissionPlanner(this.layer, ctx),
      new RadioPanel(this.layer, ctx),
      new CampaignPanel(this.layer, ctx),
      new VillagePanel(this.layer, ctx),
      new TutorialPanel(this.layer, ctx),
    ];
    const unsubMap = ctx.bus.on('ui:mapToggled', ({ open }) => this.layer.classList.toggle('map-open', open));
    const unsubQuit = ctx.bus.on('ui:quitToMenu', () => this.quitToMenu(false));
    const unsubOptions = ctx.bus.on('ui:openOptions', () => new OptionsPanel(this.layer, ctx));

    // Dialogue d'événement : à l'ouverture d'un événement (ou au chargement d'une partie en plein dialogue)
    const openDialog = (): void => {
      if (!this.scene.isActive('DialogScene')) this.scene.launch('DialogScene');
    };
    const unsub = ctx.bus.on('event:started', openDialog);
    if (ctx.state.events.active) openDialog();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      unsub();
      unsubMap();
      unsubQuit();
      unsubOptions();
      this.scene.stop('DialogScene');
      for (const p of this.parts) p.destroy();
      this.parts = [];
      this.layer.remove();
    });
  }

  override update(_time: number, delta: number): void {
    this.elapsed += delta;
    if (this.elapsed < REFRESH_MS) return;
    this.elapsed = 0;
    for (const p of this.parts) p.update?.();
  }

  private loadGame(state: GameState): void {
    game().loadState(state);
    this.scene.start('FobScene'); // redémarre la FOB, qui relance l'UI
  }

  private quitToMenu(confirm = true): void {
    if (confirm && !window.confirm(t('hud.confirmQuit'))) return;
    this.scene.stop('FobScene');
    this.scene.start('MenuScene');
  }
}
