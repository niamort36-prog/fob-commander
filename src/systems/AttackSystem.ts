/**
 * AttackSystem — attaques contre la base, jouées dans la vue FOB.
 *
 *  - Tirs indirects : obus tombant à intervalles sur la base (dégâts aux bâtiments et aux
 *    personnels exposés selon leur abri) ; les gardes peuvent repérer la position de tir.
 *  - Attaques au sol : des insurgés approchent depuis l'extérieur du périmètre et ouvrent le feu ;
 *    les gardes des tours et les fantassins en position ripostent (munitions consommées).
 *    Les assaillants se replient après de lourdes pertes ou au bout d'un certain temps.
 *  - Bilan : morts, blessés, ennemis neutralisés, bâtiments touchés ; effet sur le moral.
 *
 * Les effets visuels (tirs, impacts, morts) sont transmis au rendu par des événements du bus.
 */
import type { BlastDef } from '../core/ContentTypes';
import type { GameContext } from '../core/GameContext';
import type { Agent, BuildingInstance, CombatMode, Enemy, GridPos, Id } from '../core/GameState';
import { emptyCombat } from '../core/GameState';
import { pushLog } from '../core/Log';
import { spend } from '../core/resources';
import { newId } from '../utils/ids';
import { BuildSystem } from './BuildSystem';
import type { System } from './System';
import { powerRatio } from './lighting';
import { gearOf, installedModules } from './modules';

/** Objectifs d'un assaut, du plus convoité au moins convoité (liste vide = tout bâtiment). */
const OBJECTIVE_PRIORITY: string[][] = [['toc'], ['ammo_depot', 'artillery'], ['tent_group', 'dfac', 'infirmary'], []];

interface Shooter {
  pos: { x: number; y: number };
  z: number;
  range: number;
  skill: number;
  tower: boolean;
}

export class AttackSystem implements System {
  readonly id = 'combat';
  /** Recharge des tireurs amis (non sauvegardée). */
  private readonly cooldowns = new Map<Id, number>();
  /** Défenseurs affectés à chaque position (évite l'entassement). */
  private readonly positions = new Map<string, number>();
  private wounded = new Set<Id>();
  /** Prochain tir possible de chaque batterie d'obusiers (non sauvegardé). */
  private readonly batteryReady = new Map<Id, number>();
  private artilleryAnnounced = false;
  /** Prochaine rafale de chaque hélicoptère de combat (non sauvegardé). */
  private readonly heliReady = new Map<Id, number>();
  /** Portes et murs dont on a déjà signalé qu'ils étaient attaqués (pendant l'attaque en cours). */
  private readonly breachAnnounced = new Set<Id>();

  constructor(private readonly ctx: GameContext) {}

  private get now(): number {
    return this.ctx.state.time.tick;
  }

  private get cfg() {
    return this.ctx.content.combat.config;
  }

  private rand(min: number, max: number): number {
    return min + this.ctx.random() * (max - min);
  }

  private minutesToTicks(m: number): number {
    return Math.max(1, Math.round(m / this.ctx.content.balance.time.minutesPerTick));
  }

  get active(): boolean {
    return this.ctx.state.combat.active;
  }

  onStateLoaded(): void {
    this.cooldowns.clear();
    this.positions.clear();
    this.batteryReady.clear();
    this.artilleryAnnounced = false;
    this.heliReady.clear();
    this.wounded.clear();
  }

  // ------------------------------------------------------------ Déclenchement

  /**
   * Un tireur infiltré passé au poste de garde ouvre le feu à l'intérieur de la base : il rejoint
   * l'attaque en cours, sinon déclenche l'attaque « insider » depuis sa position.
   */
  startInsider(at: GridPos): void {
    const c = this.ctx.state.combat;
    if (c.active && this.ctx.content.combat.attacks[c.attackId ?? '']?.type === 'ground') {
      const e = this.spawnEnemy({ x: at.x + 0.5, y: at.y + 0.5 });
      e.cooldown = this.now;
      c.enemies[e.id] = e;
      c.initialEnemies++;
      return;
    }
    if (c.active) return;
    this.start('insider', 'engage', at);
  }

  private spawnEnemy(pos: { x: number; y: number }): Enemy {
    const enemyDef = this.ctx.content.combat.enemies[0];
    return {
      id: newId(this.ctx.state, 'enm'),
      defId: enemyDef.id,
      pos: { ...pos },
      prevPos: { ...pos },
      path: [],
      health: enemyDef.health,
      skill: Math.round(this.rand(enemyDef.skill[0], enemyDef.skill[1])),
      state: 'approach',
      cooldown: this.now + this.minutesToTicks(this.rand(2, 8)),
    };
  }

  /**
   * Explosion (ceinture explosive, voiture piégée) : dégâts aux bâtiments et au personnel exposé
   * selon la distance et l'abri. Renvoie le nombre de tués et de blessés.
   */
  blast(x: number, y: number, def: BlastDef, mult = 1): { kia: number; wounded: number } {
    const s = this.ctx.state;
    const radius = def.radius * Math.sqrt(mult);
    this.ctx.bus.emit('combat:impact', { x, y, radius });
    for (const b of Object.values(s.fob.buildings)) {
      if (b.state === 'construction') continue;
      const bdef = this.ctx.content.building(b.defId);
      const [w, h] = BuildSystem.footprint(bdef, b.rot);
      const d = Math.hypot(Math.max(b.pos.x - x, 0, x - (b.pos.x + w)), Math.max(b.pos.y - y, 0, y - (b.pos.y + h)));
      if (d > radius) continue;
      const shield = installedModules(bdef, b).reduce((p, m) => Math.max(p, m.blastProtection ?? 0), 0);
      this.ctx.sim.build.applyDamage(b, this.rand(def.buildingDamage[0], def.buildingDamage[1]) * mult * (1 - (d / radius) * 0.6) * (1 - shield));
    }
    let kia = 0;
    let wounded = 0;
    for (const a of Object.values(s.agents)) {
      if (a.status !== 'on_base') continue;
      const d = Math.hypot(a.pos.x - x, a.pos.y - y);
      if (d > radius) continue;
      const protection = this.protection(a);
      if (protection <= 0) continue;
      const dmg = this.rand(def.agentDamage[0], def.agentDamage[1]) * mult * protection * (1 - (d / radius) * 0.5);
      if (dmg <= 0) continue;
      this.hurt(a, dmg, s.combat.active);
      if (s.agents[a.id]) wounded++;
      else kia++;
    }
    return { kia, wounded };
  }

