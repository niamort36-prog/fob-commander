/**
 * RequirementsSystem — besoins de la base proportionnels à l'effectif (balance.json → requirements).
 *
 * Plus la base grandit, plus il lui faut de places au réfectoire, de douches, de latrines, de postes
 * de soins, d'équipements de sport, et de spécialistes (cuisiniers, médical, logisticiens).
 * Chaque besoin non couvert abaisse le moral visé de tout le personnel en proportion de ce qui
 * manque ; des latrines insuffisantes font aussi baisser l'hygiène plus vite.
 * Le système mesure enfin les files d'attente devant les services saturés (dernières 24 h).
 */
import type { RequirementDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { System } from './System';

export interface RequirementStatus {
  def: RequirementDef;
  /** Places (ou spécialistes) disponibles et nécessaires. */
  capacity: number;
  required: number;
  /** Part manquante (0 = couvert, 1 = rien). */
  shortfall: number;
  /** Exigé à cet effectif ? */
  active: boolean;
  /** Attente moyenne devant le service (min) et passages abandonnés, sur 24 h. */
  avgWait: number;
  waits: number;
  gaveUp: number;
  state: 'ok' | 'tight' | 'short' | 'inactive';
}

interface WaitRecord {
  tick: number;
  service: string;
  minutes: number;
  gaveUp: boolean;
}

export class RequirementsSystem implements System {
  readonly id = 'requirements';
  private cache: RequirementStatus[] | null = null;
  private cacheTick = -1;
  private waits: WaitRecord[] = [];

  constructor(private readonly ctx: GameContext) {
    // Bâtiment construit, amélioré ou démoli, recrue ou perte : état à recalculer
    const dirty = (): void => {
      this.cache = null;
    };
    ctx.bus.on('building:completed', dirty);
    ctx.bus.on('building:removed', dirty);
    ctx.bus.on('building:upgraded', dirty);
    ctx.bus.on('agent:spawned', dirty);
    ctx.bus.on('agent:removed', dirty);
  }

  private get cfg() {
    return this.ctx.content.balance.requirements;
  }

  onStateLoaded(): void {
    this.waits = [];
    this.cache = null;
  }

  /** Effectif de la base (en mission compris : ils reviennent). */
  headcount(): number {
    return Object.values(this.ctx.state.agents).filter((a) => a.status !== 'kia').length;
  }

  /** Un agent a attendu devant un service saturé (servi ou parti ailleurs). */
  recordWait(service: string, minutes: number, gaveUp: boolean): void {
    this.waits.push({ tick: this.ctx.state.time.tick, service, minutes, gaveUp });
    this.cache = null;
  }

  private capacityOf(def: RequirementDef): number {
    const s = this.ctx.state;
    if (def.personnel) return Object.values(s.agents).filter((a) => a.defId === def.personnel && a.status !== 'kia').length;
    let slots = 0;
    for (const b of Object.values(s.fob.buildings)) {
      if (b.state !== 'active' && b.state !== 'damaged') continue;
      const services = this.ctx.sim.build.stats(b).services;
      for (const id of def.service ?? []) slots += services[id]?.slots ?? 0;
    }
    return slots;
  }

  /** État de chaque besoin (recalculé au plus une fois par tick). */
  status(): RequirementStatus[] {
    const tick = this.ctx.state.time.tick;
    if (this.cache && this.cacheTick === tick) return this.cache;
    const perTick = this.ctx.content.balance.time.minutesPerTick;
    const since = tick - Math.round((24 * 60) / perTick);
    this.waits = this.waits.filter((w) => w.tick >= since);
    const n = this.headcount();
    this.cache = this.cfg.items.map((def) => {
      const capacity = this.capacityOf(def);
      const required = Math.ceil(n / def.perAgents);
      const active = n >= def.minHeadcount && required > 0;
      const shortfall = active ? Math.max(0, 1 - capacity / required) : 0;
      const w = def.service ? this.waits.filter((x) => def.service!.includes(x.service)) : [];
      const avgWait = w.length ? w.reduce((t, x) => t + x.minutes, 0) / w.length : 0;
      const gaveUp = w.filter((x) => x.gaveUp).length;
      // Juste : un service sans marge ou avec de longues files ; un spécialiste suffit s'il est là
      const noMargin = def.personnel ? false : capacity < required * 1.15;
      const state: RequirementStatus['state'] = !active ? 'inactive' : shortfall > 0 ? 'short' : noMargin || avgWait > 6 || gaveUp > 0 ? 'tight' : 'ok';
      return { def, capacity, required, shortfall, active, avgWait, waits: w.length, gaveUp, state };
    });
    this.cacheTick = tick;
    return this.cache;
  }

  /** Baisse du moral visé de chacun due aux besoins non couverts. */
  moralePenalty(): number {
    const p = this.status().reduce((t, r) => t + r.def.moralePenalty * r.shortfall, 0);
    return Math.min(this.cfg.maxPenalty, p) * this.ramp();
  }

  /** Montée en charge : les premiers jours, le temps de bâtir, les manques pèsent moins. */
  ramp(): number {
    const g = this.cfg.graceDays;
    return g > 0 ? Math.max(0, Math.min(1, (this.ctx.state.time.day - 1) / g)) : 1;
  }

  /** Multiplicateur de la perte d'hygiène (latrines insuffisantes). */
  hygieneDecayMult(): number {
    let m = 1;
    for (const r of this.status()) if (r.def.hygieneDecayMult) m *= 1 + (r.def.hygieneDecayMult - 1) * r.shortfall * this.ramp();
    return m;
  }

  onTick(): void {
    // Calcul paresseux : rien à faire à chaque tick, les consommateurs appellent status()
  }
}
