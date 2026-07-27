/**
 * Low-poly prop geometry and the instancing helper every builder uses.
 *
 * Every factory returns a `BufferGeometry` authored in a canonical local frame:
 * origin on the ground at the prop's centre, +Y up, +Z forward, roughly one
 * world unit per unit of `PropInstance.scale`. Nothing here touches a renderer
 * or a WebGL context, so the whole world can be constructed headless.
 *
 * Geometry is deliberately faceted (`faceted()` splits shared vertices and
 * recomputes flat normals) — the moonlight reads as crisp planes rather than
 * mushy gradients, which is what sells the stylised look at this poly count.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Rng } from '../../shared/rng.js';

type Vec3Tuple = [number, number, number];

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Axis-aligned box whose *base* sits at `y`, centred on (x, z). */
export function box(
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y + h / 2, z);
  return geometry;
}

/** Cylinder whose base sits at `y`. */
export function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  segments: number,
  x = 0,
  y = 0,
  z = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1);
  geometry.translate(x, y + h / 2, z);
  return geometry;
}

/**
 * Merges parts into one geometry and disposes the sources.
 *
 * `mergeGeometries` refuses a mix of indexed and non-indexed inputs, and the
 * polyhedra (`OctahedronGeometry`, `DodecahedronGeometry`) are non-indexed
 * while everything else is indexed. Rather than making every caller care, the
 * whole set is flattened to non-indexed when the inputs disagree.
 */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const indexedCount = parts.reduce((sum, part) => sum + (part.index ? 1 : 0), 0);
  const mixed = indexedCount > 0 && indexedCount < parts.length;
  const inputs = mixed ? parts.map((part) => (part.index ? part.toNonIndexed() : part)) : parts;
  const merged = mergeGeometries(inputs, false);
  if (mixed) {
    for (let i = 0; i < inputs.length; i += 1) {
      if (inputs[i] !== parts[i]) inputs[i].dispose();
    }
  }
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('veil-world: geometry merge failed');
  return merged;
}

/** Splits shared vertices so each face gets its own flat normal. */
export function faceted(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.index) {
    geometry.computeVertexNormals();
    return geometry;
  }
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeVertexNormals();
  return flat;
}

/** Adds a constant per-vertex attribute so parts can be merged and still differ. */
export function tagAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  value: number,
): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const array = new Float32Array(count);
  array.fill(value);
  geometry.setAttribute(name, new THREE.BufferAttribute(array, 1));
  return geometry;
}

/** Hand-rolled triangle soup, for shapes the primitives cannot express. */
class Soup {
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];

  tri(a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple): void {
    this.pos.push(...a, ...b, ...c);
    this.uv.push(0, 0, 1, 0, 1, 1);
  }

  quad(a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple, d: Vec3Tuple): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.computeVertexNormals();
    return geometry;
  }
}

// ---------------------------------------------------------------------------
// Unit geometry used with per-instance scaling
// ---------------------------------------------------------------------------

/** 1x1x1 box, base at y=0, centred in XZ. Scale by (2hw, height, 2hd). */
export function unitBox(): THREE.BufferGeometry {
  return box(1, 1, 1);
}

