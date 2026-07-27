import { describe, expect, it } from 'vitest';
import { generateMap } from '../../src/shared/mapgen.js';
import {
  collideWorld,
  floorHeightAt,
  hasLineOfSight,
  resolveCircleBox,
  surfaceAt,
  zoneAt,
} from '../../src/shared/collision.js';
import { MAP_HALF, PLAYER_RADIUS, SEALS_REQUIRED } from '../../src/shared/constants.js';
import { createRng } from '../../src/shared/rng.js';

const SEEDS = [1, 12345, 777, 99999, 424242];

describe('seeded map generation', () => {
  it('produces byte-identical maps for the same seed', () => {
    const a = generateMap(12345);
    const b = generateMap(12345);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different seal selections across seeds', () => {
    const selections = new Set(SEEDS.map((s) => generateMap(s).activeSeals.join(',')));
    expect(selections.size).toBeGreaterThan(1);
  });

  it('always activates exactly the required number of seals', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      expect(map.activeSeals).toHaveLength(SEALS_REQUIRED);
      expect(new Set(map.activeSeals).size).toBe(SEALS_REQUIRED);
      for (const id of map.activeSeals) {
        expect(map.sealAnchors.some((a) => a.id === id)).toBe(true);
      }
    }
  });

  it('never bunches all three seals into the chapel', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      const outer = map.activeSeals.filter((id) => id > 2);
      expect(outer.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the fixed navigational skeleton across seeds', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      expect(map.gate).toEqual({ x: 0, z: -MAP_HALF + 3, rot: 0 });
      expect(map.shrine).toEqual({ x: 0, z: MAP_HALF - 12 });
      expect(map.runnerSpawn).toEqual({ x: 16, z: 42 });
      expect(map.hunterSpawn).toEqual({ x: 0, z: -26 });
      // The seven landmark anchors are authored, not random.
      expect(map.sealAnchors).toHaveLength(7);
    }
  });

  it('produces a bounded, finite world', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      for (const wall of map.walls) {
        expect(Number.isFinite(wall.x) && Number.isFinite(wall.z)).toBe(true);
        expect(wall.hw).toBeGreaterThan(0);
        expect(wall.hd).toBeGreaterThan(0);
        expect(wall.height).toBeGreaterThan(0);
      }
      for (const prop of map.props) {
        expect(Math.abs(prop.x)).toBeLessThanOrEqual(MAP_HALF + 4);
        expect(Math.abs(prop.z)).toBeLessThanOrEqual(MAP_HALF + 4);
      }
      expect(map.walls.length).toBeGreaterThan(20);
      expect(map.props.length).toBeGreaterThan(50);
    }
  });
});

describe('collision', () => {
  const map = generateMap(12345);
  const world = { map, dynamic: [] };

  it('keeps the player inside the playfield from any starting point', () => {
    const limit = MAP_HALF - PLAYER_RADIUS;
    for (const [x, z] of [
      [999, 999],
      [-999, -999],
      [0, 999],
      [-999, 0],
    ] as const) {
      const result = collideWorld(world, x, z, {
        radius: PLAYER_RADIUS,
        feetY: 0,
        standHeight: 1.75,
        crouching: false,
        airborne: false,
      });
      expect(Math.abs(result.x)).toBeLessThanOrEqual(limit);
      expect(Math.abs(result.z)).toBeLessThanOrEqual(limit);
    }
  });

  it('pushes a circle out of a wall it overlaps', () => {
    const wall = map.walls.find((w) => w.kind === 'chapelWall')!;
    const result = collideWorld(world, wall.x, wall.z, {
      radius: PLAYER_RADIUS,
      feetY: 0,
      standHeight: 1.75,
      crouching: false,
      airborne: false,
    });
    const moved = Math.hypot(result.x - wall.x, result.z - wall.z);
    expect(moved).toBeGreaterThan(0);
  });

  it('resolves a circle out of an oriented box along the shallowest axis', () => {
    const out = { x: 0, z: 0 };
    // Circle sits just inside the +x face of a 2x4 box.
    const hit = resolveCircleBox(1.9, 0, 0.5, 0, 0, 2, 4, 0, out);
    expect(hit).toBe(true);
    expect(out.x).toBeGreaterThan(1.9);
    expect(out.z).toBeCloseTo(0, 5);
  });

  it('reports no overlap when the circle is clear', () => {
    const out = { x: 0, z: 0 };
    expect(resolveCircleBox(10, 10, 0.5, 0, 0, 1, 1, 0, out)).toBe(false);
  });

  it('always returns a finite floor height', () => {
    const rng = createRng(3);
    for (let i = 0; i < 500; i += 1) {
      const x = rng.range(-MAP_HALF, MAP_HALF);
      const z = rng.range(-MAP_HALF, MAP_HALF);
      const h = floorHeightAt(map, x, z);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(12);
    }
  });

  it('raises the floor on the watchtower platform', () => {
    const platform = map.platforms.find((p) => p.height > 3)!;
    expect(floorHeightAt(map, platform.x, platform.z)).toBeCloseTo(platform.height, 5);
  });

  it('blocks line of sight through a solid wall', () => {
    const wall = map.walls.find((w) => w.kind === 'boundary' && w.hw > w.hd)!;
    const a = { x: wall.x, z: wall.z - 6 };
    const b = { x: wall.x, z: wall.z + 6 };
    expect(hasLineOfSight(world, a.x, 1.6, a.z, b.x, 1.6, b.z)).toBe(false);
  });

  it('allows line of sight across open ground', () => {
    expect(hasLineOfSight(world, 0, 1.6, 40, 0, 1.6, 44)).toBe(true);
  });

  it('classifies surfaces from zones', () => {
    const water = map.zones.find((z) => z.kind === 'water')!;
    expect(surfaceAt(map, water.x, water.z)).toBe('water');
    const mud = map.zones.find((z) => z.kind === 'mud')!;
    expect(surfaceAt(map, mud.x, mud.z)).toBe('dirt');
    expect(zoneAt(map, water.x, water.z, 'water')).not.toBeNull();
    expect(zoneAt(map, water.x + 500, water.z, 'water')).toBeNull();
  });
});

