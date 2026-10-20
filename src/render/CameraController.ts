/**
 * Caméra de la FOB : glisser (clic droit ou molette enfoncée), clavier (ZQSD / WASD / flèches),
 * zoom à la molette centré sur le curseur, défilement par les bords (optionnel, balance.json).
 */
import Phaser from 'phaser';
import type { BalanceDef } from '../core/ContentTypes';
import type { IsoMath } from './IsoMath';

const DRAG_THRESHOLD = 4;

export class CameraController {
  private readonly cam: Phaser.Cameras.Scene2D.Camera;
  private readonly keys: Record<string, Phaser.Input.Keyboard.Key>;
  private dragging = false;
  private dragDistance = 0;
  /** Option du joueur (prioritaire sur balance.json). */
  edgeScrollEnabled: (() => boolean) | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly iso: IsoMath,
    mapW: number,
    mapH: number,
    private readonly cfg: BalanceDef['camera'],
  ) {
    this.cam = scene.cameras.main;
    const margin = 400;
    const left = iso.toScreen(0, mapH).x;
    const right = iso.toScreen(mapW, 0).x;
    const bottom = iso.toScreen(mapW, mapH).y;
    this.cam.setBounds(left - margin, -margin, right - left + margin * 2, bottom + margin * 2);
    this.cam.setZoom(cfg.startZoom);
    const center = iso.toScreen(mapW / 2, mapH / 2);
    this.cam.centerOn(center.x, center.y);
    this.cam.setRoundPixels(true);

    scene.input.mouse?.disableContextMenu();
    const kb = scene.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,Z,Q,UP,DOWN,LEFT,RIGHT', false) as Record<string, Phaser.Input.Keyboard.Key>;

    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown() || p.middleButtonDown()) {
        this.dragging = true;
        this.dragDistance = 0;
      }
    });
    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      if (!p.rightButtonDown() && !p.middleButtonDown()) {
        this.dragging = false;
        return;
      }
      const dx = p.position.x - p.prevPosition.x;
      const dy = p.position.y - p.prevPosition.y;
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
      this.cam.scrollX -= dx / this.cam.zoom;
      this.cam.scrollY -= dy / this.cam.zoom;
    });
    const stop = (): void => {
      this.dragging = false;
    };
    scene.input.on('pointerup', stop);
    scene.input.on('pointerupoutside', stop);
    scene.input.on('wheel', (p: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
      const factor = dy > 0 ? 1 - cfg.zoomStep : 1 + cfg.zoomStep;
      this.zoomAt(p.x, p.y, this.cam.zoom * factor);
    });
  }

  /** Centre immédiatement la vue sur une case. */
  centerOnGrid(x: number, y: number): void {
    const p = this.iso.toScreen(x, y);
    this.cam.centerOn(p.x, p.y);
  }

  /** Glisse en douceur jusqu'à une case. */
  panToGrid(x: number, y: number): void {
    const p = this.iso.toScreen(x, y);
    this.cam.pan(p.x, p.y, 350, 'Sine.easeInOut');
  }

  get worldView(): Phaser.Geom.Rectangle {
    return this.cam.worldView;
  }

  /** Vrai si le dernier appui droit/milieu a servi à glisser (et non à cliquer). */
  get wasDrag(): boolean {
    return this.dragDistance > DRAG_THRESHOLD;
  }

  update(dtMs: number): void {
    const k = this.keys;
    const speed = (this.cfg.panSpeed * dtMs) / 1000 / this.cam.zoom;
    let vx = 0;
    let vy = 0;
    if (k.A.isDown || k.Q.isDown || k.LEFT.isDown) vx -= 1;
    if (k.D.isDown || k.RIGHT.isDown) vx += 1;
    if (k.W.isDown || k.Z.isDown || k.UP.isDown) vy -= 1;
    if (k.S.isDown || k.DOWN.isDown) vy += 1;

    if ((this.edgeScrollEnabled?.() ?? this.cfg.edgeScroll) && !this.dragging) {
      const p = this.scene.input.activePointer;
      const e = this.cfg.edgeSize;
      if (p.x >= 0 && p.x < e) vx -= 1;
      if (p.x > this.cam.width - e && p.x <= this.cam.width) vx += 1;
      if (p.y >= 0 && p.y < e) vy -= 1;
      if (p.y > this.cam.height - e && p.y <= this.cam.height) vy += 1;
    }
    this.cam.scrollX += vx * speed;
    this.cam.scrollY += vy * speed;
  }

  /** Zoom en gardant fixe le point du monde situé sous (sx, sy). */
  zoomAt(sx: number, sy: number, zoom: number): void {
    const cam = this.cam;
    const z0 = cam.zoom;
    const z1 = Phaser.Math.Clamp(zoom, this.cfg.minZoom, this.cfg.maxZoom);
    if (z1 === z0) return;
    // Phaser zoome autour du centre de la caméra : monde = scroll + w/2 + (écran − w/2) / zoom
    const wx = cam.scrollX + cam.width / 2 + (sx - cam.width / 2) / z0;
    const wy = cam.scrollY + cam.height / 2 + (sy - cam.height / 2) / z0;
    cam.setZoom(z1);
    cam.scrollX = wx - cam.width / 2 - (sx - cam.width / 2) / z1;
    cam.scrollY = wy - cam.height / 2 - (sy - cam.height / 2) / z1;
  }
}
