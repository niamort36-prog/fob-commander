/** Point d'entrée : configuration de Phaser et enregistrement des scènes. */
import Phaser from 'phaser';
import './ui/ui.css';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { SetupScene } from './scenes/SetupScene';
import { FobScene } from './scenes/FobScene';
import { UIScene } from './scenes/UIScene';
import { MapScene } from './scenes/MapScene';
import { DialogScene } from './scenes/DialogScene';

function createGame(): void {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#1b1a14',
    pixelArt: true,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    input: { mouse: { preventDefaultWheel: true } },
    scene: [BootScene, MenuScene, SetupScene, FobScene, UIScene, MapScene, DialogScene],
  };
  const phaserGame = new Phaser.Game(config);
  if (import.meta.env.DEV) (window as unknown as { phaser: Phaser.Game }).phaser = phaserGame; // console de debug
}

/** Le moteur WebGL échoue si la fenêtre n'a pas encore de taille (onglet ou cadre masqué) : on attend. */
function bootWhenSized(): void {
  if (window.innerWidth > 0 && window.innerHeight > 0) createGame();
  else window.setTimeout(bootWhenSized, 100);
}

/**
 * Les sauvegardes restent dans le navigateur de chaque joueur (localStorage, propre à son PC) :
 * on demande un stockage persistant pour que le navigateur ne les efface pas en cas de manque de place.
 */
function keepSavesPersistent(): void {
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    // API indisponible (ancien navigateur, iframe) : stockage habituel
  }
}

keepSavesPersistent();
bootWhenSized();
