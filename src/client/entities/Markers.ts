/**
 * Gameplay markers: everything the players read off the world to make decisions.
 *
 * `sync(ctx)` reconciles the scene against `ctx.snapshot` every frame. All
 * repeated marker kinds are drawn through pooled `InstancedMesh`es or pooled
 * billboard clouds, so the whole system stays around ~22 draw calls no matter
 * how many entities are live. Per-entity animation state is kept in id-keyed
 * maps that persist across frames — nothing is created or disposed per frame.
 *
 * Two shader families are injected here:
 *  - a per-instance tint (rgb + alpha) for `InstancedMesh`, which stock Three
 *    cannot express (`instanceColor` has no alpha channel);
 *  - a clockwise arc mask used by the seal progress rings.
 * Both carry a `customProgramCacheKey`, without which Three can hand back a
 * cached, un-injected `basic`/`physical` program compiled elsewhere.
 */

import * as THREE from 'three';
import type { MarkerContext, MarkerSystem, QualityLevel } from '../contracts.js';
import {
  CROSSBOW,
  FOOTPRINT_LIFETIME,
  PULSE,
  SEALS_REQUIRED,
  SMOKE,
  SNARE,
  WARD,
} from '../../shared/constants.js';
import { createRng } from '../../shared/rng.js';
import type { MapData } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Palette + tunables
// ---------------------------------------------------------------------------

const CYAN = new THREE.Color(0x6feaff);
const AMBER = new THREE.Color(0xffb45c);
const MINT = new THREE.Color(0x7fffc4);
const IRON = 0x1c1f26;
const BRONZE = 0x6b5533;
const STONE = 0x525a68;

const TAU = Math.PI * 2;
/** Deterministic scatter for smoke puffs, rune orbits and wisps. */
const MARKER_SEED = 0x4d41524b;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Scratch objects — reused so `sync` allocates nothing per frame.
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Per-instance tint injection
// ---------------------------------------------------------------------------

type TintKind = 'basic' | 'standard';