/** 1x1 quad lying in the XZ plane, normal +Y. */
export function unitPlaneXZ(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * Ramp wedge: top surface climbs from y=0 at local -X to y=1 at local +X, with
 * a deep skirt so the underside never floats when the ramp starts above ground.
 */
export function unitWedge(): THREE.BufferGeometry {
  const s = new Soup();
  const skirt = -1;
  const a: Vec3Tuple = [-0.5, 0, -0.5];
  const b: Vec3Tuple = [0.5, 1, -0.5];
  const c: Vec3Tuple = [0.5, 1, 0.5];
  const d: Vec3Tuple = [-0.5, 0, 0.5];
  const a2: Vec3Tuple = [-0.5, skirt, -0.5];
  const b2: Vec3Tuple = [0.5, skirt, -0.5];
  const c2: Vec3Tuple = [0.5, skirt, 0.5];
  const d2: Vec3Tuple = [-0.5, skirt, 0.5];
  s.quad(a, d, c, b); // walking surface
  s.quad(a2, b2, c2, d2); // underside
  s.quad(a, b, b2, a2); // -Z flank
  s.quad(c, d, d2, c2); // +Z flank
  s.quad(b, c, c2, b2); // high end
  s.quad(d, a, a2, d2); // low end
  return s.build();
}

/**
 * Recessed arched window panel. Unit shape: x in [-0.5, 0.5], y in [0, 1],
 * z in [-0.5, 0.5]. Scale z past the host wall so both faces read as inset.
 */
export function archPanel(): THREE.BufferGeometry {
  const s = new Soup();
  const sill = 0.62;
  const steps = 7;
  const front = 0.5;
  const back = -0.5;
  // Sill block.
  s.quad([-0.5, 0, front], [0.5, 0, front], [0.5, sill, front], [-0.5, sill, front]);
  s.quad([0.5, 0, back], [-0.5, 0, back], [-0.5, sill, back], [0.5, sill, back]);
  // Semicircular head, fanned from the springing line.
  for (let i = 0; i < steps; i += 1) {
    const t0 = (i / steps) * Math.PI;
    const t1 = ((i + 1) / steps) * Math.PI;
    const x0 = Math.cos(t0) * -0.5;
    const y0 = sill + Math.sin(t0) * (1 - sill);
    const x1 = Math.cos(t1) * -0.5;
    const y1 = sill + Math.sin(t1) * (1 - sill);
    s.tri([x1, y1, front], [x0, y0, front], [0, sill, front]);
    s.tri([x0, y0, back], [x1, y1, back], [0, sill, back]);
  }
  return s.build();
}

/**
 * Stepped buttress standing off a wall face along +Z. Unit height and unit
 * width so it can be scaled to any wall; built from stacked boxes so the solid
 * stays watertight and the set-backs catch a hard moonlit edge.
 */
export function buttress(): THREE.BufferGeometry {
  return faceted(
    merge([
      box(1, 0.21, 1, 0, 0, 0.5),
      box(0.86, 0.15, 0.78, 0, 0.21, 0.39),
      box(0.74, 0.14, 0.56, 0, 0.36, 0.28),
      box(0.62, 0.5, 0.34, 0, 0.5, 0.17),
    ]),
  );
}

/** Jagged block for the broken tops of ruined walls. */
export function crenel(rng: Rng): THREE.BufferGeometry {
  const s = new Soup();
  const hx = 0.5;
  const hz = 0.5;
  const corners: Vec3Tuple[] = [
    [-hx, 0, -hz],
    [hx, 0, -hz],
    [hx, 0, hz],
    [-hx, 0, hz],
  ];
  const tops: Vec3Tuple[] = corners.map((c) => [
    c[0] * rng.range(0.82, 1.02),
    rng.range(0.45, 1),
    c[2] * rng.range(0.82, 1.02),
  ]);
  s.quad(tops[0], tops[3], tops[2], tops[1]);
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    s.quad(corners[j], corners[i], tops[i], tops[j]);
  }
  return s.build();
}

// ---------------------------------------------------------------------------
// Gravestones
// ---------------------------------------------------------------------------

export function gravestoneSlab(rng: Rng): THREE.BufferGeometry {
  const w = rng.range(0.62, 0.82);
  const h = rng.range(0.85, 1.15);
  const parts = [
    box(w + 0.22, 0.14, 0.42, 0, 0, 0),
    box(w, h, 0.16, 0, 0.1, 0),
    box(w * 0.72, 0.12, 0.2, 0, 0.1 + h - 0.02, 0),
  ];
  return faceted(merge(parts));
}

export function gravestoneCross(rng: Rng): THREE.BufferGeometry {
  const h = rng.range(1.15, 1.5);
  const parts = [
    box(0.62, 0.16, 0.42),
    box(0.2, h, 0.16, 0, 0.12, 0),
    box(0.72, 0.18, 0.15, 0, 0.12 + h * 0.66, 0),
  ];
  return faceted(merge(parts));
}

export function gravestoneObelisk(rng: Rng): THREE.BufferGeometry {
  const h = rng.range(1.5, 2.1);
  const parts = [
    box(0.66, 0.18, 0.66),
    box(0.5, 0.16, 0.5, 0, 0.18),
    cyl(0.17, 0.24, h, 4, 0, 0.34),
    cyl(0.02, 0.19, 0.3, 4, 0, 0.34 + h),
  ];
  return faceted(merge(parts));
}

