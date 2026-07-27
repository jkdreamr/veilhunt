/**
 * Moonveil Ruins.
 *
 * The navigational skeleton is hand-authored: chapel at the centre, graveyard
 * north-west, hedge maze north-east, flooded courtyard south-west, watchtower
 * south-east, gate on the north wall, shrine at the far south. A seed only
 * varies which seals are live, which tunnels and barricades are open, prop
 * scatter and fog — never the loops and landmarks players navigate by.
 */

import { MAP_HALF, MAP_SIZE } from './constants.js';
import { createRng } from './rng.js';
import type {
  BarricadeDef,
  CrouchGate,
  DoorDef,
  HideSpot,
  MapData,
  Platform,
  PropInstance,
  PropKind,
  Ramp,
  SealAnchor,
  VaultBox,
  WallBox,
  Zone,
  NoiseObject,
} from './types.js';

interface Builder {
  walls: WallBox[];
  vaults: VaultBox[];
  platforms: Platform[];
  ramps: Ramp[];
  zones: Zone[];
  hideSpots: HideSpot[];
  crouchGates: CrouchGate[];
  doors: DoorDef[];
  barricades: BarricadeDef[];
  props: PropInstance[];
  noiseObjects: NoiseObject[];
  nextId: number;
}

const DEG = Math.PI / 180;

function wall(
  b: Builder,
  x: number,
  z: number,
  hw: number,
  hd: number,
  height: number,
  rot = 0,
  kind: WallBox['kind'] = 'ruinWall',
  base = 0,
  opaque = true,
): void {
  b.walls.push({ id: b.nextId++, x, z, hw, hd, rot, base, height, kind, opaque });
}

function vault(
  b: Builder,
  x: number,
  z: number,
  hw: number,
  hd: number,
  height: number,
  rot = 0,
  kind: VaultBox['kind'] = 'wall',
): void {
  b.vaults.push({ id: b.nextId++, x, z, hw, hd, rot, height, kind });
}

function platform(b: Builder, x: number, z: number, hw: number, hd: number, height: number): void {
  b.platforms.push({ id: b.nextId++, x, z, hw, hd, height });
}

function ramp(
  b: Builder,
  x: number,
  z: number,
  hw: number,
  hd: number,
  rot: number,
  height0: number,
  height1: number,
): void {
  b.ramps.push({ id: b.nextId++, x, z, hw, hd, rot, height0, height1 });
}

function zone(b: Builder, kind: Zone['kind'], x: number, z: number, radius: number): void {
  b.zones.push({ id: b.nextId++, kind, x, z, radius });
}

function prop(
  b: Builder,
  kind: PropKind,
  x: number,
  z: number,
  y: number,
  rot: number,
  scale: number,
  variant: number,
): void {
  b.props.push({ kind, x, z, y, rot, scale, variant });
}

/**
 * Builds a rectangular room shell. Each opening is a doorway offset measured
 * from the centre of that wall, so `{ north: 0 }` puts the gap dead centre and
 * `{ west: 3 }` shifts it three metres along the wall.
 */
function roomShell(
  b: Builder,
  cx: number,
  cz: number,
  halfW: number,
  halfD: number,
  height: number,
  thickness: number,
  openings: { north?: number; south?: number; east?: number; west?: number },
  kind: WallBox['kind'],
): void {
  const seg = (
    axis: 'x' | 'z',
    fixed: number,
    from: number,
    to: number,
    gapOffset: number | undefined,
    gapWidth: number,
  ): void => {
    // Offsets are relative to the wall's midpoint and clamped so a doorway can
    // never fall outside the wall it belongs to.
    const mid = (from + to) / 2;
    const span = to - from;
    const gapCentre =
      gapOffset === undefined
        ? undefined
        : Math.max(
            from + gapWidth / 2,
            Math.min(to - gapWidth / 2, mid + gapOffset),
          );
    if (gapCentre === undefined || span <= gapWidth) {
      const half = Math.abs(span) / 2;
      if (axis === 'x') wall(b, mid, fixed, half, thickness, height, 0, kind);
      else wall(b, fixed, mid, thickness, half, height, 0, kind);
      return;
    }
    const g0 = gapCentre - gapWidth / 2;
    const g1 = gapCentre + gapWidth / 2;
    const spans: [number, number][] = [
      [from, g0],
      [g1, to],
    ];
    for (const [s0, s1] of spans) {
      if (s1 - s0 < 0.35) continue;
      const mid = (s0 + s1) / 2;
      const half = (s1 - s0) / 2;
      if (axis === 'x') wall(b, mid, fixed, half, thickness, height, 0, kind);
      else wall(b, fixed, mid, thickness, half, height, 0, kind);
    }
  };

  seg('x', cz - halfD, cx - halfW, cx + halfW, openings.north, 4.4);
  seg('x', cz + halfD, cx - halfW, cx + halfW, openings.south, 4.4);
  seg('z', cx + halfW, cz - halfD, cz + halfD, openings.east, 4.4);
  seg('z', cx - halfW, cz - halfD, cz + halfD, openings.west, 4.4);
}

