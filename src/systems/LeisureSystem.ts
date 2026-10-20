/**
 * LeisureSystem — détente et risques de l'alcool.
 *
 * L'amusement (besoin « fun ») se recharge à la tente de détente, au bar, au coin barbecue, au
 * réfectoire et au sport (activities.json). Un bar isolé ne pose pas de problème ; mais chaque
 * autre bar à moins de `alcohol.radius` cases multiplie le risque, par heure passée à boire,
 * d'un incident (balance.json → leisure) :
 *  - bagarre : le buveur et un camarade blessés, moral en baisse ;
 *  - gueule de bois : sommeil et hydratation au plus bas ;
 *  - matériel abîmé par un soldat ivre.
 */
import type { GameContext } from '../core/GameContext';
import type { Agent, BuildingInstance } from '../core/GameState';
import { pushLog } from '../core/Log';
import { spend } from '../core/resources';
import type { System } from './System';

export class LeisureSystem implements System {
  readonly id = 'leisure';

  constructor(private readonly ctx: GameContext) {}

  private get cfg() {
    return this.ctx.content.balance.leisure;
  }

  private rand(a: number, b: number): number {
    return a + this.ctx.random() * (b - a);
  }

  private operational(b: BuildingInstance): boolean {
    return b.state === 'active' || b.state === 'damaged';
  }

  /** Autres bars en service trop proches de celui-ci (risque d'alcoolisme). */
  neighbourBars(b: BuildingInstance): BuildingInstance[] {
    const def = this.ctx.content.building(b.defId);
    if (!def.alcohol) return [];
    const c = this.ctx.sim.agents.buildingCenter(b);
    return Object.values(this.ctx.state.fob.buildings).filter((o) => {
      if (o.id === b.id || !this.operational(o)) return false;
      const od = this.ctx.content.building(o.defId);
      if (!od.alcohol) return false;
      const oc = this.ctx.sim.agents.buildingCenter(o);
      return Math.hypot(oc.x - c.x, oc.y - c.y) <= Math.max(def.alcohol!.radius, od.alcohol.radius);
    });
  }

  /** Risque d'incident par heure passée à boire dans ce bar. */
  riskPerHour(b: BuildingInstance): number {
    return this.cfg.basePerHour + this.cfg.perNeighbourPerHour * this.neighbourBars(b).length;
  }

  onTick(): void {
    const s = this.ctx.state;
    const perTick = this.ctx.content.balance.time.minutesPerTick;
    for (const a of Object.values(s.agents)) {
      const act = a.activity;
      if (a.status !== 'on_base' || act?.id !== 'drink' || act.stage !== 'acting' || !act.targetId) continue;
      const bar = s.fob.buildings[act.targetId];
      if (!bar) continue;
      if (this.ctx.random() < (this.riskPerHour(bar) * perTick) / 60) this.incident(a, bar);
    }
  }

  private incident(a: Agent, bar: BuildingInstance): void {
    const s = this.ctx.state;
    const name = `${a.rank} ${a.lastName}`;
    const roll = this.ctx.random();
    if (roll < 0.45) {
      // Bagarre avec un autre buveur du même bar (ou un soldat à proximité)
      const other = Object.values(s.agents).find((o) => o.id !== a.id && o.activity?.targetId === bar.id && o.activity.id === 'drink');
      const [lo, hi] = this.cfg.brawlHealth;
      for (const x of [a, other]) {
        if (!x) continue;
        x.health = Math.max(5, x.health - this.rand(lo, hi));
        x.needs.morale = Math.max(0, x.needs.morale - 6);
      }
      pushLog(this.ctx, 'bad', 'log.alcohol.brawl', { name, other: other ? `${other.rank} ${other.lastName}` : 'un camarade' });
    } else if (roll < 0.8) {
      a.needs.sleep = Math.max(0, a.needs.sleep - this.cfg.hangoverSleep);
      a.needs.water = Math.max(0, a.needs.water - 20);
      pushLog(this.ctx, 'warn', 'log.alcohol.hangover', { name });
    } else {
      spend(s, { parts: Math.min(s.resources.stock.parts, this.cfg.damageParts) });
      a.needs.morale = Math.max(0, a.needs.morale - 4);
      pushLog(this.ctx, 'warn', 'log.alcohol.damage', { name, n: this.cfg.damageParts });
    }
    // On ne reste pas au bar après un incident
    a.activity = null;
    a.path = [];
  }
}