// ---------------------------------------------------------------------------
// Architecture fragments
// ---------------------------------------------------------------------------

/**
 * Broken column top. Mapgen places `pillar` props at the height of a chapel
 * column, so this is a capital plus a fractured stump, not a whole shaft.
 */
export function pillarTop(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    cyl(0.62, 0.6, 0.45, 10, 0, -0.45),
    box(1.5, 0.18, 1.5, 0, 0),
    box(1.28, 0.14, 1.28, 0, 0.18),
  ];
  // Fractured stump: three leaning shards of decreasing height.
  const shards = 3;
  for (let i = 0; i < shards; i += 1) {
    const angle = (i / shards) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const h = rng.range(0.35, 1.05);
    const shard = box(rng.range(0.3, 0.5), h, rng.range(0.3, 0.5));
    shard.rotateZ(rng.range(-0.16, 0.16));
    shard.rotateY(angle);
    shard.translate(Math.cos(angle) * 0.3, 0.32, Math.sin(angle) * 0.3);
    parts.push(shard);
  }
  return faceted(merge(parts));
}

/** Springer + voussoirs: an arch fragment that dies away mid-span. */
export function archStone(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(2.15, 0.36, 2.15, 0, 0),
    box(1.85, 0.22, 1.85, 0, 0.36),
  ];
  const radius = 1.95;
  const blocks = rng.int(4, 6);
  for (let i = 0; i < blocks; i += 1) {
    const angle = 0.18 + (i / 7) * (Math.PI / 2);
    const block = box(0.88, 0.78, 1.4);
    block.translate(0, -0.39, 0);
    block.rotateZ(-angle);
    block.translate(radius * (1 - Math.cos(angle)) - 0.15, 0.58 + radius * Math.sin(angle), 0);
    parts.push(block);
  }
  return faceted(merge(parts));
}

/**
 * Hooded figure: robe cone, shoulders, an overhanging cowl and a head pushed
 * back inside it so the face reads as a void. Every part is rotated at the
 * origin before being translated, so the poses stay where they are authored.
 */
export function statue(): THREE.BufferGeometry {
  const plinth = box(1.05, 0.28, 1.05);
  const robe = new THREE.ConeGeometry(0.56, 1.5, 8, 1);
  robe.translate(0, 0.28 + 0.75, 0);
  const shoulders = cyl(0.34, 0.42, 0.32, 8, 0, 1.5);
  const head = new THREE.SphereGeometry(0.19, 8, 6);
  head.translate(0, 1.92, -0.06);
  const cowl = new THREE.ConeGeometry(0.33, 0.62, 8, 1, true);
  cowl.rotateX(0.16);
  cowl.translate(0, 2.02, 0.02);
  const armL = box(0.13, 0.72, 0.13, 0, -0.36, 0);
  armL.rotateZ(-0.16);
  armL.translate(-0.34, 1.46, 0.1);
  const armR = box(0.13, 0.72, 0.13, 0, -0.36, 0);
  armR.rotateZ(0.16);
  armR.translate(0.34, 1.46, 0.1);
  return faceted(merge([plinth, robe, shoulders, head, cowl, armL, armR]));
}

// ---------------------------------------------------------------------------
// Light sources
// ---------------------------------------------------------------------------

export function brazierBowl(): THREE.BufferGeometry {
  return faceted(merge([cyl(0.52, 0.3, 0.34, 10, 0, 0.72), cyl(0.56, 0.5, 0.08, 10, 0, 1.04)]));
}

export function brazierLegs(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [cyl(0.16, 0.3, 0.12, 8)];
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2;
    const leg = box(0.09, 0.78, 0.09);
    leg.rotateX(0.16);
    leg.rotateY(angle);
    leg.translate(Math.cos(angle) * 0.2, 0.06, Math.sin(angle) * 0.2);
    parts.push(leg);
  }
  return faceted(merge(parts));
}

export function brazierCoals(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [cyl(0.42, 0.34, 0.1, 10, 0, 0.94)];
  for (let i = 0; i < 6; i += 1) {
    const angle = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 0.28);
    const coal = new THREE.OctahedronGeometry(rng.range(0.07, 0.14), 0);
    coal.translate(Math.cos(angle) * r, 1.0 + rng.range(0, 0.09), Math.sin(angle) * r);
    parts.push(coal);
  }
  return faceted(merge(parts));
}

