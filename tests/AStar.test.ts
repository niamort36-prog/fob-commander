import { describe, expect, it } from 'vitest';
import { AStar, type CostGrid } from '../src/utils/AStar';

/** Grille depuis un dessin : « # » = mur, « ~ » = coût 5, « . » = libre. */
function grid(rows: string[]): CostGrid {
  const height = rows.length;
  const width = rows[0].length;
  const cost = new Float32Array(width * height);
  rows.forEach((r, y) => [...r].forEach((ch, x) => (cost[y * width + x] = ch === '#' ? Infinity : ch === '~' ? 5 : 1)));
  return { width, height, cost };
}

describe('AStar', () => {
  const astar = new AStar();

  it('contourne un mur', () => {
    const g = grid(['.....', '.###.', '.....']);
    const path = astar.find(g, { x: 2, y: 0 }, [{ x: 2, y: 2 }])!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ x: 2, y: 2 });
    for (const c of path) expect(g.cost[c.y * g.width + c.x]).not.toBe(Infinity);
  });

  it('ne coupe pas les angles entre deux murs', () => {
    const g = grid(['.#', '#.']);
    expect(astar.find(g, { x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBeNull();
  });

  it('renvoie null si la cible est enfermée, [] si on y est déjà', () => {
    const g = grid(['.....', '.###.', '.#.#.', '.###.']);
    expect(astar.find(g, { x: 0, y: 0 }, [{ x: 2, y: 2 }])).toBeNull();
    expect(astar.find(g, { x: 0, y: 0 }, [{ x: 0, y: 0 }])).toEqual([]);
  });

  it('préfère un détour sur terrain facile à une traversée coûteuse', () => {
    const g = grid(['.....', '.~~~.', '.~~~.', '.~~~.', '.....']);
    const path = astar.find(g, { x: 0, y: 2 }, [{ x: 4, y: 2 }])!;
    expect(path.every((c) => g.cost[c.y * g.width + c.x] === 1)).toBe(true);
  });

  it('rejoint l’objectif le plus proche parmi plusieurs', () => {
    const g = grid(['..........']);
    const path = astar.find(g, { x: 5, y: 0 }, [{ x: 0, y: 0 }, { x: 7, y: 0 }])!;
    expect(path[path.length - 1]).toEqual({ x: 7, y: 0 });
  });
});
