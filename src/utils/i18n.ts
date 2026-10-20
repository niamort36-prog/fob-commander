/** Textes de l'interface (strings.fr.json) et formatage. */
import strings from '../data/strings.fr.json';

const table: Record<string, string> = strings;
const missing = new Set<string>();

/** Traduit une clé ; les paramètres remplacent les jetons {nom}. */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = table[key];
  if (raw === undefined) {
    if (!missing.has(key)) {
      missing.add(key);
      console.warn(`[i18n] clé manquante : ${key}`);
    }
    return `⟦${key}⟧`;
  }
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

const intFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

export function formatNumber(n: number): string {
  // Espace simple : la police pixel ne contient pas l'espace fine insécable.
  return intFormat.format(Math.floor(n)).replace(/ | /g, ' ');
}

export function formatSigned(n: number): string {
  const r = Math.round(n);
  return (r > 0 ? '+' : '') + formatNumber(r).replace(/^-/, '−');
}

export function formatClock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = Math.floor(minuteOfDay % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