/** Iron lantern cage hanging from a bracket; glass is a separate emissive part. */
export function lanternFrame(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(0.07, 0.34, 0.07, 0, -0.02),
    cyl(0.035, 0.035, 0.14, 6, 0, 0.24),
    box(0.3, 0.07, 0.3, 0, -0.44),
    box(0.34, 0.09, 0.34, 0, -0.06),
  ];
  for (let i = 0; i < 4; i += 1) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push(box(0.05, 0.4, 0.05, Math.cos(angle) * 0.14, -0.44, Math.sin(angle) * 0.14));
  }
  const cap = new THREE.ConeGeometry(0.27, 0.19, 4, 1);
  cap.rotateY(Math.PI / 4);
  cap.translate(0, 0.06, 0);
  parts.push(cap);
  // The origin sits at the hanging point so props anchor at their stated `y`.
  return faceted(merge(parts));
}

export function lanternGlass(): THREE.BufferGeometry {
  const glass = new THREE.BoxGeometry(0.26, 0.36, 0.26);
  glass.translate(0, -0.26, 0);
  return faceted(glass);
}

/**
 * Iron post carrying a lantern that has no wall to hang from. Unit height,
 * base at y=0, so it can be stretched from the ground up to the lamp.
 */
export function lanternPost(): THREE.BufferGeometry {
  return faceted(
    merge([
      cyl(0.17, 0.26, 0.09, 8),
      cyl(0.12, 0.17, 0.08, 8, 0, 0.09),
      cyl(0.05, 0.1, 0.83, 6, 0, 0.17),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Small scatter props
// ---------------------------------------------------------------------------

export function urn(): THREE.BufferGeometry {
  return faceted(
    merge([
      cyl(0.2, 0.26, 0.1, 8),
      cyl(0.34, 0.2, 0.34, 8, 0, 0.1),
      cyl(0.22, 0.34, 0.3, 8, 0, 0.44),
      cyl(0.27, 0.21, 0.09, 8, 0, 0.74),
    ]),
  );
}

export function bench(): THREE.BufferGeometry {
  return faceted(
    merge([
      box(0.34, 0.44, 0.42, -0.72, 0),
      box(0.34, 0.44, 0.42, 0.72, 0),
      box(2, 0.16, 0.56, 0, 0.44),
      box(1.9, 0.09, 0.12, 0, 0.6, -0.2),
    ]),
  );
}

export function rubblePile(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const chunks = rng.int(5, 8);
  for (let i = 0; i < chunks; i += 1) {
    const size = rng.range(0.22, 0.62);
    const chunk = box(size, size * rng.range(0.5, 0.95), size * rng.range(0.7, 1.2));
    chunk.rotateY(rng.range(0, Math.PI * 2));
    chunk.rotateZ(rng.range(-0.4, 0.4));
    chunk.rotateX(rng.range(-0.35, 0.35));
    const angle = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 0.55);
    chunk.translate(Math.cos(angle) * r, rng.range(-0.06, 0.22), Math.sin(angle) * r);
    parts.push(chunk);
  }
  return faceted(merge(parts));
}

export function root(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const arms = rng.int(3, 5);
  for (let i = 0; i < arms; i += 1) {
    const angle = (i / arms) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const segments = rng.int(2, 4);
    let radius = rng.range(0.12, 0.2);
    let x = 0;
    let z = 0;
    let y = 0.02;
    for (let s = 0; s < segments; s += 1) {
      const len = rng.range(0.32, 0.6);
      const nx = x + Math.cos(angle) * len;
      const nz = z + Math.sin(angle) * len;
      const ny = y + (s === 0 ? rng.range(0.05, 0.2) : rng.range(-0.14, 0.02));
      const seg = box(len * 1.12, radius, radius);
      seg.rotateZ(Math.atan2(ny - y, len) * 0.9);
      seg.rotateY(-angle);
      seg.translate((x + nx) / 2, (y + ny) / 2, (z + nz) / 2);
      parts.push(seg);
      x = nx;
      z = nz;
      y = Math.max(0, ny);
      radius *= 0.78;
    }
  }
  return faceted(merge(parts));
}

/** Hanging bone-and-bead charm. Anchors at y=0 and dangles to y=-1.6. */
export function charmCluster(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [box(0.06, 0.12, 0.06, 0, -0.12)];
  const strands = 5;
  for (let i = 0; i < strands; i += 1) {
    const angle = (i / strands) * Math.PI * 2;
    const spread = rng.range(0.1, 0.3);
    const dx = Math.cos(angle) * spread;
    const dz = Math.sin(angle) * spread;
    const drop = rng.range(0.7, 1.45);
    const cord = box(0.03, drop, 0.03, dx, -0.12 - drop, dz);
    parts.push(cord);
    const beads = rng.int(2, 4);
    for (let bIdx = 0; bIdx < beads; bIdx += 1) {
      const t = (bIdx + 1) / (beads + 1);
      const bead = new THREE.OctahedronGeometry(rng.range(0.05, 0.09), 0);
      bead.translate(dx, -0.12 - drop * t, dz);
      parts.push(bead);
    }
    const bone = box(0.06, rng.range(0.18, 0.3), 0.06, dx, -0.12 - drop - 0.02, dz);
    parts.push(bone);
  }
  return faceted(merge(parts));
}

/** Three crossed alpha-cut cards, base at y=0, one unit tall at scale 1. */
export function grassCard(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i += 1) {
    const plane = new THREE.PlaneGeometry(0.85, 1, 1, 2);
    plane.translate(0, 0.5, 0);
    plane.rotateY((i / 3) * Math.PI);
    parts.push(plane);
  }
  return merge(parts);
}

/** Eight tris is all a half-buried stone the size of a fist ever needs. */
export function pebble(rng: Rng): THREE.BufferGeometry {
  const geometry = new THREE.OctahedronGeometry(0.5, 0);
  geometry.scale(rng.range(0.8, 1.3), rng.range(0.4, 0.7), rng.range(0.8, 1.3));
  geometry.translate(0, 0.1, 0);
  return faceted(geometry);
}

// ---------------------------------------------------------------------------
// Vaultable obstacles: all read at waist height with a clear top edge
// ---------------------------------------------------------------------------

/** Single iron post, base at y=0, unit height. Scale Y to the rail height. */
export function railPost(): THREE.BufferGeometry {
  const parts = [
    box(0.14, 0.06, 0.14),
    box(0.075, 0.94, 0.075, 0, 0.04),
    new THREE.OctahedronGeometry(0.07, 0).translate(0, 0.99, 0),
  ];
  return faceted(merge(parts));
}

/** Horizontal rail spanning one unit of length along local X. */
export function railBar(): THREE.BufferGeometry {
  return faceted(box(1, 0.07, 0.07));
}

/** Stone slab tomb: plinth plus a slightly proud lid with a clear lip. */
export function tomb(): THREE.BufferGeometry {
  return faceted(
    merge([box(1, 0.78, 1, 0, 0), box(1.14, 0.16, 1.14, 0, 0.78), box(0.86, 0.06, 0.86, 0, 0.94)]),
  );
}

/** Collapsed handcart: bed, broken shafts and one surviving wheel. */
export function cart(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [box(1.9, 0.16, 1.05, 0, 0.72)];
  for (let i = 0; i < 5; i += 1) {
    const plank = box(1.86, 0.1, 0.16, 0, 0.86, -0.44 + i * 0.22);
    plank.rotateZ(rng.range(-0.05, 0.05));
    parts.push(plank);
  }
  parts.push(box(1.9, 0.4, 0.1, 0, 0.88, -0.52));
  parts.push(box(0.14, 0.72, 0.14, -0.78, 0));
  parts.push(box(0.14, 0.72, 0.14, 0.78, 0));
  const shaft = box(1.1, 0.11, 0.11, 1.3, 0.66);
  shaft.rotateZ(0.22);
  parts.push(shaft);
  // The wheel lies in the YZ plane, so its spokes rotate about X.
  const wheel = new THREE.TorusGeometry(0.44, 0.08, 5, 10);
  wheel.rotateY(Math.PI / 2);
  wheel.translate(-0.92, 0.44, 0.5);
  parts.push(wheel);
  for (let i = 0; i < 4; i += 1) {
    const spoke = box(0.05, 0.86, 0.05, 0, -0.43, 0);
    spoke.rotateX((i / 4) * Math.PI);
    spoke.translate(-0.92, 0.44, 0.5);
    parts.push(spoke);
  }
  return faceted(merge(parts));
}

/** Fallen log lying along local X, with a couple of snapped branches. */
export function log(rng: Rng): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.44, 0.5, 2, 8, 1);
  trunk.rotateZ(Math.PI / 2);
  trunk.translate(0, 0.48, 0);
  const parts: THREE.BufferGeometry[] = [trunk];
  for (let i = 0; i < 3; i += 1) {
    const branch = new THREE.CylinderGeometry(0.07, 0.13, rng.range(0.4, 0.8), 5, 1);
    branch.translate(0, rng.range(0.2, 0.4), 0);
    branch.rotateZ(rng.range(-0.7, 0.7));
    branch.rotateX(rng.range(-1, 1));
    branch.translate(rng.range(-0.7, 0.7), 0.7, rng.range(-0.2, 0.2));
    parts.push(branch);
  }
  return faceted(merge(parts));
}

