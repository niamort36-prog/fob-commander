import { describe, expect, it } from 'vitest';
import { loadDefaultContent } from '../src/core/ContentRegistry';
import { Settings } from '../src/core/Settings';
import { ambientAt, buildingLight, powerRatio } from '../src/systems/lighting';
import { validateContent } from '../src/utils/validate';
import buildingsJson from '../src/data/buildings.json';
import audioJson from '../src/data/audio.json';
import tutorialJson from '../src/data/tutorial.json';
import { CENTER, buildNow, makeGame } from './helpers';

class FakeStore {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

describe('Options du joueur', () => {
  const content = loadDefaultContent();

  it('valeurs par défaut, modification et persistance', () => {
    const store = new FakeStore();
    const s = new Settings(content.settings, store);
    expect(s.num('master')).toBe(0.7);
    expect(s.bool('tutorial')).toBe(true);
    s.set('master', 0.3);
    s.set('mute', true);
    const reloaded = new Settings(content.settings, store);
    expect(reloaded.num('master')).toBe(0.3);
    expect(reloaded.bool('mute')).toBe(true);
    reloaded.reset();
    expect(reloaded.num('master')).toBe(0.7);
  });

  it('ignore les valeurs illisibles ou hors bornes', () => {
    const store = new FakeStore();
    store.setItem(content.settings.storageKey, JSON.stringify({ master: 9, mute: 'oui', textSpeed: 2 }));
    const s = new Settings(content.settings, store);
    expect(s.num('master')).toBe(1);
    expect(s.bool('mute')).toBe(false);
    expect(s.num('textSpeed')).toBe(2);
    store.setItem(content.settings.storageKey, '{pas du json');
    expect(new Settings(content.settings, store).num('master')).toBe(0.7);
  });

  it('notifie les changements', () => {
    const s = new Settings(content.settings, null);
    const seen: string[] = [];
    const off = s.onChange((id) => seen.push(id));
    s.set('sfx', 0.2);
    off();
    s.set('sfx', 0.4);
    expect(seen).toEqual(['sfx']);
  });

  it('la sauvegarde automatique respecte l’option', () => {
    const ctx = makeGame();
    ctx.settings.set('autosave', false);
    for (let i = 0; i < 1440 * 2; i++) ctx.sim.step();
    expect(ctx.sim.save.summary('auto')).toBeNull();
    const other = makeGame();
    for (let i = 0; i < 1440 * 2; i++) other.sim.step();
    expect(other.sim.save.summary('auto')).not.toBeNull();
  });
});

describe('Cycle jour/nuit et éclairage', () => {
  const content = loadDefaultContent();
  const kf = content.ambience.keyframes;

  it('nuit à minuit, jour à midi, transition au crépuscule', () => {
    expect(ambientAt(kf, 0).night).toBe(1);
    expect(ambientAt(kf, 12 * 60).night).toBe(0);
    const dusk = ambientAt(kf, 19.5 * 60);
    expect(dusk.night).toBeGreaterThan(0);
    expect(dusk.night).toBeLessThan(1);
    // Teinte bleutée la nuit, chaude le jour
    const night = ambientAt(kf, 2 * 60);
    expect(night.b).toBeGreaterThan(night.r);
    const noon = ambientAt(kf, 12 * 60);
    expect(noon.r).toBeGreaterThanOrEqual(noon.b);
    expect(ambientAt(kf, 24 * 60 + 30).night).toBe(ambientAt(kf, 30).night);
  });

  it('les lumières électriques s’éteignent sans courant', () => {
    const ctx = makeGame();
    const lamp = buildNow(ctx, 'floodlight', { x: CENTER.x, y: CENTER.y });
    ctx.sim.step();
    expect(powerRatio(ctx.state)).toBe(0);
    expect(buildingLight(ctx.content, ctx.state, lamp)).toBe(0);
    buildNow(ctx, 'generator', { x: CENTER.x + 4, y: CENTER.y + 4 });
    ctx.sim.step();
    expect(powerRatio(ctx.state)).toBe(1);
    expect(buildingLight(ctx.content, ctx.state, lamp)).toBe(1);
  });

  it('les mâts d’éclairage compensent la pénalité de tir de nuit', () => {
    const ctx = makeGame();
    const attacks = ctx.sim.attacks as unknown as { litFraction(): number };
    expect(attacks.litFraction()).toBe(0);
    buildNow(ctx, 'generator', { x: CENTER.x + 4, y: CENTER.y + 4 });
    for (let i = 0; i < ctx.content.combat.config.floodlightsWanted; i++) buildNow(ctx, 'floodlight', { x: CENTER.x - 6 + i * 2, y: CENTER.y - 6 });
    ctx.sim.step();
    expect(attacks.litFraction()).toBe(1);
  });
});

describe('Validation du contenu de la Phase 8', () => {
  const raw = () => {
    const c = loadDefaultContent();
    return {
      buildings: structuredClone(buildingsJson),
      categories: c.categories,
      terrain: c.terrains,
      resources: c.resources,
      sites: c.sites,
      balance: c.balance,
      personnel: c.personnelList,
      skills: c.skills,
      traits: c.traitList,
      needs: c.needs,
      activities: c.activityList,
      routines: c.routineList,
      names: c.names,
      vehicles: c.vehicleList,
      supply: c.supply,
      events: c.events,
      combat: c.combat,
      region: c.region,
      missions: c.missions,
      radio: c.radio,
      diplomacy: c.diplomacy,
      campaign: c.campaign,
      ambience: c.ambience,
      settings: c.settings,
      audio: structuredClone(audioJson),
      tutorial: structuredClone(tutorialJson),
      visitors: c.visitors,
      equipment: c.equipment,
    };
  };

  it('le contenu livré est valide', () => {
    expect(validateContent(raw())).toEqual([]);
  });

  it('signale un son inconnu, une étape de tutoriel invalide et une lumière mal définie', () => {
    const r = raw();
    (r.audio.events as Record<string, string>)['combat:started'] = 'trompette';
    (r.tutorial.steps[2].done as { defId?: string }).defId = 'chateau';
    (r.buildings.find((b) => b.id === 'floodlight') as { light?: unknown }).light = { radius: 3, color: 'jaune' };
    const errors = validateContent(r).join('\n');
    expect(errors).toContain('trompette');
    expect(errors).toContain('tutorial.json.steps.tents.done.defId');
    expect(errors).toContain('buildings.json.floodlight.light');
  });
});
