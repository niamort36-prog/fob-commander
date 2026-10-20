import { describe, expect, it } from 'vitest';
import { CENTER, buildNow, makeGame, stepTicks, stepUntil } from './helpers';

describe('EventSystem — événements et dialogues', () => {
  it('ouvre un événement en pausant le jeu, applique le choix puis reprend', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.commands.push({ type: 'setSpeed', speed: 2 });
    ctx.sim.step();
    expect(ctx.sim.events.start('elder_visit')).toBe(true);
    expect(ctx.state.time.speed).toBe(0);
    // Le temps ne peut pas reprendre pendant le dialogue
    ctx.commands.push({ type: 'setSpeed', speed: 4 });
    ctx.sim.step();
    expect(ctx.state.time.speed).toBe(0);

    const water = ctx.state.resources.stock.water;
    const rep = ctx.state.progression.reputation;
    ctx.commands.push({ type: 'chooseEvent', choiceId: 'aid' });
    ctx.sim.step();
    const outcome = ctx.state.events.active!.outcome!;
    expect(outcome.text.length).toBeGreaterThan(10);
    expect(outcome.summary.length).toBeGreaterThan(0);
    expect(ctx.state.resources.stock.water).toBeLessThanOrEqual(water - 300 + 1);
    expect(ctx.state.progression.reputation).toBe(rep + 3);
    expect(ctx.state.progression.flags.village_friendly).toBe(true);

    ctx.commands.push({ type: 'closeEvent' });
    ctx.sim.step();
    expect(ctx.state.events.active).toBeNull();
    expect(ctx.state.time.speed).toBe(2);
  });

  it('bloque les choix impossibles (ressources, bâtiment, drapeau)', () => {
    const ctx = makeGame();
    ctx.sim.events.start('food_shortage');
    const def = ctx.content.event('food_shortage');
    ctx.state.resources.stock.funds = 100;
    expect(ctx.sim.events.choiceBlock(def.choices.find((c) => c.id === 'airdrop')!)).toBe('resources');
    expect(ctx.sim.events.choiceBlock(def.choices.find((c) => c.id === 'village')!)).toBe('flag');
    expect(ctx.sim.events.choose('airdrop')).toBe(false);
    const insp = ctx.content.event('general_inspection');
    expect(ctx.sim.events.choiceBlock(insp.choices.find((c) => c.id === 'briefing')!)).toBe('building');
  });

  it('programme et déclenche un événement en chaîne (promesse tenue ou non)', () => {
    const ctx = makeGame();
    ctx.sim.events.start('elder_visit');
    ctx.sim.events.choose('promise');
    ctx.sim.events.close();
    expect(ctx.state.events.queue).toHaveLength(1);
    stepUntil(
      ctx,
      () => {
        // Les autres événements survenus entre-temps sont réglés comme le ferait le joueur.
        const a = ctx.state.events.active;
        if (a && a.eventId !== 'elder_followup') {
          const def = ctx.content.event(a.eventId);
          const ok = def.choices.find((c) => !ctx.sim.events.choiceBlock(c) && !c.outcomes.some((o) => o.effects?.attack));
          ctx.sim.events.choose((ok ?? def.choices[0]).id);
          ctx.sim.events.close();
          if (ctx.state.combat.active) ctx.state.combat.shellsLeft = 0;
        }
        return ctx.state.events.active?.eventId === 'elder_followup';
      },
      104 * 60, // délai de la chaîne + trajet de la charrette
    );
    ctx.state.resources.stock.funds = 0;
    const pay = ctx.content.event('elder_followup').choices.find((c) => c.id === 'pay')!;
    expect(ctx.sim.events.choiceBlock(pay)).toBe('resources');
    ctx.sim.events.choose('renege');
    expect(ctx.state.progression.flags.elder_hostile).toBe(true);
    ctx.sim.events.close();
    // L'ancien hostile ne revient plus
    expect(ctx.sim.events.eligible(ctx.content.event('elder_visit'))).toBe(false);
  });

  it('choisit l’issue selon l’évaluation de la base', () => {
    const ctx = makeGame();
    ctx.state.time.day = 5;
    const funds = ctx.state.resources.stock.funds;
    ctx.state.resources.shortages = ['water', 'food']; // évaluation médiocre
    ctx.sim.events.start('general_inspection');
    ctx.sim.events.choose('tour');
    expect(ctx.state.resources.stock.funds).toBe(funds);
    expect(ctx.state.events.active!.outcome!.summary.some((s) => s.includes('Réputation'))).toBe(true);
  });

  it('déclenche des événements aléatoires au fil des heures', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.random = () => 0; // tirage toujours favorable
    stepTicks(ctx, 61);
    // Dialogue immédiat, ou délégation en route vers la base (visite physique)
    expect(ctx.state.events.active ?? ctx.state.visit).not.toBeNull();
  });
});