/** Low broken wall: unit footprint, waist-high, with an uneven crest. */
export function lowWall(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [box(1, 0.78, 1, 0, 0)];
  const blocks = 5;
  for (let i = 0; i < blocks; i += 1) {
    const h = rng.range(0.06, 0.26);
    const block = box(1 / blocks + 0.02, h, rng.range(0.85, 1.05), -0.5 + (i + 0.5) / blocks, 0.78);
    parts.push(block);
  }
  return faceted(merge(parts));
}

// ---------------------------------------------------------------------------
// Interactables
// ---------------------------------------------------------------------------

/** Door panel hinged at local x=0, swinging out along +X. */
export function doorPanel(width: number, height: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const planks = 4;
  for (let i = 0; i < planks; i += 1) {
    const w = width / planks;
    parts.push(box(w * 0.94, height, 0.12, w * (i + 0.5), 0));
  }
  parts.push(box(width, 0.11, 0.17, width / 2, height * 0.18));
  parts.push(box(width, 0.11, 0.17, width / 2, height * 0.74));
  parts.push(box(0.14, height, 0.19, 0.07, 0));
  return faceted(merge(parts));
}

/** Planks nailed across an opening. Unit footprint; scale to the barricade box. */
export function barricadePlanks(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(0.14, 2.2, 0.3, -0.46, 0),
    box(0.14, 2.2, 0.3, 0.46, 0),
  ];
  const planks = rng.int(5, 7);
  for (let i = 0; i < planks; i += 1) {
    const y = 0.25 + (i / planks) * 1.7;
    const plank = box(1.04, 0.2, 0.16, 0, y);
    plank.rotateZ(rng.range(-0.13, 0.13));
    parts.push(plank);
  }
  const brace = box(1.25, 0.18, 0.14, 0, 1.05);
  brace.rotateZ(0.72);
  parts.push(brace);
  return faceted(merge(parts));
}

