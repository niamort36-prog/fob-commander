/**
 * CareerSystem — expérience et grades du personnel.
 *
 * Chaque métier a sa carrière (personnel.json → career : grades successifs et XP requise).
 * L'expérience s'accumule au fil des actions : heures de garde, de chantier, d'entraînement ou de
 * défense (activities.json → xpPerHour), missions (réussies, partielles, et même ratées), ennemis
 * abattus, attaques repoussées, menaces arrêtées au poste de garde, contacts radio.
 * Dès que l'XP atteint le seuil du grade suivant, le soldat est promu : annonce au journal,
 * moral en hausse et quelques points de compétences (balance.json → career).
 */
import type { CareerStep } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { Agent } from '../core/GameState';
import { pushLog } from '../core/Log';
import type { System } from './System';

export interface CareerProgress {
  rank: string;
  /** Grade suivant (null au sommet de la carrière). */
  next: CareerStep | null;
  /** XP du grade actuel et du suivant. */
  from: number;
  to: number;
  /** Avancement vers le grade suivant (0..1). */
  ratio: number;
}

export class CareerSystem implements System {
  readonly id = 'career';

  constructor(private readonly ctx: GameContext) {
    ctx.bus.on('agent:spawned', ({ id }) => {
      const a = ctx.state.agents[id];
      if (a) this.alignXp(a);
    });
  }

  private get cfg() {
    return this.ctx.content.balance.career;
  }

  private career(a: Agent): CareerStep[] {
    return this.ctx.content.personnel(a.defId).career ?? [];
  }

  /** Échelon actuel dans la carrière (le plus haut portant ce grade), -1 si grade hors carrière. */
  private index(a: Agent): number {
    const c = this.career(a);
    for (let i = c.length - 1; i >= 0; i--) if (c[i].rank === a.rank) return i;
    return -1;
  }

  /** L'XP d'un soldat ne peut pas être sous le seuil de son grade (recrue gradée, ancienne sauvegarde). */
  private alignXp(a: Agent): void {
    const i = this.index(a);
    if (i >= 0) a.xp = Math.max(a.xp, this.career(a)[i].xp);
  }

  onStateLoaded(): void {
    for (const a of Object.values(this.ctx.state.agents)) this.alignXp(a);
  }

  /** Ajoute de l'expérience (la promotion éventuelle est appliquée aussitôt). */
  gain(a: Agent | undefined, xp: number): void {
    if (!a || xp <= 0) return;
    a.xp += xp;
    this.check(a);
  }

  progress(a: Agent): CareerProgress {
    const c = this.career(a);
    const i = this.index(a);
    const next = i >= 0 ? (c[i + 1] ?? null) : null;
    const from = i >= 0 ? c[i].xp : 0;
    const to = next ? next.xp : from;
    const ratio = next ? Math.max(0, Math.min(1, (a.xp - from) / Math.max(1, to - from))) : 1;
    return { rank: a.rank, next, from, to, ratio };
  }

  /** Promotion(s) si l'XP a franchi le seuil du grade suivant. */
  check(a: Agent): boolean {
    const c = this.career(a);
    let i = this.index(a);
    if (i < 0) return false;
    let promoted = false;
    while (c[i + 1] && a.xp >= c[i + 1].xp) {
      i++;
      a.rank = c[i].rank;
      promoted = true;
    }
    if (!promoted) return false;
    a.needs.morale = Math.min(100, a.needs.morale + this.cfg.promotionMorale);
    for (const [skill, v] of Object.entries(this.cfg.promotionSkills)) a.skills[skill] = Math.min(100, (a.skills[skill] ?? 0) + v);
    pushLog(this.ctx, 'good', 'log.promotion', { name: `${a.firstName} ${a.lastName}`, rank: a.rank });
    this.ctx.bus.emit('agent:promoted', { id: a.id, rank: a.rank });
    return true;
  }

  /** L'XP gagnée par les activités s'accumule en continu : vérification régulière des promotions. */
  onTick(): void {
    if (this.ctx.state.time.tick % 10 !== 0) return;
    for (const a of Object.values(this.ctx.state.agents)) this.check(a);
  }
}