  start(attackId: string, mode: CombatMode, spawnAt?: GridPos): void {
    const s = this.ctx.state;
    const def = this.ctx.content.combat.attacks[attackId];
    if (!def || s.combat.active) return;
    // Un renseignement préalable affaiblit l'attaque
    let mult = 1;
    if (s.progression.flags.intel_warning && !spawnAt) {
      mult = 0.5;
      delete s.progression.flags.intel_warning;
      pushLog(this.ctx, 'good', 'log.intelHelped');
    }
    const c = emptyCombat();
    c.active = true;
    c.attackId = attackId;
    c.mode = mode;
    c.startedTick = this.now;
    // Tireur infiltré : il surgit dans la base et se replie ensuite vers l'entrée
    c.origin = spawnAt ? { ...s.fob.entry } : this.pickOrigin();
    if (def.type === 'indirect') {
      const [a, b] = def.shells ?? [4, 8];
      c.shellsLeft = Math.max(1, Math.round(this.rand(a, b + 1) * mult));
      c.nextShellTick = this.now + this.minutesToTicks(2);
      c.endsTick = this.now + this.minutesToTicks(240);
    } else {
      const [a, b] = def.enemies ?? [3, 5];
      const n = spawnAt ? Math.max(1, a) : Math.max(1, Math.round(this.rand(a, b + 1) * mult));
      const nav = this.ctx.sim.agents.nav;
      for (let i = 0; i < n; i++) {
        const spot = spawnAt ?? nav.randomWalkableNear(c.origin, 3, () => this.ctx.random()) ?? c.origin;
        const e = this.spawnEnemy({ x: spot.x + 0.5, y: spot.y + 0.5 });
        if (spawnAt) e.cooldown = this.now;
        c.enemies[e.id] = e;
      }
      c.initialEnemies = n;
      c.endsTick = this.now + this.minutesToTicks(def.durationMin ?? 90);
    }
    s.combat = c;
    this.cooldowns.clear();
    this.positions.clear();
    this.breachAnnounced.clear();
    this.wounded.clear();
    pushLog(this.ctx, 'bad', 'log.attackStarted', { name: def.name });
    this.ctx.bus.emit('combat:started', { attackId, mode });
    this.ctx.sim.agents.alertAll();
  }

  /** Point de départ de l'attaque, hors du périmètre, sur un côté au hasard. */
  private pickOrigin(): GridPos {
    const { zone, width, height } = this.ctx.state.fob;
    const nav = this.ctx.sim.agents.nav;
    nav.ensure();
    const cx = zone.x + zone.width / 2;
    const cy = zone.y + zone.height / 2;
    for (let tries = 0; tries < 20; tries++) {
      const a = this.ctx.random() * Math.PI * 2;
      const r = Math.max(zone.width, zone.height) / 2 + this.cfg.spawnDistance;
      const x = Math.round(Math.min(width - 2, Math.max(1, cx + Math.cos(a) * r)));
      const y = Math.round(Math.min(height - 2, Math.max(1, cy + Math.sin(a) * r)));
      const spot = nav.randomWalkableNear({ x, y }, 3, () => this.ctx.random());
      if (spot) return spot;
    }
    return { x: Math.round(cx), y: Math.max(1, zone.y - this.cfg.spawnDistance) };
  }

  // ------------------------------------------------------------ Simulation

  onTick(): void {
    const c = this.ctx.state.combat;
    if (!c.active) return;
    const def = this.ctx.content.combat.attacks[c.attackId ?? ''];
    if (!def) return this.end();
    if (def.type === 'indirect') {
      if (c.shellsLeft > 0 && this.now >= c.nextShellTick) {
        this.impact();
        c.shellsLeft--;
        const [a, b] = def.intervalMin ?? [3, 6];
        c.nextShellTick = this.now + this.minutesToTicks(this.rand(a, b));
      }
      if (c.shellsLeft <= 0 || this.now >= c.endsTick) this.end();
      return;
    }
    this.updateEnemies();
    this.friendlyFire();
    this.artilleryFire();
    this.heliDefense();
    if (Object.keys(c.enemies).length === 0) this.end();
  }

  // ------------------------------------------------------------ Tirs indirects

