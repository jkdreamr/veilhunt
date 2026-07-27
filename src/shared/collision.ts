/**
 * Collision and visibility queries against the static map. Pure functions with
 * no allocations in the hot path — the server runs these 30 times a second for
 * both players and the client runs them again for prediction.
 */

import type {
  CrouchGate,
  MapData,
  Platform,
  Ramp,
  VaultBox,
  WallBox,
  Zone,
  ZoneKind,
} from './types.js';
import { MAP_HALF, PLAYER_RADIUS, STEP_UP_HEIGHT, VAULT_MAX_HEIGHT } from './constants.js';

export interface DynamicBlocker {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  base: number;
  height: number;
  opaque: boolean;
}

/** Everything a movement step needs to know about the world at this instant. */
export interface CollisionWorld {
  map: MapData;
  /** Barricades that are still intact, plus closed doors. */
  dynamic: DynamicBlocker[];
}

const EPS = 1e-6;

function rotateInto(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  rot: number,
  out: { x: number; z: number },
): void {
  const dx = px - cx;
  const dz = pz - cz;
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
}

const localPoint = { x: 0, z: 0 };

/** Squared distance from a point to an oriented box, in the box's own frame. */
function boxDistanceSq(
  px: number,
  pz: number,
  bx: number,
  bz: number,
  hw: number,
  hd: number,
  rot: number,
): number {
  rotateInto(px, pz, bx, bz, rot, localPoint);
  const dx = Math.max(Math.abs(localPoint.x) - hw, 0);
  const dz = Math.max(Math.abs(localPoint.z) - hd, 0);
  return dx * dx + dz * dz;
}

export function pointInBox(
  px: number,
  pz: number,
  bx: number,
  bz: number,
  hw: number,
  hd: number,
  rot: number,
): boolean {
  rotateInto(px, pz, bx, bz, rot, localPoint);
  return Math.abs(localPoint.x) <= hw && Math.abs(localPoint.z) <= hd;
}

export function circleIntersectsBox(
  px: number,
  pz: number,
  radius: number,
  bx: number,
  bz: number,
  hw: number,
  hd: number,
  rot: number,
): boolean {
  return boxDistanceSq(px, pz, bx, bz, hw, hd, rot) < radius * radius;
}

/**
 * Pushes a circle out of an oriented box along the shallowest axis. Returns the
 * corrected position, or null when there was no overlap.
 */
export function resolveCircleBox(
  px: number,
  pz: number,
  radius: number,
  bx: number,
  bz: number,
  hw: number,
  hd: number,
  rot: number,
  out: { x: number; z: number },
): boolean {
  rotateInto(px, pz, bx, bz, rot, localPoint);
  const lx = localPoint.x;
  const lz = localPoint.z;
  const cx = Math.max(-hw, Math.min(hw, lx));
  const cz = Math.max(-hd, Math.min(hd, lz));
  let nx = lx - cx;
  let nz = lz - cz;
  const distSq = nx * nx + nz * nz;

  if (distSq > radius * radius) return false;

  if (distSq > EPS) {
    const dist = Math.sqrt(distSq);
    const push = radius - dist;
    nx = (nx / dist) * push;
    nz = (nz / dist) * push;
  } else {
    // Centre is inside the box: escape along the shallowest face.
    const overlapX = hw + radius - Math.abs(lx);
    const overlapZ = hd + radius - Math.abs(lz);
    if (overlapX < overlapZ) {
      nx = lx >= 0 ? overlapX : -overlapX;
      nz = 0;
    } else {
      nx = 0;
      nz = lz >= 0 ? overlapZ : -overlapZ;
    }
  }

  const c = Math.cos(rot);
  const s = Math.sin(rot);
  out.x = px + (nx * c - nz * s);
  out.z = pz + (nx * s + nz * c);
  return true;
}

// ---------------------------------------------------------------------------
// Floor sampling
// ---------------------------------------------------------------------------