function injectTint(material: THREE.Material, kind: TintKind, arc: boolean): void {
  const cacheKey = `veilhunt-mk-${kind}-${arc ? 'arc' : 'plain'}-v1`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute vec4 aTint;
attribute vec2 aParam;
varying vec4 vTint;
varying vec2 vParam;
varying vec2 vLocal;
${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
	vTint = aTint;
	vParam = aParam;
	vLocal = position.xy;`,
    );

    const arcCode = arc
      ? `
	float arcAngle = atan( vLocal.x, vLocal.y );
	if ( arcAngle < 0.0 ) arcAngle += 6.283185307;
	if ( arcAngle > vParam.x * 6.283185307 ) discard;`
      : '';

    const hook = kind === 'basic' ? '#include <color_fragment>' : '#include <emissivemap_fragment>';
    const emissive =
      kind === 'standard' ? '\n\ttotalEmissiveRadiance *= vTint.rgb;' : '';

    shader.fragmentShader = `varying vec4 vTint;
varying vec2 vParam;
varying vec2 vLocal;
${shader.fragmentShader}`.replace(
      hook,
      `${hook}${arcCode}
	diffuseColor.rgb *= vTint.rgb;
	diffuseColor.a *= vTint.a;${emissive}`,
    );
  };
  material.customProgramCacheKey = () => cacheKey;
}

// ---------------------------------------------------------------------------
// Pooled instanced mesh
// ---------------------------------------------------------------------------

class InstancedPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly tint: THREE.InstancedBufferAttribute;
  private readonly param: THREE.InstancedBufferAttribute;
  private readonly capacity: number;
  private n = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    renderOrder = 0,
  ) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.param = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    this.param.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aTint', this.tint);
    geometry.setAttribute('aParam', this.param);
  }

  begin(): void {
    this.n = 0;
  }

  pushMatrix(
    matrix: THREE.Matrix4,
    color: THREE.Color,
    alpha: number,
    p0 = 0,
    p1 = 0,
  ): void {
    if (this.n >= this.capacity || alpha <= 0.001) return;
    const i = this.n;
    this.mesh.setMatrixAt(i, matrix);
    const t = this.tint.array as Float32Array;
    t[i * 4] = color.r;
    t[i * 4 + 1] = color.g;
    t[i * 4 + 2] = color.b;
    t[i * 4 + 3] = alpha;
    const p = this.param.array as Float32Array;
    p[i * 2] = p0;
    p[i * 2 + 1] = p1;
    this.n = i + 1;
  }

  push(
    x: number,
    y: number,
    z: number,
    yaw: number,
    sx: number,
    sy: number,
    sz: number,
    color: THREE.Color,
    alpha: number,
    p0 = 0,
    p1 = 0,
  ): void {
    _pos.set(x, y, z);
    _euler.set(0, yaw, 0);
    _quat.setFromEuler(_euler);
    _scale.set(sx, sy, sz);
    _mat.compose(_pos, _quat, _scale);
    this.pushMatrix(_mat, color, alpha, p0, p1);
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.tint.needsUpdate = true;
      this.param.needsUpdate = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Pooled billboard cloud (camera-facing in the vertex shader — `sync` has no
// camera, so billboarding cannot be done on the CPU)
// ---------------------------------------------------------------------------

const QUAD_POS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_IDX = [0, 1, 2, 0, 2, 3];

const CLOUD_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aColor;
attribute vec3 aParam; // x = size, y = rotation, z = variant
varying vec4 vColor;
varying vec2 vUv;
varying float vVariant;
#ifdef USE_FOG
varying float vFogDepth;
#endif
void main() {
	vColor = aColor;
	vUv = uv;
	vVariant = aParam.z;
	vec4 mv = modelViewMatrix * vec4( aOffset, 1.0 );
	float s = sin( aParam.y );
	float c = cos( aParam.y );
	vec2 corner = position.xy * aParam.x;
	mv.xy += vec2( corner.x * c - corner.y * s, corner.x * s + corner.y * c );
	#ifdef USE_FOG
	vFogDepth = - mv.z;
	#endif
	gl_Position = projectionMatrix * mv;
}
`;

const CLOUD_FRAG = /* glsl */ `
uniform float uSoft;
uniform float uAdditive;
varying vec4 vColor;
varying vec2 vUv;
varying float vVariant;
#ifdef USE_FOG
uniform vec3 fogColor;
varying float vFogDepth;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
#endif
void main() {
	vec2 p = vUv * 2.0 - 1.0;
	float d = dot( p, p );
	if ( d > 1.0 ) discard;
	float falloff = pow( max( 0.0, 1.0 - d ), mix( 1.3, 3.2, uSoft ) );
	// A cheap lobed edge so puffs never read as perfect circles.
	float lobes = 0.86 + 0.14 * sin( vVariant * 6.2831 + atan( p.y, p.x ) * 3.0 );
	float a = vColor.a * falloff * lobes;
	vec3 rgb = vColor.rgb;
	#ifdef USE_FOG
	#ifdef FOG_EXP2
	float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
	float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	// Additive families fade out in fog; alpha-blended ones tint toward it.
	a *= mix( 1.0, 1.0 - fogFactor, uAdditive );
	rgb = mix( rgb, fogColor, fogFactor * ( 1.0 - uAdditive ) );
	#endif
	if ( a < 0.002 ) discard;
	gl_FragColor = vec4( rgb, a );
}
`;

class BillboardCloud {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly offset: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly param: THREE.InstancedBufferAttribute;
  private readonly capacity: number;
  private n = 0;

  constructor(capacity: number, additive: boolean, soft: number, renderOrder: number) {
    this.capacity = capacity;
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_POS.slice(), 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(QUAD_UV.slice(), 2));
    this.geometry.setIndex(QUAD_IDX.slice());

    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.param = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.offset.setUsage(THREE.DynamicDrawUsage);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.param.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aOffset', this.offset);
    this.geometry.setAttribute('aColor', this.color);
    this.geometry.setAttribute('aParam', this.param);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSoft: { value: soft },
        uAdditive: { value: additive ? 1 : 0 },
        fogColor: { value: new THREE.Color(0x000000) },
        fogDensity: { value: 0 },
        fogNear: { value: 1 },
        fogFar: { value: 1000 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = renderOrder;
  }

  begin(): void {
    this.n = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    size: number,
    rotation: number,
    variant: number,
    color: THREE.Color,
    alpha: number,
  ): void {
    if (this.n >= this.capacity || alpha <= 0.002 || size <= 0.0001) return;
    const i = this.n;
    const o = this.offset.array as Float32Array;
    o[i * 3] = x;
    o[i * 3 + 1] = y;
    o[i * 3 + 2] = z;
    const c = this.color.array as Float32Array;
    c[i * 4] = color.r;
    c[i * 4 + 1] = color.g;
    c[i * 4 + 2] = color.b;
    c[i * 4 + 3] = alpha;
    const p = this.param.array as Float32Array;
    p[i * 3] = size;
    p[i * 3 + 1] = rotation;
    p[i * 3 + 2] = variant;
    this.n = i + 1;
  }

  end(): void {
    this.geometry.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.offset.needsUpdate = true;
      this.color.needsUpdate = true;
      this.param.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Geometry authoring
// ---------------------------------------------------------------------------

function lathe(
  y0: number,
  y1: number,
  rows: number,
  segments: number,
  profile: (t: number) => number,
): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= rows; i += 1) {
    const t = i / rows;
    pts.push(new THREE.Vector2(Math.max(0.01, profile(t)), y0 + (y1 - y0) * t));
  }
  return new THREE.LatheGeometry(pts, segments);
}

/** A flat ground ring, laid in the XZ plane, authored in local XY for arc masking. */
function groundRing(inner: number, outer: number, segments: number): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(inner, outer, segments, 1);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Angular rune shard — a thin faceted sliver that catches the seal light. */
function runeShard(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.16);
  shape.lineTo(0.05, 0.02);
  shape.lineTo(0.028, -0.13);
  shape.lineTo(-0.028, -0.13);
  shape.lineTo(-0.05, 0.02);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.022,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
}

/** Stylised humanoid card used for the Runner's decoy after-image. */
function decoySilhouette(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.1, 0);
  s.lineTo(-0.08, 0.62);
  s.lineTo(-0.22, 0.98);
  s.lineTo(-0.16, 1.16);
  s.lineTo(-0.09, 1.34);
  s.lineTo(-0.11, 1.55);
  s.lineTo(0, 1.72);
  s.lineTo(0.11, 1.55);
  s.lineTo(0.09, 1.34);
  s.lineTo(0.16, 1.16);
  s.lineTo(0.22, 0.98);
  s.lineTo(0.08, 0.62);
  s.lineTo(0.1, 0);
  s.lineTo(0.03, 0);
  s.lineTo(0.02, 0.5);
  s.lineTo(-0.02, 0.5);
  s.lineTo(-0.03, 0);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

/** Boot print decal: toe pad + heel pad, laid flat, toe pointing local -Z. */
function bootPrint(): THREE.BufferGeometry {
  const toe = new THREE.Shape();
  toe.absellipse(0, 0.055, 0.05, 0.082, 0, TAU, false, 0);
  const heel = new THREE.Shape();
  heel.absellipse(0, -0.078, 0.04, 0.052, 0, TAU, false, 0);
  const geo = new THREE.ShapeGeometry([toe, heel], 8);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Iron jaw trap: a ring of teeth around a shallow plate. */
function snareTrap(): THREE.BufferGeometry {
  const plate = new THREE.CylinderGeometry(0.34, 0.4, 0.05, 9);
  const positions: number[] = [];
  const indices: number[] = [];
  const push = (g: THREE.BufferGeometry, m: THREE.Matrix4): void => {
    const pos = g.getAttribute('position');
    const base = positions.length / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
    }
    const idx = g.getIndex();
    if (idx) for (let i = 0; i < idx.count; i += 1) indices.push(base + idx.getX(i));
    else for (let i = 0; i < pos.count; i += 1) indices.push(base + i);
    g.dispose();
  };
  push(plate, new THREE.Matrix4());
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * TAU;
    const tooth = new THREE.ConeGeometry(0.035, 0.16, 3);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * 0.33, 0.08, Math.sin(a) * 0.33),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5)),
      new THREE.Vector3(1, 1, 1),
    );
    push(tooth, m);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Per-entity state maps (pooling: state persists, GPU slots are compacted)
