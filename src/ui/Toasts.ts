/** Notifications éphémères (refus de construction, sauvegardes, pénuries…). */
import type { GameContext } from '../core/GameContext';
import type { ToastKind } from '../core/GameEvents';
import { t } from '../utils/i18n';
import { el } from './dom';

const DURATION_MS = 2800;
const MAX_TOASTS = 4;

export class Toasts {
  private readonly root: HTMLElement;
  private readonly unsubs: (() => void)[] = [];

  constructor(parent: HTMLElement, ctx: GameContext) {
    this.root = el('div', { class: 'toasts' });
    parent.append(this.root);
    const bus = ctx.bus;
    this.unsubs.push(
      bus.on('ui:toast', ({ text, kind }) => this.show(text, kind)),
      bus.on('build:rejected', ({ reason }) => this.show(t(`reason.${reason}`), 'error')),
      bus.on('save:done', ({ slot, auto }) => this.show(auto ? t('save.autoDone') : t('save.done', { slot }), 'good')),
      bus.on('save:failed', ({ error }) => this.show(t('save.failed', { error }), 'error')),
      bus.on('zone:rejected', ({ reason }) => this.show(t(`zone.${reason}`), 'error')),
      bus.on('zone:expanded', () => this.show(t('zone.expanded'), 'good')),
      bus.on('agent:incident', ({ text }) => this.show(text, 'warn')),
      bus.on('supply:rejected', ({ reason }) => this.show(t(reason === 'requires' ? 'supply.requiresShort' : `supply.${reason}`), 'error')),
      bus.on('supply:ordered', () => this.show(t('toast.ordered'), 'good')),
      bus.on('supply:arrived', () => this.show(t('toast.arrived'), 'info')),
      bus.on('supply:ambushed', ({ lossPct }) => this.show(t('toast.ambushed', { loss: lossPct }), 'error')),
      bus.on('supply:blocked', () => this.show(t('toast.blocked'), 'warn')),
      bus.on('upgrade:rejected', ({ reason }) => this.show(t(`upgrade.${reason}`), 'error')),
      bus.on('combat:ended', ({ stats }) =>
        this.show(t(stats.kia > 0 ? 'toast.combatLoss' : 'toast.combatEnd', { kia: stats.kia, wounded: stats.wounded, enemies: stats.enemyKilled }), stats.kia > 0 ? 'error' : 'good'),
      ),
      bus.on('combat:spotted', () => this.show(t('toast.spotted'), 'good')),
      bus.on('progression:unlocked', ({ defId }) => this.show(t('toast.unlocked', { name: ctx.content.building(defId).name }), 'good')),
      bus.on('visit:started', () => {
        const v = ctx.state.visit;
        if (v) this.show(t('toast.visit', { name: v.name }), 'info');
      }),
      bus.on('progression:purchased', ({ defId }) => this.show(t('toast.purchased', { name: ctx.content.building(defId).name }), 'good')),
      bus.on('progression:unlockRejected', ({ defId, reason }) =>
        this.show(t(reason === 'level' ? 'toast.unlockLevel' : 'toast.unlockPoints', { name: ctx.content.building(defId).name }), 'warn'),
      ),
      bus.on('resource:shortage', ({ resource }) => this.show(t('toast.shortage', { resource: ctx.content.resource(resource).name }), 'warn')),
    );
  }

  show(text: string, kind: ToastKind = 'info'): void {
    const toast = el('div', { class: `toast ${kind}`, text });
    this.root.append(toast);
    while (this.root.childElementCount > MAX_TOASTS) this.root.firstElementChild?.remove();
    window.setTimeout(() => {
      toast.classList.add('fade');
      window.setTimeout(() => toast.remove(), 400);
    }, DURATION_MS);
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
