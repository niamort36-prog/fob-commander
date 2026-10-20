/**
 * MapScene — carte tactique régionale.
 * Fond topographique (généré une fois), voile du brouillard de guerre (zones surveillées et
 * couvertes par les informateurs dégagées), symboles OTAN (FOB, unités alliées, contacts ennemis
 * avec cercle d'incertitude), personnalités, attitude des villages ; déplacement, zoom, sélection.
 * La simulation continue de tourner (portée par FobScene, masquée pendant que la carte est ouverte).
 */
import Phaser from 'phaser';
import type { MapIcon } from '../core/ContentTypes';
import { game, type GameContext } from '../core/GameContext';
import type { MapSelection } from '../core/GameEvents';
import { mapLayers } from '../render/mapState';
import { drawRegionBase } from '../render/regionMap';
import { drawSymbol, type Affiliation } from '../render/mapSymbols';

export const MAP_PX_PER_KM = 32;
export const MAP_MARGIN = 32;
const FOG_PX_PER_KM = 8;
const DRAG_THRESHOLD = 5;

interface Pickable {
  x: number;
  y: number;
  r: number;
  target: MapSelection;
}

export class MapScene extends Phaser.Scene {
  private ctx!: GameContext;
  private overlay!: Phaser.GameObjects.Graphics;
  private labels: Phaser.GameObjects.Text[] = [];
  private fogCanvas!: HTMLCanvasElement;
  private fogTexture!: Phaser.Textures.CanvasTexture;
  private pickables: Pickable[] = [];
  private selected: MapSelection | null = null;
  private dragging = false;
  private dragDist = 0;
  private lastZoom = 0;
  private redrawAt = 0;
  private fogAt = 0;
  private unsubs: (() => void)[] = [];

  constructor() {
    super('MapScene');
  }

  private px(km: number): number {
    return MAP_MARGIN + km * MAP_PX_PER_KM;
  }

