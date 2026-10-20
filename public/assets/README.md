# Assets graphiques — convention de remplacement des placeholders

En Phase 1, toutes les textures sont **générées par code** (`src/assets/PlaceholderFactory.ts`).
Pour les remplacer par de vrais sprites, **sans toucher au code** :

1. Dessiner les sprites en respectant la géométrie ci-dessous.
2. Les regrouper dans un atlas (TexturePacker, Free Texture Packer… format « JSON Hash » Phaser)
   et déposer `xxx.png` + `xxx.json` dans `public/assets/atlases/`.
3. Déclarer l'atlas dans `src/data/assets.json` :
   ```json
   { "atlases": [ { "key": "fob", "texture": "assets/atlases/fob.png", "atlas": "assets/atlases/fob.json" } ] }
   ```
4. Chaque **nom de frame** doit être exactement la clé du placeholder remplacé. Les clés absentes
   de l'atlas restent générées par code : on peut remplacer les sprites un par un.

## Clés

| Élément  | Clé                          | Exemple               |
|----------|------------------------------|-----------------------|
| Terrain  | `ter.<terrainId>.<0..2>`     | `ter.sand.1`          |
| Bâtiment | `<visual.key>.r<0\|1>`       | `bld.tent_group.r0`   |
| Agent    | `agent.<personnelId>`        | `agent.infantry`      |

- `r0` = emprise telle que définie dans `buildings.json` (`footprint: [w, h]`), `r1` = emprise tournée
  d'un quart de tour (`[h, w]`). Les bâtiments carrés n'ont que `r0`.

## Géométrie (tuiles 64 × 32)

- **Agent** : canevas 16 × 28 px, pieds au pixel (8, 26).
- **Terrain** : toutes les frames de terrain doivent se trouver dans le **même atlas** (rendu par Blitter) ;
  une tuile isolée dans un autre atlas fonctionne mais coûte plus cher à afficher.

- **Terrain** : losange de 66 × 34 px (débord de 1 px de chaque côté pour masquer les joints).
- **Bâtiment** d'emprise `w × h` et de hauteur `visual.height` (en px) :
  - largeur du canevas = `(w + h) × 32`
  - hauteur du canevas = `(w + h) × 16 + visual.height + 4`
  - le **sommet nord de l'emprise** (coin haut du losange au sol) est au pixel
    `(h × 32, visual.height + 4)` : c'est le point d'ancrage.

Palette conseillée : beiges, ocres, kaki, gris, vert OD ; contour sombre 1 px ; lumière venant du haut-gauche
(face gauche plus claire que la face droite).