describe('AttackSystem — attaques contre la base', () => {
  it('tirs de mortier : alerte, abris, dégâts, fin d’attaque et retour à la normale', () => {
    const ctx = makeGame(undefined, { agents: true });
    buildNow(ctx, 'bunker', CENTER);
    buildNow(ctx, 'bunker', { x: CENTER.x + 3, y: CENTER.y });
    buildNow(ctx, 'tent_group', { x: CENTER.x - 5, y: CENTER.y });
    ctx.sim.attacks.start('mortar', 'shelter');
    expect(ctx.state.combat.active).toBe(true);
    stepTicks(ctx, 10);
    const sheltered = Object.values(ctx.state.agents).filter((a) => a.activity?.id === 'take_cover');
    expect(sheltered.length).toBeGreaterThan(0);
    stepUntil(ctx, () => !ctx.state.combat.active, 400);
    expect(Object.values(ctx.state.agents).every((a) => !a.activity || !ctx.content.activity(a.activity.id).combat)).toBe(true);
    expect(ctx.state.log.some((l) => l.key === 'log.attackEnded')).toBe(true);
  });

  it('harcèlement : les défenseurs ripostent, consomment des munitions et repoussent l’attaque', () => {
    const ctx = makeGame(undefined, { agents: true });
    const z = ctx.state.fob.zone;
    for (let x = z.x + 10; x < z.x + 38; x++) buildNow(ctx, 'hesco', { x, y: z.y + 6 });
    buildNow(ctx, 'watchtower', { x: z.x + 20, y: z.y + 8 });
    const ammo = ctx.state.resources.stock.ammo;
    ctx.sim.attacks.start('harassment', 'engage');
    const n = ctx.state.combat.initialEnemies;
    expect(n).toBeGreaterThanOrEqual(3);
    stepTicks(ctx, 20);
    expect(Object.values(ctx.state.agents).some((a) => a.activity?.id === 'defend')).toBe(true);
    stepUntil(ctx, () => !ctx.state.combat.active, 600);
    expect(ctx.state.resources.stock.ammo).toBeLessThan(ammo);
    expect(Object.keys(ctx.state.combat.enemies)).toHaveLength(0);
  });

  it('un soldat tué est retiré, inscrit au mémorial et son groupe mis à jour', () => {
    const ctx = makeGame(undefined, { agents: true });
    const a = Object.values(ctx.state.agents)[3];
    const group = ctx.state.groups[a.groupId!];
    ctx.sim.attacks.hurt(a, 500, false);
    expect(ctx.state.agents[a.id]).toBeUndefined();
    expect(group.memberIds).not.toContain(a.id);
    expect(ctx.state.memorial[0].name).toContain(a.lastName);
  });

  it('un renseignement préalable affaiblit l’attaque', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.random = () => 0.99;
    ctx.sim.attacks.start('assault', 'shelter');
    const full = ctx.state.combat.initialEnemies;
    const ctx2 = makeGame(undefined, { agents: true });
    ctx2.random = () => 0.99;
    ctx2.state.progression.flags.intel_warning = true;
    ctx2.sim.attacks.start('assault', 'shelter');
    expect(ctx2.state.combat.initialEnemies).toBeLessThan(full);
    expect(ctx2.state.progression.flags.intel_warning).toBeUndefined();
  });

  it('l’engin explosif laissé sur la piste frappe le convoi suivant', () => {
    const ctx = makeGame();
    buildNow(ctx, 'unloading_zone', CENTER);
    ctx.state.progression.flags.ied_on_road = true;
    ctx.state.resources.stock.funds += 50000;
    const order = ctx.sim.supply.placeOrder('convoy', { food: 200 }, [])!;
    order.ambushed = true;
    order.etaTick = ctx.state.time.tick + 1;
    stepTicks(ctx, 3);
    const v = ctx.state.vehicles[order.vehicleId!];
    expect(v.cargo.food).toBe(100);
    expect(ctx.state.progression.flags.ied_on_road).toBeUndefined();
  });

  it('l’attaque se déclenche à la fermeture du dialogue d’alerte', () => {
    const ctx = makeGame(undefined, { agents: true });
    ctx.state.time.day = 4;
    ctx.sim.events.start('harassment');
    ctx.sim.events.choose('shelter');
    expect(ctx.state.combat.active).toBe(false);
    ctx.sim.events.close();
    expect(ctx.state.combat.active).toBe(true);
    expect(ctx.state.combat.mode).toBe('shelter');
  });
});

describe('Événements liés à un village', () => {
  it('un événement « hostile » vise un village hostile et ses effets s’y appliquent', () => {
    const ctx = makeGame(undefined, { agents: true });
    const villages = ctx.state.region.villages;
    for (const id of Object.keys(villages)) villages[id].attitude = 20;
    const def = ctx.content.event('hostile_demo');
    expect(ctx.sim.events.villagesFor('hostile')).toHaveLength(0);
    ctx.state.time.day = 10;
    expect(ctx.sim.events.eligible(def)).toBe(false);
    villages.toor.attitude = -30;
    expect(ctx.sim.events.eligible(def)).toBe(true);
    expect(ctx.sim.events.start('hostile_demo')).toBe(true);
    expect(ctx.state.events.active!.vars.villageId).toBe('toor');
    expect(ctx.sim.events.format(def.text)).toContain('Qarya-ye Toor');
    const before = villages.toor.attitude;
    ctx.sim.events.choose('disperse');
    expect(villages.toor.attitude).toBeLessThan(before);
  });
});