// ---------------------------------------------------------------------------

interface Tracked {
  seen: boolean;
  fade: number;
  phase: number;
  age: number;
  seed: number;
}

class StateMap {
  private readonly map = new Map<number, Tracked>();

  ensure(id: number): Tracked {
    let s = this.map.get(id);
    if (!s) {
      const rng = createRng((id * 2654435761 + MARKER_SEED) >>> 0);
      s = { seen: true, fade: 0, phase: rng() * TAU, age: 0, seed: rng() };
      this.map.set(id, s);
    }
    s.seen = true;
    return s;
  }

  beginFrame(): void {
    for (const s of this.map.values()) s.seen = false;
  }

  /** Fades out entries that vanished, and drops them once fully faded. */
  endFrame(dt: number): void {
    for (const [id, s] of this.map) {
      if (s.seen) continue;
      s.fade = damp(s.fade, 0, 9, dt);
      if (s.fade < 0.01) this.map.delete(id);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Marker system
// ---------------------------------------------------------------------------

const SMOKE_PUFFS = 14;

class Markers implements MarkerSystem {
  readonly root = new THREE.Group();

  private readonly map: MapData;

  // Pools -----------------------------------------------------------------
  private readonly sealStone: InstancedPool;
  private readonly sealRunes: InstancedPool;
  private readonly sealProgress: InstancedPool;
  private readonly sealPillar: InstancedPool;
  private readonly decoyBody: InstancedPool;
  private readonly groundRipple: InstancedPool;
  private readonly wardSigil: InstancedPool;
  private readonly wardGlyph: InstancedPool;
  private readonly snarePool: InstancedPool;
  private readonly boltShaft: InstancedPool;
  private readonly boltTip: InstancedPool;
  private readonly footprints: InstancedPool;
  private readonly gateRunes: InstancedPool;

  private readonly aura: BillboardCloud;
  private readonly smoke: BillboardCloud;

  // Singletons ------------------------------------------------------------
  private readonly gateGroup = new THREE.Group();
  private readonly portcullis: THREE.Mesh;
  private readonly gateCurtain: THREE.Mesh;
  private readonly gateBar: THREE.Mesh;
  private readonly shrineGlow: THREE.Mesh;
  private readonly pulseRing: THREE.Mesh;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly pools: InstancedPool[] = [];

  // Per-entity state ------------------------------------------------------
  private readonly sealState = new StateMap();
  private readonly decoyState = new StateMap();
  private readonly smokeState = new StateMap();
  private readonly wardState = new StateMap();
  private readonly snareState = new StateMap();
  private readonly boltState = new StateMap();
  /** Deterministic per-puff scatter, shared by every smoke cloud. */
  private readonly puffScatter: Float32Array;
  private readonly wispScatter: Float32Array;

  private gateOpenBlend = 0;
  private trailBlend = 0;
  private readonly tmpColor = new THREE.Color();

  constructor(map: MapData, quality: QualityLevel) {
    this.map = map;
    this.root.name = 'markers';
    const lod = quality === 'low' ? 0 : quality === 'medium' ? 1 : 2;
    const seg = 10 + lod * 6;

    const rng = createRng(MARKER_SEED);
    this.puffScatter = new Float32Array(SMOKE_PUFFS * 5);
    for (let i = 0; i < SMOKE_PUFFS; i += 1) {
      const o = i * 5;
      // Spherical-ish scatter biased low and wide, like a settled cloud.
      const a = (i / SMOKE_PUFFS) * TAU + rng.range(-0.4, 0.4);
      const r = 0.22 + rng() * 0.62;
      this.puffScatter[o] = Math.cos(a) * r;
      this.puffScatter[o + 1] = 0.16 + rng() * 0.62;
      this.puffScatter[o + 2] = Math.sin(a) * r;
      this.puffScatter[o + 3] = rng.range(0.72, 1.18); // size scale
      this.puffScatter[o + 4] = rng(); // variant / phase
    }
    this.wispScatter = new Float32Array(8 * 4);
    for (let i = 0; i < 8; i += 1) {
      const o = i * 4;
      this.wispScatter[o] = rng.range(-1, 1);
      this.wispScatter[o + 1] = rng.range(0.2, 1.9);
      this.wispScatter[o + 2] = rng.range(-1, 1);
      this.wispScatter[o + 3] = rng();
    }

    // -- materials --------------------------------------------------------
    const stoneMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.94, metalness: 0.04 }),
    );
    injectTint(stoneMat, 'standard', false);

    const ironMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: IRON, roughness: 0.58, metalness: 0.72 }),
    );
    injectTint(ironMat, 'standard', false);

    const bronzeMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: BRONZE, roughness: 0.5, metalness: 0.7 }),
    );
    injectTint(bronzeMat, 'standard', false);

    const glowMat = (arc: boolean): THREE.MeshBasicMaterial => {
      const m = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      ) as THREE.MeshBasicMaterial;
      injectTint(m, 'basic', arc);
      return m;
    };

    // -- seals ------------------------------------------------------------
    this.sealStone = this.pool(
      this.trackGeo(
        lathe(0, 0.28, 3, seg, (t) => 1.42 - t * 0.1 + Math.sin(t * Math.PI) * 0.06),
      ),
      stoneMat,
      8,
    );
    this.sealRunes = this.pool(this.trackGeo(runeShard()), glowMat(false), 8 * 6, 3);
    this.sealProgress = this.pool(
      this.trackGeo(groundRing(1.05, 1.4, seg * 3)),
      glowMat(true),
      8,
      2,
    );
    this.sealPillar = this.pool(
      this.trackGeo(new THREE.CylinderGeometry(0.62, 0.92, 1, seg, 1, true)),
      glowMat(false),
      8,
      3,
    );

    // -- decoys / ripples --------------------------------------------------
    this.decoyBody = this.pool(this.trackGeo(decoySilhouette()), glowMat(false), 4, 4);
    this.groundRipple = this.pool(this.trackGeo(groundRing(0.42, 0.55, seg * 2)), glowMat(false), 24, 2);

    // -- wards -------------------------------------------------------------
    this.wardSigil = this.pool(this.trackGeo(groundRing(0, WARD.radius * 0.7, seg * 2)), glowMat(false), 8, 2);
    this.wardGlyph = this.pool(
      this.trackGeo(groundRing(WARD.radius * 0.74, WARD.radius, 9)),
      glowMat(false),
      8,
      2,
    );

    // -- snares ------------------------------------------------------------
    this.snarePool = this.pool(this.trackGeo(snareTrap()), ironMat, 8);

    // -- bolts -------------------------------------------------------------
    const shaft = this.trackGeo(
      new THREE.CylinderGeometry(CROSSBOW.projectileRadius * 0.34, CROSSBOW.projectileRadius * 0.28, 0.62, 5),
    );
    shaft.rotateX(Math.PI / 2);
    this.boltShaft = this.pool(shaft, bronzeMat, 8);
    const tip = this.trackGeo(new THREE.ConeGeometry(0.055, 0.5, 5));
    tip.rotateX(-Math.PI / 2);
    this.boltTip = this.pool(tip, glowMat(false), 16, 3);

    // -- footprints --------------------------------------------------------
    this.footprints = this.pool(this.trackGeo(bootPrint()), glowMat(false), 96, 2);

    // -- gate --------------------------------------------------------------
    this.gateRunes = this.pool(
      this.trackGeo(new THREE.TorusGeometry(0.19, 0.05, 5, seg)),
      glowMat(false),
      SEALS_REQUIRED,
      3,
    );

    const gate = this.gateGroup;
    gate.position.set(map.gate.x, 0, map.gate.z);
    gate.rotation.y = map.gate.rot;
    this.root.add(gate);

    // Stone arch: two piers plus a torus lintel.
    const archParts = new THREE.Group();
    const pierGeo = this.trackGeo(new THREE.BoxGeometry(0.9, 5.2, 1.1));
    const archStone = this.trackMat(
      new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.95, metalness: 0.03 }),
    );
    for (const side of [-1, 1]) {
      const pier = new THREE.Mesh(pierGeo, archStone);
      pier.position.set(side * 2.4, 2.6, 0);
      pier.castShadow = true;
      pier.receiveShadow = true;
      archParts.add(pier);
    }
    const lintel = new THREE.Mesh(
      this.trackGeo(new THREE.TorusGeometry(2.4, 0.55, 5, seg + 4, Math.PI)),
      archStone,
    );
    lintel.position.y = 5.2;
    lintel.castShadow = true;
    archParts.add(lintel);
    gate.add(archParts);

    // Portcullis: merged bar grid so the whole grate is one draw call.
    this.portcullis = new THREE.Mesh(this.trackGeo(this.buildPortcullis()), ironMat);
    this.portcullis.castShadow = true;
    this.portcullis.position.y = 0;
    gate.add(this.portcullis);

    this.gateCurtain = new THREE.Mesh(
      this.trackGeo(new THREE.PlaneGeometry(4.4, 5)),
      this.trackMat(
        new THREE.MeshBasicMaterial({
          color: CYAN,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.gateCurtain.position.set(0, 2.5, 0);
    this.gateCurtain.visible = false;
    this.gateCurtain.renderOrder = 3;
    gate.add(this.gateCurtain);

    this.gateBar = new THREE.Mesh(
      this.trackGeo(new THREE.PlaneGeometry(4.2, 1)),
      this.trackMat(
        new THREE.MeshBasicMaterial({
          color: CYAN,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.gateBar.position.set(0, 0, 0.05);
    this.gateBar.visible = false;
    this.gateBar.renderOrder = 3;
    gate.add(this.gateBar);

    // -- shrine ------------------------------------------------------------
    const shrine = new THREE.Group();
    shrine.position.set(map.shrine.x, 0, map.shrine.z);
    this.root.add(shrine);
    const basin = new THREE.Mesh(
      this.trackGeo(
        lathe(0, 1.05, 6, seg + 2, (t) =>
          0.32 + Math.sin(t * Math.PI * 0.9) * 0.12 + (t > 0.82 ? 0.42 * (t - 0.82) * 5 : 0),
        ),
      ),
      archStone,
    );
    basin.castShadow = true;
    basin.receiveShadow = true;
    shrine.add(basin);

    this.shrineGlow = new THREE.Mesh(
      this.trackGeo(new THREE.CircleGeometry(0.66, seg + 2).rotateX(-Math.PI / 2)),
      this.trackMat(
        new THREE.MeshBasicMaterial({
          color: MINT,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.shrineGlow.position.y = 1.02;
    this.shrineGlow.renderOrder = 3;
    shrine.add(this.shrineGlow);

    // -- pulse -------------------------------------------------------------
    this.pulseRing = new THREE.Mesh(
      this.trackGeo(groundRing(0.86, 1, seg * 4)),
      this.trackMat(
        new THREE.MeshBasicMaterial({
          color: CYAN,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.pulseRing.visible = false;
    this.pulseRing.frustumCulled = false;
    this.pulseRing.renderOrder = 2;
    this.root.add(this.pulseRing);

    // -- clouds ------------------------------------------------------------
    const puffCap = (quality === 'low' ? 3 : 5) * SMOKE_PUFFS;
    this.smoke = new BillboardCloud(puffCap, false, 1, 5);
    this.aura = new BillboardCloud(96, true, 0.9, 4);
    this.root.add(this.smoke.mesh, this.aura.mesh);
  }

  // -- construction helpers -----------------------------------------------

  private trackMat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private pool(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    capacity: number,
    renderOrder = 0,
  ): InstancedPool {
    const p = new InstancedPool(geo, mat, capacity, renderOrder);
    this.pools.push(p);
    this.root.add(p.mesh);
    return p;
  }

  private buildPortcullis(): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const v = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    const add = (g: THREE.BufferGeometry, m: THREE.Matrix4): void => {
      const pos = g.getAttribute('position');
      const na = g.getAttribute('normal');
      const base = positions.length / 3;
      nm.setFromMatrix4(m).invert().transpose();
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        positions.push(v.x, v.y, v.z);
        nrm.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        normals.push(nrm.x, nrm.y, nrm.z);
      }
      const idx = g.getIndex();
      if (idx) for (let i = 0; i < idx.count; i += 1) indices.push(base + idx.getX(i));
      g.dispose();
    };
    for (let i = 0; i < 7; i += 1) {
      const x = -1.95 + i * 0.65;
      add(
        new THREE.CylinderGeometry(0.055, 0.055, 4.6, 5),
        new THREE.Matrix4().makeTranslation(x, 2.3, 0),
      );
    }
    for (let i = 0; i < 3; i += 1) {
      add(
        new THREE.BoxGeometry(4.3, 0.11, 0.11),
        new THREE.Matrix4().makeTranslation(0, 0.6 + i * 1.7, 0),
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  // -- per-frame sync ------------------------------------------------------

  sync(ctx: MarkerContext): void {
    const dt = clamp(ctx.dt, 0, 0.1);
    const t = ctx.elapsed;
    const calm = ctx.reducedMotion ? 0.35 : 1;

    for (const pool of this.pools) pool.begin();
    this.aura.begin();
    this.smoke.begin();

    this.syncSeals(ctx, dt, t, calm);
    this.syncGate(ctx, dt, t, calm);
    this.syncShrine(ctx, dt, t);
    this.syncDecoys(ctx, dt, t, calm);
    this.syncSmoke(ctx, dt, t, calm);
    this.syncWards(ctx, dt, t, calm);
    this.syncSnares(ctx, dt, t);
    this.syncBolts(ctx, dt, t);
    this.syncFootprints(ctx);
    this.syncPulse(ctx);
    this.syncMarkedTrail(ctx, dt, t, calm);

    for (const pool of this.pools) pool.end();
    this.aura.end();
    this.smoke.end();
  }

  // -- seals ---------------------------------------------------------------

  private syncSeals(ctx: MarkerContext, dt: number, t: number, calm: number): void {
    this.sealState.beginFrame();
    const viewer = ctx.snapshot.self.transform;
    for (const seal of ctx.snapshot.seals) {
      // The beam and aura are long-range landmarks. Standing at the seal — which
      // the Runner must do for seven seconds — would otherwise fill the screen
      // with additive white and hide the Hunter walking up behind them.
      const viewerDistance = Math.hypot(seal.x - viewer.x, seal.z - viewer.z);
      const proximityFade = smoothstep(2.2, 9.5, viewerDistance);
      const s = this.sealState.ensure(seal.id);
      s.fade = damp(s.fade, 1, 7, dt);
      const progress = clamp(seal.progress, 0, 1);
      const active = seal.active;
      const heat = active ? 1 : progress;
      // Runes accelerate with progress and again once the seal is lit.
      s.phase += dt * (0.35 + progress * 2.4 + (active ? 2.6 : 0)) * calm;
      s.age += dt;

      const intensity = (0.22 + heat * 0.78) * s.fade;
      this.tmpColor.copy(CYAN);

      // Carved stone ring.
      this.sealStone.push(seal.x, 0.02, seal.z, s.phase * 0.05, 1, 1, 1, this.tmpColor, s.fade, 0, 0);

      // Ground ring filling clockwise to match progress.
      if (progress > 0.001 || active) {
        const fill = active ? 1 : progress;
        this.sealProgress.push(
          seal.x,
          0.32,
          seal.z,
          0,
          1,
          1,
          1,
          this.tmpColor,
          (0.5 + heat * 0.5) * s.fade,
          fill,
          0,
        );
      }

      // Orbiting rune shards.
      const shards = 6;
      for (let i = 0; i < shards; i += 1) {
        const a = s.phase + (i / shards) * TAU;
        const radius = 1.05 + Math.sin(a * 1.7 + s.seed * TAU) * 0.12;
        const y = 0.85 + Math.sin(a * 2.1 + i) * 0.24 + heat * 0.5;
        _pos.set(seal.x + Math.cos(a) * radius, y, seal.z + Math.sin(a) * radius);
        _euler.set(a * 0.8, -a, Math.sin(a * 1.3) * 0.6);
        _quat.setFromEuler(_euler);
        _scale.setScalar(0.8 + heat * 0.5);
        _mat.compose(_pos, _quat, _scale);
        this.sealRunes.pushMatrix(_mat, this.tmpColor, intensity * (0.6 + 0.4 * Math.sin(a * 3)));
      }

      // Standing pillar of light, the long-range landmark.
      if (active || progress > 0.02) {
        const h = active ? 11 : 0.6 + progress * 2.2;
        const flicker = 0.82 + Math.sin(t * 3.1 + s.seed * TAU) * 0.12 * calm;
        this.sealPillar.push(
          seal.x,
          h * 0.5,
          seal.z,
          0,
          1,
          h,
          1,
          this.tmpColor,
          (active ? 0.3 : 0.14 * progress) * flicker * s.fade * proximityFade,
        );
      }

      // Persistent ground glow visible from a distance.
      const glowSize = 2.4 + heat * 3.4;
      this.aura.push(
        seal.x,
        0.5 + heat * 0.9,
        seal.z,
        glowSize,
        s.phase * 0.2,
        s.seed,
        this.tmpColor,
        (0.1 + heat * 0.34) * s.fade * (0.35 + 0.65 * proximityFade),
      );
    }
    this.sealState.endFrame(dt);
  }

  // -- gate ----------------------------------------------------------------

  private syncGate(ctx: MarkerContext, dt: number, t: number, calm: number): void {
    const snap = ctx.snapshot;
    this.gateOpenBlend = damp(this.gateOpenBlend, snap.gateOpen ? 1 : 0, 1.6, dt);
    const lit = clamp(snap.sealsActivated, 0, SEALS_REQUIRED);

    // Three rune slots across the lintel; one lights per activated seal.
    for (let i = 0; i < SEALS_REQUIRED; i += 1) {
      const on = i < lit;
      const pulse = on ? 0.72 + Math.sin(t * 2.4 + i * 1.3) * 0.28 * calm : 0.05;
      const blaze = this.gateOpenBlend * (0.6 + Math.sin(t * 5 + i) * 0.4 * calm);
      _pos.set(this.map.gate.x, 5.05, this.map.gate.z);
      _euler.set(0, this.map.gate.rot, 0);
      _quat.setFromEuler(_euler);
      _scale.setScalar(1);
      _mat.compose(_pos, _quat, _scale);
      // Offset along the arch's local X.
      _dir.set((i - 1) * 1.5, 0, -0.62).applyQuaternion(_quat);
      _pos.add(_dir);
      _mat.compose(_pos, _quat, _scale.setScalar(0.9 + blaze * 0.35));
      this.tmpColor.copy(CYAN);
      this.gateRunes.pushMatrix(_mat, this.tmpColor, clamp(pulse + blaze, 0, 1.6));
      if (on) {
        this.aura.push(_pos.x, _pos.y, _pos.z, 1.5 + blaze * 1.4, 0, i * 0.31, CYAN, 0.28 + blaze * 0.4);
      }
    }

    // Portcullis raises as the gate opens.
    this.portcullis.position.y = this.gateOpenBlend * 4.5;
    this.portcullis.visible = this.gateOpenBlend < 0.995;

    // Threshold curtain.
    const curtainMat = this.gateCurtain.material as THREE.MeshBasicMaterial;
    curtainMat.opacity = this.gateOpenBlend * (0.24 + Math.sin(t * 1.9) * 0.06 * calm);
    this.gateCurtain.visible = curtainMat.opacity > 0.005;

    // Rising bar of light driven by channel progress.
    const gp = clamp(snap.gateProgress, 0, 1);
    const barMat = this.gateBar.material as THREE.MeshBasicMaterial;
    this.gateBar.visible = gp > 0.002 && !snap.gateOpen;
    if (this.gateBar.visible) {
      const h = 0.2 + gp * 5;
      this.gateBar.scale.set(1, h, 1);
      this.gateBar.position.y = h * 0.5;
      barMat.opacity = 0.16 + gp * 0.3;
      this.aura.push(
        this.map.gate.x,
        h,
        this.map.gate.z,
        1.4 + gp * 2.2,
        t * 0.4,
        0.21,
        CYAN,
        0.2 + gp * 0.35,
      );
    }
  }

  // -- shrine --------------------------------------------------------------

  private syncShrine(ctx: MarkerContext, dt: number, t: number): void {
    const p = clamp(ctx.snapshot.shrineProgress, 0, 1);
    const mat = this.shrineGlow.material as THREE.MeshBasicMaterial;
    const target = 0.18 + p * 0.62;
    mat.opacity = damp(mat.opacity, target, 6, dt);
    this.shrineGlow.scale.setScalar(0.55 + p * 0.5 + Math.sin(t * 1.7) * 0.02);
    this.aura.push(
      this.map.shrine.x,
      1.1 + p * 0.5,
      this.map.shrine.z,
      1.6 + p * 2.1,
      t * 0.25,
      0.44,
      MINT,
      0.14 + p * 0.4,
    );
  }

  // -- decoys --------------------------------------------------------------

  private syncDecoys(ctx: MarkerContext, dt: number, t: number, calm: number): void {
    this.decoyState.beginFrame();
    for (const decoy of ctx.snapshot.decoys) {
      const s = this.decoyState.ensure(decoy.id);
      s.fade = damp(s.fade, 1, 8, dt);
      s.age += dt;
      // Fade out over the last second of life, and flicker throughout.
      const life = clamp(decoy.expiresIn, 0, 4) / 4;
      const flicker =
        0.62 + Math.sin(t * 21 + s.seed * TAU) * 0.16 * calm + Math.sin(t * 7.3 + s.seed) * 0.14 * calm;
      const alpha = s.fade * clamp(life, 0, 1) * flicker * 0.55;
      this.tmpColor.copy(CYAN);
      this.decoyBody.push(decoy.x, 0.02, decoy.z, decoy.yaw, 1, 1, 1, this.tmpColor, alpha);
      this.aura.push(decoy.x, 0.95, decoy.z, 1.9, 0, s.seed, CYAN, alpha * 0.45);

      // Footstep ripples pulsing at the feet.
      for (let i = 0; i < 2; i += 1) {
        const cycle = ((t * 1.9 + s.seed * 3 + i * 0.5) % 1);
        this.groundRipple.push(
          decoy.x,
          0.03,
          decoy.z,
          0,
          0.6 + cycle * 2.2,
          1,
          0.6 + cycle * 2.2,
          this.tmpColor,
          alpha * (1 - cycle) * 0.7,
        );
      }
    }
    this.decoyState.endFrame(dt);
  }

  // -- smoke ---------------------------------------------------------------

  private syncSmoke(ctx: MarkerContext, dt: number, t: number, calm: number): void {
    this.smokeState.beginFrame();
    for (const cloud of ctx.snapshot.smokes) {
      const s = this.smokeState.ensure(cloud.id);
      s.age += dt;
      const elapsedLife = Math.max(0, SMOKE.lifetime - cloud.expiresIn);
      // 0.4 s bloom in, then fade as the cloud expires.
      const fadeIn = smoothstep(0, 0.4, elapsedLife);
      const fadeOut = smoothstep(0, 1.6, cloud.expiresIn);
      s.fade = fadeIn * fadeOut;
      const radius = cloud.radius;
      // Peak coverage ≈ 0.82: obscuring, never a black-out.
      const puffAlpha = 0.12 * s.fade;
      const spread = 0.35 + fadeIn * 0.65;

      for (let i = 0; i < SMOKE_PUFFS; i += 1) {
        const o = i * 5;
        const variant = this.puffScatter[o + 4];
        const churn = t * 0.22 * calm + variant * TAU;
        // Slow turbulence: each puff wanders on its own low-frequency orbit.
        const wobbleX = Math.sin(churn * 1.3) * radius * 0.1;
        const wobbleY = Math.sin(churn * 0.9 + 1.7) * radius * 0.06;
        const wobbleZ = Math.cos(churn * 1.1 + 0.6) * radius * 0.1;
        this.smoke.push(
          cloud.x + this.puffScatter[o] * radius * spread + wobbleX,
          this.puffScatter[o + 1] * radius * 0.72 + 0.35 + wobbleY,
          cloud.z + this.puffScatter[o + 2] * radius * spread + wobbleZ,
          radius * 0.95 * this.puffScatter[o + 3] * (0.55 + fadeIn * 0.45),
          churn * 0.35 + variant * TAU,
          variant,
          this.tmpColor.setRGB(0.56, 0.61, 0.68),
          puffAlpha,
        );
      }
    }
    this.smokeState.endFrame(dt);
  }

  // -- wards ---------------------------------------------------------------

  private syncWards(ctx: MarkerContext, dt: number, t: number, calm: number): void {
    this.wardState.beginFrame();
    for (const ward of ctx.snapshot.wards) {
      const s = this.wardState.ensure(ward.id);
      s.age += dt;
      if (ward.triggered) {
        // Bright flash then a quick fade-out.
        s.fade = damp(s.fade, 0, 2.6, dt);
        const flash = clamp(s.fade * 3, 0, 2.4);
        this.tmpColor.setRGB(0.92, 1, 1);
        this.wardSigil.push(ward.x, 0.04, ward.z, 0, 1.6, 1, 1.6, this.tmpColor, flash * 0.5);
        this.aura.push(ward.x, 0.7, ward.z, 3.2 + (1 - s.fade) * 4, 0, s.seed, this.tmpColor, flash * 0.6);
        continue;
      }
      s.fade = damp(s.fade, 1, 6, dt);
      s.phase += dt * 0.55 * calm;
      const pulse = ward.armed ? 0.55 + Math.sin(t * 2.2 + s.seed * TAU) * 0.28 * calm : 0.22;
      this.tmpColor.copy(CYAN);
      this.wardSigil.push(ward.x, 0.035, ward.z, s.phase * 0.3, 1, 1, 1, this.tmpColor, pulse * 0.4 * s.fade);
      // Slowly rotating glyph ring.
      this.wardGlyph.push(ward.x, 0.045, ward.z, -s.phase, 1, 1, 1, this.tmpColor, pulse * 0.9 * s.fade);
      this.aura.push(ward.x, 0.35, ward.z, 1.5, 0, s.seed, CYAN, pulse * 0.22 * s.fade);
    }
    this.wardState.endFrame(dt);
  }

  // -- snares --------------------------------------------------------------

  private syncSnares(ctx: MarkerContext, dt: number, t: number): void {
    this.snareState.beginFrame();
    for (const snare of ctx.snapshot.snares) {
      const s = this.snareState.ensure(snare.id);
      s.fade = damp(s.fade, 1, 6, dt);
      // Deliberately subtle: dark iron, partly buried, with a faint amber glint
      // so a careful player can spot it without it being signposted.
      const snapped = snare.triggered;
      const openness = snapped ? 0.12 : 1;
      this.tmpColor.setRGB(0.42, 0.42, 0.46);
      this.snarePool.push(
        snare.x,
        snapped ? -0.02 : -0.05,
        snare.z,
        s.seed * TAU,
        SNARE.radius * 0.86,
        openness,
        SNARE.radius * 0.86,
        this.tmpColor,
        s.fade,
      );
      if (!snapped && snare.armed) {
        const glint = 0.1 + Math.abs(Math.sin(t * 0.7 + s.seed * TAU)) * 0.12;
        this.aura.push(snare.x, 0.09, snare.z, 0.34, 0, s.seed, AMBER, glint * s.fade);
      }
    }
    this.snareState.endFrame(dt);
  }

  // -- bolts ---------------------------------------------------------------

  private syncBolts(ctx: MarkerContext, dt: number, t: number): void {
    this.boltState.beginFrame();
    for (const bolt of ctx.snapshot.bolts) {
      const s = this.boltState.ensure(bolt.id);
      s.fade = damp(s.fade, 1, 12, dt);
      s.age += dt;

      _dir.set(bolt.vx, bolt.vy, bolt.vz);
      if (_dir.lengthSq() < 1e-4) _dir.set(0, -1, 0.55);
      _dir.normalize();
      // Shaft geometry is authored pointing down local +Z.
      _quat.setFromUnitVectors(_axis.set(0, 0, 1), _dir);
      _pos.set(bolt.x, bolt.y, bolt.z);
      _scale.set(1, 1, 1);
      _mat.compose(_pos, _quat, _scale);

      this.tmpColor.setRGB(0.55, 0.45, 0.3);
      this.boltShaft.pushMatrix(_mat, this.tmpColor, s.fade);
      this.tmpColor.copy(CYAN);

      if (!bolt.landed) {
        // Glowing tip plus a short stretched motion trail behind it.
        _scale.set(0.9, 0.9, 0.55);
        _pos.set(bolt.x + _dir.x * 0.3, bolt.y + _dir.y * 0.3, bolt.z + _dir.z * 0.3);
        _mat.compose(_pos, _quat, _scale);
        this.boltTip.pushMatrix(_mat, this.tmpColor, s.fade);

        _scale.set(0.5, 0.5, -3.4);
        _pos.set(bolt.x, bolt.y, bolt.z);
        _mat.compose(_pos, _quat, _scale);
        this.boltTip.pushMatrix(_mat, this.tmpColor, s.fade * 0.3);
        this.aura.push(bolt.x, bolt.y, bolt.z, 0.55, 0, s.seed, CYAN, 0.5 * s.fade);
      } else {
        // Spent bolt: faint pickup shimmer.
        const shimmer = 0.22 + Math.sin(t * 3.1 + s.seed * TAU) * 0.14;
        this.aura.push(bolt.x, bolt.y + 0.18, bolt.z, 0.7, 0, s.seed, CYAN, shimmer * s.fade);
      }
    }
    this.boltState.endFrame(dt);
  }

  // -- footprints ----------------------------------------------------------

  private syncFootprints(ctx: MarkerContext): void {
    if (ctx.role !== 'hunter') return;
    for (const trace of ctx.snapshot.revealedTraces) {
      const k = 1 - clamp(trace.age / FOOTPRINT_LIFETIME, 0, 1);
      if (k <= 0.001) continue;
      // Older prints read dimmer and cooler.
      const brightness = Math.pow(k, 1.7);
      this.tmpColor.copy(CYAN).multiplyScalar(0.5 + brightness * 0.5);
      // `foot` alternates the decal so the trail reads as a walking gait.
      const side = trace.foot === 0 ? -1 : 1;
      this.footprints.push(
        trace.x,
        0.025,
        trace.z,
        trace.yaw,
        side,
        1,
        1,
        this.tmpColor,
        0.2 + brightness * 0.75,
      );
    }
  }

  // -- tracking pulse ------------------------------------------------------

  private syncPulse(ctx: MarkerContext): void {
    const pulse = ctx.snapshot.pulse;
    const mat = this.pulseRing.material as THREE.MeshBasicMaterial;
    if (!pulse) {
      this.pulseRing.visible = false;
      mat.opacity = 0;
      return;
    }
    const k = clamp(pulse.age / PULSE.duration, 0, 1);
    const radius = Math.max(0.01, pulse.radius * k);
    this.pulseRing.visible = k < 1;
    this.pulseRing.position.set(pulse.x, 0.05, pulse.z);
    this.pulseRing.scale.set(radius, 1, radius);
    // Bright leading edge that thins and fades as the wave expands.
    mat.opacity = (1 - k) * (1 - k) * 0.65;
  }

  // -- marked trail --------------------------------------------------------

  private syncMarkedTrail(ctx: MarkerContext, dt: number, t: number, calm: number): void {
    const trail = ctx.snapshot.opponent.markedTrail;
    this.trailBlend = damp(this.trailBlend, trail ? clamp(trail.strength, 0, 1) : 0, 3.5, dt);
    if (!trail || this.trailBlend < 0.01) return;
    // Deliberately diffuse: a drifting cloud, never a precise pin.
    for (let i = 0; i < 8; i += 1) {
      const o = i * 4;
      const seed = this.wispScatter[o + 3];
      const drift = t * 0.35 * calm + seed * TAU;
      const spread = 2.6 - this.trailBlend * 1.1;
      this.aura.push(
        trail.x + this.wispScatter[o] * spread + Math.sin(drift) * 0.55,
        this.wispScatter[o + 1] + Math.sin(drift * 0.7 + 1.1) * 0.35,
        trail.z + this.wispScatter[o + 2] * spread + Math.cos(drift * 0.9) * 0.55,
        2.2 + seed * 1.6,
        drift * 0.2,
        seed,
        CYAN,
        this.trailBlend * (0.06 + seed * 0.05),
      );
    }
  }

  // -- teardown ------------------------------------------------------------

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    this.gateGroup.clear();
    for (const pool of this.pools) pool.mesh.dispose();
    for (const geo of this.geometries) geo.dispose();
    for (const mat of this.materials) mat.dispose();
    this.aura.dispose();
    this.smoke.dispose();
    this.sealState.clear();
    this.decoyState.clear();
    this.smokeState.clear();
    this.wardState.clear();
    this.snareState.clear();
    this.boltState.clear();
    this.pools.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMarkerSystem(map: MapData, quality: QualityLevel): MarkerSystem {
  return new Markers(map, quality);
}
