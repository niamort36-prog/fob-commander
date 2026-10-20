/**
 * Settings — options du joueur (son, affichage, partie), définies dans settings.json et
 * enregistrées dans le navigateur, indépendamment des sauvegardes de partie.
 */
import type { SettingsDef } from './ContentTypes';

export type SettingValue = number | boolean;

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class Settings {
  private values: Record<string, SettingValue> = {};
  private readonly listeners = new Set<(id: string, value: SettingValue) => void>();

  constructor(
    private readonly def: SettingsDef,
    private readonly store: KeyValueStore | null = defaultStore(),
  ) {
    for (const o of def.options) this.values[o.id] = o.default;
    try {
      const raw = this.store?.getItem(def.storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, unknown>;
        for (const o of def.options) {
          const v = saved[o.id];
          if (o.type === 'toggle' && typeof v === 'boolean') this.values[o.id] = v;
          if (o.type === 'slider' && typeof v === 'number' && Number.isFinite(v)) this.values[o.id] = Math.min(o.max ?? v, Math.max(o.min ?? v, v));
        }
      }
    } catch {
      // options illisibles : valeurs par défaut
    }
  }

  num(id: string): number {
    const v = this.values[id];
    return typeof v === 'number' ? v : 0;
  }

  bool(id: string): boolean {
    return this.values[id] === true;
  }

  get(id: string): SettingValue | undefined {
    return this.values[id];
  }

  set(id: string, value: SettingValue): void {
    if (!this.def.options.some((o) => o.id === id)) return;
    this.values[id] = value;
    try {
      this.store?.setItem(this.def.storageKey, JSON.stringify(this.values));
    } catch {
      // stockage plein ou bloqué : l'option vaut pour la session
    }
    for (const l of this.listeners) l(id, value);
  }

  reset(): void {
    for (const o of this.def.options) this.set(o.id, o.default);
  }

  onChange(fn: (id: string, value: SettingValue) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
