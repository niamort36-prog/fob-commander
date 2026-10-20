/** BootScene — chargement des atlas, validation du contenu JSON, génération des placeholders. */
import Phaser from 'phaser';
import { AssetLoader } from '../assets/AssetLoader';
import { AudioManager, setAudio } from '../audio/AudioManager';
import { PlaceholderFactory } from '../assets/PlaceholderFactory';
import { ContentError, loadDefaultContent, type ContentRegistry } from '../core/ContentRegistry';
import { GameContext, setGame } from '../core/GameContext';
import { el, uiRoot } from '../ui/dom';
import { t } from '../utils/i18n';

const FONT_TIMEOUT_MS = 1500;

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    AssetLoader.preload(this);
  }

  create(): void {
    let content: ContentRegistry;
    try {
      content = loadDefaultContent();
    } catch (e) {
      this.showFatal(e);
      return;
    }

    const ctx = new GameContext(content);
    setGame(ctx);
    const sound = new AudioManager(ctx);
    setAudio(sound);
    if (import.meta.env.DEV) (window as unknown as { fobAudio: AudioManager }).fobAudio = sound;
    if (import.meta.env.DEV) (window as unknown as { fob: GameContext }).fob = ctx; // console de debug

    AssetLoader.indexAtlases(this);
    const generated = PlaceholderFactory.ensureAll(this, content);
    console.info(`[Boot] contenu validé, ${generated} texture(s) de remplacement générée(s)`);

    // Attend la police pixel (sans bloquer si elle est indisponible hors ligne).
    const font = document.fonts ? document.fonts.load('20px "VT323"').catch(() => undefined) : Promise.resolve();
    const timeout = new Promise((resolve) => window.setTimeout(resolve, FONT_TIMEOUT_MS));
    void Promise.race([font, timeout]).then(() => this.scene.start('MenuScene'));
  }

  private showFatal(e: unknown): void {
    const errors = e instanceof ContentError ? e.errors : [e instanceof Error ? e.message : String(e)];
    console.error('[Boot] erreur fatale', e);
    uiRoot().append(
      el('div', { class: 'screen' }, [
        el('div', { class: 'panel fatal' }, [
          el('div', { class: 'panel-title', text: t('boot.contentError') }),
          el('ul', {}, errors.map((msg) => el('li', { text: msg }))),
        ]),
      ]),
    );
  }
}
