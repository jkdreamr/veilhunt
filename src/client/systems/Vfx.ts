/**
 * Pooled event VFX.
 *
 * Every effect is drawn from one of five pre-allocated families, so the whole
 * system is five draw calls regardless of how much is on screen:
 *
 *   sparks  — small, fast, additive billboards (blade hits, iron, bolts)
 *   motes   — soft, slow, rising billboards (seals, healing, dust, splashes)
 *   shards  — real 3D chunks with spin (breach debris, stone, wood)
 *   rings   — flat ground shockwaves (impacts, seal completion, gate)
 *   arcs    — camera-facing slash quads (blade misses)
 *
 * Buffers are allocated once in the constructor and never grown. `spawn`
 * allocates round-robin from a monotonic cursor, which makes the slot at the
 * cursor the oldest one allocated — so an exhausted pool recycles oldest-first
 * without any search. Particle state lives in flat typed arrays indexed by pool
 * slot; the GPU instance buffers are re-packed from the live subset each frame.
 *
 * All randomness routes through `createRng` with a fixed seed, and all motion is
 * integrated from the `dt` handed to `update`, so a given sequence of spawns
 * reproduces exactly — required for screenshot baselines and bot playtests.
 */

import * as THREE from 'three';
import type { QualityLevel, VfxKind, VfxSystem } from '../contracts.js';
import { createRng, type Rng } from '../../shared/rng.js';