  private impact(): void {
    const s = this.ctx.state;
    const c = s.combat;
    const def = this.ctx.content.combat.attacks[c.attackId!];
    const radius = def.radius ?? 1.5;
    const { zone } = s.fob;
    // 70 % des obus visent un bâtiment, les autres tombent au hasard dans le périmètre
    const targets = Object.values(s.fob.buildings).filter((b) => b.state !== 'construction' && this.ctx.content.building(b.defId).visual.style !== 'flat');
    let x: number;
    let y: number;
    if (targets.length && this.ctx.random() < 0.7) {
      const b = targets[Math.floor(this.ctx.random() * targets.length)];
      const ctr = this.ctx.sim.agents.buildingCenter(b);
      x = ctr.x + 0.5 + this.rand(-1.8, 1.8);
      y = ctr.y + 0.5 + this.rand(-1.8, 1.8);
    } else {
      x = zone.x + this.rand(0, zone.width);
      y = zone.y + this.rand(0, zone.height);
    }
    this.ctx.bus.emit('combat:impact', { x, y, radius });

    // Bâtiments touchés
    for (const b of Object.values(s.fob.buildings)) {
      if (b.state === 'construction') continue;
      const bdef = this.ctx.content.building(b.defId);
      const [w, h] = BuildSystem.footprint(bdef, b.rot);
      const dx = Math.max(b.pos.x - x, 0, x - (b.pos.x + w));
      const dy = Math.max(b.pos.y - y, 0, y - (b.pos.y + h));
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const [lo, hi] = def.buildingDamage ?? [0.15, 0.4];
      const shield = installedModules(bdef, b).reduce((p, m) => Math.max(p, m.blastProtection ?? 0), 0);
      this.ctx.sim.build.applyDamage(b, this.rand(lo, hi) * (1 - (d / radius) * 0.6) * (1 - shield));
      c.stats.damaged++;
    }
    // Personnels exposés
    const [dlo, dhi] = def.agentDamage ?? [30, 70];
    for (const a of Object.values(s.agents)) {
      const d = Math.hypot(a.pos.x - x, a.pos.y - y);
      if (d > radius) continue;
      const protection = this.protection(a);
      if (protection <= 0) continue;
      this.hurt(a, this.rand(dlo, dhi) * protection * (1 - (d / radius) * 0.5), true);
    }
    // Contre-batterie : les gardes repèrent la position de tir
    const guards = this.mannedGuardPosts();
    const posts = guards.length;
    const spotBonus = guards.reduce((sum, a) => sum + gearOf(this.ctx.content, a).reduce((x, i) => x + (i.combat?.spot ?? 0), 0), 0);
    const chance = (this.cfg.spotChancePerImpact * posts + spotBonus) * (c.mode === 'engage' ? this.cfg.spotEngageMult : 1);
    if (c.shellsLeft > 1 && this.ctx.random() < chance) {
      c.shellsLeft = 1;
      pushLog(this.ctx, 'good', 'log.mortarSpotted');
      this.ctx.bus.emit('combat:spotted', {});
    }
    // Hélicoptère de combat disponible : il décolle et neutralise l'équipe de mortier
    const helo = this.availableAttackHelos()[0];
    if (helo && c.shellsLeft > 1 && s.resources.stock.fuel > 0 && this.ctx.random() < this.cfg.heli.counterBatteryChance) {
      c.shellsLeft = 1;
      pushLog(this.ctx, 'good', 'log.heliCounter', { name: this.ctx.content.vehicle(helo.defId).name });
    }
    // Contre-batterie : les obusiers de la base ripostent sur le mortier ennemi
    const art = this.cfg.artillery;
    const batteries = this.batteries();
    const loaded = batteries.find((b) => this.ctx.sim.logistics.stock(b, 'ammo') >= art.ammoPerSalvo);
    if (c.shellsLeft > 1 && loaded && this.ctx.random() < art.counterBatteryChance * batteries.length && this.ctx.sim.logistics.consume(loaded, 'ammo', art.ammoPerSalvo)) {
      c.shellsLeft = 1;
      for (const b of batteries) this.emitFire(b);
      pushLog(this.ctx, 'good', 'log.counterBattery');
    }
  }

  // ------------------------------------------------------------ Hélicoptère de combat

  /** Hélicoptères de combat de la base posés et non engagés en mission. */
  private availableAttackHelos() {
    const used = new Set(Object.values(this.ctx.state.missions).flatMap((m) => (m.phase !== 'done' ? [m.supportVehicleId, m.heliId] : [])).filter(Boolean));
    return Object.values(this.ctx.state.vehicles).filter(
      (v) => this.ctx.content.vehicle(v.defId).role === 'attack' && (v.state === 'idle' || v.state === 'sortie') && !used.has(v.id),
    );
  }

  /** Décollage et rafales de canon sur les assaillants. */
  private heliDefense(): void {
    const s = this.ctx.state;
    const enemies = Object.values(s.combat.enemies);
    if (!enemies.length || s.resources.stock.fuel <= 0) return;
    const cx = enemies.reduce((t0, e) => t0 + e.pos.x, 0) / enemies.length;
    const cy = enemies.reduce((t0, e) => t0 + e.pos.y, 0) / enemies.length;
    const cfg = this.cfg.heli;
    for (const v of this.availableAttackHelos()) {
      if (v.state === 'idle') {
        this.ctx.sim.supply.heliSortie(v, { x: Math.floor(cx), y: Math.floor(cy) });
        pushLog(this.ctx, 'good', 'log.heliSortie', { name: this.ctx.content.vehicle(v.defId).name });
        continue;
      }
      v.path = [{ x: Math.floor(cx), y: Math.floor(cy) }];
      if (v.altitude < 20 || (this.heliReady.get(v.id) ?? 0) > this.now) continue;
      let target: Enemy | null = null;
      let best = cfg.range;
      for (const e of enemies) {
        const d = Math.hypot(e.pos.x - v.pos.x, e.pos.y - v.pos.y);
        if (d < best) {
          best = d;
          target = e;
        }
      }
      if (!target) continue;
      if (s.resources.stock.ammo < cfg.ammoPerBurst) {
        this.ctx.sim.economy.flagShortage('ammo');
        return;
      }
      spend(s, { ammo: cfg.ammoPerBurst });
      this.heliReady.set(v.id, this.now + this.minutesToTicks(this.rand(cfg.burstMin[0], cfg.burstMin[1])));
      this.ctx.bus.emit('combat:shot', { fromX: v.pos.x, fromY: v.pos.y, fromZ: v.altitude, toX: target.pos.x, toY: target.pos.y, toZ: 4, hit: true, friendly: true });
      target.health -= this.rand(cfg.damage[0], cfg.damage[1]);
      if (target.health <= 0) {
        delete s.combat.enemies[target.id];
        s.combat.stats.enemyKilled++;
        this.ctx.bus.emit('combat:death', { x: target.pos.x, y: target.pos.y, friendly: false });
      }
    }
  }

