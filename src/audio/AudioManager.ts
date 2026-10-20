/**
 * AudioManager — sons synthétisés en direct (Web Audio), décrits dans audio.json.
 *
 *  - Effets : couches d'oscillateurs et de bruit filtré, enveloppes, répétitions, limitation
 *    de fréquence et du nombre de voix ; spatialisation simple (volume et panoramique selon la
 *    position dans la base par rapport au centre de la vue).
 *  - Événements du jeu associés aux sons (audio.json « events ») ; clics de l'interface.
 *  - Ambiance continue dans la vue FOB : vent (rafales), grillons la nuit, ronronnement des
 *    groupes électrogènes ; étouffée quand la carte tactique est ouverte.
 *  - Volumes : général × catégorie (options du joueur), coupure du son.
 * Le contexte audio ne démarre qu'après une première interaction (règle des navigateurs).
 */
import type { AudioDef, SoundDef, SoundLayer } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';

export interface Listener {
  /** Centre de la vue, en cases. */
  x: number;
  y: number;
  mapOpen: boolean;
}

type Category = 'sfx' | 'radio' | 'ui' | 'ambient';

export class AudioManager {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = 0;
  private readonly lastPlayed = new Map<string, number>();
  private listener: (() => Listener) | null = null;
  private ambientTimer: number | null = null;
  private wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private hum: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode } | null = null;
  private nextCricket = 0;
  private readonly def: AudioDef;

  constructor(private readonly ctx: GameContext) {
    this.def = ctx.content.audio;
    const unlock = (): void => {
      this.ensure();
      void this.ac?.resume();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });

    // Clics de l'interface
    document.addEventListener(
      'click',
      (e) => {
        const btn = (e.target as HTMLElement | null)?.closest?.('button');
        if (btn && !(btn as HTMLButtonElement).disabled) this.play('click');
      },
      { capture: true },
    );

    // Événements de la simulation
    for (const [event, sound] of Object.entries(this.def.events)) {
      ctx.bus.on(event as never, ((payload: { x?: number; y?: number }) => this.play(sound, payload?.x, payload?.y)) as never);
    }
    ctx.bus.on('combat:shot', ({ fromX, fromY, friendly }) => this.play(friendly ? 'shotFriendly' : 'shotEnemy', fromX, fromY));
    ctx.bus.on('mission:done', ({ id }) => {
      const m = ctx.hasGame ? ctx.state.missions[id] : undefined;
      this.play(m?.result === 'failure' ? 'failure' : 'success');
    });
    ctx.bus.on('campaign:notice', ({ kind }) => {
      if (kind === 'victory') this.play('fanfare');
      else if (kind === 'defeat' || kind === 'missed') this.play('failure');
      else if (kind === 'phaseDone') this.play('success');
    });
    ctx.settings.onChange(() => this.applyVolumes());
  }

  // ------------------------------------------------------------ Contexte et volumes

  private ensure(): AudioContext | null {
    if (this.ac) return this.ac;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ac = new Ctor();
    this.master = this.ac.createGain();
    this.master.connect(this.ac.destination);
    const len = this.ac.sampleRate * 2;
    this.noise = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    return this.ac;
  }

  private volume(cat: Category): number {
    const s = this.ctx.settings;
    if (s.bool('mute')) return 0;
    return s.num(cat);
  }

  private applyVolumes(): void {
    if (!this.master || !this.ac) return;
    const s = this.ctx.settings;
    this.master.gain.setTargetAtTime(s.bool('mute') ? 0 : s.num('master'), this.ac.currentTime, 0.05);
  }

  // ------------------------------------------------------------ Effets

  /** Position d'écoute (vue FOB) ; null hors de la base (menus). */
  setListener(fn: (() => Listener) | null): void {
    this.listener = fn;
    if (fn) this.startAmbient();
    else this.stopAmbient();
  }

  /** Volume et panoramique selon la position (cases) du son. */
  private spatial(x?: number, y?: number): { gain: number; pan: number } {
    const l = this.listener?.();
    if (!l) return { gain: 1, pan: 0 };
    const muffle = l.mapOpen ? this.def.mapMuffle : 1;
    if (x === undefined || y === undefined) return { gain: muffle, pan: 0 };
    const d = Math.hypot(x - l.x, y - l.y);
    const gain = Math.max(0.06, 1 - d / this.def.hearingTiles) * muffle;
    const pan = Math.max(-0.9, Math.min(0.9, (x - y - (l.x - l.y)) / this.def.hearingTiles));
    return { gain, pan };
  }

  play(id: string, x?: number, y?: number, gainMult = 1): void {
    const sound: SoundDef | undefined = this.def.sounds[id];
    const ac = this.ac;
    if (!sound || !ac || !this.master || ac.state !== 'running') return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(id) ?? -Infinity) < (sound.minGapMs ?? 0)) return;
    if (this.voices >= this.def.maxVoices) return;
    const vol = this.volume(sound.cat as Category) * gainMult;
    if (vol <= 0.001) return;
    this.lastPlayed.set(id, now);
    const { gain, pan } = this.spatial(x, y);
    const out = ac.createGain();
    out.gain.value = vol * gain;
    const panner = ac.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.master);
    const repeat = Math.max(1, sound.repeat ?? 1);
    let end = 0;
    for (let r = 0; r < repeat; r++) {
      const base = ac.currentTime + r * (sound.interval ?? 0);
      for (const layer of sound.layers) end = Math.max(end, this.layer(layer, base, out));
    }
    this.voices++;
    window.setTimeout(
      () => {
        this.voices--;
        out.disconnect();
        panner.disconnect();
      },
      (end - ac.currentTime) * 1000 + 50,
    );
  }

  /** Joue une couche ; renvoie l'instant de fin. */
  private layer(l: SoundLayer, base: number, out: AudioNode): number {
    const ac = this.ac!;
    const t0 = base + (l.delay ?? 0);
    const t1 = t0 + l.dur;
    const attack = Math.min(l.attack ?? 0.004, l.dur * 0.5);
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, l.gain), t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t1);
    let node: AudioNode = env;
    if (l.filter) {
      const f = ac.createBiquadFilter();
      f.type = l.filter.type;
      f.frequency.setValueAtTime(l.filter.freq, t0);
      if (l.filter.freqEnd) f.frequency.exponentialRampToValueAtTime(l.filter.freqEnd, t1);
      if (l.filter.q) f.Q.value = l.filter.q;
      f.connect(env);
      node = f;
    }
    env.connect(out);
    if (l.type === 'noise') {
      const src = ac.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.connect(node);
      src.start(t0, Math.random() * 1.5);
      src.stop(t1 + 0.02);
    } else {
      const osc = ac.createOscillator();
      osc.type = l.wave ?? 'sine';
      osc.frequency.setValueAtTime(l.freq ?? 440, t0);
      if (l.freqEnd) osc.frequency.exponentialRampToValueAtTime(l.freqEnd, t1);
      osc.connect(node);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    return t1;
  }

  // ------------------------------------------------------------ Ambiance

  private startAmbient(): void {
    if (this.ambientTimer !== null) return;
    this.ambientTimer = window.setInterval(() => this.ambientTick(), 250);
  }

  private stopAmbient(): void {
    if (this.ambientTimer !== null) window.clearInterval(this.ambientTimer);
    this.ambientTimer = null;
    if (this.ac) {
      const t = this.ac.currentTime;
      this.wind?.gain.gain.setTargetAtTime(0, t, 0.3);
      this.hum?.gain.gain.setTargetAtTime(0, t, 0.3);
    }
  }

  private ambientTick(): void {
    const ac = this.ac;
    if (!ac || !this.master || ac.state !== 'running' || !this.ctx.hasGame) return;
    const amb = this.def.ambient;
    const l = this.listener?.();
    const muffle = l?.mapOpen ? this.def.mapMuffle : 1;
    const vol = this.volume('ambient') * muffle;
    const t = ac.currentTime;

    if (!this.wind) {
      const src = ac.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = amb.wind.filterFreq;
      const gain = ac.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.wind = { src, filter, gain };
    }
    // Rafales lentes
    const gust = 0.6 + 0.4 * Math.sin((t / amb.wind.gustEverySec) * Math.PI * 2) * Math.sin(t / 3.1);
    this.wind.gain.gain.setTargetAtTime(amb.wind.gain * vol * gust, t, 0.8);
    this.wind.filter.frequency.setTargetAtTime(amb.wind.filterFreq * (0.7 + 0.6 * gust), t, 0.8);

    // Groupes électrogènes en marche
    if (!this.hum) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = amb.generator.freq;
      const osc2 = ac.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = amb.generator.freq * 2;
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 180;
      const gain = ac.createGain();
      gain.gain.value = 0;
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain).connect(this.master);
      osc.start();
      osc2.start();
      this.hum = { osc, osc2, gain };
    }
    const powered = this.ctx.state.resources.power.supply > 0;
    this.hum.gain.gain.setTargetAtTime(powered ? amb.generator.gain * vol : 0, t, 0.5);

    // Grillons la nuit
    const h = this.ctx.state.time.minuteOfDay / 60;
    const night = h >= amb.nightFrom || h < amb.nightTo;
    if (night && vol > 0 && t >= this.nextCricket) {
      this.nextCricket = t + amb.crickets.everySec * (0.6 + Math.random() * 0.8);
      const g = ac.createGain();
      g.gain.value = amb.crickets.gain * vol;
      g.connect(this.master);
      for (let i = 0; i < 3; i++) {
        this.layer({ type: 'tone', wave: 'sine', freq: amb.crickets.freq * (0.97 + Math.random() * 0.06), dur: 0.035, gain: 1, delay: i * 0.06 }, t, g);
      }
      window.setTimeout(() => g.disconnect(), 400);
    }
  }
}

// ---------------------------------------------------------------- Instance globale (côté rendu)

let audioInstance: AudioManager | null = null;

export function setAudio(a: AudioManager): void {
  audioInstance = a;
}

/** Gestionnaire audio, ou null (tests, navigateur sans Web Audio). */
export function audio(): AudioManager | null {
  return audioInstance;
}