export function floorHeightAt(map: MapData, x: number, z: number): number {
  let best = 0;
  for (let i = 0; i < map.platforms.length; i += 1) {
    const p: Platform = map.platforms[i];
    if (
      x >= p.x - p.hw &&
      x <= p.x + p.hw &&
      z >= p.z - p.hd &&
      z <= p.z + p.hd &&
      p.height > best
    ) {
      best = p.height;
    }
  }
  for (let i = 0; i < map.ramps.length; i += 1) {
    const r: Ramp = map.ramps[i];
    rotateInto(x, z, r.x, r.z, r.rot, localPoint);
    if (Math.abs(localPoint.x) <= r.hw && Math.abs(localPoint.z) <= r.hd) {
      const t = (localPoint.x + r.hw) / (2 * r.hw);
      const h = r.height0 + (r.height1 - r.height0) * t;
      if (h > best) best = h;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Movement collision
// ---------------------------------------------------------------------------

export interface CollideOptions {
  radius: number;
  /** Feet height; a wall only blocks when it straddles this height. */
  feetY: number;
  /** Standing head height above feet. */
  standHeight: number;
  crouching: boolean;
  /** Vaulting players pass over low obstacles. */
  airborne: boolean;
}

const resolved = { x: 0, z: 0 };

/**
 * Slides a circle through the static world, resolving each blocker once. Called
 * with the already-integrated position; returns the corrected position.
 */
export function collideWorld(
  world: CollisionWorld,
  x: number,
  z: number,
  opts: CollideOptions,
): { x: number; z: number } {
  let px = x;
  let pz = z;
  const map = world.map;
  const feetTop = opts.feetY + opts.standHeight;

  // Two relaxation passes handle corners without exploding the cost.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < map.walls.length; i += 1) {
      const w: WallBox = map.walls[i];
      const top = w.base + w.height;
      if (top <= opts.feetY + 0.05 || w.base >= feetTop) continue;
      if (resolveCircleBox(px, pz, opts.radius, w.x, w.z, w.hw, w.hd, w.rot, resolved)) {
        px = resolved.x;
        pz = resolved.z;
      }
    }

    for (let i = 0; i < map.vaults.length; i += 1) {
      const v: VaultBox = map.vaults[i];
      // Airborne players clear low obstacles; grounded players are stopped.
      if (opts.airborne && opts.feetY >= v.height - 0.25) continue;
      if (opts.feetY >= v.height - 0.02) continue;
      if (resolveCircleBox(px, pz, opts.radius, v.x, v.z, v.hw, v.hd, v.rot, resolved)) {
        px = resolved.x;
        pz = resolved.z;
      }
    }

    for (let i = 0; i < map.crouchGates.length; i += 1) {
      const g: CrouchGate = map.crouchGates[i];
      if (opts.crouching) continue;
      if (resolveCircleBox(px, pz, opts.radius, g.x, g.z, g.hw, g.hd, g.rot, resolved)) {
        px = resolved.x;
        pz = resolved.z;
      }
    }

    for (let i = 0; i < world.dynamic.length; i += 1) {
      const d = world.dynamic[i];
      const top = d.base + d.height;
      if (top <= opts.feetY + 0.05 || d.base >= feetTop) continue;
      if (resolveCircleBox(px, pz, opts.radius, d.x, d.z, d.hw, d.hd, d.rot, resolved)) {
        px = resolved.x;
        pz = resolved.z;
      }
    }
  }

  // Hard playfield boundary — the player can never leave the map.
  const limit = MAP_HALF - opts.radius - 0.2;
  if (px < -limit) px = -limit;
  if (px > limit) px = limit;
  if (pz < -limit) pz = -limit;
  if (pz > limit) pz = limit;

  return { x: px, z: pz };
}

/** True when a vaultable obstacle is within reach in front of the player. */
export function findVaultTarget(
  world: CollisionWorld,
  x: number,
  z: number,
  yaw: number,
  feetY: number,
): VaultBox | null {
  const probeDist = PLAYER_RADIUS + 0.85;
  const px = x + Math.sin(yaw) * probeDist;
  const pz = z + Math.cos(yaw) * probeDist;
  const map = world.map;
  for (let i = 0; i < map.vaults.length; i += 1) {
    const v = map.vaults[i];
    if (v.height > VAULT_MAX_HEIGHT + feetY) continue;
    if (v.height <= feetY + STEP_UP_HEIGHT) continue;
    if (circleIntersectsBox(px, pz, PLAYER_RADIUS + 0.15, v.x, v.z, v.hw, v.hd, v.rot)) {
      return v;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line of sight
// ---------------------------------------------------------------------------

/** Slab test: does the segment (ax,az)->(bx,bz) cross this oriented box? */
function segmentHitsBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  hw: number,
  hd: number,
  rot: number,
): boolean {
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const a0x = (ax - cx) * c - (az - cz) * s;
  const a0z = (ax - cx) * s + (az - cz) * c;
  const b0x = (bx - cx) * c - (bz - cz) * s;
  const b0z = (bx - cx) * s + (bz - cz) * c;

  const dx = b0x - a0x;
  const dz = b0z - a0z;
  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) < EPS) {
    if (a0x < -hw || a0x > hw) return false;
  } else {
    let t1 = (-hw - a0x) / dx;
    let t2 = (hw - a0x) / dx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  if (Math.abs(dz) < EPS) {
    if (a0z < -hd || a0z > hd) return false;
  } else {
    let t1 = (-hd - a0z) / dz;
    let t2 = (hd - a0z) / dz;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  return true;
}

/**
 * Sight test between two eye points. `eyeY` values are absolute world heights;
 * a wall only blocks when it spans the lower of the two eye heights, which keeps
 * the watchtower balcony able to see over low ruins.
 */
export function hasLineOfSight(
  world: CollisionWorld,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  const map = world.map;
  const lowEye = Math.min(ay, by);
  for (let i = 0; i < map.walls.length; i += 1) {
    const w = map.walls[i];
    if (!w.opaque) continue;
    const top = w.base + w.height;
    if (top <= lowEye || w.base >= Math.max(ay, by)) continue;
    if (segmentHitsBox(ax, az, bx, bz, w.x, w.z, w.hw, w.hd, w.rot)) return false;
  }
  for (let i = 0; i < world.dynamic.length; i += 1) {
    const d = world.dynamic[i];
    if (!d.opaque) continue;
    const top = d.base + d.height;
    if (top <= lowEye || d.base >= Math.max(ay, by)) continue;
    if (segmentHitsBox(ax, az, bx, bz, d.x, d.z, d.hw, d.hd, d.rot)) return false;
  }
  return true;
}

/** Blade / interaction reach test: short segment that must not cross a wall. */
export function canReach(
  world: CollisionWorld,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  maxRange: number,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  if (dx * dx + dz * dz > maxRange * maxRange) return false;
  return hasLineOfSight(world, ax, ay, az, bx, by, bz);
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export function zoneAt(map: MapData, x: number, z: number, kind: ZoneKind): Zone | null {
  for (let i = 0; i < map.zones.length; i += 1) {
    const zone = map.zones[i];
    if (zone.kind !== kind) continue;
    const dx = x - zone.x;
    const dz = z - zone.z;
    if (dx * dx + dz * dz <= zone.radius * zone.radius) return zone;
  }
  return null;
}

export function surfaceAt(map: MapData, x: number, z: number): 'stone' | 'dirt' | 'water' | 'grass' {
  if (zoneAt(map, x, z, 'water')) return 'water';
  if (zoneAt(map, x, z, 'foliage')) return 'grass';
  if (zoneAt(map, x, z, 'mud')) return 'dirt';
  return 'stone';
}

/** Nearest hiding spot the player is standing inside, if any. */
export function hideSpotAt(map: MapData, x: number, z: number): number {
  for (let i = 0; i < map.hideSpots.length; i += 1) {
    const spot = map.hideSpots[i];
    const dx = x - spot.x;
    const dz = z - spot.z;
    if (dx * dx + dz * dz <= 0.95 * 0.95) return spot.id;
  }
  return -1;
}
