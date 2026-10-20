/** Bannière d'alerte et liseré rouge pendant une attaque contre la base. */
import type { GameContext } from '../core/GameContext';
import { t } from '../utils/i18n';
import { el, setText } from './dom';

export class AlertBanner {
  private readonly banner: HTMLElement;
  private readonly label: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly vignette: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly ctx: GameContext,
  ) {
    this.label = el('span', { class: 'alert-label' });
    this.detail = el('span', { class: 'alert-detail' });
    this.banner = el('div', { class: 'alert-banner hidden' }, [this.label, this.detail]);
    this.vignette = el('div', { class: 'alert-vignette hidden' });
    parent.append(this.vignette, this.banner);
    this.update();
  }

  update(): void {
    const c = this.ctx.state.combat;
    this.banner.classList.toggle('hidden', !c.active);
    this.vignette.classList.toggle('hidden', !c.active);
    if (!c.active) return;
    const def = this.ctx.content.combat.attacks[c.attackId ?? ''];
    setText(this.label, t('alert.title', { name: def?.name ?? '' }));
    const enemies = Object.keys(c.enemies).length;
    const detail =
      def?.type === 'indirect'
        ? t('alert.indirect', { shells: c.shellsLeft })
        : t('alert.ground', { enemies, killed: c.stats.enemyKilled });
    const losses = c.stats.kia + c.stats.wounded > 0 ? ` · ${t('alert.losses', { kia: c.stats.kia, wounded: c.stats.wounded })}` : '';
    setText(this.detail, detail + losses);
  }

  destroy(): void {
    this.banner.remove();
    this.vignette.remove();
  }
}
