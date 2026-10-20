/** MenuScene — écran titre : continuer, nouvelle partie, charger. */
import Phaser from 'phaser';
import { game } from '../core/GameContext';
import type { GameState } from '../core/GameState';
import { el, uiRoot } from '../ui/dom';
import { SaveMenu } from '../ui/SaveMenu';
import { OptionsPanel } from '../ui/OptionsPanel';
import { t } from '../utils/i18n';

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('MenuScene');
  }

  create(): void {
    const ctx = game();
    const root = uiRoot();
    const save = ctx.sim.save;
    const latest = save.latest();

    const screen = el('div', { class: 'screen menu-screen' }, [
      el('div', { class: 'panel menu-box' }, [
        el('div', { class: 'title', text: t('menu.title') }),
        el('div', { class: 'subtitle', text: t('menu.subtitle') }),
        latest
          ? el('button', {
              class: 'btn big',
              text: t('menu.continue'),
              onClick: () => {
                const state = save.load(latest);
                if (state) this.startGame(state);
              },
            })
          : null,
        el('button', { class: 'btn big', text: t('menu.new'), onClick: () => this.scene.start('SetupScene') }),
        el('button', {
          class: 'btn big',
          text: t('menu.load'),
          onClick: () => new SaveMenu(root, ctx, 'load', (state) => this.startGame(state)),
        }),
        el('button', { class: 'btn big', text: t('menu.options'), onClick: () => new OptionsPanel(root, ctx) }),
        el('button', {
          class: 'btn big',
          text: t('menu.about'),
          onClick: () => {
            const box = el('div', { class: 'modal-backdrop' });
            box.append(
              el('div', { class: 'panel modal about' }, [
                el('div', { class: 'panel-title', text: t('menu.about') }),
                ...t('menu.aboutText').split('|').map((l) => el('p', { text: l })),
                el('button', { class: 'btn primary', text: t('options.close'), onClick: () => box.remove() }),
              ]),
            );
            root.append(box);
          },
        }),
        el('div', { class: 'menu-help muted small', text: t('menu.help') }),
        el('div', { class: 'muted small', text: t('menu.version') }),
      ]),
    ]);
    root.append(screen);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => screen.remove());
  }

  private startGame(state: GameState): void {
    game().loadState(state);
    this.scene.start('FobScene');
  }
}