export function wardrobe(): THREE.BufferGeometry {
  return faceted(
    merge([
      box(1.5, 0.14, 0.82),
      box(1.42, 1.95, 0.74, 0, 0.14),
      box(0.66, 1.7, 0.09, -0.36, 0.26, 0.38),
      box(0.66, 1.7, 0.09, 0.36, 0.26, 0.38),
      box(1.62, 0.16, 0.94, 0, 2.09),
      box(0.09, 0.09, 0.09, -0.06, 1.05, 0.45),
      box(0.09, 0.09, 0.09, 0.06, 1.05, 0.45),
    ]),
  );
}

/** Recessed niche in a wall: jambs, a lintel and a shadowed back panel. */
export function alcove(): THREE.BufferGeometry {
  return faceted(
    merge([
      box(0.34, 2.4, 0.9, -0.9, 0),
      box(0.34, 2.4, 0.9, 0.9, 0),
      box(2.14, 0.4, 0.9, 0, 2.4),
      box(1.5, 2.4, 0.24, 0, 0, -0.33),
      box(1.9, 0.16, 1.02, 0, 2.8),
    ]),
  );
}

export function sarcophagus(): THREE.BufferGeometry {
  return faceted(
    merge([
      box(1.15, 0.2, 2.5),
      box(1, 0.72, 2.32, 0, 0.2),
      box(1.14, 0.22, 2.46, 0, 0.92),
      box(0.62, 0.14, 1.5, 0, 1.14),
      box(0.3, 0.1, 0.3, 0, 1.28, -0.7),
    ]),
  );
}