const TAU = Math.PI * 2;
/** Fixed so replays and screenshot baselines are byte-stable. */
const VFX_SEED = 0x5eafc0de;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Shared billboard shader (camera-facing in the vertex shader — `update` has no
// camera, and world-space sizing stays correct at any resolution)
// ---------------------------------------------------------------------------

const QUAD_POS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_IDX = [0, 1, 2, 0, 2, 3];

const BILLBOARD_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aColor;
attribute vec3 aParam; // x = size, y = rotation, z = stretch along local X
varying vec4 vColor;
varying vec2 vUv;
#ifdef USE_FOG
varying float vFogDepth;
#endif
void main() {
	vColor = aColor;
	vUv = uv;
	vec4 mv = modelViewMatrix * vec4( aOffset, 1.0 );
	float s = sin( aParam.y );
	float c = cos( aParam.y );
	vec2 corner = position.xy * vec2( aParam.x * aParam.z, aParam.x );
	mv.xy += vec2( corner.x * c - corner.y * s, corner.x * s + corner.y * c );
	#ifdef USE_FOG
	vFogDepth = - mv.z;
	#endif
	gl_Position = projectionMatrix * mv;
}
`;

/** `uShape`: 0 = tight spark, 1 = soft mote, 2 = thin arc. */
const BILLBOARD_FRAG = /* glsl */ `
uniform int uShape;
varying vec4 vColor;
varying vec2 vUv;
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
	float a = vColor.a;
	if ( uShape == 2 ) {
		// Arc: a thin blade of light, brightest along the horizontal midline.
		float band = 1.0 - abs( p.y );
		float span = 1.0 - abs( p.x );
		a *= pow( max( 0.0, band ), 3.0 ) * smoothstep( 0.0, 0.45, span );
	} else {
		float d = dot( p, p );
		if ( d > 1.0 ) discard;
		float falloff = max( 0.0, 1.0 - d );
		a *= uShape == 0 ? pow( falloff, 1.6 ) : pow( falloff, 2.8 );
	}
	#ifdef USE_FOG
	#ifdef FOG_EXP2
	float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
	float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	// Additive light must fade toward nothing in fog, never toward the fog colour.
	a *= 1.0 - fogFactor;
	#endif
	if ( a < 0.002 ) discard;
	gl_FragColor = vec4( vColor.rgb, a );
}
`;

function fogUniforms(): Record<string, THREE.IUniform> {
  return {
    fogColor: { value: new THREE.Color(0x000000) },
    fogDensity: { value: 0 },
    fogNear: { value: 1 },
    fogFar: { value: 1000 },
  };
}

// ---------------------------------------------------------------------------
// Particle storage
// ---------------------------------------------------------------------------

/** Stride of the per-particle state record. */
const S_X = 0;
const S_Y = 1;
const S_Z = 2;
const S_VX = 3;
const S_VY = 4;
const S_VZ = 5;
const S_LIFE = 6; // seconds remaining
const S_MAX = 7; // total lifetime
const S_SIZE = 8;
const S_ROT = 9;
const S_SPIN = 10;
const S_R = 11;
const S_G = 12;
const S_B = 13;
const S_A = 14; // peak alpha
const S_STRETCH = 15;
const STRIDE = 16;

interface FamilyTuning {
  gravity: number;
  drag: number;
  /** Size multiplier applied over the particle's life (1 → grow, <1 → shrink). */
  growth: number;
  /** Alpha curve exponent: higher fades out later. */
  fadePower: number;
  /** Lateral swirl acceleration, driven by world time so drifting particles
   *  keep wandering instead of settling into straight lines. */
  turbulence?: number;
}

/**
 * Base class holding the flat particle arrays and the round-robin allocator.
 * Subclasses own the GPU representation and how a live particle is written out.
 */
abstract class Family {
  readonly capacity: number;
  protected readonly state: Float32Array;
  protected readonly tuning: FamilyTuning;
  private cursor = 0;
  protected live = 0;

  constructor(capacity: number, tuning: FamilyTuning) {
    this.capacity = capacity;
    this.state = new Float32Array(capacity * STRIDE);
    this.tuning = tuning;
  }

  /**
   * Claims the next slot. Because the cursor only ever moves forward, the slot
   * it lands on is the oldest allocation in the pool — so a full pool recycles
   * oldest-first, and the pool never grows.
   */
  protected claim(): number {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    return slot * STRIDE;
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    r: number,
    g: number,
    b: number,
    a: number,
    rot: number,
    spin: number,
    stretch = 1,
  ): void {
    const o = this.claim();
    const s = this.state;
    s[o + S_X] = x;
    s[o + S_Y] = y;
    s[o + S_Z] = z;
    s[o + S_VX] = vx;
    s[o + S_VY] = vy;
    s[o + S_VZ] = vz;
    s[o + S_LIFE] = life;
    s[o + S_MAX] = life;
    s[o + S_SIZE] = size;
    s[o + S_ROT] = rot;
    s[o + S_SPIN] = spin;
    s[o + S_R] = r;
    s[o + S_G] = g;
    s[o + S_B] = b;
    s[o + S_A] = a;
    s[o + S_STRETCH] = stretch;
  }

  /** Integrates motion, then re-packs the live subset into the GPU buffers. */
  update(dt: number, elapsed: number): void {
    const s = this.state;
    const { gravity, drag } = this.tuning;
    const turbulence = this.tuning.turbulence ?? 0;
    const damping = Math.exp(-drag * dt);
    let n = 0;
    this.beginWrite();
    for (let i = 0; i < this.capacity; i += 1) {
      const o = i * STRIDE;
      const life = s[o + S_LIFE];
      if (life <= 0) continue;
      const next = life - dt;
      s[o + S_LIFE] = next;
      if (next <= 0) continue;

      s[o + S_VY] -= gravity * dt;
      if (turbulence > 0) {
        // Per-particle phase comes from its spawn rotation, so the swirl is
        // decorrelated across the pool but still fully deterministic.
        const phase = s[o + S_ROT];
        s[o + S_VX] += Math.sin(elapsed * 0.9 + phase) * turbulence * dt;
        s[o + S_VZ] += Math.cos(elapsed * 0.7 + phase * 1.3) * turbulence * dt;
      }
      s[o + S_VX] *= damping;
      s[o + S_VY] *= damping;
      s[o + S_VZ] *= damping;
      s[o + S_X] += s[o + S_VX] * dt;
      s[o + S_Y] += s[o + S_VY] * dt;
      s[o + S_Z] += s[o + S_VZ] * dt;
      s[o + S_ROT] += s[o + S_SPIN] * dt;

      const t = 1 - next / s[o + S_MAX]; // 0 at birth, 1 at death
      const alpha = s[o + S_A] * Math.pow(1 - t, this.tuning.fadePower);
      const size = s[o + S_SIZE] * (1 + (this.tuning.growth - 1) * t);
      this.write(n, o, size, alpha, t);
      n += 1;
    }
    this.live = n;
    this.endWrite(n);
  }

  protected beginWrite(): void {
    /* optional hook */
  }

  protected abstract write(
    index: number,
    offset: number,
    size: number,
    alpha: number,
    t: number,
  ): void;

  protected abstract endWrite(count: number): void;

  abstract get object(): THREE.Object3D;
  abstract dispose(): void;

  get liveCount(): number {
    return this.live;
  }
}

// ---------------------------------------------------------------------------
// Billboard family (sparks / motes / arcs)
// ---------------------------------------------------------------------------

class BillboardFamily extends Family {
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aParam: THREE.InstancedBufferAttribute;

  constructor(capacity: number, tuning: FamilyTuning, shape: 0 | 1 | 2, renderOrder: number) {
    super(capacity, tuning);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_POS.slice(), 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(QUAD_UV.slice(), 2));
    this.geometry.setIndex(QUAD_IDX.slice());

    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aParam = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aOffset.setUsage(THREE.DynamicDrawUsage);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.aParam.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aOffset', this.aOffset);
    this.geometry.setAttribute('aColor', this.aColor);
    this.geometry.setAttribute('aParam', this.aParam);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uShape: { value: shape }, ...fogUniforms() },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = renderOrder;
  }

  protected write(index: number, offset: number, size: number, alpha: number): void {
    const s = this.state;
    const o = this.aOffset.array as Float32Array;
    o[index * 3] = s[offset + S_X];
    o[index * 3 + 1] = s[offset + S_Y];
    o[index * 3 + 2] = s[offset + S_Z];
    const c = this.aColor.array as Float32Array;
    c[index * 4] = s[offset + S_R];
    c[index * 4 + 1] = s[offset + S_G];
    c[index * 4 + 2] = s[offset + S_B];
    c[index * 4 + 3] = alpha;
    const p = this.aParam.array as Float32Array;
    p[index * 3] = size;
    p[index * 3 + 1] = s[offset + S_ROT];
    p[index * 3 + 2] = s[offset + S_STRETCH];
  }

  protected endWrite(count: number): void {
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    if (count > 0) {
      this.aOffset.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aParam.needsUpdate = true;
    }
  }

  get object(): THREE.Object3D {
    return this.mesh;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shard family — chunky 3D debris with real spin
// ---------------------------------------------------------------------------

const SHARD_CACHE_KEY = 'veilhunt-vfx-shard-v1';

const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

class ShardFamily extends Family {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly aTint: THREE.InstancedBufferAttribute;

  constructor(capacity: number, tuning: FamilyTuning) {
    super(capacity, tuning);
    // An irregular wedge reads as broken stone/wood far better than a cube.
    const geometry = new THREE.TetrahedronGeometry(0.5, 0);
    geometry.scale(1, 0.7, 1.35);

    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aTint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aTint', this.aTint);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.05,
      transparent: true,
      depthWrite: true,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute vec4 aTint;
varying vec4 vTint;
${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
	vTint = aTint;`,
      );
      shader.fragmentShader = `varying vec4 vTint;
${shader.fragmentShader}`.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
	diffuseColor.rgb *= vTint.rgb;
	diffuseColor.a *= vTint.a;`,
      );
    };
    this.material.customProgramCacheKey = () => SHARD_CACHE_KEY;

    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  protected write(index: number, offset: number, size: number, alpha: number): void {
    const s = this.state;
    _pos.set(s[offset + S_X], s[offset + S_Y], s[offset + S_Z]);
    const rot = s[offset + S_ROT];
    _euler.set(rot, rot * 0.7, rot * 1.3);
    _quat.setFromEuler(_euler);
    _scale.setScalar(size);
    _mat.compose(_pos, _quat, _scale);
    this.mesh.setMatrixAt(index, _mat);
    const t = this.aTint.array as Float32Array;
    t[index * 4] = s[offset + S_R];
    t[index * 4 + 1] = s[offset + S_G];
    t[index * 4 + 2] = s[offset + S_B];
    t[index * 4 + 3] = clamp(alpha, 0, 1);
  }

  protected endWrite(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    if (count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.aTint.needsUpdate = true;
    }
  }

  get object(): THREE.Object3D {
    return this.mesh;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Ring family — flat expanding ground shockwaves
// ---------------------------------------------------------------------------

const RING_CACHE_KEY = 'veilhunt-vfx-ring-v1';

class RingFamily extends Family {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly aTint: THREE.InstancedBufferAttribute;

  constructor(capacity: number, tuning: FamilyTuning) {
    super(capacity, tuning);
    const geometry = new THREE.RingGeometry(0.78, 1, 40, 1);
    geometry.rotateX(-Math.PI / 2);

    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aTint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aTint', this.aTint);

    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute vec4 aTint;
varying vec4 vTint;
${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
	vTint = aTint;`,
      );
      shader.fragmentShader = `varying vec4 vTint;
${shader.fragmentShader}`.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
	diffuseColor.rgb *= vTint.rgb;
	diffuseColor.a *= vTint.a;`,
      );
    };
    this.material.customProgramCacheKey = () => RING_CACHE_KEY;

    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  protected write(index: number, offset: number, size: number, alpha: number): void {
    const s = this.state;
    _pos.set(s[offset + S_X], s[offset + S_Y], s[offset + S_Z]);
    _euler.set(0, s[offset + S_ROT], 0);
    _quat.setFromEuler(_euler);
    // Rings expand outward while keeping a thin, bright leading edge.
    _scale.set(size, 1, size);
    _mat.compose(_pos, _quat, _scale);
    this.mesh.setMatrixAt(index, _mat);
    const t = this.aTint.array as Float32Array;
    t[index * 4] = s[offset + S_R];
    t[index * 4 + 1] = s[offset + S_G];
    t[index * 4 + 2] = s[offset + S_B];
    t[index * 4 + 3] = clamp(alpha, 0, 1);
  }

  protected endWrite(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    if (count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.aTint.needsUpdate = true;
    }
  }

  get object(): THREE.Object3D {
    return this.mesh;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Effect recipes
// ---------------------------------------------------------------------------

type FamilyName = 'sparks' | 'motes' | 'shards' | 'rings' | 'arcs';

interface Burst {
  family: FamilyName;
  /** Particle count at `strength` 1, before the quality scale. */
  count: number;
  speed: [number, number];
  /** Upward velocity bias added on top of the radial spread. */
  lift: [number, number];
  life: [number, number];
  size: [number, number];
  color: [number, number, number];
  /** Secondary colour; each particle lerps between the two. */
  color2: [number, number, number];
  alpha: number;
  spin: [number, number];
  /** 0 = flat disc spread, 1 = full sphere. */
  sphericity: number;
  stretch?: number;
}

const WHITE: [number, number, number] = [1, 1, 1];
const CYAN: [number, number, number] = [0.44, 0.92, 1];
const PALE_CYAN: [number, number, number] = [0.81, 0.98, 1];
const AMBER: [number, number, number] = [1, 0.71, 0.36];
const MINT: [number, number, number] = [0.5, 1, 0.77];
const DUST: [number, number, number] = [0.44, 0.41, 0.36];
const WOOD: [number, number, number] = [0.29, 0.21, 0.14];
const STONE: [number, number, number] = [0.42, 0.44, 0.48];
const WATER: [number, number, number] = [0.62, 0.82, 0.92];

/** Each kind is one or more bursts fired together. */
const RECIPES: Record<VfxKind, Burst[]> = {
  bladeImpact: [
    {
      family: 'sparks',
      count: 26,
      speed: [3.2, 9.5],
      lift: [0.4, 2.6],
      life: [0.16, 0.42],
      size: [0.045, 0.12],
      color: PALE_CYAN,
      color2: WHITE,
      alpha: 1,
      spin: [-8, 8],
      sphericity: 1,
      stretch: 2.2,
    },
    {
      family: 'rings',
      count: 1,
      speed: [0, 0],
      lift: [0, 0],
      life: [0.3, 0.34],
      size: [0.5, 0.6],
      color: PALE_CYAN,
      color2: CYAN,
      alpha: 0.9,
      spin: [0, 0],
      sphericity: 0,
    },
  ],
  bladeMiss: [
    {
      family: 'arcs',
      count: 1,
      speed: [0, 0],
      lift: [0, 0],
      life: [0.2, 0.26],
      size: [2.1, 2.5],
      color: PALE_CYAN,
      color2: CYAN,
      alpha: 0.34,
      spin: [-1.4, -0.9],
      sphericity: 0,
      stretch: 2.6,
    },
  ],
  sealPulse: [
    {
      family: 'motes',
      count: 16,
      speed: [0.25, 0.9],
      lift: [0.8, 2.1],
      life: [0.9, 1.7],
      size: [0.1, 0.24],
      color: CYAN,
      color2: PALE_CYAN,
      alpha: 0.75,
      spin: [-1, 1],
      sphericity: 0.25,
    },
  ],
  sealComplete: [
    {
      family: 'motes',
      count: 52,
      speed: [0.7, 2.6],
      lift: [3.4, 8.2],
      life: [1.1, 2.3],
      size: [0.14, 0.4],
      color: CYAN,
      color2: PALE_CYAN,
      alpha: 0.95,
      spin: [-1.6, 1.6],
      sphericity: 0.35,
    },
    {
      family: 'sparks',
      count: 22,
      speed: [2.2, 6],
      lift: [2, 6],
      life: [0.4, 0.9],
      size: [0.05, 0.12],
      color: PALE_CYAN,
      color2: WHITE,
      alpha: 1,
      spin: [-5, 5],
      sphericity: 0.6,
    },
    {
      family: 'rings',
      count: 1,
      speed: [0, 0],
      lift: [0, 0],
      life: [0.95, 1.1],
      size: [1.1, 1.3],
      color: CYAN,
      color2: PALE_CYAN,
      alpha: 0.85,
      spin: [0, 0],
      sphericity: 0,
    },
  ],
  gateOpen: [
    {
      family: 'rings',
      count: 2,
      speed: [0, 0],
      lift: [0, 0],
      life: [1.5, 1.9],
      size: [1.4, 2],
      color: CYAN,
      color2: PALE_CYAN,
      alpha: 0.8,
      spin: [0, 0],
      sphericity: 0,
    },
    {
      family: 'motes',
      count: 44,
      speed: [1.6, 5.5],
      lift: [1.2, 4.4],
      life: [1.2, 2.4],
      size: [0.18, 0.5],
      color: CYAN,
      color2: PALE_CYAN,
      alpha: 0.7,
      spin: [-1, 1],
      sphericity: 0.15,
    },
  ],
  wardBurst: [
    {
      family: 'sparks',
      count: 40,
      speed: [4.5, 13],
      lift: [1.5, 5],
      life: [0.22, 0.6],
      size: [0.06, 0.16],
      color: WHITE,
      color2: PALE_CYAN,
      alpha: 1,
      spin: [-9, 9],
      sphericity: 1,
      stretch: 1.8,
    },
    {
      family: 'rings',
      count: 1,
      speed: [0, 0],
      lift: [0, 0],
      life: [0.42, 0.5],
      size: [1.2, 1.4],
      color: WHITE,
      color2: PALE_CYAN,
      alpha: 1,
      spin: [0, 0],
      sphericity: 0,
    },
  ],
  snareSnap: [
    {
      family: 'sparks',
      count: 20,
      speed: [2.6, 7.5],
      lift: [1.2, 3.6],
      life: [0.18, 0.46],
      size: [0.035, 0.09],
      color: AMBER,
      color2: WHITE,
      alpha: 1,
      spin: [-8, 8],
      sphericity: 0.8,
      stretch: 2,
    },
    {
      family: 'motes',
      count: 12,
      speed: [0.6, 2.2],
      lift: [0.3, 1.2],
      life: [0.5, 1.1],
      size: [0.14, 0.34],
      color: DUST,
      color2: STONE,
      alpha: 0.42,
      spin: [-0.8, 0.8],
      sphericity: 0.1,
    },
  ],
  boltImpact: [
    {
      family: 'sparks',
      count: 14,
      speed: [2, 6.2],
      lift: [0.6, 2.4],
      life: [0.14, 0.36],
      size: [0.035, 0.085],
      color: CYAN,
      color2: PALE_CYAN,
      alpha: 1,
      spin: [-7, 7],
      sphericity: 0.9,
      stretch: 2,
    },
    {
      family: 'shards',
      count: 6,
      speed: [1.4, 4],
      lift: [1.4, 3.6],
      life: [0.5, 1.1],
      size: [0.05, 0.11],
      color: STONE,
      color2: DUST,
      alpha: 1,
      spin: [-9, 9],
      sphericity: 0.5,
    },
  ],
  footDust: [
    {
      family: 'motes',
      count: 7,
      speed: [0.35, 1.15],
      lift: [0.15, 0.65],
      life: [0.36, 0.78],
      size: [0.1, 0.24],
      color: DUST,
      color2: STONE,
      alpha: 0.34,
      spin: [-0.7, 0.7],
      sphericity: 0.06,
    },
  ],
  waterSplash: [
    {
      family: 'motes',
      count: 20,
      speed: [1.1, 3.6],
      lift: [1.8, 4.6],
      life: [0.4, 0.9],
      size: [0.05, 0.15],
      color: WATER,
      color2: WHITE,
      alpha: 0.72,
      spin: [-2, 2],
      sphericity: 0.35,
    },
    {
      family: 'rings',
      count: 1,
      speed: [0, 0],
      lift: [0, 0],
      life: [0.5, 0.6],
      size: [0.5, 0.7],
      color: WATER,
      color2: WHITE,
      alpha: 0.5,
      spin: [0, 0],
      sphericity: 0,
    },
  ],
  breachDebris: [
    {
      family: 'shards',
      count: 22,
      speed: [2.4, 7.5],
      lift: [2.2, 6.4],
      life: [0.9, 1.9],
      size: [0.08, 0.22],
      color: WOOD,
      color2: STONE,
      alpha: 1,
      spin: [-12, 12],
      sphericity: 0.6,
    },
    {
      family: 'motes',
      count: 16,
      speed: [0.8, 2.8],
      lift: [0.5, 2],
      life: [0.7, 1.5],
      size: [0.2, 0.5],
      color: DUST,
      color2: STONE,
      alpha: 0.46,
      spin: [-0.9, 0.9],
      sphericity: 0.15,
    },
  ],
  healPulse: [
    {
      family: 'motes',
      count: 26,
      speed: [0.35, 1.3],
      lift: [1, 2.6],
      life: [1.1, 2.1],
      size: [0.1, 0.26],
      color: MINT,
      color2: PALE_CYAN,
      alpha: 0.7,
      spin: [-0.8, 0.8],
      sphericity: 0.3,
    },
    {
      family: 'rings',
      count: 1,
      speed: [0, 0],
      lift: [0, 0],
      life: [0.9, 1],
      size: [0.7, 0.85],
      color: MINT,
      color2: PALE_CYAN,
      alpha: 0.6,
      spin: [0, 0],
      sphericity: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

class Vfx implements VfxSystem {
  readonly root = new THREE.Group();

  private readonly rng: Rng;
  private readonly families: Record<FamilyName, Family>;
  private readonly all: Family[];
  /** Halved on `low`. */
  private readonly countScale: number;

  constructor(quality: QualityLevel) {
    this.root.name = 'vfx';
    this.rng = createRng(VFX_SEED);
    const low = quality === 'low';
    this.countScale = low ? 0.5 : 1;
    const cap = (n: number): number => (low ? Math.ceil(n / 2) : n);

    this.families = {
      // Sparks: heavy gravity, strong drag — they die fast and close.
      sparks: new BillboardFamily(cap(512), { gravity: 14, drag: 3.4, growth: 0.5, fadePower: 1.4 }, 0, 6),
      // Motes: buoyant and slow, they hang in the air and wander.
      motes: new BillboardFamily(
        cap(384),
        { gravity: -0.35, drag: 1.5, growth: 1.7, fadePower: 1.9, turbulence: 0.9 },
        1,
        5,
      ),
      // Arcs: static slashes that flare and vanish.
      arcs: new BillboardFamily(cap(16), { gravity: 0, drag: 0.5, growth: 1.5, fadePower: 1.1 }, 2, 6),
      // Shards: real debris that falls and tumbles.
      shards: new ShardFamily(cap(96), { gravity: 19, drag: 0.5, growth: 1, fadePower: 0.7 }),
      // Rings: expanding ground waves.
      rings: new RingFamily(cap(24), { gravity: 0, drag: 0, growth: 7, fadePower: 1.6 }),
    };

    this.all = [
      this.families.shards,
      this.families.rings,
      this.families.motes,
      this.families.sparks,
      this.families.arcs,
    ];
    for (const f of this.all) this.root.add(f.object);
  }

  spawn(kind: VfxKind, x: number, y: number, z: number, strength = 1): void {
    const recipe = RECIPES[kind];
    if (!recipe) return;
    const power = clamp(strength, 0, 3);
    if (power <= 0) return;
    const rng = this.rng;

    for (const burst of recipe) {
      const family = this.families[burst.family];
      const count = Math.max(1, Math.round(burst.count * this.countScale * Math.min(power, 1.6)));
      for (let i = 0; i < count; i += 1) {
        // Direction: a disc spread lifted toward a sphere by `sphericity`.
        const theta = rng() * TAU;
        const flat = Math.sqrt(rng());
        const vertical = (rng() * 2 - 1) * burst.sphericity;
        const horizontal = Math.sqrt(Math.max(0, 1 - vertical * vertical));
        const speed = rng.range(burst.speed[0], burst.speed[1]) * (0.6 + power * 0.4);
        const dx = Math.cos(theta) * horizontal * flat;
        const dz = Math.sin(theta) * horizontal * flat;
        const lift = rng.range(burst.lift[0], burst.lift[1]) * (0.6 + power * 0.4);

        const mix = rng();
        const r = burst.color[0] + (burst.color2[0] - burst.color[0]) * mix;
        const g = burst.color[1] + (burst.color2[1] - burst.color[1]) * mix;
        const b = burst.color[2] + (burst.color2[2] - burst.color[2]) * mix;

        const jitter = burst.family === 'rings' || burst.family === 'arcs' ? 0 : 0.12;
        family.emit(
          x + (rng() - 0.5) * jitter,
          y + (rng() - 0.5) * jitter,
          z + (rng() - 0.5) * jitter,
          dx * speed,
          vertical * speed + lift,
          dz * speed,
          rng.range(burst.life[0], burst.life[1]),
          rng.range(burst.size[0], burst.size[1]) * (0.75 + power * 0.35),
          r,
          g,
          b,
          clamp(burst.alpha * (0.7 + power * 0.3), 0, 1),
          rng.range(0, TAU),
          rng.range(burst.spin[0], burst.spin[1]),
          burst.stretch ?? 1,
        );
      }
    }
  }

  update(dt: number, elapsed: number): void {
    // Clamped so a stalled tab cannot teleport every live particle.
    const step = clamp(dt, 0, 0.1);
    for (const f of this.all) f.update(step, elapsed);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    for (const f of this.all) f.dispose();
    this.all.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVfxSystem(quality: QualityLevel): VfxSystem {
  return new Vfx(quality);
}
