/**
 * Veil Hunt world builder — "moonlit dark-fantasy ruins".
 *
 * Turns a seeded `MapData` into a renderable scene graph. Everything is
 * deterministic: the same seed always produces the same textures, the same
 * broken wall tops, the same grass scatter and the same crow perches.
 *
 * ## Draw-call strategy
 *
 * Every repeated element is routed through `bucketFor()`, which returns a
 * shared `InstanceBucket` keyed by (geometry, material). Trim courses on a
 * crypt, the plinth under a chapel buttress and the edge lip of a platform all
 * land in the *same* `box/stoneDark` bucket and cost one draw call between
 * them. The whole world lands around 60 draw calls, well inside the 200 budget.
 *
 * ## Coordinate convention
 *
 * The collision code (`src/shared/collision.ts`) rotates world points into a
 * box's frame with `cos(-rot) / sin(-rot)`, which makes engine-local +X map to
 * world `(cos rot, sin rot)`. Three's `rotation.y = θ` maps local +X to world
 * `(cos θ, -sin θ)`. The two agree only when **θ = -rot**, so every oriented
 * box, ramp, door and vault here is rendered with the negated angle. Getting
 * this wrong makes visuals disagree with the colliders.
 *
 * `VaultBox.height` is an absolute world Y (the engine compares it against
 * `feetY + VAULT_MAX_HEIGHT`), so vault meshes are drawn from the floor beneath
 * them up to that height — which is what puts the watchtower balcony railing on
 * the deck rather than sunk into it.
 */

import * as THREE from 'three';
import type { BuildWorldOptions, WorldHandles, WorldUpdateContext } from '../contracts.js';
import type { PropInstance, WallBox, Zone } from '../../shared/types.js';
import { MAP_HALF, MAP_SIZE } from '../../shared/constants.js';
import { createRng, hashString } from '../../shared/rng.js';
import { ATMOSPHERE, GRASS, LIGHTING, PALETTE, WIND } from './palette.js';
import { createTextureKit } from './textures.js';
import { createMaterialKit, createWorldUniforms } from './materials.js';
import { createSky } from './sky.js';
import {
  InstanceBucket,
  alcove,
  archPanel,
  archStone,
  barricadePlanks,
  bench,
  brazierBowl,
  brazierCoals,
  brazierLegs,
  buttress,
  cart,
  charmCluster,
  crenel,
  crouchArch,
  crow,
  doorPanel,
  escapeGate,
  faceted,
  grassCard,
  gravestoneCross,
  gravestoneObelisk,
  gravestoneSlab,
  lanternFrame,
  lanternGlass,
  lanternPost,
  log,
  lowWall,
  merge,
  pebble,
  pillarTop,
  railBar,
  railPost,
  root as rootProp,
  rubblePile,
  runeRing,
  sarcophagus,
  shrine as shrineProp,
  statue,
  tomb,
  unitBox,
  unitPlaneXZ,
  unitWedge,
  urn,
  wardrobe,
  type InstancedOptions,
} from './props.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface WorldDiagnostics {
  drawCallEstimate: number;
  triangles: number;
  instancedMeshes: number;
  materials: number;
  textures: number;
}

export interface WorldExtras extends WorldHandles {
  /** Rotate a door mesh. `open` is 0..1. */
  setDoorOpen(id: number, open: number): void;
  /** Hide a barricade once breached. */
  setBarricadeBroken(id: number, broken: boolean): void;
  /** World-space anchor points so the app can attach seal/gate/shrine markers. */
  getAnchors(): { seals: Map<number, THREE.Vector3>; gate: THREE.Vector3; shrine: THREE.Vector3 };
  /** Renderer diagnostics helper. */
  describe(): WorldDiagnostics;
}

// ---------------------------------------------------------------------------
// Geometry maths shared with the collision model
// ---------------------------------------------------------------------------

/** Engine-local (lx, lz) to world, matching `collision.ts`. */
function localToWorld(
  cx: number,
  cz: number,
  rot: number,
  lx: number,
  lz: number,
  out: { x: number; z: number },
): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  out.x = cx + lx * c - lz * s;
  out.z = cz + lx * s + lz * c;
}

const SCRATCH_XZ = { x: 0, z: 0 };