describe('map connectivity', () => {
  /**
   * Flood-fills the walkable grid from the Runner spawn. Every objective must be
   * reachable on every seed — an unreachable seal would make the match
   * unwinnable, so this is a hard correctness guarantee, not a nicety.
   */
  function reachability(seed: number) {
    const map = generateMap(seed);
    const world = { map, dynamic: [] };
    const CELL = 0.8;
    const N = Math.floor((MAP_HALF * 2) / CELL);
    const toWorld = (i: number) => -MAP_HALF + (i + 0.5) * CELL;
    const idx = (i: number, j: number) => j * N + i;

    const open = new Uint8Array(N * N);
    for (let j = 0; j < N; j += 1) {
      for (let i = 0; i < N; i += 1) {
        const x = toWorld(i);
        const z = toWorld(j);
        const y = floorHeightAt(map, x, z);
        const r = collideWorld(world, x, z, {
          radius: PLAYER_RADIUS,
          feetY: y,
          standHeight: 1.75,
          crouching: false,
          airborne: false,
        });
        if (Math.hypot(r.x - x, r.z - z) < 1e-3) open[idx(i, j)] = 1;
      }
    }

    const si = Math.round((map.runnerSpawn.x + MAP_HALF) / CELL - 0.5);
    const sj = Math.round((map.runnerSpawn.z + MAP_HALF) / CELL - 0.5);
    const seen = new Uint8Array(N * N);
    const queue: number[] = [idx(si, sj)];
    seen[queue[0]] = 1;
    let head = 0;
    while (head < queue.length) {
      const c = queue[head++];
      const i = c % N;
      const j = Math.floor(c / N);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nc = idx(ni, nj);
        if (seen[nc] || !open[nc]) continue;
        seen[nc] = 1;
        queue.push(nc);
      }
    }

    const canReach = (x: number, z: number): boolean => {
      const ci = Math.round((x + MAP_HALF) / CELL - 0.5);
      const cj = Math.round((z + MAP_HALF) / CELL - 0.5);
      const rad = Math.ceil(2.4 / CELL);
      for (let dj = -rad; dj <= rad; dj += 1) {
        for (let di = -rad; di <= rad; di += 1) {
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
          if (seen[idx(ni, nj)]) return true;
        }
      }
      return false;
    };

    return { map, canReach, spawnOpen: open[idx(si, sj)] === 1 };
  }

  it.each(SEEDS)('leaves every objective reachable on seed %i', (seed) => {
    const { map, canReach, spawnOpen } = reachability(seed);
    expect(spawnOpen).toBe(true);

    for (const id of map.activeSeals) {
      const anchor = map.sealAnchors.find((a) => a.id === id)!;
      expect(canReach(anchor.x, anchor.z), `seal ${anchor.area} unreachable`).toBe(true);
    }
    expect(canReach(map.gate.x, map.gate.z), 'gate unreachable').toBe(true);
    expect(canReach(map.shrine.x, map.shrine.z), 'shrine unreachable').toBe(true);
    expect(canReach(map.hunterSpawn.x, map.hunterSpawn.z), 'hunter spawn unreachable').toBe(true);
    for (const spot of map.hideSpots) {
      expect(canReach(spot.x, spot.z), `hide spot ${spot.id} unreachable`).toBe(true);
    }
  });
});