/** Arch framing a crouch-only opening: unit width, ~1.5 tall. */
export function crouchArch(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(0.34, 1.2, 1.1, -0.62, 0),
    box(0.34, 1.2, 1.1, 0.62, 0),
  ];
  const steps = 6;
  for (let i = 0; i < steps; i += 1) {
    const t0 = (i / steps) * Math.PI;
    const angle = t0;
    const voussoir = box(0.26, 0.32, 1.1);
    voussoir.translate(0, -0.16, 0);
    voussoir.rotateZ(Math.PI / 2 - angle);
    voussoir.translate(Math.cos(angle) * -0.62, 1.2 + Math.sin(angle) * 0.44, 0);
    parts.push(voussoir);
  }
  return faceted(merge(parts));
}

/**
 * The escape gate: two piers, a lintel, a keystone and a ruined tympanum.
 * Runes are split out so they can take the emissive material.
 */
export function escapeGate(): { stone: THREE.BufferGeometry; runes: THREE.BufferGeometry } {
  const half = 2.6;
  const height = 6.2;
  const stoneParts: THREE.BufferGeometry[] = [
    box(1.6, 0.5, 2.2, -half, 0),
    box(1.6, 0.5, 2.2, half, 0),
    box(1.3, height, 1.7, -half, 0.5),
    box(1.3, height, 1.7, half, 0.5),
    box(2 * half + 1.8, 0.9, 2, 0, height + 0.5),
    box(2 * half + 1.1, 0.55, 1.6, 0, height + 1.4),
    box(1.5, 0.9, 1.5, 0, height + 1.95),
  ];
  // Voussoirs springing between the piers.
  const steps = 9;
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / (steps - 1)) * Math.PI;
    const voussoir = box(0.62, 0.8, 1.5, 0, -0.4, 0);
    voussoir.rotateZ(Math.PI / 2 - angle);
    voussoir.translate(-Math.cos(angle) * half, height * 0.62 + Math.sin(angle) * 1.9, 0);
    stoneParts.push(voussoir);
  }
  const runeParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i += 1) {
    const angle = 0.22 + (i / 6) * (Math.PI - 0.44);
    const rune = box(0.3, 0.06, 0.3, 0, 0, 0);
    rune.rotateZ(Math.PI / 2 - angle);
    rune.translate(-Math.cos(angle) * (half - 0.35), height * 0.62 + Math.sin(angle) * 1.62, 0.78);
    runeParts.push(rune);
  }
  runeParts.push(box(2 * half - 0.4, 0.1, 0.12, 0, 0.05, 0.86));
  return {
    stone: faceted(merge(stoneParts)),
    runes: faceted(merge(runeParts)),
  };
}

/** The healing shrine: a stepped plinth carrying a ritual bowl. */
export function shrine(): { stone: THREE.BufferGeometry; bowl: THREE.BufferGeometry } {
  const stoneParts: THREE.BufferGeometry[] = [
    cyl(1.35, 1.6, 0.22, 12),
    cyl(1.1, 1.35, 0.2, 12, 0, 0.22),
    cyl(0.42, 0.62, 0.85, 10, 0, 0.42),
    cyl(0.78, 0.44, 0.3, 12, 0, 1.27),
  ];
  for (let i = 0; i < 4; i += 1) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const post = box(0.16, 1.9, 0.16, Math.cos(angle) * 1.15, 0.42, Math.sin(angle) * 1.15);
    stoneParts.push(post);
  }
  const bowl = merge([cyl(0.7, 0.52, 0.06, 12, 0, 1.5), new THREE.OctahedronGeometry(0.26, 0).translate(0, 1.78, 0)]);
  return { stone: faceted(merge(stoneParts)), bowl: faceted(bowl) };
}

/** Flat rune ring laid on the ground under an active seal. */
export function runeRing(): THREE.BufferGeometry {
  const ring = new THREE.RingGeometry(1.05, 1.35, 24, 1);
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, 0.03, 0);
  const marks: THREE.BufferGeometry[] = [ring];
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2;
    const mark = box(0.32, 0.02, 0.1, Math.cos(angle) * 1.62, 0.02, Math.sin(angle) * 1.62);
    mark.rotateY(-angle);
    marks.push(mark);
  }
  return merge(marks);
}