/** Position-hashed pseudo-random in 0..1: coincident vertices agree, so no cracks. */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(Math.round(x * 64) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (Math.round(y * 64) + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ (Math.round(z * 64) - 0x27d4eb2f), 0x9e3779b1);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Crows
// ---------------------------------------------------------------------------

type CrowState = 'perched' | 'fleeing' | 'circling' | 'returning';

interface Crow {
  perch: THREE.Vector3;
  position: THREE.Vector3;
  target: THREE.Vector3;
  yaw: number;
  state: CrowState;
  timer: number;
  phase: number;
  flap: number;
  bobPhase: number;
}

interface EmberSource {
  position: THREE.Vector3;
  /** Scales the point-light radius: braziers throw more light than lanterns. */
  power: number;
  phase: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildWorld(options: BuildWorldOptions): WorldExtras {
  const { map, quality } = options;
  const rng = createRng((map.seed ^ hashString('veil.world')) >>> 0);

  const root = new THREE.Group();
  root.name = 'veil-world';

  const textures = createTextureKit(map);
  const uniforms = createWorldUniforms(map.fogDensity);
  const materials = createMaterialKit(textures, uniforms, MAP_SIZE);

  const fog = new THREE.FogExp2(PALETTE.fog, map.fogDensity);
  const baseFogDensity = map.fogDensity;

  /** Geometries created outside the bucket system, tracked for disposal. */
  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const trackGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    ownedGeometries.add(geometry);
    return geometry;
  };

  // -------------------------------------------------------------------------
  // Instancing registry: one InstancedMesh per (geometry, material) pair
  // -------------------------------------------------------------------------

  interface BucketRecord {
    bucket: InstanceBucket;
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    options: InstancedOptions;
  }
  const buckets = new Map<string, BucketRecord>();

  function bucketFor(
    key: string,
    makeGeometry: () => THREE.BufferGeometry,
    material: THREE.Material,
    bucketOptions: InstancedOptions = {},
  ): InstanceBucket {
    let record = buckets.get(key);
    if (!record) {
      record = {
        bucket: new InstanceBucket(`veil-${key}`),
        geometry: makeGeometry(),
        material,
        options: bucketOptions,
      };
      buckets.set(key, record);
    }
    return record.bucket;
  }

  const SOLID: InstancedOptions = { castShadow: true, receiveShadow: true };
  const DETAIL: InstancedOptions = { castShadow: false, receiveShadow: true };

  // Shared masonry buckets — most of the world's silhouette lives in these.
  const boxStone = (): InstanceBucket => bucketFor('box/stone', unitBox, materials.stone, SOLID);
  const boxDark = (): InstanceBucket =>
    bucketFor('box/stoneDark', unitBox, materials.stoneDark, SOLID);
  const boxWarm = (): InstanceBucket =>
    bucketFor('box/stoneWarm', unitBox, materials.stoneWarm, SOLID);
  const crenelBucket = (): InstanceBucket =>
    bucketFor('crenel/stone', () => crenel(rng), materials.stone, SOLID);
  const buttressBucket = (): InstanceBucket =>
    bucketFor('buttress/stone', buttress, materials.stone, SOLID);
  const windowBucket = (): InstanceBucket =>
    bucketFor('window/stoneDark', archPanel, materials.stoneDark, DETAIL);

  // -------------------------------------------------------------------------
  // Floor sampling (mirrors collision.floorHeightAt so props sit on decks)
  // -------------------------------------------------------------------------

  function floorHeightAt(x: number, z: number): number {
    let best = 0;
    for (const platform of map.platforms) {
      if (
        x >= platform.x - platform.hw &&
        x <= platform.x + platform.hw &&
        z >= platform.z - platform.hd &&
        z <= platform.z + platform.hd &&
        platform.height > best
      ) {
        best = platform.height;
      }
    }
    for (const ramp of map.ramps) {
      const dx = x - ramp.x;
      const dz = z - ramp.z;
      const c = Math.cos(-ramp.rot);
      const s = Math.sin(-ramp.rot);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) <= ramp.hw && Math.abs(lz) <= ramp.hd) {
        const t = (lx + ramp.hw) / (2 * ramp.hw);
        const h = ramp.height0 + (ramp.height1 - ramp.height0) * t;
        if (h > best) best = h;
      }
    }
    return best;
  }

  function insideWall(wall: WallBox, x: number, z: number, pad: number): boolean {
    const dx = x - wall.x;
    const dz = z - wall.z;
    const c = Math.cos(-wall.rot);
    const s = Math.sin(-wall.rot);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return Math.abs(lx) <= wall.hw + pad && Math.abs(lz) <= wall.hd + pad;
  }

  function blockedAt(x: number, z: number, pad: number): boolean {
    if (Math.abs(x) > MAP_HALF - 3 || Math.abs(z) > MAP_HALF - 3) return true;
    for (const wall of map.walls) {
      if (insideWall(wall, x, z, pad)) return true;
    }
    return false;
  }

  function inZone(kind: Zone['kind'], x: number, z: number, slack = 0): boolean {
    for (const zone of map.zones) {
      if (zone.kind !== kind) continue;
      if (Math.hypot(x - zone.x, z - zone.z) <= zone.radius + slack) return true;
    }
    return false;
  }

  function nearWall(x: number, z: number, distance: number): boolean {
    for (const wall of map.walls) {
      if (wall.kind === 'boundary') continue;
      if (insideWall(wall, x, z, distance)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Lighting
  // -------------------------------------------------------------------------

  const moon = new THREE.DirectionalLight(PALETTE.moonlight, LIGHTING.moonIntensity);
  moon.name = 'veil-moon';
  moon.position.set(
    LIGHTING.moonPosition.x,
    LIGHTING.moonPosition.y,
    LIGHTING.moonPosition.z,
  );
  moon.target.position.set(0, 0, 0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(LIGHTING.shadowMapSize, LIGHTING.shadowMapSize);
  moon.shadow.bias = LIGHTING.shadowBias;
  moon.shadow.normalBias = LIGHTING.shadowNormalBias;
  fitShadowCamera(moon, MAP_HALF + 2, LIGHTING.worldMaxHeight);
  root.add(moon);
  root.add(moon.target);

  const hemisphere = new THREE.HemisphereLight(
    PALETTE.skyFill,
    PALETTE.groundFill,
    LIGHTING.hemiIntensity,
  );
  hemisphere.name = 'veil-hemi';
  root.add(hemisphere);

  const sky = createSky(map.seed, moon.position.clone());
  root.add(sky.group);

  /**
   * Frames the shadow camera tightly around the play volume by projecting the
   * world AABB into light space, rather than guessing a symmetric box that has
   * to be oversized to survive the light's diagonal direction.
   */
  function fitShadowCamera(light: THREE.DirectionalLight, half: number, top: number): void {
    const lightWorld = new THREE.Matrix4()
      .lookAt(light.position, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0))
      .setPosition(light.position);
    const view = lightWorld.invert();
    const corner = new THREE.Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const sx of [-half, half]) {
      for (const sy of [0, top]) {
        for (const sz of [-half, half]) {
          corner.set(sx, sy, sz).applyMatrix4(view);
          minX = Math.min(minX, corner.x);
          maxX = Math.max(maxX, corner.x);
          minY = Math.min(minY, corner.y);
          maxY = Math.max(maxY, corner.y);
          minZ = Math.min(minZ, corner.z);
          maxZ = Math.max(maxZ, corner.z);
        }
      }
    }
    const camera = light.shadow.camera;
    const margin = 2;
    camera.left = minX - margin;
    camera.right = maxX + margin;
    camera.bottom = minY - margin;
    camera.top = maxY + margin;
    // The camera looks down -Z, so view-space Z is negative in front of it.
    camera.near = Math.max(0.5, -maxZ - margin);
    camera.far = -minZ + margin;
    camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------

  {
    const span = MAP_SIZE + 36;
    const geometry = trackGeometry(new THREE.PlaneGeometry(span, span, 56, 56));
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = position.getZ(i);
      // Gentle undulation only: the collision floor is flat at y=0, so this has
      // to stay well under the player's step-up height.
      const y =
        Math.sin(x * 0.107 + 1.7) * Math.cos(z * 0.131 - 0.6) * 0.035 +
        Math.sin(x * 0.037 - z * 0.041) * 0.028;
      position.setY(i, y);
    }
    geometry.computeVertexNormals();
    const ground = new THREE.Mesh(geometry, materials.ground);
    ground.name = 'veil-ground';
    ground.receiveShadow = true;
    ground.castShadow = false;
    root.add(ground);
  }

  // -------------------------------------------------------------------------
  // Water
  // -------------------------------------------------------------------------

  {
    const discs: THREE.BufferGeometry[] = [];
    for (const zone of map.zones) {
      if (zone.kind !== 'water') continue;
      const disc = new THREE.CircleGeometry(zone.radius, 44);
      disc.rotateX(-Math.PI / 2);
      // Re-author uv.x as the normalised radius so the shader can fade the
      // shoreline without a second attribute.
      const position = disc.getAttribute('position');
      const uv = disc.getAttribute('uv');
      for (let i = 0; i < position.count; i += 1) {
        const r = Math.hypot(position.getX(i), position.getZ(i)) / zone.radius;
        uv.setXY(i, r, 0);
      }
      disc.translate(zone.x, 0.06, zone.z);
      discs.push(disc);
    }
    if (discs.length > 0) {
      const geometry = trackGeometry(merge(discs));
      const water = new THREE.Mesh(geometry, materials.water);
      water.name = 'veil-water';
      water.renderOrder = 2;
      water.receiveShadow = false;
      root.add(water);
    }
  }

  // -------------------------------------------------------------------------
  // Walls
  // -------------------------------------------------------------------------

  /** World anchor + yaw for a point on one of a wall's long faces. */
  function faceAnchor(
    wall: WallBox,
    along: number,
    side: 1 | -1,
  ): { x: number; z: number; yaw: number } {
    const longIsX = wall.hw >= wall.hd;
    const shortHalf = longIsX ? wall.hd : wall.hw;
    const lx = longIsX ? along : side * shortHalf;
    const lz = longIsX ? side * shortHalf : along;
    localToWorld(wall.x, wall.z, wall.rot, lx, lz, SCRATCH_XZ);
    const outward = longIsX ? (side > 0 ? 0 : Math.PI) : side > 0 ? Math.PI / 2 : -Math.PI / 2;
    return { x: SCRATCH_XZ.x, z: SCRATCH_XZ.z, yaw: -wall.rot + outward };
  }

  /**
   * Uneven blocks along a wall crest — the single biggest "ruined" cue.
   *
   * `ragged` breaks the alignment as well as the height, which is what turns a
   * regular castle sawtooth into something that reads as broken rock. Masonry
   * crests want it off so the courses stay coursed.
   */
  function addBrokenTop(
    wall: WallBox,
    crestY: number,
    rise: number,
    spacing: number,
    ragged = false,
  ): void {
    const longIsX = wall.hw >= wall.hd;
    const longHalf = longIsX ? wall.hw : wall.hd;
    const shortHalf = longIsX ? wall.hd : wall.hw;
    const count = Math.max(1, Math.round((longHalf * 2) / spacing));
    const segment = (longHalf * 2) / count;
    for (let i = 0; i < count; i += 1) {
      const along =
        -longHalf + segment * (i + 0.5) + (ragged ? rng.range(-segment * 0.3, segment * 0.3) : 0);
      const lx = longIsX ? along : 0;
      const lz = longIsX ? 0 : along;
      localToWorld(wall.x, wall.z, wall.rot, lx, lz, SCRATCH_XZ);
      const spread = ragged ? rng.range(0.68, 1.34) : 1.02;
      const thick = ragged ? rng.range(0.85, 1.5) : 1.92;
      crenelBucket().place(
        SCRATCH_XZ.x,
        crestY,
        SCRATCH_XZ.z,
        -wall.rot + (ragged ? rng.range(-0.3, 0.3) : 0),
        longIsX ? segment * spread : shortHalf * thick,
        rise * rng.range(0.6, 1.35),
        longIsX ? shortHalf * thick : segment * spread,
      );
    }
  }

  function addTrimCourse(wall: WallBox, y: number, thickness: number, overhang: number): void {
    boxDark().place(
      wall.x,
      y,
      wall.z,
      -wall.rot,
      wall.hw * 2 + overhang,
      thickness,
      wall.hd * 2 + overhang,
    );
  }

  const hedgeParts: THREE.BufferGeometry[] = [];

  for (const wall of map.walls) {
    const yaw = -wall.rot;
    const width = wall.hw * 2;
    const depth = wall.hd * 2;
    const longHalf = Math.max(wall.hw, wall.hd);
    const isColumn = Math.max(wall.hw, wall.hd) < 1.4;

    switch (wall.kind) {
      case 'boundary': {
        boxWarm().place(wall.x, wall.base, wall.z, yaw, width, wall.height, depth);
        addTrimCourse(wall, wall.base, 0.7, 0.9);
        // A darker, taller mass behind the curtain wall reads as cliff face and
        // closes the skyline without any extra draw calls.
        const outX = Math.abs(wall.x) > Math.abs(wall.z) ? Math.sign(wall.x) : 0;
        const outZ = Math.abs(wall.z) >= Math.abs(wall.x) ? Math.sign(wall.z) : 0;
        const outHalf = outZ !== 0 ? wall.hd : wall.hw;
        const cliffHalf = 4.5;
        const cliff: WallBox = {
          ...wall,
          x: wall.x + outX * (outHalf + cliffHalf),
          z: wall.z + outZ * (outHalf + cliffHalf),
          hw: outZ !== 0 ? wall.hw + 4 : cliffHalf,
          hd: outZ !== 0 ? cliffHalf : wall.hd + 4,
        };
        boxDark().place(cliff.x, -1, cliff.z, yaw, cliff.hw * 2, 17, cliff.hd * 2);
        // Jagged rock along the cliff crest: without it the skyline is a
        // perfectly straight synthetic edge against the gradient.
        addBrokenTop(cliff, 15.4, 4.6, 5.5, true);
        addBrokenTop(wall, wall.base + wall.height - 0.2, 1.5, 3.1);
        for (let i = -3; i <= 3; i += 1) {
          const anchor = faceAnchor(wall, (i / 3.5) * longHalf, -1);
          buttressBucket().place(anchor.x, wall.base, anchor.z, anchor.yaw, 2.4, wall.height * 0.8, 2);
        }
        break;
      }

      case 'hedge': {
        // Merged rather than instanced: authoring in world space lets the sway
        // shader read a real world phase, so wind crosses a hedge as a wave.
        const segX = Math.max(2, Math.round(width / 1.5));
        const segY = 3;
        const segZ = Math.max(2, Math.round(depth / 1.5));
        const geometry = new THREE.BoxGeometry(width, wall.height, depth, segX, segY, segZ);
        const position = geometry.getAttribute('position');
        for (let i = 0; i < position.count; i += 1) {
          const px = position.getX(i);
          const py = position.getY(i);
          const pz = position.getZ(i);
          const planted = clamp((py + wall.height / 2) / 0.6, 0, 1);
          const amp = 0.26 * planted;
          position.setXYZ(
            i,
            px + (hash3(px, py, pz) - 0.5) * amp * 2,
            py + (hash3(py, pz, px) - 0.5) * amp * 1.4,
            pz + (hash3(pz, px, py) - 0.5) * amp * 2,
          );
        }
        geometry.translate(0, wall.height / 2, 0);
        geometry.rotateY(yaw);
        geometry.translate(wall.x, wall.base, wall.z);
        hedgeParts.push(geometry);
        break;
      }

      case 'chapelWall': {
        if (isColumn) {
          boxStone().place(wall.x, wall.base, wall.z, yaw, width, wall.height, depth);
          addTrimCourse(wall, wall.base, 0.34, 0.55);
          addTrimCourse(wall, wall.base + 0.34, 0.16, 0.28);
          break;
        }
        const broken = rng.bool(0.4);
        const bodyHeight = broken ? wall.height * 0.82 : wall.height * 0.94;
        boxStone().place(wall.x, wall.base, wall.z, yaw, width, bodyHeight, depth);
        addTrimCourse(wall, wall.base, 0.42, 0.5);
        if (broken) {
          addBrokenTop(wall, wall.base + bodyHeight, wall.height * 0.3, 1.35);
        } else {
          addTrimCourse(wall, wall.base + bodyHeight, wall.height * 0.06, 0.44);
        }
        // Buttresses on both faces: the chapel reads as buttressed from inside
        // the nave as well as from the graveyard side.
        const buttressCount = Math.max(2, Math.floor((longHalf * 2) / 5.5));
        for (let i = 0; i < buttressCount; i += 1) {
          const along = -longHalf + ((i + 0.5) / buttressCount) * longHalf * 2;
          for (const side of [1, -1] as const) {
            const anchor = faceAnchor(wall, along, side);
            buttressBucket().place(
              anchor.x,
              wall.base,
              anchor.z,
              anchor.yaw,
              1.15,
              wall.height * 0.84,
              0.8,
            );
          }
        }
        // Arched window reveals cut between the buttresses.
        if (longHalf * 2 >= 6 && wall.height >= 4.5) {
          const shortHalf = wall.hw >= wall.hd ? wall.hd : wall.hw;
          const windows = Math.max(1, Math.floor((longHalf * 2) / 5.5));
          for (let i = 0; i < windows; i += 1) {
            const along = -longHalf + ((i + 1) / (windows + 1)) * longHalf * 2;
            const lx = wall.hw >= wall.hd ? along : 0;
            const lz = wall.hw >= wall.hd ? 0 : along;
            localToWorld(wall.x, wall.z, wall.rot, lx, lz, SCRATCH_XZ);
            windowBucket().place(
              SCRATCH_XZ.x,
              wall.base + wall.height * 0.3,
              SCRATCH_XZ.z,
              yaw + (wall.hw >= wall.hd ? 0 : -Math.PI / 2),
              1.6,
              wall.height * 0.48,
              shortHalf * 2 + 0.12,
            );
          }
        }
        break;
      }

      case 'crypt':
      case 'tower': {
        boxWarm().place(wall.x, wall.base, wall.z, yaw, width, wall.height, depth);
        addTrimCourse(wall, wall.base, 0.45, 0.6);
        addTrimCourse(wall, wall.base + wall.height * 0.55, 0.28, 0.34);
        addTrimCourse(wall, wall.base + wall.height - 0.42, 0.42, 0.62);
        if (!isColumn && rng.bool(0.55)) {
          addBrokenTop(wall, wall.base + wall.height, wall.height * 0.14, 1.5);
        }
        break;
      }

      case 'rubble': {
        boxStone().place(wall.x, wall.base, wall.z, yaw, width, wall.height * 0.6, depth);
        addBrokenTop(wall, wall.base + wall.height * 0.6, wall.height * 0.5, 1.1);
        break;
      }

      case 'ruinWall':
      default: {
        const bodyHeight = wall.height * (isColumn ? 0.9 : 0.76);
        boxStone().place(wall.x, wall.base, wall.z, yaw, width, bodyHeight, depth);
        addTrimCourse(wall, wall.base, 0.32, 0.42);
        addBrokenTop(wall, wall.base + bodyHeight, wall.height * 0.3, 1.15);
        if (!isColumn && longHalf > 5) {
          for (const side of [1, -1] as const) {
            const anchor = faceAnchor(wall, rng.range(-longHalf * 0.6, longHalf * 0.6), side);
            buttressBucket().place(
              anchor.x,
              wall.base,
              anchor.z,
              anchor.yaw,
              1.1,
              wall.height * 0.6,
              0.7,
            );
          }
        }
        break;
      }
    }
  }

  if (hedgeParts.length > 0) {
    const geometry = trackGeometry(merge(hedgeParts));
    geometry.computeVertexNormals();
    const hedgeMesh = new THREE.Mesh(geometry, materials.hedge);
    hedgeMesh.name = 'veil-hedges';
    hedgeMesh.castShadow = true;
    hedgeMesh.receiveShadow = true;
    root.add(hedgeMesh);
  }

  // -------------------------------------------------------------------------
  // Platforms and ramps
  // -------------------------------------------------------------------------

  for (const platform of map.platforms) {
    const deck = Math.min(1.1, Math.max(0.45, platform.height * 0.35));
    boxStone().place(
      platform.x,
      platform.height - deck,
      platform.z,
      0,
      platform.hw * 2,
      deck,
      platform.hd * 2,
    );
    // Edge trim so a raised balcony reads as a deck rather than a slab.
    const lip = 0.22;
    boxDark().place(platform.x, platform.height - lip, platform.z - platform.hd, 0, platform.hw * 2 + 0.5, lip + 0.1, 0.5);
    boxDark().place(platform.x, platform.height - lip, platform.z + platform.hd, 0, platform.hw * 2 + 0.5, lip + 0.1, 0.5);
    boxDark().place(platform.x - platform.hw, platform.height - lip, platform.z, 0, 0.5, lip + 0.1, platform.hd * 2 + 0.5);
    boxDark().place(platform.x + platform.hw, platform.height - lip, platform.z, 0, 0.5, lip + 0.1, platform.hd * 2 + 0.5);
    // Skirt down to the ground so the deck is not floating.
    if (platform.height - deck > 0.2) {
      boxWarm().place(
        platform.x,
        0,
        platform.z,
        0,
        platform.hw * 2 - 0.6,
        platform.height - deck,
        platform.hd * 2 - 0.6,
      );
    }
  }

  const rampBucket = (): InstanceBucket =>
    bucketFor('wedge/stone', unitWedge, materials.stone, SOLID);

  for (const ramp of map.ramps) {
    const rise = ramp.height1 - ramp.height0;
    const yaw = -ramp.rot;
    if (Math.abs(rise) < 0.02) {
      boxStone().place(ramp.x, ramp.height0 - 0.4, ramp.z, yaw, ramp.hw * 2, 0.4, ramp.hd * 2);
      continue;
    }
    // A negative Y scale would flip the winding, so flip along X instead by
    // adding half a turn when the ramp descends along its local +X.
    const descending = rise < 0;
    rampBucket().place(
      ramp.x,
      Math.min(ramp.height0, ramp.height1),
      ramp.z,
      descending ? yaw + Math.PI : yaw,
      ramp.hw * 2,
      Math.abs(rise),
      ramp.hd * 2,
    );
    // Kerbs along both sloped edges.
    for (const side of [1, -1] as const) {
      localToWorld(ramp.x, ramp.z, ramp.rot, 0, side * (ramp.hd - 0.14), SCRATCH_XZ);
      rampBucket().place(
        SCRATCH_XZ.x,
        Math.min(ramp.height0, ramp.height1) + 0.02,
        SCRATCH_XZ.z,
        descending ? yaw + Math.PI : yaw,
        ramp.hw * 2,
        Math.abs(rise) + 0.24,
        0.28,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Vault obstacles
  // -------------------------------------------------------------------------

  for (const vault of map.vaults) {
    const floor = floorHeightAt(vault.x, vault.z);
    const height = Math.max(0.4, vault.height - floor);
    const yaw = -vault.rot;
    const width = vault.hw * 2;
    const depth = vault.hd * 2;

    switch (vault.kind) {
      case 'railing': {
        const longIsX = vault.hw >= vault.hd;
        const longHalf = longIsX ? vault.hw : vault.hd;
        const posts = Math.max(2, Math.round((longHalf * 2) / 1.5) + 1);
        const postBucket = bucketFor('railpost/iron', railPost, materials.iron, DETAIL);
        const barBucket = bucketFor('railbar/iron', railBar, materials.iron, DETAIL);
        for (let i = 0; i < posts; i += 1) {
          const along = -longHalf + (i / (posts - 1)) * longHalf * 2;
          const lx = longIsX ? along : 0;
          const lz = longIsX ? 0 : along;
          localToWorld(vault.x, vault.z, vault.rot, lx, lz, SCRATCH_XZ);
          postBucket.place(SCRATCH_XZ.x, floor, SCRATCH_XZ.z, yaw, 1, height, 1);
        }
        // Two horizontal rails: the top edge is what sells "vaultable".
        for (const frac of [0.98, 0.55]) {
          barBucket.place(
            vault.x,
            floor + height * frac,
            vault.z,
            longIsX ? yaw : yaw + Math.PI / 2,
            longHalf * 2,
            1,
            1,
          );
        }
        break;
      }
      case 'tomb':
        bucketFor('tomb/stonePale', tomb, materials.stonePale, SOLID).place(
          vault.x,
          floor,
          vault.z,
          yaw,
          width,
          height,
          depth,
        );
        break;
      case 'cart':
        bucketFor('cart/wood', () => cart(rng), materials.wood, SOLID).place(
          vault.x,
          floor,
          vault.z,
          yaw,
          width / 1.9,
          height,
          depth / 1.05,
        );
        break;
      case 'log':
        bucketFor('log/wood', () => log(rng), materials.wood, SOLID).place(
          vault.x,
          floor,
          vault.z,
          yaw,
          width / 2,
          height,
          depth,
        );
        break;
      case 'wall':
      default:
        bucketFor('lowwall/stone', () => lowWall(rng), materials.stone, SOLID).place(
          vault.x,
          floor,
          vault.z,
          yaw,
          width,
          height,
          depth,
        );
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Props
  // -------------------------------------------------------------------------

  const embers: EmberSource[] = [];
  const grassPlacements: { x: number; y: number; z: number; rot: number; scale: number }[] = [];

  const grassPerProp = GRASS.perProp[quality];
  const grassScatter = GRASS.scatter[quality];

  function addGrassClump(x: number, z: number, spread: number, count: number, scale: number): void {
    for (let i = 0; i < count; i += 1) {
      const angle = rng.range(0, Math.PI * 2);
      const radius = Math.sqrt(rng()) * spread;
      const gx = x + Math.cos(angle) * radius;
      const gz = z + Math.sin(angle) * radius;
      grassPlacements.push({
        x: gx,
        y: floorHeightAt(gx, gz),
        z: gz,
        rot: rng.range(0, Math.PI * 2),
        scale: scale * rng.range(0.62, 1.25),
      });
    }
  }

  for (const prop of map.props) {
    placeProp(prop);
  }

  function placeProp(prop: PropInstance): void {
    const yaw = -prop.rot;
    const s = prop.scale;
    const { x, z, y, variant } = prop;

    switch (prop.kind) {
      case 'gravestone': {
        const key =
          variant < 0.4
            ? ('gravestoneSlab' as const)
            : variant < 0.75
              ? ('gravestoneCross' as const)
              : ('gravestoneObelisk' as const);
        const factory =
          key === 'gravestoneSlab'
            ? gravestoneSlab
            : key === 'gravestoneCross'
              ? gravestoneCross
              : gravestoneObelisk;
        bucketFor(`${key}/stonePale`, () => factory(rng), materials.stonePale, SOLID).placeEuler(
          x,
          y,
          z,
          new THREE.Euler(rng.range(-0.07, 0.07), yaw, rng.range(-0.09, 0.09)),
          s,
        );
        break;
      }
      case 'pillar':
        bucketFor('pillarTop/stone', () => pillarTop(rng), materials.stone, SOLID).place(
          x,
          y,
          z,
          yaw,
          s * 0.62,
        );
        break;
      case 'archStone':
        bucketFor('archStone/stone', () => archStone(rng), materials.stone, SOLID).place(
          x,
          y,
          z,
          yaw,
          s * 0.72,
        );
        break;
      case 'statue':
        bucketFor('statue/stonePale', statue, materials.stonePale, SOLID).place(x, y, z, yaw, s);
        break;
      case 'brazier': {
        bucketFor(
          'brazierBody/iron',
          () => faceted(merge([brazierLegs(), brazierBowl()])),
          materials.iron,
          SOLID,
        ).place(x, y, z, yaw, s);
        bucketFor(
          'brazierCoals/amber',
          () => brazierCoals(rng),
          materials.emberAmber,
          DETAIL,
        ).place(x, y, z, yaw, s);
        embers.push({
          position: new THREE.Vector3(x, y + 1.05 * s, z),
          power: 1.35,
          phase: x * 3.17 + z * 2.31 + (y + 1.05 * s) * 1.13,
        });
        break;
      }
      case 'lantern': {
        bucketFor('lanternFrame/iron', lanternFrame, materials.iron, DETAIL).place(x, y, z, yaw, s);
        bucketFor('lanternGlass/amber', lanternGlass, materials.emberAmber, DETAIL).place(
          x,
          y,
          z,
          yaw,
          s,
        );
        const floor = floorHeightAt(x, z);
        const drop = y - 0.62 * s - floor;
        if (drop > 0.6 && !nearWall(x, z, 1.4)) {
          bucketFor('lanternPost/iron', lanternPost, materials.iron, SOLID).place(
            x,
            floor,
            z,
            yaw,
            1,
            drop,
            1,
          );
        }
        embers.push({
          position: new THREE.Vector3(x, y - 0.26 * s, z),
          power: 0.85,
          phase: x * 3.17 + z * 2.31 + (y - 0.26 * s) * 1.13,
        });
        break;
      }
      case 'charm':
        bucketFor('charm/bone', () => charmCluster(rng), materials.charm, DETAIL).place(
          x,
          y,
          z,
          yaw,
          s,
        );
        break;
      case 'grass':
        addGrassClump(x, z, 0.9 * s, grassPerProp, s);
        break;
      case 'rubble': {
        const index = variant < 0.34 ? 0 : variant < 0.67 ? 1 : 2;
        bucketFor(`rubble${index}/stone`, () => rubblePile(rng), materials.stone, SOLID).place(
          x,
          y,
          z,
          yaw,
          s,
        );
        break;
      }
      case 'root': {
        const index = variant < 0.5 ? 0 : 1;
        bucketFor(`root${index}/wood`, () => rootProp(rng), materials.wood, DETAIL).place(
          x,
          y,
          z,
          yaw,
          s,
        );
        break;
      }
      case 'urn':
        bucketFor('urn/stonePale', urn, materials.stonePale, SOLID).place(x, y, z, yaw, s);
        break;
      case 'bench':
        bucketFor('bench/wood', bench, materials.wood, SOLID).place(x, y, z, yaw, s);
        break;
      default:
        break;
    }
  }

  // Extra ground cover, weighted toward foliage zones and away from geometry.
  {
    const foliageZones = map.zones.filter((zone) => zone.kind === 'foliage');
    let placed = 0;
    let attempts = 0;
    while (placed < grassScatter && attempts < grassScatter * 6) {
      attempts += 1;
      let gx: number;
      let gz: number;
      if (foliageZones.length > 0 && rng.bool(0.55)) {
        const zone = rng.pick(foliageZones);
        const angle = rng.range(0, Math.PI * 2);
        const radius = Math.sqrt(rng()) * zone.radius;
        gx = zone.x + Math.cos(angle) * radius;
        gz = zone.z + Math.sin(angle) * radius;
      } else {
        gx = rng.range(-MAP_HALF + 4, MAP_HALF - 4);
        gz = rng.range(-MAP_HALF + 4, MAP_HALF - 4);
      }
      if (inZone('water', gx, gz, -0.5)) continue;
      if (blockedAt(gx, gz, 0.2)) continue;
      grassPlacements.push({
        x: gx,
        y: floorHeightAt(gx, gz),
        z: gz,
        rot: rng.range(0, Math.PI * 2),
        scale: rng.range(0.45, 1.15) * (inZone('foliage', gx, gz) ? 1.25 : 0.85),
      });
      placed += 1;
    }

    const grassBucket = bucketFor('grassCard/grass', grassCard, materials.grass, {
      castShadow: false,
      receiveShadow: false,
    });
    for (const placement of grassPlacements) {
      grassBucket.place(
        placement.x,
        placement.y,
        placement.z,
        placement.rot,
        placement.scale,
        placement.scale * rng.range(0.85, 1.3),
        placement.scale,
      );
    }
  }

  // Pebble scatter to break up bare ground near ruins.
  {
    const pebbleBucket = bucketFor('pebble/stone', () => pebble(rng), materials.stone, DETAIL);
    const target = quality === 'low' ? 180 : 520;
    let placed = 0;
    let attempts = 0;
    while (placed < target && attempts < target * 5) {
      attempts += 1;
      const px = rng.range(-MAP_HALF + 4, MAP_HALF - 4);
      const pz = rng.range(-MAP_HALF + 4, MAP_HALF - 4);
      if (inZone('water', px, pz, -1)) continue;
      if (blockedAt(px, pz, 0.1)) continue;
      pebbleBucket.placeEuler(
        px,
        floorHeightAt(px, pz),
        pz,
        new THREE.Euler(rng.range(0, 0.4), rng.range(0, Math.PI * 2), rng.range(0, 0.4)),
        rng.range(0.2, 0.55),
      );
      placed += 1;
    }
  }

  // -------------------------------------------------------------------------
  // Hide spots and crouch gates
  // -------------------------------------------------------------------------

  for (const spot of map.hideSpots) {
    const yaw = -spot.rot;
    const floor = floorHeightAt(spot.x, spot.z);
    switch (spot.kind) {
      case 'wardrobe':
        bucketFor('wardrobe/wood', wardrobe, materials.wood, SOLID).place(
          spot.x,
          floor,
          spot.z,
          yaw,
          1,
        );
        break;
      case 'alcove':
        bucketFor('alcove/stone', alcove, materials.stone, SOLID).place(
          spot.x,
          floor,
          spot.z,
          yaw,
          1,
        );
        break;
      case 'sarcophagus':
      default:
        bucketFor('sarcophagus/stonePale', sarcophagus, materials.stonePale, SOLID).place(
          spot.x,
          floor,
          spot.z,
          yaw,
          1,
        );
        break;
    }
  }

  for (const gate of map.crouchGates) {
    const longIsX = gate.hw >= gate.hd;
    bucketFor('crouchArch/stone', crouchArch, materials.stone, SOLID).place(
      gate.x,
      floorHeightAt(gate.x, gate.z),
      gate.z,
      -gate.rot + (longIsX ? 0 : Math.PI / 2),
      Math.max(gate.hw, gate.hd) * 1.6,
      1.35,
      Math.min(gate.hw, gate.hd) * 1.9,
    );
  }

  // -------------------------------------------------------------------------
  // Doors and barricades: individually addressable for animation
  // -------------------------------------------------------------------------

  const doorPivots = new Map<number, THREE.Group>();
  for (const door of map.doors) {
    const pivot = new THREE.Group();
    pivot.name = `veil-door-${door.id}`;
    pivot.position.set(door.x, floorHeightAt(door.x, door.z), door.z);
    pivot.rotation.y = -door.rot;
    const geometry = trackGeometry(doorPanel(door.width, 2.85));
    const mesh = new THREE.Mesh(geometry, materials.wood);
    mesh.name = `veil-door-panel-${door.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    root.add(pivot);
    doorPivots.set(door.id, pivot);
  }

  const barricadeMeshes = new Map<number, THREE.Mesh>();
  for (const barricade of map.barricades) {
    const geometry = trackGeometry(barricadePlanks(rng));
    const mesh = new THREE.Mesh(geometry, materials.wood);
    mesh.name = `veil-barricade-${barricade.id}`;
    mesh.position.set(barricade.x, floorHeightAt(barricade.x, barricade.z), barricade.z);
    mesh.rotation.y = -barricade.rot;
    mesh.scale.set(barricade.hw * 2, 1, barricade.hd * 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    barricadeMeshes.set(barricade.id, mesh);
  }

  // -------------------------------------------------------------------------
  // Landmarks: escape gate, shrine, active seal rings
  // -------------------------------------------------------------------------

  {
    const gate = escapeGate();
    const gateStone = new THREE.Mesh(trackGeometry(gate.stone), materials.stone);
    gateStone.name = 'veil-gate';
    gateStone.castShadow = true;
    gateStone.receiveShadow = true;
    const gateRunes = new THREE.Mesh(trackGeometry(gate.runes), materials.emberCyan);
    gateRunes.name = 'veil-gate-runes';
    for (const mesh of [gateStone, gateRunes]) {
      mesh.position.set(map.gate.x, floorHeightAt(map.gate.x, map.gate.z), map.gate.z);
      mesh.rotation.y = -map.gate.rot;
      root.add(mesh);
    }
    embers.push({
      position: new THREE.Vector3(map.gate.x, 4.6, map.gate.z + 0.9),
      power: 1.1,
      phase: 11.3,
    });
  }

  {
    const parts = shrineProp();
    const shrineStone = new THREE.Mesh(trackGeometry(parts.stone), materials.stonePale);
    shrineStone.name = 'veil-shrine';
    shrineStone.castShadow = true;
    shrineStone.receiveShadow = true;
    const shrineBowl = new THREE.Mesh(trackGeometry(parts.bowl), materials.emberCyan);
    shrineBowl.name = 'veil-shrine-bowl';
    for (const mesh of [shrineStone, shrineBowl]) {
      mesh.position.set(map.shrine.x, floorHeightAt(map.shrine.x, map.shrine.z), map.shrine.z);
      root.add(mesh);
    }
    embers.push({
      position: new THREE.Vector3(map.shrine.x, 1.9, map.shrine.z),
      power: 1,
      phase: 5.9,
    });
  }

  const sealAnchors = new Map<number, THREE.Vector3>();
  for (const anchor of map.sealAnchors) {
    sealAnchors.set(
      anchor.id,
      new THREE.Vector3(anchor.x, floorHeightAt(anchor.x, anchor.z), anchor.z),
    );
  }
  {
    const ringBucket = bucketFor('runeRing/cyan', runeRing, materials.emberCyan, {
      castShadow: false,
      receiveShadow: false,
    });
    for (const id of map.activeSeals) {
      const position = sealAnchors.get(id);
      if (!position) continue;
      ringBucket.place(position.x, position.y, position.z, rng.range(0, Math.PI * 2), 1);
    }
  }

  // -------------------------------------------------------------------------
  // Atmosphere: mist, motes, crows
  // -------------------------------------------------------------------------

  const mistCount = ATMOSPHERE.mistPlanes[quality];
  if (mistCount > 0) {
    const mistBucket = bucketFor('mist/plane', unitPlaneXZ, materials.mist, {
      castShadow: false,
      receiveShadow: false,
    });
    const pooling = map.zones.filter(
      (zone) => zone.kind === 'water' || zone.kind === 'mud' || zone.kind === 'shadow',
    );
    for (let i = 0; i < mistCount; i += 1) {
      let mx: number;
      let mz: number;
      if (pooling.length > 0 && rng.bool(0.55)) {
        const zone = rng.pick(pooling);
        const angle = rng.range(0, Math.PI * 2);
        mx = zone.x + Math.cos(angle) * rng.range(0, zone.radius);
        mz = zone.z + Math.sin(angle) * rng.range(0, zone.radius);
      } else {
        mx = rng.range(-MAP_HALF + 6, MAP_HALF - 6);
        mz = rng.range(-MAP_HALF + 6, MAP_HALF - 6);
      }
      const radius = rng.range(ATMOSPHERE.mistRadius.min, ATMOSPHERE.mistRadius.max);
      mistBucket.place(
        mx,
        ATMOSPHERE.mistY + rng.range(0, 0.9),
        mz,
        rng.range(0, Math.PI * 2),
        radius * 2,
        1,
        radius * 2,
      );
    }
  }

  let motes: THREE.Points | null = null;
  const moteCount = ATMOSPHERE.moteCount[quality];
  if (moteCount > 0) {
    const geometry = trackGeometry(new THREE.BufferGeometry());
    const positions = new Float32Array(moteCount * 3);
    const seeds = new Float32Array(moteCount);
    const boxSize = ATMOSPHERE.moteBox;
    for (let i = 0; i < moteCount; i += 1) {
      positions[i * 3] = rng.range(-boxSize.x / 2, boxSize.x / 2);
      positions[i * 3 + 1] = rng.range(-boxSize.y / 2, boxSize.y / 2);
      positions[i * 3 + 2] = rng.range(-boxSize.z / 2, boxSize.z / 2);
      seeds[i] = rng();
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    materials.mote.uniforms.uBox.value = new THREE.Vector3(boxSize.x, boxSize.y, boxSize.z);
    motes = new THREE.Points(geometry, materials.mote);
    motes.name = 'veil-motes';
    motes.frustumCulled = false;
    root.add(motes);
  }

  const crows: Crow[] = [];
  let crowMesh: THREE.InstancedMesh | null = null;
  let crowFlap: THREE.InstancedBufferAttribute | null = null;
  const crowCount = ATMOSPHERE.crowCount[quality];
  if (crowCount > 0) {
    // Perch on the tallest ruins, keeping the birds spread across the map.
    const candidates = map.walls
      .filter((wall) => wall.kind !== 'boundary' && wall.base + wall.height >= 3.4)
      .map((wall) => {
        const longIsX = wall.hw >= wall.hd;
        const longHalf = longIsX ? wall.hw : wall.hd;
        const along = rng.range(-longHalf * 0.8, longHalf * 0.8);
        localToWorld(wall.x, wall.z, wall.rot, longIsX ? along : 0, longIsX ? 0 : along, SCRATCH_XZ);
        return new THREE.Vector3(
          SCRATCH_XZ.x,
          wall.base + wall.height + 0.22,
          SCRATCH_XZ.z,
        );
      });
    const chosen: THREE.Vector3[] = [];
    for (const candidate of rng.shuffle(candidates)) {
      if (chosen.length >= crowCount) break;
      if (chosen.some((other) => other.distanceTo(candidate) < 13)) continue;
      chosen.push(candidate);
    }
    while (chosen.length < crowCount && candidates.length > 0) {
      chosen.push(rng.pick(candidates).clone());
    }

    if (chosen.length > 0) {
      for (const perch of chosen) {
        crows.push({
          perch: perch.clone(),
          position: perch.clone(),
          target: perch.clone(),
          yaw: rng.range(0, Math.PI * 2),
          state: 'perched',
          timer: 0,
          phase: rng.range(0, Math.PI * 2),
          flap: 0,
          bobPhase: rng.range(0, Math.PI * 2),
        });
      }
      const geometry = trackGeometry(crow());
      const flapData = new Float32Array(crows.length * 2);
      for (let i = 0; i < crows.length; i += 1) {
        flapData[i * 2] = crows[i].phase;
        flapData[i * 2 + 1] = 0;
      }
      crowFlap = new THREE.InstancedBufferAttribute(flapData, 2);
      crowFlap.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aFlap', crowFlap);
      crowMesh = new THREE.InstancedMesh(geometry, materials.crow, crows.length);
      crowMesh.name = 'veil-crows';
      crowMesh.castShadow = false;
      crowMesh.receiveShadow = false;
      crowMesh.frustumCulled = false;
      crowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(crowMesh);
    }
  }

  // -------------------------------------------------------------------------
  // Ember point lights (the only lights besides the moon and hemisphere)
  // -------------------------------------------------------------------------

  const emberLights: THREE.PointLight[] = [];
  const emberLightCount = Math.min(LIGHTING.maxEmberLights, embers.length);
  for (let i = 0; i < emberLightCount; i += 1) {
    const light = new THREE.PointLight(
      LIGHTING.emberLightColor,
      0,
      LIGHTING.emberLightDistance,
      LIGHTING.emberLightDecay,
    );
    light.name = `veil-ember-${i}`;
    light.castShadow = false;
    emberLights.push(light);
    root.add(light);
  }

  // -------------------------------------------------------------------------
  // Materialise every bucket
  // -------------------------------------------------------------------------

  for (const record of buckets.values()) {
    const mesh = record.bucket.build(record.geometry, record.material, record.options);
    if (!mesh) continue;
    root.add(mesh);
    ownedGeometries.add(mesh.geometry);
  }
  buckets.clear();

  // -------------------------------------------------------------------------
  // Runtime
  // -------------------------------------------------------------------------

  let motionTime = 0;
  let bendStrength = 0;
  const bendPoint = new THREE.Vector2();
  const motePivot = new THREE.Vector3();
  const crowMatrix = new THREE.Matrix4();
  const crowQuat = new THREE.Quaternion();
  const crowScale = new THREE.Vector3(1, 1, 1);
  const crowPos = new THREE.Vector3();
  const crowEuler = new THREE.Euler();
  const emberOrder: number[] = embers.map((_, index) => index);

  function emberFlicker(phase: number, time: number): number {
    return (
      1 +
      (Math.sin(time * 6.2 + phase) * 0.5 +
        Math.sin(time * 11.6 + phase * 1.7) * 0.32 +
        Math.sin(time * 2.54 + phase * 0.6) * 0.18) *
        0.34
    );
  }

  function updateCrows(dt: number, reducedMotion: boolean): void {
    if (!crowMesh || !crowFlap) return;
    const speed = ATMOSPHERE.crowFlightSpeed;
    for (let i = 0; i < crows.length; i += 1) {
      const bird = crows[i];
      bird.timer -= dt;
      if (bird.state === 'perched') {
        bird.position.copy(bird.perch);
        if (!reducedMotion) {
          bird.position.y += Math.sin(motionTime * 1.6 + bird.bobPhase) * 0.035;
          bird.yaw += Math.sin(motionTime * 0.4 + bird.phase) * dt * 0.25;
        }
        bird.flap += (0 - bird.flap) * Math.min(1, dt * 4);
      } else {
        const toTarget = bird.target.clone().sub(bird.position);
        const distance = toTarget.length();
        if (distance > 0.001) {
          toTarget.multiplyScalar(1 / distance);
          const step = Math.min(distance, speed * dt);
          bird.position.addScaledVector(toTarget, step);
          bird.yaw = Math.atan2(toTarget.x, toTarget.z);
        }
        bird.flap += (1 - bird.flap) * Math.min(1, dt * 5);
        if (distance < 0.8) {
          if (bird.state === 'fleeing') {
            bird.state = 'circling';
            bird.timer = rng.range(ATMOSPHERE.crowReturnDelay.min, ATMOSPHERE.crowReturnDelay.max);
          } else if (bird.state === 'returning') {
            bird.state = 'perched';
            bird.flap = 0;
          }
        }
        if (bird.state === 'circling') {
          const orbit = motionTime * 0.5 + bird.phase;
          bird.target.set(
            bird.perch.x + Math.cos(orbit) * 16,
            bird.perch.y + 11 + Math.sin(orbit * 1.7) * 2.2,
            bird.perch.z + Math.sin(orbit) * 16,
          );
          if (bird.timer <= 0) {
            bird.state = 'returning';
            bird.target.copy(bird.perch);
          }
        }
      }

      const bank = bird.state === 'perched' ? 0 : Math.sin(motionTime * 1.7 + bird.phase) * 0.35;
      crowEuler.set(0, bird.yaw, bank);
      crowQuat.setFromEuler(crowEuler);
      crowPos.copy(bird.position);
      crowMatrix.compose(crowPos, crowQuat, crowScale);
      crowMesh.setMatrixAt(i, crowMatrix);
      crowFlap.setXY(i, bird.phase, bird.flap);
    }
    crowMesh.instanceMatrix.needsUpdate = true;
    crowFlap.needsUpdate = true;
  }

  function update(ctx: WorldUpdateContext): void {
    const dt = Math.min(0.1, Math.max(0, ctx.dt));
    const reduced = ctx.reducedMotion;
    // Reduced motion slows the clock itself rather than only damping amplitude,
    // so nothing is left vibrating in place.
    motionTime += dt * (reduced ? 0.08 : 1);

    uniforms.uTime.value = motionTime;
    uniforms.uWind.value = reduced ? WIND.reducedStrength : WIND.strength;
    uniforms.uFlicker.value = reduced ? 0.06 : 1;

    bendStrength = Math.max(0, bendStrength - dt / WIND.bendDecay);
    uniforms.uBend.value.set(bendPoint.x, 0, bendPoint.y, bendStrength);

    const density = baseFogDensity * (1 + (ATMOSPHERE.fogBoostMax - 1) * clamp(ctx.fogBoost, 0, 1));
    fog.density = density;
    uniforms.uFogDensity.value = density;

    sky.update(ctx.cameraPosition, motionTime);

    if (motes) {
      // Snap the mote volume to a coarse grid so it follows the camera without
      // the points visibly sliding relative to the world.
      motePivot.set(
        Math.round(ctx.cameraPosition.x / 6) * 6,
        Math.round(ctx.cameraPosition.y / 4) * 4 + 2,
        Math.round(ctx.cameraPosition.z / 6) * 6,
      );
      motes.position.copy(motePivot);
    }

    if (emberLights.length > 0 && embers.length > 0) {
      emberOrder.sort((a, b) => {
        const da = embers[a].position.distanceToSquared(ctx.cameraPosition);
        const db = embers[b].position.distanceToSquared(ctx.cameraPosition);
        return da - db;
      });
      for (let i = 0; i < emberLights.length; i += 1) {
        const source = embers[emberOrder[i]];
        const light = emberLights[i];
        light.position.copy(source.position);
        const distance = Math.sqrt(source.position.distanceToSquared(ctx.cameraPosition));
        const falloff = 1 - clamp((distance - 30) / 18, 0, 1);
        const flicker = reduced ? 1 : emberFlicker(source.phase, motionTime);
        light.intensity = LIGHTING.emberLightIntensity * source.power * flicker * falloff;
        light.distance = LIGHTING.emberLightDistance * source.power;
      }
    }

    updateCrows(dt, reduced);
  }

  function reactAt(x: number, z: number, strength: number): void {
    const power = clamp(strength, 0, 1);
    if (power <= 0) return;
    bendPoint.set(x, z);
    bendStrength = Math.max(bendStrength, power);
    const radiusSq = ATMOSPHERE.crowStartleRadius * ATMOSPHERE.crowStartleRadius;
    for (const bird of crows) {
      if (bird.state !== 'perched') continue;
      const dx = bird.perch.x - x;
      const dz = bird.perch.z - z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > radiusSq) continue;
      const length = Math.max(0.001, Math.sqrt(distanceSq));
      bird.state = 'fleeing';
      bird.flap = 1;
      bird.target.set(
        clamp(bird.perch.x + (dx / length) * 22, -MAP_HALF + 4, MAP_HALF - 4),
        bird.perch.y + 10 + power * 5,
        clamp(bird.perch.z + (dz / length) * 22, -MAP_HALF + 4, MAP_HALF - 4),
      );
    }
  }

  function setDoorOpen(id: number, open: number): void {
    const pivot = doorPivots.get(id);
    if (!pivot) return;
    const door = map.doors.find((candidate) => candidate.id === id);
    const closed = door ? -door.rot : 0;
    pivot.rotation.y = closed - clamp(open, 0, 1) * 1.75;
  }

  function setBarricadeBroken(id: number, broken: boolean): void {
    const mesh = barricadeMeshes.get(id);
    if (mesh) mesh.visible = !broken;
  }

  function getAnchors(): {
    seals: Map<number, THREE.Vector3>;
    gate: THREE.Vector3;
    shrine: THREE.Vector3;
  } {
    const seals = new Map<number, THREE.Vector3>();
    for (const [id, position] of sealAnchors) seals.set(id, position.clone());
    return {
      seals,
      gate: new THREE.Vector3(map.gate.x, floorHeightAt(map.gate.x, map.gate.z), map.gate.z),
      shrine: new THREE.Vector3(
        map.shrine.x,
        floorHeightAt(map.shrine.x, map.shrine.z) + 1.6,
        map.shrine.z,
      ),
    };
  }

  /**
   * Counts the colour pass plus the shadow pass, so the estimate lines up with
   * what `renderer.info.render.calls` will actually report.
   */
  function describe(): WorldDiagnostics {
    let drawCallEstimate = 0;
    let triangles = 0;
    let instancedMeshes = 0;
    root.traverse((object) => {
      if (object instanceof THREE.Points) {
        drawCallEstimate += 1;
        return;
      }
      if (!(object instanceof THREE.Mesh)) return;
      drawCallEstimate += object.castShadow ? 2 : 1;
      const geometry = object.geometry;
      const index = geometry.getIndex();
      const positions = geometry.getAttribute('position');
      const vertexCount = index ? index.count : positions ? positions.count : 0;
      const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
      if (object instanceof THREE.InstancedMesh) instancedMeshes += 1;
      triangles += Math.floor(vertexCount / 3) * instances;
    });
    return {
      drawCallEstimate,
      triangles,
      instancedMeshes,
      materials: materials.all.length,
      textures: textures.all.length,
    };
  }

  function dispose(): void {
    sky.dispose();
    root.remove(sky.group);
    for (const light of emberLights) light.dispose();
    moon.shadow.dispose();
    moon.dispose();
    hemisphere.dispose();
    for (const geometry of ownedGeometries) geometry.dispose();
    ownedGeometries.clear();
    materials.dispose();
    textures.dispose();
    crows.length = 0;
    doorPivots.clear();
    barricadeMeshes.clear();
    sealAnchors.clear();
    root.clear();
  }

  return {
    root,
    moon,
    fog,
    update,
    reactAt,
    dispose,
    setDoorOpen,
    setBarricadeBroken,
    getAnchors,
    describe,
  };
}