  // ------------------------------------------------------------ Artillerie de la base

  /** Batteries d'obusiers en service. */
  batteries() {
    return Object.values(this.ctx.state.fob.buildings).filter((b) => b.defId === 'artillery' && (b.state === 'active' || b.state === 'damaged'));
  }

  private emitFire(b: { id: Id }): void {
    const bi = this.ctx.state.fob.buildings[b.id];
    if (!bi) return;
    const c = this.ctx.sim.agents.buildingCenter(bi);
    this.ctx.bus.emit('artillery:fire', { x: c.x + 0.5, y: c.y + 0.5 });
  }

  /** Les obusiers pilonnent les groupes d'assaillants assez éloignés des soldats amis. */
  private artilleryFire(): void {
    const s = this.ctx.state;
    const art = this.cfg.artillery;
    const enemies = Object.values(s.combat.enemies);
    if (enemies.length === 0) return;
    const friends = Object.values(s.agents).filter((a) => a.status === 'on_base');
    for (const b of this.batteries()) {
      if ((this.batteryReady.get(b.id) ?? 0) > this.now) continue;
      // Cible : l'assaillant le plus entouré, hors de la zone de danger rapproché
      let target: Enemy | null = null;
      let best = 0;
      for (const e of enemies) {
        if (friends.some((a) => Math.hypot(a.pos.x - e.pos.x, a.pos.y - e.pos.y) < art.dangerClose)) continue;
        const n = enemies.filter((o) => Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) <= art.radius).length;
        if (n > best) {
          best = n;
          target = e;
        }
      }
      if (!target) continue;
      // Obus puisés dans la soute de la batterie (ravitaillée par le soutien)
      if (!this.ctx.sim.logistics.consume(b, 'ammo', art.ammoPerSalvo)) {
        this.ctx.sim.economy.flagShortage('ammo');
        continue;
      }
      this.batteryReady.set(b.id, this.now + this.minutesToTicks(this.rand(art.intervalMin[0], art.intervalMin[1])));
      this.emitFire(b);
      if (!this.artilleryAnnounced) {
        this.artilleryAnnounced = true;
        pushLog(this.ctx, 'good', 'log.artilleryFire');
      }
      const x = target.pos.x + this.rand(-0.6, 0.6);
      const y = target.pos.y + this.rand(-0.6, 0.6);
      this.ctx.bus.emit('combat:impact', { x, y, radius: art.radius });
      for (const e of Object.values(s.combat.enemies)) {
        const d = Math.hypot(e.pos.x - x, e.pos.y - y);
        if (d > art.radius) continue;
        e.health -= this.rand(art.damage[0], art.damage[1]) * (1 - (d / art.radius) * 0.5);
        if (e.health <= 0) {
          delete s.combat.enemies[e.id];
          s.combat.stats.enemyKilled++;
          this.ctx.bus.emit('combat:death', { x: e.pos.x, y: e.pos.y, friendly: false });
        }
      }
    }
  }

  /** Part des dégâts d'explosion subis selon l'abri (0 = totalement protégé). */
  private protection(a: Agent): number {
    const act = a.activity;
    if (!act || act.stage !== 'acting') return 1;
    const def = this.ctx.content.activity(act.id);
    if (def.service === 'shelter') return 0;
    if (def.inside && act.targetId) {
      const b = this.ctx.state.fob.buildings[act.targetId];
      const shield = b ? installedModules(this.ctx.content.building(b.defId), b).reduce((p, m) => Math.max(p, m.blastProtection ?? 0), 0) : 0;
      return this.cfg.insideProtection * (1 - shield);
    }
    if (act.id === 'prone') return this.cfg.proneProtection;
    return 1;
  }

  // ------------------------------------------------------------ Combat au sol

  private updateEnemies(): void {
    const s = this.ctx.state;
    const c = s.combat;
    const nav = this.ctx.sim.agents.nav;
    nav.ensure();
    const penetrate = this.ctx.content.combat.attacks[c.attackId ?? '']?.penetrate === true;
    const losses = c.initialEnemies - Object.keys(c.enemies).length;
    const retreat = this.now >= c.endsTick || losses >= Math.ceil(c.initialEnemies * this.cfg.retreatAtLosses);
    for (const e of Object.values(c.enemies)) {
      e.prevPos.x = e.pos.x;
      e.prevPos.y = e.pos.y;
      const def = this.ctx.content.enemy(e.defId);
      if (retreat && e.state !== 'retreat') {
        e.state = 'retreat';
        e.path = nav.findPath(this.cell(e.pos), [c.origin]) ?? [];
      }
      if (e.state === 'retreat') {
        this.step(e, def.speed);
        const d = Math.hypot(e.pos.x - c.origin.x, e.pos.y - c.origin.y);
        if (e.path.length === 0 || d < 2 || this.now > c.endsTick + this.minutesToTicks(90)) delete c.enemies[e.id];
        continue;
      }
      const target = this.enemyTarget(e, def.range);
      // En train de forcer une porte ou un mur : on continue (en tirant si un soldat se montre)
      if (e.state === 'breach') {
        if (target?.agent && this.now >= e.cooldown) this.enemyShoot(e, target);
        this.breachStep(e);
        continue;
      }
      // Un soldat en vue : on s'arrête et on tire. Seulement des bâtiments : on tire en avançant
      // jusqu'au périmètre, pour accrocher les défenseurs abrités derrière les murs.
      if (target?.agent) {
        e.state = 'engage';
        e.path = [];
        if (this.now >= e.cooldown) this.enemyShoot(e, target);
        continue;
      }
      if (target && this.now >= e.cooldown) this.enemyShoot(e, target);
      // Assaut : plus personne en vue, on reprend la progression vers l'intérieur de la base
      if (penetrate) {
        if (e.state === 'engage') e.state = 'approach';
        if (e.path.length === 0) e.path = nav.findEnemyPath(this.cell(e.pos), this.objectiveGoals(e)) ?? [];
        if (e.path.length === 0) {
          e.state = 'engage'; // arrivé sur l'objectif
          continue;
        }
        e.state = 'approach';
        this.stepEnemy(e, def.speed, true);
        continue;
      }
      if (e.state !== 'engage') {
        if (e.path.length === 0) {
          e.path = nav.findEnemyPath(this.cell(e.pos), this.approachGoals(e)) ?? [];
          if (e.path.length === 0) e.state = 'engage'; // arrivé au contact du périmètre
        }
        if (e.state !== 'engage') {
          e.state = 'approach';
          this.stepEnemy(e, def.speed, false);
        }
      }
    }
  }

  /**
   * Objectif d'un assaut à l'intérieur de la base : TOC, dépôt de munitions, logements… le plus
   * proche des bâtiments de la catégorie la plus prioritaire présente.
   */
  private objectiveGoals(e: Enemy): GridPos[] {
    const nav = this.ctx.sim.agents.nav;
    const buildings = Object.values(this.ctx.state.fob.buildings).filter((b) => {
      const d = this.ctx.content.building(b.defId);
      return b.state !== 'construction' && d.visual.style !== 'flat' && !d.gate && !d.placement.line;
    });
    for (const ids of OBJECTIVE_PRIORITY) {
      const list = buildings.filter((b) => ids.length === 0 || ids.includes(b.defId)).sort((a, b) => this.distTo(e, a) - this.distTo(e, b));
      for (const b of list) {
        const cells = nav.accessCells(b).filter((x) => nav.enemyPassable(x.x, x.y));
        if (cells.length) return cells;
      }
    }
    const z = this.ctx.state.fob.zone;
    const center = { x: Math.floor(z.x + z.width / 2), y: Math.floor(z.y + z.height / 2) };
    return [nav.randomWalkableNear(center, 4, () => this.ctx.random()) ?? center];
  }

  private distTo(e: Enemy, b: BuildingInstance): number {
    const c = this.ctx.sim.agents.buildingCenter(b);
    return Math.hypot(c.x - e.pos.x, c.y - e.pos.y);
  }

  /** Avance sur la grille des assaillants ; une porte ou un mur sur le chemin : on le force (assaut) ou on s'arrête. */
  private stepEnemy(e: Enemy, speed: number, canBreach: boolean): void {
    const nav = this.ctx.sim.agents.nav;
    let budget = speed * this.ctx.content.balance.time.minutesPerTick;
    while (budget > 0 && e.path.length > 0) {
      const next = e.path[0];
      const blocking = nav.breachAt(next.x, next.y);
      if (blocking) {
        e.path = [];
        if (!canBreach) {
          e.state = 'engage';
          return;
        }
        e.state = 'breach';
        e.breachId = blocking;
        if (!this.breachAnnounced.has(blocking)) {
          this.breachAnnounced.add(blocking);
          const b = this.ctx.state.fob.buildings[blocking];
          if (b) pushLog(this.ctx, 'bad', 'log.breaching', { name: this.ctx.content.building(b.defId).name });
        }
        return;
      }
      if (!nav.enemyPassable(next.x, next.y)) {
        e.path = [];
        return;
      }
      const tx = next.x + 0.5;
      const ty = next.y + 0.5;
      const dx = tx - e.pos.x;
      const dy = ty - e.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = budget / nav.costAt(next.x, next.y);
      if (step >= dist) {
        e.pos.x = tx;
        e.pos.y = ty;
        e.path.shift();
        budget -= dist * nav.costAt(next.x, next.y);
      } else {
        e.pos.x += (dx / dist) * step;
        e.pos.y += (dy / dist) * step;
        budget = 0;
      }
    }
  }

  /** Un assaillant force une porte (à coups de crosse, de pied-de-biche) ou souffle un mur à l'explosif. */
  private breachStep(e: Enemy): void {
    const s = this.ctx.state;
    const b = e.breachId ? s.fob.buildings[e.breachId] : undefined;
    if (!b) {
      e.state = 'approach';
      e.breachId = null;
      e.path = [];
      return;
    }
    const def = this.ctx.content.building(b.defId);
    const minutes = this.ctx.content.balance.time.minutesPerTick;
    b.wear = Math.min(1, b.wear + minutes / Math.max(1, def.breachMin ?? 20));
    const ctr = this.ctx.sim.agents.buildingCenter(b);
    // Coups sur la porte : petites gerbes d'étincelles de temps en temps
    if (def.gate && this.ctx.random() < 0.25) this.ctx.bus.emit('combat:shot', { fromX: e.pos.x, fromY: e.pos.y, fromZ: 10, toX: ctr.x + 0.5, toY: ctr.y + 0.5, toZ: 10, hit: true, friendly: false });
    if (b.wear < 1) return;
    // Brèche ouverte
    if (!def.gate) this.ctx.bus.emit('combat:impact', { x: ctr.x + 0.5, y: ctr.y + 0.5, radius: 1 });
    s.combat.stats.damaged++;
    this.ctx.sim.build.destroy(b.id);
    for (const other of Object.values(s.combat.enemies)) {
      if (other.breachId === b.id) {
        other.state = 'approach';
        other.breachId = null;
        other.path = [];
      }
    }
  }

  private cell(p: { x: number; y: number }): GridPos {
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  /** Cases juste à l'extérieur du périmètre, du côté de l'ennemi. */
  private approachGoals(e: Enemy): GridPos[] {
    const z = this.ctx.state.fob.zone;
    const nav = this.ctx.sim.agents.nav;
    const px = Math.min(z.x + z.width - 1, Math.max(z.x, Math.floor(e.pos.x)));
    const py = Math.min(z.y + z.height - 1, Math.max(z.y, Math.floor(e.pos.y)));
    const goals: GridPos[] = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const x = px + dx;
        const y = py + dy;
        if (nav.enemyPassable(x, y)) goals.push({ x, y });
      }
    }
    return goals;
  }

  private step(e: Enemy, speed: number): void {
    const nav = this.ctx.sim.agents.nav;
    let budget = speed * this.ctx.content.balance.time.minutesPerTick;
    while (budget > 0 && e.path.length > 0) {
      const next = e.path[0];
      if (!nav.walkable(next.x, next.y)) {
        e.path = [];
        return;
      }
      const tx = next.x + 0.5;
      const ty = next.y + 0.5;
      const dx = tx - e.pos.x;
      const dy = ty - e.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = budget / nav.costAt(next.x, next.y);
      if (step >= dist) {
        e.pos.x = tx;
        e.pos.y = ty;
        e.path.shift();
        budget -= dist * nav.costAt(next.x, next.y);
      } else {
        e.pos.x += (dx / dist) * step;
        e.pos.y += (dy / dist) * step;
        budget = 0;
      }
    }
  }

  /** Personnel visible le plus proche à portée, sinon un bâtiment. */
  private enemyTarget(e: Enemy, range: number): { agent?: Agent; building?: Id; x: number; y: number } | null {
    const s = this.ctx.state;
    let best: Agent | null = null;
    let bestD = range;
    for (const a of Object.values(s.agents)) {
      if (a.status !== 'on_base' || this.hidden(a)) continue;
      const p = this.agentPos(a);
      const d = Math.hypot(p.x - e.pos.x, p.y - e.pos.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    if (best) {
      const p = this.agentPos(best);
      return { agent: best, x: p.x, y: p.y };
    }
    for (const b of Object.values(s.fob.buildings)) {
      if (b.state === 'construction' || this.ctx.content.building(b.defId).visual.style === 'flat') continue;
      const ctr = this.ctx.sim.agents.buildingCenter(b);
      if (Math.hypot(ctr.x - e.pos.x, ctr.y - e.pos.y) < range) return { building: b.id, x: ctr.x + 0.5, y: ctr.y + 0.5 };
    }
    return null;
  }

  /** Agent à l'intérieur d'un bâtiment : invisible pour les tireurs. */
  private hidden(a: Agent): boolean {
    const act = a.activity;
    return !!act && act.stage === 'acting' && !!act.targetId && this.ctx.content.activity(act.id).inside;
  }

  /** Position effective (garde sur sa tour : centre de la tour). */
  private agentPos(a: Agent): { x: number; y: number } {
    const tower = this.guardTower(a);
    if (tower) {
      const c = this.ctx.sim.agents.buildingCenter(tower);
      return { x: c.x + 0.5, y: c.y + 0.5 };
    }
    return a.pos;
  }

  private guardTower(a: Agent) {
    const act = a.activity;
    if (!act || act.id !== 'guard' || act.stage !== 'acting' || !act.targetId) return null;
    return this.ctx.state.fob.buildings[act.targetId] ?? null;
  }

  private mannedGuardPosts(): Agent[] {
    return Object.values(this.ctx.state.agents).filter((a) => this.guardTower(a) !== null);
  }

  /** Part de l'éclairage nocturne souhaité (mâts d'éclairage alimentés). */
  private litFraction(): number {
    const ratio = powerRatio(this.ctx.state);
    let lit = 0;
    for (const b of Object.values(this.ctx.state.fob.buildings)) if (b.defId === 'floodlight' && (b.state === 'active' || b.state === 'damaged')) lit += ratio;
    return Math.min(1, lit / Math.max(1, this.cfg.floodlightsWanted));
  }

  private isNight(): boolean {
    const h = this.ctx.state.time.minuteOfDay / 60;
    return h < 5 || h >= 20;
  }

  /** Couverture de la cible : derrière un mur, sur une tour, à plat ventre. */
  private coverOf(a: Agent): number {
    if (this.guardTower(a)) return this.cfg.coverMult;
    if (a.activity?.id === 'prone' && a.activity.stage === 'acting') return this.cfg.proneMult;
    const nav = this.ctx.sim.agents.nav;
    const cx = Math.floor(a.pos.x);
    const cy = Math.floor(a.pos.y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((dx || dy) && !nav.walkable(cx + dx, cy + dy) && nav.inBounds(cx + dx, cy + dy)) return this.cfg.coverMult;
    return 1;
  }

  private hitChance(skill: number, distance: number, range: number, cover: number, tower: boolean, shooter?: Agent): number {
    let p = this.cfg.baseHitChance * (skill / 50) * cover * Math.max(0.2, 1 - distance / (range * 1.6));
    if (tower) p += this.cfg.towerBonus;
    // Optiques et vision nocturne du tireur
    const gear = shooter ? gearOf(this.ctx.content, shooter) : [];
    p *= gear.reduce((m, i) => m * (i.combat?.hitMult ?? 1), 1);
    if (this.isNight()) {
      const seeing = Math.max(this.litFraction(), ...gear.map((i) => i.combat?.night ?? 0));
      p *= this.cfg.nightHitMult + (1 - this.cfg.nightHitMult) * seeing;
    }
    return Math.min(0.85, Math.max(0.01, p));
  }

  private enemyShoot(e: Enemy, target: { agent?: Agent; building?: Id; x: number; y: number }): void {
    const def = this.ctx.content.enemy(e.defId);
    const [c0, c1] = this.cfg.shotCooldown;
    e.cooldown = this.now + this.minutesToTicks(this.rand(c0, c1));
    const d = Math.hypot(target.x - e.pos.x, target.y - e.pos.y);
    if (target.agent) {
      const hit = this.ctx.random() < this.hitChance(e.skill, d, def.range, this.coverOf(target.agent), false);
      this.ctx.bus.emit('combat:shot', { fromX: e.pos.x, fromY: e.pos.y, fromZ: 14, toX: target.x, toY: target.y, toZ: this.guardTower(target.agent) ? 40 : 12, hit, friendly: false });
      if (hit) this.hurt(target.agent, this.rand(this.cfg.damage[0], this.cfg.damage[1]), true);
    } else if (target.building) {
      const b = this.ctx.state.fob.buildings[target.building];
      this.ctx.bus.emit('combat:shot', { fromX: e.pos.x, fromY: e.pos.y, fromZ: 14, toX: target.x, toY: target.y, toZ: 14, hit: true, friendly: false });
      if (b) this.ctx.sim.build.applyDamage(b, this.cfg.buildingDamagePerHit);
    }
  }

  /**
   * Tir d'un soldat : puise dans ses munitions individuelles. Un garde à sec recomplète sur le stock
   * de sa tour ; les autres doivent aller se rééquiper au dépôt.
   */
  private useAmmo(a: Agent, tower: BuildingInstance | null): boolean {
    const per = this.cfg.ammoPerShot;
    const cap = this.ctx.content.personnel(a.defId).ammoCapacity ?? 0;
    const logistics = this.ctx.sim.logistics;
    if (cap <= 0) {
      if (logistics.consume(tower, 'ammo', per)) return true;
      this.ctx.sim.economy.flagShortage('ammo');
      return false;
    }
    a.ammo ??= cap;
    if (a.ammo < per && tower) {
      const take = Math.min(cap - a.ammo, logistics.stock(tower, 'ammo'), this.ctx.state.resources.stock.ammo);
      if (take > 0 && logistics.consume(tower, 'ammo', take)) a.ammo += take;
    }
    if (a.ammo < per) {
      if (logistics.free('ammo') < 1) this.ctx.sim.economy.flagShortage('ammo');
      return false;
    }
    a.ammo -= per;
    return true;
  }

  /** Tireurs amis : gardes sur les tours (allonge et précision accrues) et fantassins en position. */
  private friendlyShooters(): [Agent, Shooter][] {
    const out: [Agent, Shooter][] = [];
    for (const a of Object.values(this.ctx.state.agents)) {
      if (a.status !== 'on_base') continue;
      const tower = this.guardTower(a);
      if (tower) {
        const c = this.ctx.sim.agents.buildingCenter(tower);
        const standZ = this.ctx.content.building(tower.defId).services?.guard?.standZ ?? 30;
        out.push([a, { pos: { x: c.x + 0.5, y: c.y + 0.5 }, z: standZ + 8, range: this.cfg.defenderRange + this.cfg.towerRangeBonus, skill: a.skills.shooting ?? 50, tower: true }]);
      } else if (a.activity?.id === 'defend' && a.activity.stage === 'acting') {
        out.push([a, { pos: a.pos, z: 12, range: this.cfg.defenderRange, skill: a.skills.shooting ?? 50, tower: false }]);
      }
    }
    return out;
  }

  private friendlyFire(): void {
    const s = this.ctx.state;
    const enemies = Object.values(s.combat.enemies);
    if (enemies.length === 0) return;
    for (const [a, sh] of this.friendlyShooters()) {
      if ((this.cooldowns.get(a.id) ?? 0) > this.now) continue;
      let target: Enemy | null = null;
      let bestD = sh.range;
      for (const e of enemies) {
        if (e.health <= 0) continue;
        const d = Math.hypot(e.pos.x - sh.pos.x, e.pos.y - sh.pos.y);
        if (d < bestD) {
          bestD = d;
          target = e;
        }
      }
      if (!target) continue;
      // Munitions portées par le tireur (un garde recomplète sur les caisses de sa tour)
      if (!this.useAmmo(a, sh.tower ? this.guardTower(a) : null)) continue;
      const [c0, c1] = this.cfg.shotCooldown;
      this.cooldowns.set(a.id, this.now + this.minutesToTicks(this.rand(c0, c1)));
      // Couverture de l'ennemi : à plat dans la nature, il se cache mieux en position de tir
      const cover = target.state === 'engage' ? 0.75 : 1;
      const hit = this.ctx.random() < this.hitChance(sh.skill * a.efficiency + 10, bestD, sh.range, cover, sh.tower, a);
      this.ctx.bus.emit('combat:shot', { fromX: sh.pos.x, fromY: sh.pos.y, fromZ: sh.z, toX: target.pos.x, toY: target.pos.y, toZ: 10, hit, friendly: true });
      if (hit) {
        target.health -= this.rand(this.cfg.damage[0], this.cfg.damage[1]);
        if (target.health <= 0) {
          delete s.combat.enemies[target.id];
          s.combat.stats.enemyKilled++;
          a.xp += 5;
          this.ctx.bus.emit('combat:death', { x: target.pos.x, y: target.pos.y, friendly: false });
        }
      }
    }
  }

  // ------------------------------------------------------------ Blessures et pertes

  /** Inflige des dégâts à un agent ; à zéro de santé, il tombe. */
  hurt(a: Agent, amount: number, inCombat: boolean): void {
    if (amount <= 0) return;
    a.health = Math.max(0, a.health - amount);
    if (inCombat && !this.wounded.has(a.id)) {
      this.wounded.add(a.id);
      this.ctx.state.combat.stats.wounded++;
    }
    if (a.health <= 0) this.kill(a);
  }

  kill(a: Agent, fx = true): void {
    const s = this.ctx.state;
    const name = `${a.rank} ${a.firstName} ${a.lastName}`;
    s.memorial.push({ name, day: s.time.day });
    if (a.groupId && s.groups[a.groupId]) s.groups[a.groupId].memberIds = s.groups[a.groupId].memberIds.filter((id) => id !== a.id);
    if (a.activity?.carry) a.activity.carry = null;
    delete s.agents[a.id];
    if (s.combat.active) {
      s.combat.stats.kia++;
      if (this.wounded.delete(a.id)) s.combat.stats.wounded--;
    }
    this.ctx.sim.agents.markHomesDirty();
    pushLog(this.ctx, 'bad', 'log.kia', { name });
    if (fx) this.ctx.bus.emit('combat:death', { x: a.pos.x, y: a.pos.y, friendly: true });
    this.ctx.bus.emit('agent:removed', { id: a.id });
  }

  // ------------------------------------------------------------ Positions de défense

  /** Case de défense pour un fantassin : derrière un mur, du côté de l'ennemi. */
  defensivePosition(a: Agent): GridPos | null {
    const s = this.ctx.state;
    const nav = this.ctx.sim.agents.nav;
    const enemies = Object.values(s.combat.enemies);
    const focus = enemies.length
      ? { x: enemies.reduce((t, e) => t + e.pos.x, 0) / enemies.length, y: enemies.reduce((t, e) => t + e.pos.y, 0) / enemies.length }
      : s.combat.origin;
    const z = s.fob.zone;
    let best: GridPos | null = null;
    let bestScore = Infinity;
    for (const b of Object.values(s.fob.buildings)) {
      if (b.defId !== 'hesco' || b.state === 'construction') continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const x = b.pos.x + dx;
        const y = b.pos.y + dy;
        if (!nav.walkable(x, y) || x < z.x || y < z.y || x >= z.x + z.width || y >= z.y + z.height) continue;
        // Côté intérieur du mur : plus loin de l'ennemi que le mur lui-même
        if (Math.hypot(x - focus.x, y - focus.y) < Math.hypot(b.pos.x - focus.x, b.pos.y - focus.y)) continue;
        const key = `${x},${y}`;
        const score = Math.hypot(x - focus.x, y - focus.y) + (this.positions.get(key) ?? 0) * 6 + Math.hypot(x - a.pos.x, y - a.pos.y) * 0.3;
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    if (!best) {
      // Pas de mur : bord du périmètre face à l'ennemi, deux cases à l'intérieur
      const x = Math.round(Math.min(z.x + z.width - 3, Math.max(z.x + 2, focus.x)));
      const y = Math.round(Math.min(z.y + z.height - 3, Math.max(z.y + 2, focus.y)));
      best = nav.randomWalkableNear({ x, y }, 2, () => this.ctx.random());
    }
    if (best) {
      const key = `${best.x},${best.y}`;
      this.positions.set(key, (this.positions.get(key) ?? 0) + 1);
    }
    return best;
  }

  // ------------------------------------------------------------ Fin

  private end(): void {
    const s = this.ctx.state;
    const c = s.combat;
    const def = this.ctx.content.combat.attacks[c.attackId ?? ''];
    const stats = { ...c.stats };
    const morale = stats.kia > 0 ? this.cfg.lossMorale : def?.type === 'indirect' ? this.cfg.fearMorale : this.cfg.victoryMorale;
    for (const a of Object.values(s.agents)) a.needs.morale = Math.max(0, Math.min(100, a.needs.morale + morale));
    s.combat = emptyCombat();
    this.cooldowns.clear();
    this.positions.clear();
    this.batteryReady.clear();
    this.artilleryAnnounced = false;
    this.heliReady.clear();
    // Les hélicoptères de combat rentrent se poser
    for (const v of Object.values(s.vehicles)) if (v.state === 'sortie') this.ctx.sim.supply.sendHeli(v, 'back');
    pushLog(this.ctx, stats.kia > 0 ? 'bad' : 'warn', 'log.attackEnded', {
      name: def?.name ?? '',
      kia: stats.kia,
      wounded: stats.wounded,
      enemies: stats.enemyKilled,
      damaged: stats.damaged,
    });
    this.ctx.bus.emit('combat:ended', { stats });
    this.ctx.sim.agents.standDown();
  }
}