  create(): void {
    this.ctx = game();
    this.unsubs = [];
    this.labels = [];
    this.selected = null;
    const def = this.ctx.content.region;
    this.cameras.main.setBackgroundColor('#1b1a14');

    // Fond de carte (mis en cache pour toute la session)
    if (!this.textures.exists('region.base')) {
      const canvas = document.createElement('canvas');
      drawRegionBase(canvas, def, MAP_PX_PER_KM, { labels: true, margin: MAP_MARGIN });
      this.textures.addCanvas('region.base', canvas)!.setFilter(Phaser.Textures.FilterMode.LINEAR);
    }
    this.add.image(0, 0, 'region.base').setOrigin(0, 0);

    // Brouillard de guerre (canevas basse résolution, lissé)
    if (!this.textures.exists('region.fog')) {
      this.fogTexture = this.textures.createCanvas('region.fog', def.size.width * FOG_PX_PER_KM, def.size.height * FOG_PX_PER_KM)!;
      this.fogTexture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    } else {
      this.fogTexture = this.textures.get('region.fog') as Phaser.Textures.CanvasTexture;
    }
    this.fogCanvas = this.fogTexture.getSourceImage() as HTMLCanvasElement;
    this.add
      .image(MAP_MARGIN, MAP_MARGIN, 'region.fog')
      .setOrigin(0, 0)
      .setDisplaySize(def.size.width * MAP_PX_PER_KM, def.size.height * MAP_PX_PER_KM);
    this.drawFog();

    this.overlay = this.add.graphics();

    // Caméra
    const cam = this.cameras.main;
    const w = def.size.width * MAP_PX_PER_KM + MAP_MARGIN * 2;
    const h = def.size.height * MAP_PX_PER_KM + MAP_MARGIN * 2;
    cam.setBounds(-300, -300, w + 600, h + 600);
    cam.setZoom(Math.max(0.45, Math.min(1, this.scale.width / (w * 0.6))));
    const fob = this.ctx.site.regionPos;
    cam.centerOn(this.px(fob.x), this.px(fob.y));
    this.bindInput();

    const redraw = (): void => {
      this.redrawAt = 0;
    };
    this.unsubs.push(
      this.ctx.bus.on('intel:contact', redraw),
      this.ctx.bus.on('mission:launched', redraw),
      this.ctx.bus.on('mission:phase', redraw),
      this.ctx.bus.on('ui:mapLayers', () => {
        this.redrawAt = 0;
        this.fogAt = 0;
      }),
      this.ctx.bus.on('ui:mapSelect', ({ target }) => {
        this.selected = target;
        this.redrawAt = 0;
      }),
      this.ctx.bus.on('ui:mapFocus', ({ x, y }) => this.cameras.main.pan(this.px(x), this.px(y), 350, 'Sine.easeInOut')),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  private bindInput(): void {
    const cam = this.cameras.main;
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', () => {
      this.dragging = true;
      this.dragDist = 0;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.dragging || !p.isDown) return;
      const dx = p.position.x - p.prevPosition.x;
      const dy = p.position.y - p.prevPosition.y;
      this.dragDist += Math.abs(dx) + Math.abs(dy);
      cam.scrollX -= dx / cam.zoom;
      cam.scrollY -= dy / cam.zoom;
    });
    const up = (p: Phaser.Input.Pointer): void => {
      const wasDrag = this.dragDist > DRAG_THRESHOLD;
      this.dragging = false;
      if (!wasDrag && p.button === 0) this.pick(p.worldX, p.worldY);
    };
    this.input.on('pointerup', up);
    this.input.on('pointerupoutside', () => {
      this.dragging = false;
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      const z0 = cam.zoom;
      const z1 = Phaser.Math.Clamp(z0 * (dy > 0 ? 0.88 : 1.12), 0.3, 2.5);
      const wx = cam.scrollX + cam.width / 2 + (p.x - cam.width / 2) / z0;
      const wy = cam.scrollY + cam.height / 2 + (p.y - cam.height / 2) / z0;
      cam.setZoom(z1);
      cam.scrollX = wx - cam.width / 2 - (p.x - cam.width / 2) / z1;
      cam.scrollY = wy - cam.height / 2 - (p.y - cam.height / 2) / z1;
    });
    const kb = this.input.keyboard!;
    kb.on('keydown-M', () => this.ctx.bus.emit('ui:toggleMap', {}));
    kb.on('keydown-ESC', () => {
      if (this.selected) this.ctx.bus.emit('ui:mapSelect', { target: null });
      else this.ctx.bus.emit('ui:toggleMap', {});
    });
    kb.on('keydown-SPACE', () => this.ctx.commands.push({ type: 'togglePause' }));
    kb.on('keydown-O', () => this.ctx.bus.emit('ui:toggleOps', {}));
    kb.on('keydown-C', () => this.ctx.bus.emit('ui:toggleCampaign', {}));
  }

  override update(time: number): void {
    const zoom = this.cameras.main.zoom;
    if (zoom !== this.lastZoom || time >= this.redrawAt) {
      this.lastZoom = zoom;
      this.redrawAt = time + 500;
      this.drawOverlay();
    }
    if (time >= this.fogAt) {
      this.fogAt = time + 2000;
      this.drawFog();
    }
  }

  // ------------------------------------------------------------ Brouillard

  private drawFog(): void {
    const def = this.ctx.content.region;
    const g = this.fogCanvas.getContext('2d')!;
    const k = FOG_PX_PER_KM;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    if (!mapLayers.coverage) {
      this.fogTexture.refresh();
      return;
    }
    g.fillStyle = 'rgba(28, 24, 16, 0.42)';
    g.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    g.globalCompositeOperation = 'destination-out';
    const clear = (x: number, y: number, r: number): void => {
      const grad = g.createRadialGradient(x * k, y * k, r * k * 0.6, x * k, y * k, r * k);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x * k, y * k, r * k, 0, Math.PI * 2);
      g.fill();
    };
    const intel = this.ctx.sim.intel;
    const fob = intel.fobPos();
    clear(fob.x, fob.y, intel.observationKm() * 1.15);
    for (const vid of intel.informantVillages()) {
      const v = def.villages.find((x) => x.id === vid)!;
      clear(v.pos.x, v.pos.y, def.intel.villageCoverKm);
    }
    for (const u of def.friendlyUnits) clear(u.pos.x, u.pos.y, 2);
    g.globalCompositeOperation = 'source-over';
    this.fogTexture.refresh();
  }

  // ------------------------------------------------------------ Symboles

  private label(x: number, y: number, text: string, size: number, color = '#101010', bold = false): void {
    const t = this.add
      .text(x, y, text, {
        fontFamily: 'VT323, "Courier New", monospace',
        fontSize: `${Math.round(size)}px`,
        color,
        stroke: '#f0ead6',
        strokeThickness: Math.max(2, size / 5),
        fontStyle: bold ? 'bold' : 'normal',
      })
      .setOrigin(0.5, 0)
      .setResolution(2);
    this.labels.push(t);
  }

  private drawOverlay(): void {
    const g = this.overlay;
    g.clear();
    for (const t of this.labels) t.destroy();
    this.labels = [];
    this.pickables = [];
    const def = this.ctx.content.region;
    const region = this.ctx.state.region;
    const intel = this.ctx.sim.intel;
    const zoom = this.cameras.main.zoom;
    const k = 1 / Phaser.Math.Clamp(zoom, 0.5, 1.6);
    const S = 22 * k; // taille des symboles, à peu près constante à l'écran
    const fs = 15 * k;
    const sel = this.selected;
    const isSel = (t: MapSelection): boolean => !!sel && sel.kind === t.kind && ('id' in sel ? 'id' in t && sel.id === t.id : true);

    // Attitude des villages (anneau rouge → vert)
    if (mapLayers.villages) {
      for (const v of def.villages) {
        const st = region.villages[v.id];
        if (!st) continue;
        const x = this.px(v.pos.x);
        const y = this.px(v.pos.y);
        const t = (st.attitude + 100) / 200;
        const color = Phaser.Display.Color.GetColor(Math.round(220 * (1 - t) + 60 * t), Math.round(70 * (1 - t) + 170 * t), 60);
        g.lineStyle(3 * k, color, 0.9);
        g.strokeCircle(x, y, 12 * k + (v.type === 'town' ? 6 * k : 0));
        this.pickables.push({ x, y, r: 18 * k, target: { kind: 'village', id: v.id } });
        if (isSel({ kind: 'village', id: v.id })) {
          g.lineStyle(2 * k, 0xffe24a, 1);
          g.strokeCircle(x, y, 22 * k);
        }
      }
    }

    // Surveillance de la FOB
    const fob = intel.fobPos();
    const fx = this.px(fob.x);
    const fy = this.px(fob.y);
    if (mapLayers.coverage) {
      g.lineStyle(1.5 * k, 0x2a5aa0, 0.7);
      const r = intel.observationKm() * MAP_PX_PER_KM;
      for (let a = 0; a < Math.PI * 2; a += 0.12) g.lineBetween(fx + Math.cos(a) * r, fy + Math.sin(a) * r, fx + Math.cos(a + 0.06) * r, fy + Math.sin(a + 0.06) * r);
    }

    // Unités amies et alliées
    if (mapLayers.friendly) {
      for (const u of def.friendlyUnits) {
        const x = this.px(u.pos.x);
        const y = this.px(u.pos.y);
        const box = this.symbol(x, y, S, 'friend', u.icon, false, u.echelon);
        this.label(x, y + box.hh + 3 * k, u.name, fs * 0.85, '#1a3a6a');
        this.pickables.push({ x, y, r: S, target: { kind: 'friendly', id: u.id } });
        if (isSel({ kind: 'friendly', id: u.id })) this.highlight(x, y, S);
      }
    }
    // La FOB du joueur
    const fbox = this.symbol(fx, fy, S * 1.3, 'friend', 'installation', false, 'I');
    this.label(fx, fy + fbox.hh + 3 * k, `FOB — ${this.ctx.site.name}`, fs, '#0e2a5a', true);
    this.pickables.push({ x: fx, y: fy, r: S * 1.3, target: { kind: 'fob' } });
    if (isSel({ kind: 'fob' })) this.highlight(fx, fy, S * 1.3);

    // Contacts ennemis connus
    if (mapLayers.contacts) {
      for (const c of intel.knownContacts()) {
        const cdef = intel.contactDef(c.id);
        const kind = def.contactKinds[cdef.kind];
        const x = this.px(c.estPos.x);
        const y = this.px(c.estPos.y);
        const age = intel.ageHours(c);
        const presumed = c.reliability < 0.5 || age > 48;
        const aff: Affiliation = c.reliability < 0.3 ? 'unknown' : 'hostile';
        if (mapLayers.uncertainty && c.error > 0.2) {
          const r = c.error * MAP_PX_PER_KM;
          g.fillStyle(0xd04030, 0.07);
          g.fillCircle(x, y, r);
          g.lineStyle(1.2 * k, 0xb03020, 0.6);
          for (let a = 0; a < Math.PI * 2; a += 0.18) g.lineBetween(x + Math.cos(a) * r, y + Math.sin(a) * r, x + Math.cos(a + 0.09) * r, y + Math.sin(a + 0.09) * r);
        }
        const box = this.symbol(x, y, S, aff, kind.icon, presumed, aff === 'hostile' ? kind.echelon : '');
        const name = aff === 'unknown' ? 'Contact non identifié' : kind.label;
        this.label(x, y + box.hh + 3 * k, `${name} · ${intel.grade(c)}`, fs * 0.85, '#6a1010');
        this.pickables.push({ x, y, r: S, target: { kind: 'contact', id: c.id } });
        if (isSel({ kind: 'contact', id: c.id })) this.highlight(x, y, S);
      }
    }

    // Unités en mission : itinéraire et position
    for (const m of this.ctx.sim.missions.active()) {
      if (m.phase === 'assembling') continue;
      const p = this.ctx.sim.missions.position(m);
      const tx = this.px(m.target.pos.x);
      const ty = this.px(m.target.pos.y);
      g.lineStyle(1.5 * k, 0x2a5aa0, 0.8);
      const len = Math.hypot(tx - fx, ty - fy);
      for (let d = 0; d < len; d += 12 * k) {
        const t0 = d / len;
        const t1 = Math.min(1, (d + 6 * k) / len);
        g.lineBetween(fx + (tx - fx) * t0, fy + (ty - fy) * t0, fx + (tx - fx) * t1, fy + (ty - fy) * t1);
      }
      const x = this.px(p.x);
      const y = this.px(p.y);
      const box = this.symbol(x, y, S, 'friend', m.vehicleIds.length ? 'mechanized' : 'infantry', false, m.memberIds.length > 8 ? '•••' : '••');
      this.label(x, y + box.hh + 3 * k, m.callsign, fs, '#0e2a5a', true);
      this.pickables.push({ x, y, r: S, target: { kind: 'mission', id: m.id } });
      if (isSel({ kind: 'mission', id: m.id })) this.highlight(x, y, S);
    }

    // Personnalités connues (pastille près de leur village)
    if (mapLayers.personalities) {
      const perVillage = new Map<string, number>();
      for (const p of def.personalities) {
        if (!region.personalities[p.id]?.known) continue;
        const v = def.villages.find((x) => x.id === p.village)!;
        const n = perVillage.get(v.id) ?? 0;
        perVillage.set(v.id, n + 1);
        const x = this.px(v.pos.x) + (18 + n * 16) * k;
        const y = this.px(v.pos.y) - 16 * k;
        const color = p.stance === 'hostile' ? 0xd04030 : p.stance === 'friendly' ? 0x3a7ad0 : 0x8a8a7a;
        g.fillStyle(color, 1);
        g.fillCircle(x, y, 7 * k);
        g.lineStyle(1.5 * k, 0x101010, 1);
        g.strokeCircle(x, y, 7 * k);
        const t = this.add
          .text(x, y, p.name.replace(/^(Hadji|Mollah|Malik|Bibi)\s+/, '').charAt(0), { fontFamily: 'VT323, monospace', fontSize: `${Math.round(11 * k)}px`, color: '#ffffff' })
          .setOrigin(0.5)
          .setResolution(2);
        this.labels.push(t);
        this.pickables.push({ x, y, r: 10 * k, target: { kind: 'personality', id: p.id } });
        if (isSel({ kind: 'personality', id: p.id })) this.highlight(x, y, 10 * k);
      }
    }
  }

  private symbol(x: number, y: number, s: number, aff: Affiliation, icon: MapIcon, dashed: boolean, echelon: string): { hw: number; hh: number } {
    const box = drawSymbol(this.overlay, x, y, s, aff, icon, dashed);
    const k = s / 22;
    if (icon === 'police' || icon === 'ied') {
      const t = this.add
        .text(x, y, icon === 'police' ? 'POL' : 'IED', { fontFamily: 'VT323, monospace', fontSize: `${Math.round(13 * k)}px`, color: '#101010' })
        .setOrigin(0.5)
        .setResolution(2);
      this.labels.push(t);
    }
    if (echelon) {
      const t = this.add
        .text(x, y - box.hh - 1, echelon, { fontFamily: 'VT323, monospace', fontSize: `${Math.round(14 * k)}px`, color: '#101010' })
        .setOrigin(0.5, 1)
        .setResolution(2);
      this.labels.push(t);
    }
    return box;
  }

  private highlight(x: number, y: number, s: number): void {
    this.overlay.lineStyle(2, 0xffe24a, 1);
    this.overlay.strokeCircle(x, y, s * 1.15);
  }

  private pick(wx: number, wy: number): void {
    let best: Pickable | null = null;
    let bestD = Infinity;
    for (const p of this.pickables) {
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d <= p.r && d < bestD) {
        bestD = d;
        best = p;
      }
    }
    this.ctx.bus.emit('ui:mapSelect', { target: best?.target ?? null });
  }

  private cleanup(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const t of this.labels) t.destroy();
    this.labels = [];
  }
}