// ---------------------------------------------------------------------------
// Crow
// ---------------------------------------------------------------------------

/**
 * Spectral crow. `aWing` marks the vertices the flap shader rotates: 0 for the
 * body, ramping to 1 at the wing tips so the fold looks hinged at the shoulder.
 */
export function crow(): THREE.BufferGeometry {
  const bodyParts: THREE.BufferGeometry[] = [
    box(0.17, 0.17, 0.44, 0, -0.085, 0),
    box(0.13, 0.13, 0.13, 0, -0.04, 0.25),
    box(0.05, 0.05, 0.13, 0, -0.01, 0.36),
  ];
  const tail = box(0.13, 0.05, 0.3, 0, -0.05, -0.34);
  tail.rotateX(-0.2);
  bodyParts.push(tail);
  const body = merge(bodyParts);
  tagAttribute(body, 'aWing', 0);

  const wingParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const inner = box(0.2, 0.035, 0.3, side * 0.18, -0.02, 0.02);
    const outer = box(0.26, 0.03, 0.2, side * 0.4, -0.01, -0.02);
    wingParts.push(inner, outer);
  }
  const wings = merge(wingParts);
  // Ramp the flap weight with distance from the spine.
  const pos = wings.getAttribute('position');
  const weights = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i += 1) {
    weights[i] = Math.min(1, Math.abs(pos.getX(i)) / 0.5);
  }
  wings.setAttribute('aWing', new THREE.BufferAttribute(weights, 1));

  return faceted(merge([body, wings]));
}

// ---------------------------------------------------------------------------
// Instancing
// ---------------------------------------------------------------------------

const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_QUAT = new THREE.Quaternion();
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_SCALE = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export interface InstancedOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Skips frustum culling for meshes whose instances span the whole map. */
  frustumCulled?: boolean;
}

/**
 * Accumulates instance transforms, then materialises one `InstancedMesh`.
 * Keeping the draw-call budget is simply a matter of routing every repeated
 * element through one of these.
 */
export class InstanceBucket {
  readonly name: string;
  private readonly matrices: THREE.Matrix4[] = [];

  constructor(name: string) {
    this.name = name;
  }

  get count(): number {
    return this.matrices.length;
  }

  add(matrix: THREE.Matrix4): void {
    this.matrices.push(matrix.clone());
  }

  /** Position + yaw + (possibly non-uniform) scale, the common case. */
  place(
    x: number,
    y: number,
    z: number,
    rotY: number,
    sx: number,
    sy = sx,
    sz = sx,
  ): void {
    SCRATCH_POS.set(x, y, z);
    SCRATCH_QUAT.setFromAxisAngle(UP, rotY);
    SCRATCH_SCALE.set(sx, sy, sz);
    this.matrices.push(SCRATCH_MATRIX.compose(SCRATCH_POS, SCRATCH_QUAT, SCRATCH_SCALE).clone());
  }

  /** Full Euler placement, for props that lean or tip over. */
  placeEuler(
    x: number,
    y: number,
    z: number,
    euler: THREE.Euler,
    sx: number,
    sy = sx,
    sz = sx,
  ): void {
    SCRATCH_POS.set(x, y, z);
    SCRATCH_QUAT.setFromEuler(euler);
    SCRATCH_SCALE.set(sx, sy, sz);
    this.matrices.push(SCRATCH_MATRIX.compose(SCRATCH_POS, SCRATCH_QUAT, SCRATCH_SCALE).clone());
  }

  build(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    options: InstancedOptions = {},
  ): THREE.InstancedMesh | null {
    if (this.matrices.length === 0) {
      geometry.dispose();
      return null;
    }
    const mesh = new THREE.InstancedMesh(geometry, material, this.matrices.length);
    mesh.name = this.name;
    for (let i = 0; i < this.matrices.length; i += 1) mesh.setMatrixAt(i, this.matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = options.castShadow ?? false;
    mesh.receiveShadow = options.receiveShadow ?? true;
    if (options.frustumCulled === false) mesh.frustumCulled = false;
    mesh.computeBoundingSphere();
    this.matrices.length = 0;
    return mesh;
  }
}
