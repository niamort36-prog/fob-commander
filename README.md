# FOB COMMANDER (nom provisoire)

**Jouer en ligne :** https://niamort36-prog.github.io/fob-commander/ — mis à jour automatiquement à chaque envoi sur `main` (workflow `.github/workflows/deploy.yml`).
Les sauvegardes restent dans le navigateur utilisé (stockage local).

Jeu de gestion et de construction d'une base opérationnelle avancée (FOB), Afghanistan années 2000-2010.
Tous les lieux, personnages et factions sont fictifs.

**Stack** : TypeScript strict · Phaser 3.90 · Vite · Vitest · contenu en JSON · sauvegardes en localStorage.

## Lancer le projet

Prérequis : Node.js 18 ou plus récent.

```bash
npm install
npm run dev          # serveur de développement → http://localhost:5173
npm test             # tests unitaires de la simulation (Vitest)
npm run typecheck    # vérification TypeScript
npm run build        # build de production dans dist/
npm run preview      # sert le build de production
```

## Contrôles

| Action | Commande |
|---|---|
| Construire | choisir un bâtiment dans le menu, puis clic gauche |
| Murs HESCO / routes | cliquer-glisser pour tracer une ligne |
| Pivoter (et orienter l'entrée) | `R` — la flèche de l'aperçu indique la porte ; orange si l'accès est bloqué |
| Démolir | bouton *Démolir* ou `X`, puis clic sur le bâtiment (remboursement 50 %, 100 % si le chantier n'est pas fini) |
| Annuler | `Échap` ou clic droit |
| Sélectionner | clic gauche sur un bâtiment (panneau d'info, `Suppr` pour démolir) |
| Déplacer la vue | clic droit glissé, clic molette glissé, `ZQSD` / `WASD` / flèches |
| Zoom | molette |
| Pause / vitesses | `Espace`, `1` (x1), `2` (x2), `3` (x4), `4` (x8) |
| Grille | `G` |
| Liste du personnel | `P` ou bouton *Personnel* — ✎ renommer un groupe, ✕ le dissoudre, *+ Nouveau groupe*, liste déroulante pour changer un soldat de groupe (aussi depuis sa fiche) |
| Logistique (commandes, renforts, chariots) | `L` ou bouton *Logistique* |
| Carte tactique | `M` ou bouton *Carte* (glisser pour déplacer, molette pour zoomer, clic pour sélectionner) |
| Planifier une mission | carte (`M`), sélectionner un contact, un village ou la FOB, bouton *Planifier une mission* |
| Opérations (missions en cours, comptes rendus) | `O` ou bouton *Opérations* |
| Campagne (objectifs, stabilité, villages) | `C`, bouton *Campagne* ou clic sur *STAB* dans la barre du haut |
| Options (son, nuit, vitesse des textes…) | bouton *Options* (menu principal ou barre du haut) |
| Tutoriel | proposé en début de partie (désactivable dans les options) |
| Diplomatie d'un village | carte (`M`), sélectionner un village, bouton *Diplomatie* (ou clic sur un village dans le panneau de campagne) |
| Améliorer un bâtiment | sélectionner le bâtiment, bouton *Améliorer* |
| Fiche d'un soldat | clic gauche sur l'agent (ou sur une ligne de la liste) |
| Agrandir la base | bouton *Agrandir le périmètre* du menu de construction |

## Architecture

```
src/
  core/      GameState (état sérialisable), Simulation (tick fixe), EventBus typé,
             Commands (file de commandes), ContentRegistry (chargement + validation des JSON)
  systems/   TimeSystem, BuildSystem (périmètre, chantiers), EconomySystem, SaveSystem (migrations),
             NeedsSystem (besoins, moral, santé), AgentAI (routines, réservations, déplacements),
             NavGrid (coûts de déplacement + A*)
             + MissionSystem, RadioSystem, EventSystem, DiplomacySystem, IntelSystem (phases suivantes)
  scenes/    Boot, Menu, Setup, Fob, UI, Map*, Dialog*   (* coquilles des phases 4-5)
  render/    IsoMath, TerrainRenderer (blocs + élimination hors champ), ZoneRenderer, BuildingRenderer,
             AgentRenderer, GhostPreview, CameraController
  ui/        interface DOM superposée (HUD, menu de construction, panneaux, sauvegardes) + ui.css
  assets/    AssetLoader (atlas), PlaceholderFactory (graphismes générés), spriteKeys (convention)
  data/      tout le contenu et l'équilibrage en JSON
  utils/     Rng déterministe, bruit, génération du terrain, i18n, validation
tests/       tests Vitest de la simulation (sans Phaser)
```

Principes :
- La **simulation** (`core/`, `systems/`) n'importe jamais Phaser : elle tourne dans Node pour les tests.
- 1 tick = 1 minute de jeu ; 10 ticks/s à x1 (une journée ≈ 2 min 24). Réglable dans `balance.json`.
- L'interface ne modifie jamais l'état : elle pousse des **commandes**, validées par les systèmes.
- Les systèmes communiquent par l'**EventBus** (`core/GameEvents.ts` liste tous les événements).

## Une base qui grandit

La carte fait 160 × 160 cases (`balance.json → map`). Seul le **périmètre** possédé est constructible :
il démarre à 32-48 cases de côté selon le site (`sites.json → zone`) et s'agrandit de `zone.step` cases
de chaque côté contre paiement (coût croissant, `zone.baseCost × zone.costGrowth^n`). Le sol est rendu
par blocs de 16 × 16 masqués hors du champ de la caméra : la taille de la carte n'a pas d'effet sur
les performances d'affichage.

## Vie dans la base (Phase 2)

- Chaque habitant suit l'emploi du temps de son rôle (`routines.json`, avec quarts décalés pour
  l'infanterie) ; un besoin critique passe avant tout (manger, dormir, se laver).
- Les activités (`activities.json`) utilisent les **services** des bâtiments (`services` dans
  `buildings.json` : couchages, repas, douches, garde, TOC, infirmerie, sport), avec des places
  limitées et des solutions de repli (ration froide, dormir à même le sol…).
- Les besoins, le moral, la santé et les incidents sont réglés dans `needs.json` ; les traits de
  personnalité dans `traits.json` ; les types de personnel et leurs compétences dans `personnel.json`.
- Les logisticiens travaillent sur les chantiers : chaque ouvrier accélère la construction.
- Les murs et bâtiments bloquent le passage : laissez une entrée dans votre enceinte HESCO.

## Économie et ravitaillement (Phase 3)

- **Convois routiers** : les camions arrivent par la **piste** depuis le bord de carte (`sites.json → entry`)
  et roulent jusqu'à leur destination. Les murs et bâtiments bloquent les véhicules : gardez un accès.
- **Camion-citerne** : se gare **à côté d'une citerne d'eau** (ou d'un réservoir de carburant) et pompe
  son chargement. C'est la source d'eau du début de partie, avant le **forage** (débloqué à réputation 25).
- **Camion de palettes** : se gare sur une **zone de déchargement** ; le personnel disponible (soutien,
  soldats à l'entraînement ou au repos) fait des **allers-retours** jusqu'au stockage (entrepôt, dépôt de
  munitions, à défaut la zone elle-même). Un **chariot élévateur** (6 000 $) décharge bien plus vite.
- **Hélicoptère** : rapide et sûr, coûteux, se pose sur une **hélisurface**.
- **Embuscades** : risque par commande × danger de la route du site ; une partie de la cargaison est perdue.
- **Renforts** : embarqués dans les convois ; les profils rares se débloquent avec la réputation.
- **Électricité** : groupes électrogènes (carburant) ; sans courant suffisant, les bâtiments électriques
  tournent à mi-régime.
- **Usure** : les bâtiments s'usent, deviennent endommagés puis hors service ; le soutien les répare avec
  des pièces (deux fois plus vite avec un atelier).
- **Améliorations** : niveaux supplémentaires (`levels` dans `buildings.json`), réalisés par les ouvriers.
- **Commandement** : évaluation chaque nuit (moral, logement, postes de garde, approvisionnement) →
  réputation (déblocages) et budget du lendemain (×0,7 à ×1,3). Les salaires sont prélevés chaque jour.

Contenu : `supply.json` (commandes, prix, renforts), `vehicles.json` (camions, hélicoptère, chariot),
`balance.json → supply / power / wear / command`.

## Événements et attaques (Phase 4)

- **Événements** (`events.json`) : conditions (jour, réputation, ressources, drapeaux, plage horaire,
  bâtiment requis), poids, recharge, personnages avec **portrait pixel art** généré, choix (avec coûts
  et prérequis), issues pondérées ou conditionnées par l'évaluation de la base, effets (ressources,
  réputation, moral, blessés, drapeaux, recrues, retards de livraison, usure, **événements en chaîne**,
  attaques). Le jeu se met en pause pendant le dialogue.
- **Attaques** (`combat.json`) jouées dans la vue FOB : tirs de mortier (impacts, dégâts, contre-batterie
  par les gardes), harcèlement et assaut nocturne (insurgés qui approchent, échanges de tirs, repli).
  Choix tactique dans le dialogue d'alerte : **tous aux abris** ou **riposte**. Les **abris bétonnés**
  protègent des éclats, les murs HESCO couvrent les défenseurs, les tours donnent portée et précision.
  Chaque tir consomme des munitions. Blessés soignés plus vite à l'infirmerie (matériel médical) ;
  les soldats tombés sont inscrits au mémorial.

## Carte tactique (Phase 5)

- **District fictif de Sarband** (60 × 45 km, `region.json`) : relief en courbes de niveau et teintes,
  rivières, route nationale et pistes, villages, quadrillage de 5 km. L'emplacement de la FOB se
  choisit sur cette carte en début de partie.
- **Symboles OTAN (APP-6 simplifié)** : FOB et unités amies/alliées (bleu), contacts hostiles (rouge),
  non identifiés (jaune), cadre en pointillés pour un renseignement présumé ; échelons.
- **Brouillard de guerre** : les contacts ennemis ne sont connus que renseignés — position estimée,
  cercle d'incertitude, cote de fiabilité (A à F), âge ; sans nouvelles, l'information se dégrade puis se perd.
  Sources : surveillance de la FOB (étendue par les tours occupées), informateurs des villages favorables,
  analyse des officiers au TOC, agent CIA, événements, analyse après attaque.
- **Villages** (attitude, emprise insurgée, besoins) et **personnalités** (rencontrées lors des événements).

## Missions et radio (Phase 6)

- **8 types de missions** (`missions.json`) : patrouille, reconnaissance, recueil de renseignement,
  sécurisation de village, raid, escorte de convoi, rencontre avec un chef, opération spéciale.
  Chacune a ses cibles (contact, village, FOB), son effectif, sa difficulté, son risque et ses gains.
- **Préparation** depuis la carte : choix du personnel (par soldat ou par groupe), des véhicules
  blindés (MRAP, achetables une fois le *parc à véhicules* construit), de la dotation (légère, standard,
  renforcée). La chance de succès est estimée avec une fourchette (compétences, effectif, chef,
  spécialistes, force de l'ennemi, emprise insurgée, fiabilité du renseignement).
- **Déroulement** : l'équipe se rassemble au point de départ de la base, puis quitte la carte de la FOB
  (les MRAP prennent la piste). Le symbole de l'unité progresse sur la carte tactique.
- **Radio** (`radio.json`) : des messages arrivent en cours de mission (accrochage, blessé, IED,
  foule, cible absente, renforts ennemis, cache, panne, informateur, tombée de la nuit…). Le jeu se met
  en pause ; chaque réponse modifie la chance, les pertes, la durée, coûte des ressources (appui aérien,
  MEDEVAC), touche les villages ou interrompt la mission.
- **Résolution** : succès, succès partiel ou échec ; pertes (tués et blessés), XP, moral, fonds,
  réputation, attitude et emprise des villages, renseignement confirmé, contacts révélés ou neutralisés,
  route sécurisée pour les convois. Un **compte rendu rédigé** s'ouvre au retour de l'unité
  (historique dans le panneau *Opérations*).

## Géopolitique et campagne (Phase 7)

- **Villages vivants** (`diplomacy.json`) : chaque jour, l'emprise insurgée revient vers son équilibre,
  monte quand des groupes ennemis s'installent à proximité et baisse avec la présence de la coalition
  (patrouilles récentes, poste de police, bonne attitude). L'attitude garde la mémoire des actions
  et revient lentement vers une valeur qui dépend des besoins satisfaits et de l'emprise insurgée.
  Paliers : hostile, méfiant, neutre, favorable, allié.
- **Diplomatie** (fenêtre *Diplomatie* d'un village) : distribution humanitaire, consultation médicale
  (MEDCAP), indemnisation, rétribution du chef (mal vue du commandement), **shura** avec les anciens
  (issue incertaine : renseignement, rencontre du chef, demande).
- **Demandes et promesses** : après une shura, le chef peut formuler une demande (puits, école…).
  La promettre améliore aussitôt l'attitude ; la tenir dans le délai rapporte confiance et réputation,
  la rompre fait chuter les deux et renforce les insurgés.
- **Projets civils** : puits, école, dispensaire, réfection de piste (réduit le risque routier), poste de
  police locale (réduit l'emprise chaque jour). Les chantiers peuvent être sabotés dans les villages tenus.
- **Auxiliaires locaux** : recrutables dans les villages favorables (attitude ≥ 30), noms afghans,
  bonus pour les patrouilles, le renseignement et la sécurisation de village. Une recrue peut être
  **infiltrée** : l'événement « Un loup dans la bergerie » survient alors quelques jours plus tard.
- **Stabilité régionale** (0-100, `STAB` dans la barre du haut) : population, emprise insurgée,
  force ennemie réelle et incidents récents (attaques, pertes, bavures, promesses rompues).
  Elle module le **budget** du commandement, la **fréquence des attaques** contre la base et le
  **risque d'embuscade** des convois.
- **Réaction de l'insurrection** : de nouveaux groupes apparaissent près des villages qu'elle tient
  (un village favorable prévient la base).
- **Campagne** (`campaign.json`) : quatre phases (S'implanter, Gagner la population, Briser
  l'insurrection, Transition), chacune avec ses objectifs, un délai, une récompense et une sanction
  en cas de retard. Victoire au terme de la phase IV ; une stabilité effondrée pendant 7 jours
  entraîne la relève (on peut alors continuer hors campagne).

## Finitions (Phase 8)

- **Cycle jour/nuit** (`ambience.json`) : teinte chaude le jour, orangée à l'aube et au crépuscule,
  bleutée la nuit. La nuit, les bâtiments éclairés (éteints sans électricité, vacillants s'il en
  manque), les **mâts d'éclairage** (nouveau bâtiment, onglet INF), les phares des véhicules,
  les explosions et les départs de coups dessinent des halos de lumière. Les mâts alimentés
  compensent la pénalité de tir des défenseurs de nuit.
- **Sons synthétisés** (`audio.json`, Web Audio, aucun fichier) : interface, chantiers, radio,
  sirène d'alerte, tirs amis/ennemis, explosions, moteurs, fanfare de victoire ; ambiance
  (vent en rafales, grillons la nuit, ronronnement des groupes électrogènes), spatialisée selon
  la position dans la base et étouffée quand la carte est ouverte.
- **Options** (`settings.json`, enregistrées dans le navigateur) : volumes par catégorie, coupure
  du son, intensité de la nuit, vitesse des textes, défilement par les bords, tutoriel,
  sauvegarde automatique.
- **Tutoriel guidé** (`tutorial.json`) : 13 étapes validées par les actions du joueur
  (tentes, accélération du temps, ravitaillement, tour de garde, éclairage, carte, patrouille,
  diplomatie, campagne), avec mise en évidence de l'interface concernée.
- **Menus** : Options et À propos dans le menu principal ; écran de fin de campagne (victoire ou
  relève) avec bilan complet et mémorial des soldats tombés, retour au menu.
- **Équilibrage** (parties simulées sur 60 jours) : réputation plus progressive
  (`balance.json` → `command.reputationPerPoint` = 3), camion de ravitaillement porté à 800 unités
  et hélicoptère à 250 (`vehicles.json`), phase I de campagne portée à 25 jours, stabilité initiale
  calibrée.

## Points de réputation, aviation et artillerie

- **Points de réputation (PR)** : la réputation reste un niveau (0-100) ; les PR sont une monnaie
  gagnée chaque jour selon l'évaluation du commandement, avec les missions réussies, les projets
  civils et les phases de campagne (`balance.json` → `progression`). Les bâtiments avancés
  s'**achètent** en PR (clic sur le bâtiment verrouillé dans le menu), parfois après un niveau de
  réputation minimal (`buildings.json` → `unlock: { reputation, points }`).
- **Piste d'aviation** (4 × 22, orientable) : rotations de **C-130 Hercules** (3 000 unités de fret,
  40 renforts, 2 véhicules en soute). L'avion arrive en finale dans l'axe, se pose, roule jusqu'au
  bout de piste, est déchargé par le personnel (jusqu'à 10 porteurs), fait demi-tour au roulage et
  redécolle. Balisage lumineux la nuit.
- **Véhicules** : nouveau **Humvee** (rapide, 4 places, peu protégé) à côté du MRAP ; protection
  propre à chaque véhicule en mission ; livraison possible par C-130 ; les véhicules se garent
  côte à côte au parc.
- **Appui feu des missions** (`missions.json` → `support`) : artillerie de la base (portée 25 km),
  **A-10** de jour (une sortie par 24 h, décollage visible au-dessus de la base), **AC-130** de nuit
  (une sortie par 48 h). Chaque appui augmente la chance de succès, réduit les pertes, coûte des
  ressources et comporte un risque de dommages collatéraux. Avec un appui aérien en alerte, la
  demande d'appui par radio est gratuite.
- **Batterie d'obusiers** : pilonne les assaillants pendant les attaques au sol (jamais trop près
  des soldats amis) et riposte aux tirs de mortier (contre-batterie). Départs de coups visibles
  et audibles.

## Entrées des bâtiments

Les bâtiments à porte (`"entrance": true` dans `buildings.json` : bâtiments en dur, abris, tentes)
ont un côté d'entrée qui tourne avec eux (`R`). L'aperçu fantôme affiche une flèche vers l'extérieur
(orange si les cases devant la porte sont bloquées) ; la porte est dessinée sur la façade visible.
Les soldats entrent par ce côté (repli sur les autres côtés si la porte est murée).

## Visites physiques et forces spéciales

- **Visites** (`events.json` → `visit`, apparences dans `visitors.json`) : les événements de visite
  font venir la délégation dans la base avant d'ouvrir le dialogue. L'ancien de Sangar arrive en
  **charrette à âne** avec ses hommes armés, le général et la journaliste en **hélicoptère** (posé sur
  l'hélisurface, sinon sur une zone dégagée), la société privée en tout-terrain, la villageoise,
  l'informateur et le déserteur à pied. Le dialogue s'ouvre quand le chef de délégation (nom affiché
  au-dessus de lui) arrive devant le TOC ; la délégation reste ensuite un moment puis repart comme
  elle est venue (aussitôt en cas d'attaque). Aucun autre événement ne survient pendant une visite.
- **Forces spéciales** : les opérateurs ne peuvent être recrutés qu'avec un **commandant des forces
  spéciales** présent à la base (un seul, réputation 35, `supply.json` → `recruits` : `requires`, `max`).
  Le commandant compte comme opérateur pour les opérations spéciales.

## Améliorations des bâtiments, TOC et équipement

- **Améliorations** (`buildings.json` → `modules`, fiche du bâtiment → section *Améliorations*) :
  installées par les ouvriers, indépendantes des niveaux, souvent **visibles sur le bâtiment** :
  - tentes : lits et matelas (sommeil), **climatisation** (confort, électricité, climatiseur visible),
    **murets de sacs de sable** (protection contre les éclats, visibles) ;
  - TOC : **antenne radio** (portée radio +15 km, mât haubané visible), **liaison satellite**
    (portée illimitée et bonus, parabole), **informatique** (analyse du renseignement plus fine,
    parfois un second dossier par jour, groupe de refroidissement sur le toit) ;
  - réfectoire : cuisine équipée (cheminée), climatisation ; douches : chauffe-eau (réservoir sur le
    toit) ; infirmerie : bloc de soins avancés (guérison plus rapide, croix rouge sur le toit).
- **Liaison radio** : au-delà de la portée du TOC (12 km, 6 km sans TOC), la chance de succès baisse
  avec la distance (`missions.json` → `config.comms`).
- **Officiers au TOC** : chaque mission hors de la base doit être suivie par un officier présent au
  TOC (officier, commandant, commandant SF, agent CIA). Le suivi est relevé chaque heure : pénalité
  s'il manque des officiers, petit bonus sinon (`config.toc`). Le planificateur affiche la situation.
- **Équipement individuel** (`equipment.json`, Logistique → *Équipement individuel*) : jumelles,
  lunettes de visée, **vision nocturne**, optiques thermiques, achetés par 5, stockés au dépôt de
  munitions, distribués aux combattants (puis récupérables). Bonus en mission selon la part de
  l'équipe équipée (vision nocturne : objectif atteint de nuit, moins de pertes) et en défense de la
  base (précision, tir de nuit sans pénalité, guetteurs plus efficaces contre les mortiers).

## Hélicoptères de la base, parcs, personnages

- **Hélicoptères achetables** (Logistique → équipement, une **hélisurface** requise, **un appareil par
  hélisurface**) : ils arrivent en vol et se posent, rotor arrêté.
  - **Hélicoptère de combat** : appui feu des missions (option du planificateur, il part avec l'unité
    et revient se poser) et **défense de la base** (il décolle pendant les attaques au sol, tourne
    au-dessus des assaillants et les mitraille ; il peut aussi neutraliser une équipe de mortier).
  - **Hélicoptère de transport** : **héliportage** des missions (8 soldats, trajet bien plus rapide
    et plus sûr, consomme du carburant).
  - Une hélisurface occupée par un appareil de la base ne reçoit plus les rotations de ravitaillement.
- **Parcs à véhicules** : 4 véhicules (MRAP et Humvee confondus) par parc, chacun sur sa place attitrée.
- **Personnages** : tenue propre à chaque rôle (casque et gilet des fantassins, vision nocturne et
  barbe des forces spéciales, casquette des officiers, gilet haute visibilité des logisticiens,
  croix rouge des secouristes, tenue civile des contractors et de la CIA, shalwar kamiz des
  auxiliaires), trois teintes de peau, pas de marche, et **insigne de couleur par rôle** au-dessus de
  la tête (légende dans la liste du personnel).
- **Exercices visibles** : tir couché sur le pas de tir (départs de coups et traceuses vers les
  cibles), course et escalade sur le parcours du combattant, tractions, pompes et squats à l'aire
  de musculation.

## Entraînement

Onglet **ENT** du menu de construction. Pendant leur heure d'entraînement, les soldats choisissent
une structure libre (sinon ils s'entraînent à l'air libre) et **progressent dans leurs compétences**,
ce qui améliore leurs chances en mission et leur tir en défense :
- **Stand de tir** : tir +0,8/h, consomme **3 munitions par heure et par tireur**, de 6 h à 21 h.
  **Bruyant** : les soldats qui dorment dans un logement à moins de 10 cases d'un stand en activité
  récupèrent beaucoup moins et perdent du moral (« dérangé par le bruit » sur leur fiche). La zone
  de bruit s'affiche quand on pose le stand (logements exposés surlignés) ou un logement, et la fiche
  des tentes exposées le signale. Améliorations : cibles mobiles (progression ×1,5), **merlons
  antibruit** (bruit deux fois moins loin, visibles).
- **Parcours du combattant** : discrétion et commandement, fatigant et salissant.
- **Maison de combat (CQB)** : tir, discrétion et commandement, tirs à blanc (1 munition/h), un peu
  bruyante (6 cases).
- **Aire de musculation** en plein air : moral, quand la salle de sport est pleine.
- **Salle de sport** : nouvelles améliorations (bancs et charges guidées, tapis et vélos, ring et
  sacs de frappe, climatisation).

## Logistique interne et routines du soutien

La base vit désormais de ses propres corvées (`LogisticsSystem`, `balance.json → logistics`) :
- **Stocks locaux** (`buildings.json → supplies` : capacité et seuil de réapprovisionnement) :
  réfectoire (rations), tours de garde, obusiers, stand de tir et maison de combat (munitions),
  groupes électrogènes (carburant), infirmerie (médical). Ils font partie du stock global affiché
  mais doivent être **apportés à pied** depuis l'entrepôt, le dépôt de munitions ou la citerne
  (à défaut une aire de déchargement) par le soutien. Un bâtiment **à sec** ne fonctionne plus :
  groupe sans carburant = plus de courant, tour sans munitions = garde qui ne tire qu'avec sa
  dotation (moins bien, moins loin), obusiers muets, stand fermé, infirmerie sans soins avancés.
  Un bâtiment terminé reçoit une dotation initiale.
- **Cuisiniers** (nouveau rôle recrutable, calot et tablier blancs, un au départ) : ils transforment
  les rations livrées au réfectoire en **repas chauds** (`kitchen.mealCapacity`). Sans repas prêt, les
  soldats mangent une **ration froide** (moral en baisse). Le soutien dépanne en cuisine si personne n'y est.
- **Propreté** (`cleaning.dirtPerUse`) : douches/latrines et réfectoire se salissent à chaque passage ;
  sales, elles rendent moins de services et minent le moral (sacs poubelle et flaque visibles). Le
  soutien (et les auxiliaires) les **nettoie**.
- **Chantiers réalistes** : chaque construction, amélioration ou module demande des **matériaux**
  (1 unité par 150 $ de coût, 60 au plus ; pas pour les murs et routes en ligne). Les ouvriers les
  **portent depuis l'entrepôt, la zone de déchargement, l'hélisurface ou l'atelier** (sinon depuis
  le point d'arrivée des convois), puis les **montent** : ils ne peuvent pas avancer au-delà de ce qui
  a été livré (piles de planches et de parpaings visibles sur le chantier). L'équipe locale de base
  apporte et monte toujours sa part, plus lentement.
- **Corvées par spécialité** (`personnel.json → duties`) : logisticiens = ravitaillement, cuisine,
  nettoyage, puis chantiers ; cuisiniers = cuisine, ravitaillement, nettoyage ; auxiliaires =
  nettoyage, ravitaillement. Le déchargement des camions reste prioritaire.
- **Fiche des bâtiments** : stock livré (et livraisons en route), repas prêts, propreté, matériaux
  livrés / nécessaires et porteurs.
- **Visible** : caisses de rations, de munitions, d'obus, jerricans, caisses médicales selon le
  remplissage ; palettes devant l'entrepôt ; vapeur de la cuisine ; charges portées selon leur
  contenu (caisse, caisse à munitions, jerricans à la main, planches sur l'épaule).
- **Véhicules plus détaillés** : roues de secours, jerricans, échappements, antennes, gyrophares,
  coffres, rétroviseurs, plaques, feu anticollision et mitrailleuse de porte de l'hélicoptère.
- Un besoin impossible à satisfaire (pas de douches) ne bloque plus les repas ni le sommeil.
- **Vitesse** : la vitesse normale est ralentie (4 minutes de jeu par seconde au lieu de 10) et une
  vitesse **x8** (touche `4`) a été ajoutée.

## Munitions individuelles, cuisine de fortune, équipement, sorties à pied, véhicules

- **Munitions individuelles** (`personnel.json → ammoCapacity`) : chaque soldat emporte sa dotation.
  Il tire dessus en défense ; un garde à sec recomplète sur les caisses de sa tour. Hors combat, sous
  la moitié (`balance.json → logistics.rearmBelow`), il va se **rééquiper au dépôt de munitions** (à
  défaut une aire de déchargement) ; en combat, un défenseur à sec quitte sa position pour aller en
  chercher. Les missions entament la dotation de ceux qui rentrent. Fiche du soldat : « Munitions x / y ».
- **Cuisine de fortune** : sans cuisinier disponible, un logisticien, un fantassin (sur ses heures
  d'entraînement) ou un auxiliaire passe en cuisine. Ses repas sont **moins nourrissants et moins bons
  pour le moral** (`logistics.amateurMealQuality`, 60 %) ; la fiche du réfectoire indique « cuisine de fortune ».
- **Équipement individuel** : acheté, il est stocké au dépôt de munitions. « Distribuer » l'**attribue** :
  les soldats concernés vont le **percevoir eux-mêmes au dépôt** (tout de suite s'ils ne sont pas de
  service, sinon à la fin de leur garde). Le panneau Logistique montre ce qui reste à percevoir.
- **Missions à pied** : l'unité ne disparaît plus au point de départ ; elle **marche jusqu'au bord de la
  carte** (bout de la piste) puis sort, et au retour elle **réapparaît au bord de la carte** et rentre à
  pied. Les missions motorisées ou héliportées embarquent toujours au point de départ.
- **Véhicules fidèles à leurs modèles** : camion **FMTV** (cabine avancée, bâche sur arceaux, crochets
  rouges), citernes **HEMTT** (4 essieux, passerelle, enrouleurs), **MRAP MaxxPro** (antennes de brouilleur,
  porte arrière blindée), **Humvee M1151** (calandre à fentes, pare-buffle), **Land Cruiser** blindé noir de
  la société privée (galerie, snorkel, vitres teintées), **CH-47 Chinook** pour le ravitaillement
  (birotor en tandem, `vehicles.json → visual.rotors`), **UH-60 Black Hawk** pour l'héliportage, **AH-64
  Apache** (tourelle de visée, canon sous le menton, Hellfire, radôme Longbow), C-130 (réservoirs sous
  voilure, hublots), A-10 (carénages de train, entrées d'air).

## MH-6 Little Bird

Hélicoptère léger des forces spéciales (Logistique → véhicules, 18 000 $, une hélisurface requise,
un appareil par hélisurface). Dans le planificateur de mission, l'héliportage propose désormais de
choisir l'appareil (aucun, Black Hawk, Little Bird) :
- **4 opérateurs** sur les banquettes extérieures ;
- **200 km/h** (Black Hawk 140) et moitié moins de carburant ;
- **approche discrète : +12 % de réussite** (`vehicles.json → stealthBonus`) ;
- **assaut éclair** : 40 % de temps en moins sur l'objectif (`objectiveMult`) ;
- **fragile** : aucune protection, risque de pertes ×1,3 (Black Hawk ×0,7) — à réserver aux coups rapides.

## Rendu des véhicules

- **Matière** : poussière du désert déposée sur le bas de caisse et les roues, arêtes supérieures qui
  accrochent la lumière (chanfreins), reflets en biais sur les vitres, **jantes et moyeux** sur toutes les roues.
- **Marquages** : panneaux d'identification air-sol **VS-17** orange sur les toits (FMTV, Humvee, MRAP),
  numéros d'unité au pochoir, feux arrière, bandes de danger des citernes, grilles des vitres du MRAP,
  vitres blindées du bouclier de tourelle du Humvee.
- **Hélicoptères** : ailes ESSS et réservoirs externes + boule FLIR du Black Hawk, perche de ravitaillement
  et réservoirs de sponsons du Chinook (version MH-47), feux de navigation et leurres de l'Apache.
- **Effets animés** : fumée d'échappement des diesels (en roulant et au ralenti pendant un déchargement),
  gyrophares orange clignotants (chariot élévateur au travail, citerne qui pompe), feu anticollision rouge
  des hélicoptères en vol et, la nuit, feux de navigation rouge/vert, flash blanc de queue, phares et feux
  arrière des véhicules avec halo.

## Éclairages

- **Projecteurs des tours de garde** : une tour occupée la nuit balaie ses abords d'un faisceau
  (`ambience.json → searchlight` : portée, couleur, amplitude du balayage) ; ampoule visible en haut.
- **Lampes de porte** : flaque de lumière devant l'entrée des bâtiments alimentés et ampoule au mur
  (`doorLamp`) ; têtes de lampes visibles en haut des mâts d'éclairage.
- **Phares en faisceau** devant les véhicules en mouvement (au lieu d'un simple halo).
- **Vignettage nocturne** (`vignette`) et halos un peu plus présents (`glowAlpha`).
- Les caisses de stock ne se posent plus que sur des cases libres devant le mur (ni sur un voisin,
  un mur ou un hesco collé au bâtiment, ni devant la porte) : plus de caisses dessinées à travers un mur.

## Décor des bâtiments et structures d'entraînement

- **Décor posé contre les bâtiments** (caisses, jerricans, munitions, sacs poubelle) : il évite aussi
  les éléments d'amélioration posés au sol (climatiseur) ; la flaque d'eau sale se place sous les
  sacs poubelle ; avec un muret de sacs de sable, décor et climatiseur se posent à l'extérieur du muret
  (`src/render/moduleAnchors.ts`, partagé par le rendu des bâtiments et du décor). La vapeur de la
  cuisine sort de la cheminée installée.
- **Aire de musculation redessinée** : dalles de caoutchouc, portique de traction, banc de développé
  couché sur pieds avec supports de barre, cage à squat, arbre à disques, tapis de pompes, kettlebells, pneu.
- **Disposition partagée** (`src/assets/trainingLayout.ts`) : le dessin des structures et l'animation
  des soldats utilisent les mêmes positions, si bien que les gestes tombent sur les agrès.
- **Gestes de sport dessinés** (tenue de sport : t-shirt gris, short noir, sans arme) :
  - tractions mains sur la barre, du bras tendu au menton au-dessus ;
  - développé couché allongé sur le banc ;
  - squat barre sur les épaules ;
  - pompes ;
  - footing autour de l'aire.
- **Parcours du combattant** : les soldats suivent l'itinéraire à travers les obstacles : escalade du
  mur, poutre, ramping sous le filet, saut de la fosse, pas chassés dans les pneus.

## Radio de mission et événements aléatoires (catalogue étendu)

- **48 situations radio, 167 ordres** (`radio.json`). Chaque situation n'apparaît que si elle colle
  au contexte (`when` : nuit, unité motorisée, héliportée ou à pied, objectif ennemi ou village,
  infirmier / forces spéciales / CIA dans l'équipe, appui engagé, village hostile ou ami…) et jamais
  deux fois dans la même mission ; deux à quatre messages par mission.
- **Ordres selon les moyens** (`requires`) : soins par l'infirmier de l'équipe, évacuation par
  l'hélicoptère de la mission, tir d'artillerie ou Apache s'ils sont engagés, vision nocturne,
  caméra thermique, optiques, auxiliaire qui parle pachto, forces spéciales… Les ordres impossibles
  restent visibles, grisés avec la raison.
- **Issues aléatoires mais cohérentes** (`outcomes`) : un ordre risqué peut bien ou mal tourner ;
  les bonnes issues sont favorisées par la compétence de l'équipe (`skill` : tir, discrétion,
  commandement, médecine, mécanique, transmissions). Effets : réussite, risque de pertes, blessés
  immédiats, durée, abandon, coût, butin, réputation, attitude et emprise du village, renseignement,
  moral, expérience, dommages collatéraux. Certaines issues déclenchent une **suite** (`followUp`).
- **Détails tirés au hasard** : direction, terrain (verger, oued, qalat…), repère, nombre et armes
  de l'ennemi, véhicule, nom du chef de groupe, d'un soldat, de l'infirmier, village concerné.
- **Événements : 48 au total (30 nouveaux)**, dont beaucoup liés à un **village tiré selon son
  attitude** (`village` : any, friendly, hostile, neutral, influenced ; effets sur « $village ») :
  prêche du mollah, bazar, école, lettres de nuit, sécheresse, funérailles, champ miné, familles
  déplacées, mariage, pavot, vendetta, manifestation, véhicule suspect, drone, roquette non explosée,
  combattant qui se rend, trafic d'armes, patrouille avec l'armée afghane, nouvelles du pays,
  intoxication, acte de bravoure, tripot, panne, ONG médicale, chantier de reconstruction, canicule,
  nuit glaciale, route coupée, livraison inattendue, marché noir… Nouveaux personnages et listes de
  mots (`events.json → pools`).

## Monde vivant et carte agrandie

- **Carte régionale 120 × 90 km** (au lieu de 60 × 45) : la vallée de départ au centre, et autour
  de nouvelles vallées (8 villages, routes, rivière de l'Arghandab, montagnes, 9 groupes ennemis,
  bases de coalition voisines pensées pour un futur multijoueur, forces afghanes). Les zones
  lointaines ne pèsent pas en début de partie ; elles deviennent l'enjeu quand la FOB s'étend,
  et les véhicules ou l'hélicoptère deviennent indispensables pour y aller (temps de trajet à pied,
  en véhicule et en hélicoptère affichés sur chaque fiche de la carte).
- **Ennemis qui bougent avec de vrais objectifs** (`region.json → behaviour`, `WorldSystem`) :
  combattants qui patrouillent entre villages sous emprise et caches, et viennent parfois rôder
  près de la FOB ; **équipes mortier** qui sortent de leur cachette, s'installent à 4–6,5 km de la
  base, tirent puis **changent de place** ; cellules IED qui posent de vrais engins sur les routes.
  Les tirs de mortier, harcèlements et assauts ne se produisent qu'avec un groupe réellement en
  position ; après une attaque, la position de tir est connue… mais l'équipe est déjà repartie.
- **Monde vivant** (`region.json → world`) : patrouilles de l'armée et de la police afghanes,
  marchands, bergers, pèlerins, familles, convois humanitaires circulent entre villages, bourgs et
  lieux. Accrochages, embuscades, rackets et engins explosifs entre eux modifient l'emprise
  insurgée, l'attitude des villages et la stabilité ; les alliés et les villages amis renseignent
  la base. Les faits marquants s'affichent sur la carte et dans la liste « Faits marquants ».
- **Rencontres en mission avec les vrais groupes** : à moins de 1,2 km (1,6 en véhicule), on tire qui
  repère l'autre en premier. Nous : discrétion, transmissions, contact déjà connu, ratissage,
  **vision nocturne et thermique la nuit, optiques et jumelles le jour**. Eux : véhicules bruyants,
  hélicoptère, nuit qui les gêne. Repérés sans être vus → avantage (embuscade, observation, tir
  d'appui) ; surpris → **malus** (embuscade, pertes accrues) ; les deux → combat de rencontre.
  Les pertes infligées réduisent réellement le groupe (détruit à zéro). Les engins posés se
  découvrent ou explosent au passage. Un raid sur un groupe qui s'est déplacé trouve l'objectif vide.
- **Lieux d'intérêt** (28) : grottes, forts, campements nomades, cols, carrières, puits, relais,
  ruines, champs de pavot, pistes de contrebande, hameaux isolés, sanctuaires. Une mission sur place
  révèle les environs, peut découvrir une cache, rassurer la population ou nettoyer les engins.
- **Patrouille de secteur** : un clic dans le vide sur la carte sélectionne un carré de 5 km ;
  « Planifier une mission » y envoie une patrouille qui ratisse la zone (rencontres facilitées),
  révèle les groupes et neutralise les engins posés.

## Rééquilibrage économique

Fonds de départ ×1,8 (`sites.json`), budget quotidien du commandement 1 500 → 2 400 $
(`balance.json` → `economy.dailyBudget`), constructions −30 % et améliorations −25 %
(`buildings.json`, murs, routes et mâts d'éclairage inchangés), agrandissement du périmètre
6 000 → 4 000 $, convoi 1 200 → 900 $, carburant 3 000 → 2 000 $, hélicoptère 5 000 → 4 000 $.
Sur 30 jours simulés, une base complète (projets civils compris) garde 6 000 à 14 000 $ en caisse.

## Portes, poste de garde et assauts dans l'enceinte

- **Porte piétonne** (1 case, 250 $) et **portail double** (2 cases, 600 $) dans l'onglet
  Défense : ils se posent directement sur un tronçon de hesco existant (qui est remplacé), et
  pivotent avec R. Les battants grillagés s'ouvrent vers l'intérieur à l'approche d'un soldat
  (et d'un véhicule pour le portail) puis se referment. Seul le portail laisse passer les véhicules.
- **Poste de garde** (400 $) : guérite sacs de sable + tôle, lampe et panneau STOP. Un soldat de
  garde y contrôle les portes à moins de 4 cases : chaque véhicule qui entre ou sort marque un
  arrêt de 2 min (journal : « contrôle à la porte »).
- **Assauts** (`combat.json` → `penetrate`) : les assaillants cherchent un chemin vers le TOC,
  puis les dépôts de munitions/artillerie, puis les tentes. Ils passent par une ouverture du mur
  si elle existe ; sinon ils forcent la porte la plus accessible (10 min pour une porte, 16 pour
  un portail) ou, en dernier recours, éventrent un hesco (35 min), sous le feu des défenseurs.
  La brèche détruit l'élément et ouvre le passage. Le harcèlement reste, lui, à l'extérieur.
  Le panneau d'info d'une porte ou d'un mur indique le temps de brèche restant.

## Point de contrôle : fouille des civils et infiltrations

- **Va-et-vient** (`visitors.json` → `traffic`) : de 6 h à 18 h, des civils (ouvriers, marchands,
  paysans…) viennent à la base à pied, en pick-up ou en camion décoré. Ils s'arrêtent au **poste de
  garde le plus proche de l'entrée** (« Fouille… » au-dessus d'eux), entrent jusqu'au TOC, y restent
  un moment puis repartent. En cas d'attaque, ils s'en vont.
- **Menaces cachées** (à partir du jour 5, plus fréquentes là où la menace régionale est forte) :
  - **tireur** : s'il passe, il sort son arme dans l'enceinte et devient un assaillant (attaque
    « Tireur infiltré » qui progresse vers le TOC) ;
  - **ceinture explosive** : il se fait sauter près d'un groupe de soldats ;
  - **voiture piégée** : elle explose au cœur de la base (gros rayon, dégâts aux bâtiments).
- **Fouille** : chance de démasquer la menace selon le niveau du poste (50 / 70 / 86 %), divisée
  par trois sans sentinelle ; sans aucun poste, un soldat ne remarque l'anomalie que 1 fois sur 10.
  Une menace démasquée est arrêtée (« Arrêté », à genoux) : **prime** (150 / 250 / 400 $) et
  **moral** pour toute la base. Un engin démasqué peut tout de même exploser au poste, avec une
  puissance réduite (40 % de risque au niveau 1, 12 % au niveau 3).
- **Pression ennemie** (`visitors.json` → `traffic.pressure`, fiche du poste de garde) : calculée
  autour de la FOB à partir de l'emprise insurgée des villages à moins de 18 km et des groupes
  ennemis (cellules, poseurs d'engins, mortiers) à moins de 22 km, selon leurs effectifs et leur
  proximité. Faible, moyenne ou forte, elle rend les infiltrations jusqu'à 6 fois plus fréquentes
  (×0,35 → ×2,2), plus discrètes à la fouille (détection ×1,05 → ×0,8) et plus fortes :
  explosions ×0,7 → ×1,45, et jusqu'à 3 tireurs qui surgissent ensemble. Une capture sous forte
  pression rapporte jusqu'à 50 % de prime en plus. Faire reculer l'emprise des villages et
  neutraliser les groupes voisins réduit donc directement le danger aux portes.
- **Améliorations du poste de garde** : *Point de contrôle renforcé* (500 $) puis *Point de
  contrôle équipé* (900 $), qui améliorent la fouille sans changer l'apparence de la guérite.
  La fiche du poste affiche la chance de détection et le bilan des contrôles.
- La guérite a été redessinée : les sacs de sable de devant passent bien devant la cabane.

## Expérience et grades

- **Carrières** (`personnel.json` → `career`) : chaque métier a ses grades successifs et l'XP requise.
  Fantassin : Soldat → Soldat de 1re classe (30) → Caporal (90) → Caporal-chef (170) → Sergent (280)
  → Sergent-chef (420) → Adjudant (600). Officier jusqu'à Capitaine, commandant jusqu'à
  Lieutenant-colonel, forces spéciales jusqu'à Major, médical d'Infirmier à Médecin-chef, etc.
  Une recrue arrive avec l'expérience correspondant à son grade.
- **Gagner de l'XP** : heures de garde, de chantier, de manutention, de cuisine, de soins, de
  commandement, d'entraînement et surtout de défense (`activities.json` → `xpPerHour`) ; missions
  (10 si réussie, 5 si partielle, 3 si ratée, +4 pour un blessé) ; ennemi abattu (+5) ; attaque au
  sol repoussée pour les défenseurs et gardes (+6) ; menace démasquée au poste de garde pour la
  sentinelle (+12) ; décisions radio réussies (`balance.json` → `career`).
- **Promotion automatique** dès le seuil atteint : annonce au journal et notification, moral +15,
  commandement +4 et tir +1. La fiche du soldat montre son grade, une barre d'XP et l'XP restante
  avant le grade suivant. Au rythme d'une base normale, un fantassin gagne un grade par mois environ,
  plus vite s'il part en mission et défend la base.

## Besoins de la base selon l'effectif

- **Panneau « Besoins »** (bouton de la barre du haut ou touche **B**) : pour l'effectif actuel,
  places disponibles face au nécessaire, file d'attente mesurée sur 24 h, conseil et coût en moral
  de chaque manque. Le bouton clignote et compte les besoins non couverts.
- **Ratios** (`balance.json` → `requirements`) : 1 lit par personne ; 1 place au réfectoire pour 4
  (dès 8 personnes) ; 1 douche pour 8 ; 1 cabine de latrines pour 6 ; 1 poste de soins pour 15
  (dès 15) ; 1 place de sport pour 10 (dès 20) ; 1 cuisinier pour 20, 1 soignant pour 25,
  1 logisticien pour 12. Chaque manque abaisse le moral visé de tous (jusqu'à −20), en douceur
  les 3 premiers jours le temps de s'installer ; des latrines insuffisantes salissent plus vite.
- **Nouveau besoin « Toilettes »** et bâtiment **Latrines** (rangée de cabines de chantier, 380 $,
  améliorable en *Bloc de latrines* puis *Sanitaires en dur* : 3 → 5 → 8 cabines). Sans latrines,
  les soldats se soulagent derrière un mur : hygiène et moral en baisse.
- **Files d'attente** : quand le réfectoire, les douches ou les latrines sont pleins, les soldats
  font la queue devant la porte (« Fait la queue »), puis se rabattent sur la ration froide ou
  la solution de fortune si l'attente dure trop.
- **Bâtiments plus grands** : *Grand réfectoire* (30 places, 4 cuisiniers), *Grand bloc de
  douches* (10), *Infirmerie agrandie* (4 postes), *Grande salle de sport* (10 places).

## Interface : panneaux réductibles

Le bandeau de construction et le journal se réduisent à leur barre de titre (bouton « − / + »
ou clic sur le titre) ; l'état est mémorisé. Le journal s'illumine à chaque nouveau message
(vert, orange ou rouge selon la gravité) et, réduit, affiche le nombre de messages non lus.

## Ajouter du contenu (sans toucher au code)

- **Bâtiment** : ajouter une entrée dans `src/data/buildings.json` (catégorie, emprise, coût, entretien,
  consommation, stockage, style visuel parmi `box`, `flat`, `hesco`, `tent`, `tank`, `tower`, `building`, `gate`, `booth`) et services offerts aux agents.
- **Site de départ** : `src/data/sites.json` (ressources initiales, budget, périmètre, terrain).
- **Événement** : une entrée dans `events.json` (personnage, texte, choix, issues, effets).
- **Personnel** : `personnel.json`, `skills.json`, `traits.json`, `names.json`, force de départ dans
  `balance.json → startingForce`.
- **Équilibrage** : `src/data/balance.json`. **Textes d'interface** : `src/data/strings.fr.json`.
- Le contenu est **validé au démarrage** : une erreur affiche la liste précise des problèmes.

Sprites : voir `public/assets/README.md`.

## Debug (mode dev)

Dans la console du navigateur : `fob` (GameContext : `fob.state`, `fob.commands.push(...)`) et `phaser` (instance Phaser).