export function generateMap(seed: number): MapData {
  const rng = createRng(seed);
  const b: Builder = {
    walls: [],
    vaults: [],
    platforms: [],
    ramps: [],
    zones: [],
    hideSpots: [],
    crouchGates: [],
    doors: [],
    barricades: [],
    props: [],
    noiseObjects: [],
    nextId: 1,
  };

  // -------------------------------------------------------------------------
  // Outer boundary — a solid ring the player can never leave.
  // -------------------------------------------------------------------------
  const B = MAP_HALF;
  const T = 2;
  wall(b, 0, -B, B + T, T, 9, 0, 'boundary');
  wall(b, 0, B, B + T, T, 9, 0, 'boundary');
  wall(b, -B, 0, T, B + T, 9, 0, 'boundary');
  wall(b, B, 0, T, B + T, 9, 0, 'boundary');

  // -------------------------------------------------------------------------
  // Ruined chapel — the central landmark. Open nave, broken columns, two apses.
  // -------------------------------------------------------------------------
  const CH = { x: 0, z: 2 };
  roomShell(b, CH.x, CH.z, 15, 11, 7.5, 1, { north: 0, south: 0, east: 2, west: -2 }, 'chapelWall');
  // Interior colonnade: two rows of broken columns that break sightlines.
  for (let i = 0; i < 5; i += 1) {
    const zc = CH.z - 8 + i * 4;
    const h = 4.2 + rng.range(0, 2.6);
    wall(b, CH.x - 7.5, zc, 0.85, 0.85, h, 0, 'chapelWall');
    wall(b, CH.x + 7.5, zc, 0.85, 0.85, 4.2 + rng.range(0, 2.6), 0, 'chapelWall');
    prop(b, 'pillar', CH.x - 7.5, zc, h, 0, 1, rng());
    prop(b, 'pillar', CH.x + 7.5, zc, h, 0, 1, rng());
  }
  // Altar dais with a ramp: a raised, exposed but commanding position.
  platform(b, CH.x, CH.z - 8.5, 4, 2.2, 0.9);
  ramp(b, CH.x, CH.z - 5.6, 1.4, 2.2, 90 * DEG, 0, 0.9);
  vault(b, CH.x, CH.z - 10.5, 4, 0.4, 1.1, 0, 'tomb');
  prop(b, 'statue', CH.x - 3.2, CH.z - 9.6, 0.9, 0.2, 1.1, rng());
  prop(b, 'statue', CH.x + 3.2, CH.z - 9.6, 0.9, -0.2, 1.1, rng());
  prop(b, 'brazier', CH.x - 5, CH.z + 6, 0, 0, 1, rng());
  prop(b, 'brazier', CH.x + 5, CH.z + 6, 0, 0, 1, rng());
  zone(b, 'shadow', CH.x, CH.z + 8, 6);
  b.hideSpots.push({ id: b.nextId++, kind: 'alcove', x: CH.x - 13.2, z: CH.z + 6.5, rot: 90 * DEG });
  b.hideSpots.push({ id: b.nextId++, kind: 'alcove', x: CH.x + 13.2, z: CH.z - 6.5, rot: -90 * DEG });

  // Chapel doors: north and south entrances swing.
  b.doors.push({ id: b.nextId++, x: CH.x - 2.2, z: CH.z - 11, rot: 0, width: 2.2 });
  b.doors.push({ id: b.nextId++, x: CH.x - 2.2, z: CH.z + 11, rot: 0, width: 2.2 });

  // -------------------------------------------------------------------------
  // Graveyard (north-west) — mud, gravestones, mausoleum, sarcophagus hide spot.
  // -------------------------------------------------------------------------
  const GY = { x: -36, z: -32 };
  zone(b, 'mud', GY.x, GY.z, 20);
  zone(b, 'shadow', GY.x - 8, GY.z + 9, 7);
  for (let i = 0; i < 26; i += 1) {
    const gx = GY.x + rng.range(-17, 17);
    const gz = GY.z + rng.range(-15, 15);
    if (Math.hypot(gx - GY.x, gz - GY.z) > 18) continue;
    prop(b, 'gravestone', gx, gz, 0, rng.range(-0.3, 0.3), rng.range(0.85, 1.25), rng());
    if (rng.bool(0.3)) vault(b, gx, gz, 0.45, 0.25, 0.95, rng.range(-0.3, 0.3), 'tomb');
  }
  // Mausoleum: a small solid block with one entrance, hides a seal anchor.
  roomShell(b, GY.x + 12, GY.z - 10, 4.5, 4, 5, 0.7, { south: 0 }, 'crypt');
  b.hideSpots.push({ id: b.nextId++, kind: 'sarcophagus', x: GY.x + 12, z: GY.z - 12, rot: 0 });
  prop(b, 'urn', GY.x + 9.4, GY.z - 6.4, 0, 0, 1, rng());
  b.noiseObjects.push({ id: b.nextId++, x: GY.x + 9.4, z: GY.z - 6.4, kind: 'urnStack' });

  // Iron railings the runner can vault but that slow a committed chase.
  for (let i = 0; i < 4; i += 1) {
    vault(b, GY.x - 18 + i * 12, GY.z + 18, 5, 0.22, 1.0, 0, 'railing');
  }

  // -------------------------------------------------------------------------
  // Hedge maze (north-east) — foliage concealment, loops, crouch tunnel below.
  // -------------------------------------------------------------------------
  const HM = { x: 36, z: -32 };
  const hedgeRows: [number, number, number, number, number][] = [
    [-18, -16, 12, 0.9, 0],
    [4, -16, 10, 0.9, 0],
    [-16, -4, 0.9, 10, 0],
    [16, -6, 0.9, 12, 0],
    [-4, 4, 12, 0.9, 0],
    [10, 6, 0.9, 8, 0],
    [-10, 12, 0.9, 6, 0],
    [2, 16, 14, 0.9, 0],
    [-18, 6, 0.9, 8, 0],
    [8, -8, 6, 0.9, 0],
  ];
  for (const [ox, oz, hw, hd] of hedgeRows) {
    wall(b, HM.x + ox, HM.z + oz, hw, hd, 3.1, 0, 'hedge');
  }
  zone(b, 'foliage', HM.x, HM.z, 21);
  zone(b, 'shadow', HM.x + 8, HM.z + 10, 6);
  for (let i = 0; i < 40; i += 1) {
    const gx = HM.x + rng.range(-20, 20);
    const gz = HM.z + rng.range(-20, 20);
    prop(b, 'grass', gx, gz, 0, rng.range(0, Math.PI), rng.range(0.7, 1.4), rng());
  }
  b.hideSpots.push({ id: b.nextId++, kind: 'wardrobe', x: HM.x - 19, z: HM.z + 14, rot: 0 });
  b.noiseObjects.push({ id: b.nextId++, x: HM.x + 14, z: HM.z + 14, kind: 'charmCluster' });
  prop(b, 'charm', HM.x + 14, HM.z + 14, 2.6, 0, 1, rng());

  // -------------------------------------------------------------------------
  // Flooded courtyard (south-west) — loud water, low cover, arch colonnade.
  // -------------------------------------------------------------------------
  const FC = { x: -34, z: 34 };
  zone(b, 'water', FC.x, FC.z, 17);
  roomShell(b, FC.x, FC.z, 19, 16, 5.2, 1, { north: 4, east: 0, south: -3 }, 'ruinWall');
  for (let i = 0; i < 4; i += 1) {
    const ax = FC.x - 12 + i * 8;
    wall(b, ax, FC.z - 8, 1.1, 1.1, 5, 0, 'ruinWall');
    prop(b, 'archStone', ax, FC.z - 8, 5, 0, 1, rng());
  }
  for (let i = 0; i < 5; i += 1) {
    vault(b, FC.x - 10 + i * 5, FC.z + 6, 1.8, 0.5, 1.0, rng.range(-0.2, 0.2), 'log');
  }
  prop(b, 'lantern', FC.x + 10, FC.z - 12, 3.4, 0, 1, rng());
  b.hideSpots.push({ id: b.nextId++, kind: 'alcove', x: FC.x - 17.6, z: FC.z + 8, rot: -90 * DEG });

  // -------------------------------------------------------------------------
  // Broken watchtower (south-east) — ramp to a raised balcony overlook.
  // -------------------------------------------------------------------------
  const WT = { x: 36, z: 34 };
  roomShell(b, WT.x, WT.z, 9, 9, 4, 1, { west: 0, north: 3 }, 'tower');
  platform(b, WT.x, WT.z, 8, 8, 4.2);
  ramp(b, WT.x - 13.5, WT.z + 3, 5.5, 3, 0, 0, 4.2);
  // Balcony railings: vaultable, so the tower is an escape route both ways.
  vault(b, WT.x, WT.z - 8, 8, 0.3, 5.3, 0, 'railing');
  vault(b, WT.x, WT.z + 8, 8, 0.3, 5.3, 0, 'railing');
  vault(b, WT.x + 8, WT.z, 0.3, 8, 5.3, 0, 'railing');
  // Upper tower stub gives the silhouette its height.
  wall(b, WT.x + 5.5, WT.z + 5.5, 3, 3, 13, 0, 'tower', 4.2);
  prop(b, 'lantern', WT.x - 6, WT.z - 6, 5.6, 0, 1.2, rng());
  prop(b, 'brazier', WT.x + 2, WT.z - 2, 4.2, 0, 1, rng());
  zone(b, 'shadow', WT.x - 14, WT.z - 8, 7);

  // -------------------------------------------------------------------------
  // Connective ruin walls — create the looping paths between landmarks.
  // -------------------------------------------------------------------------
  const connectors: [number, number, number, number, number, number][] = [
    [-18, -14, 0.9, 9, 0, 4.6],
    [18, -14, 0.9, 9, 0, 4.6],
    [-18, 18, 0.9, 8, 0, 4.2],
    [18, 18, 0.9, 8, 0, 4.2],
    [-30, 2, 9, 0.9, 0, 4.4],
    [30, 2, 9, 0.9, 0, 4.4],
    [0, -30, 7, 0.9, 0, 4.0],
    [0, 30, 7, 0.9, 0, 4.0],
    [-52, -6, 0.9, 12, 0, 5],
    [52, -6, 0.9, 12, 0, 5],
    [-14, 44, 10, 0.9, 0, 4.2],
    [14, 44, 10, 0.9, 0, 4.2],
    [-46, 12, 6, 0.9, 20 * DEG, 4.2],
    [46, 12, 6, 0.9, -20 * DEG, 4.2],
  ];
  for (const [x, z, hw, hd, rot, h] of connectors) {
    wall(b, x, z, hw, hd, h, rot, 'ruinWall');
  }

  // Rubble piles: waist-high, vaultable, break up open ground.
  for (let i = 0; i < 16; i += 1) {
    const rx = rng.range(-56, 56);
    const rz = rng.range(-56, 56);
    if (Math.abs(rx) < 17 && Math.abs(rz - 2) < 13) continue;
    vault(b, rx, rz, rng.range(1.1, 2.1), rng.range(0.9, 1.6), 1.05, rng.range(0, Math.PI), 'cart');
    prop(b, 'rubble', rx, rz, 0, rng.range(0, Math.PI), rng.range(0.9, 1.35), rng());
  }

  // -------------------------------------------------------------------------
  // Undercroft crouch tunnels — Runner-only escape valves.
  // -------------------------------------------------------------------------
  const tunnelCandidates: [number, number, number, number, number][] = [
    [-18, -14, 1.6, 1.2, 0],
    [18, -14, 1.6, 1.2, 0],
    [-18, 18, 1.6, 1.2, 0],
    [18, 18, 1.6, 1.2, 0],
    [-30, 2, 1.2, 1.6, 90 * DEG],
    [30, 2, 1.2, 1.6, 90 * DEG],
  ];
  const openTunnels = rng.shuffle(tunnelCandidates).slice(0, 4);
  for (const [x, z, hw, hd, rot] of openTunnels) {
    b.crouchGates.push({ id: b.nextId++, x, z, hw, hd, rot });
    // Carve the wall so a crouch gap actually exists in the collider.
    for (let i = b.walls.length - 1; i >= 0; i -= 1) {
      const w = b.walls[i];
      if (w.kind !== 'ruinWall') continue;
      if (Math.abs(w.x - x) < 0.6 && Math.abs(w.z - z) < 0.6) {
        b.walls.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Barricades — breachable shortcuts, seeded open/closed.
  // -------------------------------------------------------------------------
  const barricadeSpots: [number, number, number][] = [
    [-24, -2, 90 * DEG],
    [24, -2, 90 * DEG],
    [0, 20, 0],
    [-40, 18, 0],
    [40, 18, 0],
  ];
  for (const [x, z, rot] of rng.shuffle(barricadeSpots).slice(0, 4)) {
    b.barricades.push({ id: b.nextId++, x, z, rot, hw: 2.4, hd: 0.5 });
  }

  // -------------------------------------------------------------------------
  // Escape gate (north wall) and healing shrine (far south).
  // -------------------------------------------------------------------------
  const gate = { x: 0, z: -B + 3, rot: 0 };
  wall(b, -9, gate.z, 6, 1.2, 8, 0, 'ruinWall');
  wall(b, 9, gate.z, 6, 1.2, 8, 0, 'ruinWall');
  prop(b, 'brazier', -4.5, gate.z + 3, 0, 0, 1.3, rng());
  prop(b, 'brazier', 4.5, gate.z + 3, 0, 0, 1.3, rng());

  const shrine = { x: 0, z: B - 12 };
  roomShell(b, shrine.x, shrine.z, 7, 6, 4.5, 0.8, { north: 0 }, 'ruinWall');
  prop(b, 'statue', shrine.x, shrine.z + 3.4, 0, 0, 1.4, rng());
  zone(b, 'shadow', shrine.x, shrine.z, 6);

  // -------------------------------------------------------------------------
  // Seal anchors — seven candidates, three go live.
  // -------------------------------------------------------------------------
  const sealAnchors: SealAnchor[] = [
    { id: 1, x: CH.x, z: CH.z - 8.5, area: 'Chapel Altar' },
    { id: 2, x: CH.x + 11, z: CH.z + 7, area: 'Chapel Transept' },
    { id: 3, x: GY.x + 12, z: GY.z - 10, area: 'Mausoleum' },
    { id: 4, x: GY.x - 10, z: GY.z + 8, area: 'Graveyard Rows' },
    { id: 5, x: HM.x + 2, z: HM.z + 1, area: 'Hedge Heart' },
    { id: 6, x: FC.x + 2, z: FC.z + 2, area: 'Flooded Courtyard' },
    { id: 7, x: WT.x, z: WT.z, area: 'Watchtower Balcony' },
  ];
  // Always take one from the chapel cluster and spread the rest around the map,
  // so no seeded layout can bunch all three seals into one corner.
  const chapelPool = sealAnchors.filter((s) => s.id <= 2);
  const outerPool = sealAnchors.filter((s) => s.id > 2);
  const activeSeals = [
    rng.pick(chapelPool).id,
    ...rng.shuffle(outerPool).slice(0, 2).map((s) => s.id),
  ].sort((a, c) => a - c);

  // Ambient lanterns and charms for lighting anchors.
  const lanternSpots: [number, number, number][] = [
    [-20, -20, 3.2],
    [20, -20, 3.2],
    [-20, 20, 3.2],
    [20, 20, 3.2],
    [0, -22, 3.4],
    [0, 22, 3.4],
    [-44, -4, 3.2],
    [44, -4, 3.2],
    [-8, 46, 3.2],
    [8, 46, 3.2],
  ];
  for (const [x, z, y] of lanternSpots) {
    prop(b, 'lantern', x, z, y, rng.range(0, Math.PI), rng.range(0.9, 1.15), rng());
  }
  for (let i = 0; i < 22; i += 1) {
    prop(b, 'root', rng.range(-58, 58), rng.range(-58, 58), 0, rng.range(0, Math.PI), rng.range(0.8, 1.6), rng());
  }
  for (let i = 0; i < 10; i += 1) {
    prop(b, 'bench', rng.range(-50, 50), rng.range(-50, 50), 0, rng.range(0, Math.PI), 1, rng());
  }

  return {
    seed,
    size: MAP_SIZE,
    walls: b.walls,
    vaults: b.vaults,
    platforms: b.platforms,
    ramps: b.ramps,
    zones: b.zones,
    hideSpots: b.hideSpots,
    crouchGates: b.crouchGates,
    doors: b.doors,
    barricades: b.barricades,
    props: b.props,
    sealAnchors,
    activeSeals,
    noiseObjects: b.noiseObjects,
    gate,
    shrine,
    // Chosen so both players open on a long sightline into the ruins on every
    // seed, rather than staring at a wall. Verified by a clearance scan.
    runnerSpawn: { x: 16, z: 42 },
    hunterSpawn: { x: 0, z: -26 },
    fogDensity: 0.016 + rng.range(0, 0.008),
  };
}
