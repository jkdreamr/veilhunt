/**
 * Procedural texture generation.
 *
 * Every texel in Veil Hunt is authored here at load time from the map seed —
 * there are no image assets to ship or wait on. Pixels are rasterised into a
 * plain RGBA byte buffer by the small `Raster` helper below and then wrapped in
 * a `THREE.CanvasTexture` when a DOM canvas is available (the browser), or a
 * `THREE.DataTexture` when it is not (headless construction, tests, SSR).
 * Both paths produce byte-identical texels, so the world builds and can be
 * inspected without a WebGL context.
 *
 * Height fields are kept alongside the colour buffer so normal maps can be
 * derived with a Sobel filter instead of being authored twice.
 */

import * as THREE from 'three';
import type { MapData, Zone } from '../../shared/types.js';
import { createRng, hashString, type Rng } from '../../shared/rng.js';
import { MAP_SIZE } from '../../shared/constants.js';
import { PALETTE, TEXTURE_SIZE } from './palette.js';

// ---------------------------------------------------------------------------
// Small colour helpers (all in sRGB display space)
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function rgb(hex: number): Rgb {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smoothstep between two edges, matching GLSL semantics. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Wrapping value noise
// ---------------------------------------------------------------------------

/** One octave of tileable bilinear value noise, in 0..1. */
function noiseLayer(width: number, height: number, cells: number, rng: Rng): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i += 1) grid[i] = rng();
  const out = new Float32Array(width * height);
  const sx = cells / width;
  const sy = cells / height;
  for (let y = 0; y < height; y += 1) {
    const fy = y * sy;
    const iy = Math.floor(fy);
    const y0 = iy % cells;
    const y1 = (y0 + 1) % cells;
    const ty = smootherstep(fy - iy);
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const fx = x * sx;
      const ix = Math.floor(fx);
      const x0 = ix % cells;
      const x1 = (x0 + 1) % cells;
      const tx = smootherstep(fx - ix);
      const a = grid[y0 * cells + x0];
      const b = grid[y0 * cells + x1];
      const c = grid[y1 * cells + x0];
      const d = grid[y1 * cells + x1];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      out[row + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** Fractal sum of tileable value noise, normalised to 0..1. */
function fbm(
  width: number,
  height: number,
  cells: number,
  octaves: number,
  rng: Rng,
): Float32Array {
  const out = new Float32Array(width * height);
  let amp = 1;
  let total = 0;
  let c = cells;
  for (let o = 0; o < octaves; o += 1) {
    const layer = noiseLayer(width, height, c, rng);
    for (let i = 0; i < out.length; i += 1) out[i] += layer[i] * amp;
    total += amp;
    amp *= 0.5;
    c *= 2;
  }
  const inv = 1 / total;
  for (let i = 0; i < out.length; i += 1) out[i] *= inv;
  return out;
}

// ---------------------------------------------------------------------------
// Raster: an RGBA byte buffer plus a parallel height field
// ---------------------------------------------------------------------------

class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly depth: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.depth = new Float32Array(width * height);
  }

  fill(color: Rgb, alpha = 255): void {
    const { data } = this;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = alpha;
    }
  }

  /** Alpha-blends a colour over a single texel. `alpha` is 0..1. */
  blend(x: number, y: number, color: Rgb, alpha: number, wrap: boolean): void {
    let px = x;
    let py = y;
    if (wrap) {
      px = ((px % this.width) + this.width) % this.width;
      py = ((py % this.height) + this.height) % this.height;
    } else if (px < 0 || py < 0 || px >= this.width || py >= this.height) {
      return;
    }
    const a = clamp01(alpha);
    if (a <= 0) return;
    const i = (py * this.width + px) * 4;
    const { data } = this;
    data[i] += (color.r - data[i]) * a;
    data[i + 1] += (color.g - data[i + 1]) * a;
    data[i + 2] += (color.b - data[i + 2]) * a;
  }

  setAlpha(x: number, y: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data[(y * this.width + x) * 4 + 3] = alpha * 255;
  }

  addDepth(x: number, y: number, amount: number, wrap: boolean): void {
    let px = x;
    let py = y;
    if (wrap) {
      px = ((px % this.width) + this.width) % this.width;
      py = ((py % this.height) + this.height) % this.height;
    } else if (px < 0 || py < 0 || px >= this.width || py >= this.height) {
      return;
    }
    this.depth[py * this.width + px] += amount;
  }

  /** Soft-edged disc of colour and (optionally) height. */
  disc(
    cx: number,
    cy: number,
    radius: number,
    color: Rgb,
    alpha: number,
    wrap: boolean,
    depthAmount = 0,
    hardness = 0.55,
  ): void {
    if (radius <= 0) return;
    const x0 = Math.floor(cx - radius);
    const x1 = Math.ceil(cx + radius);
    const y0 = Math.floor(cy - radius);
    const y1 = Math.ceil(cy + radius);
    const inner = radius * hardness;
    for (let y = y0; y <= y1; y += 1) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - cx;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius) continue;
        const f = 1 - smoothstep(inner, radius, d);
        if (f <= 0) continue;
        this.blend(x, y, color, alpha * f, wrap);
        if (depthAmount !== 0) this.addDepth(x, y, depthAmount * f, wrap);
      }
    }
  }

  /** Stamps discs along a segment; the workhorse for cracks, blades and paths. */
  stroke(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width0: number,
    width1: number,
    color: Rgb,
    alpha: number,
    wrap: boolean,
    depthAmount = 0,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(len / Math.max(0.4, Math.min(width0, width1) * 0.45)));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      this.disc(
        x0 + dx * t,
        y0 + dy * t,
        width0 + (width1 - width0) * t,
        color,
        alpha,
        wrap,
        depthAmount,
      );
    }
  }

  /** Turns the height field into a tangent-space normal map texture. */
  toNormalTexture(strength: number, wrap: boolean): THREE.Texture {
    const { width, height, depth } = this;
    const out = new Uint8ClampedArray(width * height * 4);
    const at = (x: number, y: number): number => {
      let px = x;
      let py = y;
      if (wrap) {
        px = ((px % width) + width) % width;
        py = ((py % height) + height) % height;
      } else {
        px = px < 0 ? 0 : px >= width ? width - 1 : px;
        py = py < 0 ? 0 : py >= height ? height - 1 : py;
      }
      return depth[py * width + px];
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const l = at(x - 1, y);
        const r = at(x + 1, y);
        const d = at(x, y - 1);
        const u = at(x, y + 1);
        let nx = (l - r) * strength;
        let ny = (d - u) * strength;
        let nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv;
        ny *= inv;
        nz *= inv;
        const i = (y * width + x) * 4;
        out[i] = (nx * 0.5 + 0.5) * 255;
        out[i + 1] = (ny * 0.5 + 0.5) * 255;
        out[i + 2] = (nz * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }
    return makeTexture(width, height, out, { srgb: false, wrap });
  }

  toTexture(opts: { srgb?: boolean; wrap?: boolean } = {}): THREE.Texture {
    return makeTexture(this.width, this.height, this.data, {
      srgb: opts.srgb !== false,
      wrap: opts.wrap !== false,
    });
  }
}

// ---------------------------------------------------------------------------
// Texture construction (canvas when available, raw data otherwise)
// ---------------------------------------------------------------------------

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function makeTexture(
  width: number,
  height: number,
  data: Uint8ClampedArray,
  opts: { srgb: boolean; wrap: boolean },
): THREE.Texture {
  let texture: THREE.Texture | null = null;
  if (hasDom()) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const image = ctx.createImageData(width, height);
      image.data.set(data);
      ctx.putImageData(image, 0, 0);
      texture = new THREE.CanvasTexture(canvas);
    }
  }
  if (!texture) {
    texture = new THREE.DataTexture(new Uint8Array(data), width, height, THREE.RGBAFormat);
    texture.needsUpdate = true;
  }
  // Normalise both paths so canvas and data textures sample identically.
  texture.flipY = false;
  texture.wrapS = opts.wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = texture.wrapS;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Non-tiling macro layer covering the whole 132x132 map exactly once.
 *
 * RGB is a *modulation* around neutral 0.5 (so `diffuse * macro * 2` is a
 * no-op at 128) and A is a roughness control (0.5 neutral, lower = wetter).
 * Mud, foliage, water and shadow zones plus worn footpaths are all baked in
 * here, so zone tinting costs nothing at render time.
 */
function buildGroundMacro(map: MapData, rng: Rng): THREE.Texture {
  const size = TEXTURE_SIZE.groundMacro;
  const raster = new Raster(size, size);
  const neutral: Rgb = { r: 128, g: 128, b: 128 };
  raster.fill(neutral, 128);

  const broad = fbm(size, size, 5, 4, rng);
  const grit = fbm(size, size, 22, 3, rng);
  const { data } = raster;
  for (let i = 0, p = 0; i < broad.length; i += 1, p += 4) {
    const v = broad[i] * 0.72 + grit[i] * 0.28;
    // +-14% broad tonal drift, with a faint cool cast in the darker hollows.
    const scale = 0.86 + v * 0.3;
    data[p] = 128 * scale;
    data[p + 1] = 128 * scale * (1 + (0.5 - v) * 0.03);
    data[p + 2] = 128 * scale * (1 + (0.5 - v) * 0.07);
  }

  const toPx = (world: number): number => (world / MAP_SIZE + 0.5) * size;
  const pxPerUnit = size / MAP_SIZE;

  // Worn footpaths between landmarks: the strongest readability win on the
  // ground, and free because it is baked.
  const routes: [number, number, number, number][] = [
    [0, -60, 0, -12],
    [0, 12, 0, 48],
    [-8, -6, -34, -30],
    [8, -6, 34, -30],
    [-8, 12, -32, 30],
    [8, 12, 32, 30],
    [-34, -30, -34, 30],
    [34, -30, 34, 30],
    [-20, 2, 20, 2],
  ];
  const pathColor = mixRgb(neutral, { r: 176, g: 168, b: 152 }, 0.5);
  for (const [ax, az, bx, bz] of routes) {
    const segs = 9;
    let px = toPx(ax);
    let py = toPx(az);
    for (let s = 1; s <= segs; s += 1) {
      const t = s / segs;
      const jitter = Math.sin(t * Math.PI) * rng.range(-5, 5);
      const nx = bx - ax;
      const nz = bz - az;
      const nlen = Math.max(0.001, Math.hypot(nx, nz));
      const qx = toPx(ax + nx * t + (-nz / nlen) * jitter);
      const qy = toPx(az + nz * t + (nx / nlen) * jitter);
      const w = rng.range(1.5, 2.6) * pxPerUnit;
      raster.stroke(px, py, qx, qy, w, w, pathColor, 0.5, false);
      px = qx;
      py = qy;
    }
  }

  // Zone tints. Drawn after paths so a mud pit reads over a trail.
  const zoneTint = (zone: Zone): { color: Rgb; alpha: number; rough: number } | null => {
    switch (zone.kind) {
      case 'mud':
        return { color: mixRgb(neutral, rgb(PALETTE.mud), 0.9), alpha: 0.82, rough: 0.2 };
      case 'foliage':
        return { color: mixRgb(neutral, rgb(PALETTE.hedge), 0.62), alpha: 0.62, rough: 0.72 };
      case 'water':
        return { color: mixRgb(neutral, { r: 20, g: 30, b: 34 }, 0.9), alpha: 0.9, rough: 0.08 };
      case 'shadow':
        return { color: { r: 74, g: 80, b: 92 }, alpha: 0.4, rough: 0.5 };
      default:
        return null;
    }
  };

  for (const zone of map.zones) {
    const tint = zoneTint(zone);
    if (!tint) continue;
    const cx = toPx(zone.x);
    const cy = toPx(zone.z);
    const rad = zone.radius * pxPerUnit;
    const x0 = Math.max(0, Math.floor(cx - rad - 2));
    const x1 = Math.min(size - 1, Math.ceil(cx + rad + 2));
    const y0 = Math.max(0, Math.floor(cy - rad - 2));
    const y1 = Math.min(size - 1, Math.ceil(cy + rad + 2));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / rad;
        if (d > 1) continue;
        // Ragged edge: modulate the falloff with the grit octave so zone
        // borders never read as perfect circles.
        const n = grit[y * size + x];
        const edge = 1 - smoothstep(0.52 + n * 0.22, 1.02, d);
        if (edge <= 0.002) continue;
        const a = tint.alpha * edge;
        raster.blend(x, y, tint.color, a, false);
        const p = (y * size + x) * 4 + 3;
        data[p] += (tint.rough * 255 - data[p]) * a;
      }
    }
  }

  return raster.toTexture({ srgb: true, wrap: false });
}

/** Tiling close-up dirt/stone grain with cracks and embedded gravel. */
function buildGroundDetail(rng: Rng): { map: THREE.Texture; normal: THREE.Texture } {
  const size = TEXTURE_SIZE.groundDetail;
  const raster = new Raster(size, size);
  // Albedo maps are authored as near-white *detail modulations*: the palette
  // colour on the material is the real albedo, so a mid-grey texture here would
  // multiply the surface down into near-black under moonlight.
  const base = rgb(0xd4d1c9);
  const pale = rgb(0xf4f0e6);
  const dark = rgb(0x9a978f);
  raster.fill(base);

  const coarse = fbm(size, size, 6, 4, rng);
  const fine = fbm(size, size, 40, 3, rng);
  const { data, depth } = raster;
  for (let i = 0, p = 0; i < coarse.length; i += 1, p += 4) {
    const v = clamp01(coarse[i] * 0.62 + fine[i] * 0.38);
    const c = v < 0.5 ? mixRgb(dark, base, v * 2) : mixRgb(base, pale, (v - 0.5) * 2);
    data[p] = c.r;
    data[p + 1] = c.g;
    data[p + 2] = c.b;
    data[p + 3] = 255;
    depth[i] = v * 0.35;
  }

  // Gravel: small raised pebbles catching the moonlight.
  for (let i = 0; i < 320; i += 1) {
    const r = rng.range(1.4, 4.2);
    raster.disc(
      rng.range(0, size),
      rng.range(0, size),
      r,
      mixRgb(base, pale, rng.range(0.35, 1)),
      rng.range(0.35, 0.75),
      true,
      rng.range(0.5, 1.1),
      0.25,
    );
  }

  // Cracks: wandering polylines carved into the height field.
  for (let i = 0; i < 26; i += 1) {
    let x = rng.range(0, size);
    let y = rng.range(0, size);
    let angle = rng.range(0, Math.PI * 2);
    const segments = rng.int(5, 11);
    let width = rng.range(1.1, 2.3);
    for (let s = 0; s < segments; s += 1) {
      angle += rng.range(-0.65, 0.65);
      const len = rng.range(9, 26);
      const nx = x + Math.cos(angle) * len;
      const ny = y + Math.sin(angle) * len;
      const nextWidth = Math.max(0.5, width * rng.range(0.72, 1.02));
      raster.stroke(x, y, nx, ny, width, nextWidth, dark, 0.62, true, -1.5);
      x = nx;
      y = ny;
      width = nextWidth;
    }
  }

  return {
    map: raster.toTexture({ srgb: true, wrap: true }),
    normal: raster.toNormalTexture(1.9, true),
  };
}

/** Tiling ashlar masonry: coursed blocks, recessed mortar, chipped corners. */
function buildStone(rng: Rng): { map: THREE.Texture; normal: THREE.Texture } {
  const size = TEXTURE_SIZE.stone;
  const raster = new Raster(size, size);
  const base = rgb(0xdededc);
  const light = rgb(0xfaf8f2);
  const shade = rgb(0xb0b0b5);
  const mortar = rgb(0x8a8a90);

  const rows = 8;
  const rowH = size / rows;
  const grain = fbm(size, size, 30, 4, rng);
  const stain = fbm(size, size, 5, 3, rng);

  // Per-block tone jitter, resolved deterministically from a block hash.
  const blockTone = new Float32Array(rows * 8);
  for (let i = 0; i < blockTone.length; i += 1) blockTone[i] = rng.range(-0.18, 0.18);

  const { data, depth } = raster;
  for (let y = 0; y < size; y += 1) {
    const row = Math.floor(y / rowH);
    const cols = 3 + (row % 3);
    const bw = size / cols;
    const offset = ((row * bw * 0.5) % size) + (row % 2) * bw * 0.17;
    const edgeY = Math.min(y - row * rowH, (row + 1) * rowH - y);
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const p = i * 4;
      const bxf = (((x + offset) % size) + size) % size;
      const col = Math.floor(bxf / bw);
      const inCol = bxf - col * bw;
      const edgeX = Math.min(inCol, bw - inCol);
      const tone = blockTone[(row * 8 + col) % blockTone.length];

      const g = grain[i];
      let c = g < 0.5 ? mixRgb(shade, base, g * 2) : mixRgb(base, light, (g - 0.5) * 2);
      c = mixRgb(c, tone > 0 ? light : shade, Math.abs(tone));
      // Damp, dark staining creeping up from the base of every course.
      const damp = clamp01(stain[i] * 1.25 - 0.28);
      c = mixRgb(c, shade, damp * 0.35);

      const gap = Math.min(edgeX, edgeY);
      const mortarMask = 1 - smoothstep(2.5, 5.5, gap);
      c = mixRgb(c, mortar, mortarMask * 0.85);

      // A soft bevel highlight on the upper-left of each block.
      const bevel = (1 - smoothstep(4, 13, edgeY)) * (y - row * rowH < rowH * 0.5 ? 1 : -0.7);
      c = mixRgb(c, bevel > 0 ? light : shade, Math.abs(bevel) * 0.16);

      data[p] = c.r;
      data[p + 1] = c.g;
      data[p + 2] = c.b;
      data[p + 3] = 255;
      depth[i] = (1 - mortarMask) * 1.9 + g * 0.55;
    }
  }

  // Chips knocked out of block corners and faces.
  for (let i = 0; i < 90; i += 1) {
    raster.disc(
      rng.range(0, size),
      rng.range(0, size),
      rng.range(2, 6.5),
      shade,
      rng.range(0.3, 0.6),
      true,
      -rng.range(0.6, 1.6),
      0.2,
    );
  }

  return {
    map: raster.toTexture({ srgb: true, wrap: true }),
    normal: raster.toNormalTexture(1.35, true),
  };
}

/** Tiling dense leaf mass for hedges. */
function buildHedge(rng: Rng): { map: THREE.Texture; normal: THREE.Texture } {
  const size = TEXTURE_SIZE.small;
  const raster = new Raster(size, size);
  const deep = rgb(0x8a9487);
  const mid = rgb(0xc8d2c2);
  const tip = rgb(0xf0f6e6);
  raster.fill(deep);

  const clump = fbm(size, size, 9, 4, rng);
  const { data, depth } = raster;
  for (let i = 0, p = 0; i < clump.length; i += 1, p += 4) {
    const v = clump[i];
    const c = v < 0.55 ? mixRgb(deep, mid, v / 0.55) : mixRgb(mid, tip, (v - 0.55) / 0.45);
    data[p] = c.r;
    data[p + 1] = c.g;
    data[p + 2] = c.b;
    data[p + 3] = 255;
    depth[i] = v * 1.4;
  }
  // Individual leaves catching light on top of the mass.
  for (let i = 0; i < 900; i += 1) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(1.2, 3.4);
    const lit = rng.bool(0.42);
    raster.disc(
      x,
      y,
      r,
      lit ? tip : deep,
      rng.range(0.25, 0.6),
      true,
      lit ? 0.8 : -0.5,
      0.15,
    );
  }
  return {
    map: raster.toTexture({ srgb: true, wrap: true }),
    normal: raster.toNormalTexture(2.2, true),
  };
}

/**
 * Alpha-cut grass card: a handful of tapered blades.
 *
 * Roots are drawn at image row 0 and tips at increasing rows. Textures are
 * uploaded with `flipY = false`, so row 0 is v = 0, which is where the card
 * geometry puts the planted base.
 */
function buildGrassCard(rng: Rng): THREE.Texture {
  const size = TEXTURE_SIZE.tiny;
  const raster = new Raster(size, size);
  raster.fill(rgb(0xc8d2c2), 0);
  const root = rgb(0x8d9a86);
  const tip = rgb(0xf2f8e6);

  const blades = 9;
  for (let i = 0; i < blades; i += 1) {
    const x0 = ((i + 0.5) / blades) * size + rng.range(-4, 4);
    const lean = rng.range(-0.34, 0.34);
    const bladeHeight = rng.range(size * 0.52, size * 0.97);
    const w0 = rng.range(2.4, 4.2);
    const steps = 9;
    let px = x0;
    let py = 0;
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const qy = bladeHeight * t;
      const qx = x0 + lean * size * t * t;
      const w = w0 * (1 - t * 0.86);
      const color = mixRgb(root, tip, t);
      const stepsAlong = Math.max(1, Math.ceil(Math.abs(py - qy) / 0.8));
      for (let k = 0; k <= stepsAlong; k += 1) {
        const kt = k / stepsAlong;
        const cx = px + (qx - px) * kt;
        const cy = py + (qy - py) * kt;
        const rad = Math.max(0.6, w);
        for (let yy = Math.floor(cy - rad); yy <= Math.ceil(cy + rad); yy += 1) {
          for (let xx = Math.floor(cx - rad); xx <= Math.ceil(cx + rad); xx += 1) {
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
            if (d > rad) continue;
            const a = 1 - smoothstep(rad * 0.4, rad, d);
            if (a <= 0) continue;
            raster.blend(xx, yy, color, a, false);
            const idx = (yy * size + xx) * 4 + 3;
            if (raster.data[idx] < a * 255) raster.setAlpha(xx, yy, a);
          }
        }
      }
      px = qx;
      py = qy;
    }
  }
  return raster.toTexture({ srgb: true, wrap: false });
}

/** Tiling pitted wrought iron. */
function buildIron(rng: Rng): { map: THREE.Texture; normal: THREE.Texture } {
  const size = TEXTURE_SIZE.small;
  const raster = new Raster(size, size);
  const base = rgb(0xd8dce2);
  const rust = rgb(0xc08a62);
  const deep = rgb(0x8d939d);
  const grain = fbm(size, size, 26, 4, rng);
  const patch = fbm(size, size, 6, 3, rng);
  const { data, depth } = raster;
  for (let i = 0, p = 0; i < grain.length; i += 1, p += 4) {
    const v = grain[i];
    let c = mixRgb(deep, base, v);
    c = mixRgb(c, rust, clamp01(patch[i] * 1.5 - 0.72) * 0.7);
    data[p] = c.r;
    data[p + 1] = c.g;
    data[p + 2] = c.b;
    data[p + 3] = 255;
    depth[i] = v * 0.5;
  }
  for (let i = 0; i < 260; i += 1) {
    raster.disc(
      rng.range(0, size),
      rng.range(0, size),
      rng.range(0.8, 2.6),
      deep,
      rng.range(0.2, 0.5),
      true,
      -rng.range(0.4, 1),
      0.15,
    );
  }
  return {
    map: raster.toTexture({ srgb: true, wrap: true }),
    normal: raster.toNormalTexture(1.6, true),
  };
}

/** Tiling weathered plank grain, oriented along the texture's U axis. */
function buildWood(rng: Rng): { map: THREE.Texture; normal: THREE.Texture } {
  const size = TEXTURE_SIZE.small;
  const raster = new Raster(size, size);
  const base = rgb(0xd6c6ae);
  const dark = rgb(0x928475);
  const pale = rgb(0xf4e8d2);
  const grain = fbm(size, size, 4, 4, rng);
  const streak = fbm(size, size, 3, 3, rng);
  const planks = 5;
  const plankH = size / planks;
  const { data, depth } = raster;
  for (let y = 0; y < size; y += 1) {
    const plank = Math.floor(y / plankH);
    const edge = Math.min(y - plank * plankH, (plank + 1) * plankH - y);
    const seam = 1 - smoothstep(1.5, 4, edge);
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const p = i * 4;
      // Ring-like grain: warp a low-frequency field and take its fractional part.
      const warp = grain[i] * 6 + streak[i] * 2.5 + plank * 1.7;
      const rings = Math.abs(((warp * 3) % 1) - 0.5) * 2;
      let c = mixRgb(dark, base, 0.35 + rings * 0.5);
      c = mixRgb(c, pale, clamp01(streak[i] - 0.55) * 0.8);
      c = mixRgb(c, dark, seam * 0.9);
      data[p] = c.r;
      data[p + 1] = c.g;
      data[p + 2] = c.b;
      data[p + 3] = 255;
      depth[i] = rings * 0.4 - seam * 1.6;
    }
  }
  return {
    map: raster.toTexture({ srgb: true, wrap: true }),
    normal: raster.toNormalTexture(1.5, true),
  };
}

/** Soft wispy blob used by the ground mist planes. */
function buildMist(rng: Rng): THREE.Texture {
  const size = TEXTURE_SIZE.small;
  const raster = new Raster(size, size);
  // White body: MeshBasicMaterial multiplies map by colour, and the tint
  // already lives on the material.
  const body = rgb(0xffffff);
  raster.fill(body, 0);
  const wisp = fbm(size, size, 5, 4, rng);
  const half = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const d = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      const radial = 1 - smoothstep(0.12, 1, d);
      const a = clamp01(radial * (0.35 + wisp[i] * 1.05) * radial);
      raster.data[i * 4 + 3] = a * 255;
    }
  }
  return raster.toTexture({ srgb: true, wrap: false });
}

/** Round soft dot for the dust motes. */
function buildMote(): THREE.Texture {
  const size = 64;
  const raster = new Raster(size, size);
  raster.fill(rgb(0xffffff), 0);
  const half = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      const a = Math.pow(1 - clamp01(d), 2.6);
      raster.data[(y * size + x) * 4 + 3] = a * 255;
    }
  }
  return raster.toTexture({ srgb: true, wrap: false });
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

export interface TextureKit {
  groundMacro: THREE.Texture;
  groundDetail: THREE.Texture;
  groundDetailNormal: THREE.Texture;
  stone: THREE.Texture;
  stoneNormal: THREE.Texture;
  hedge: THREE.Texture;
  hedgeNormal: THREE.Texture;
  grassCard: THREE.Texture;
  iron: THREE.Texture;
  ironNormal: THREE.Texture;
  wood: THREE.Texture;
  woodNormal: THREE.Texture;
  mist: THREE.Texture;
  mote: THREE.Texture;
  /** Every texture the kit owns, for diagnostics and disposal. */
  all: THREE.Texture[];
  dispose(): void;
}

/**
 * Builds the full texture set. Deterministic: the same `map.seed` always yields
 * the same texels. Costs roughly 100-200ms of CPU on first call.
 */
export function createTextureKit(map: MapData): TextureKit {
  const rng = createRng((map.seed ^ hashString('veil.textures')) >>> 0);
  const groundMacro = buildGroundMacro(map, rng);
  const ground = buildGroundDetail(rng);
  const stone = buildStone(rng);
  const hedge = buildHedge(rng);
  const grassCard = buildGrassCard(rng);
  const iron = buildIron(rng);
  const wood = buildWood(rng);
  const mist = buildMist(rng);
  const mote = buildMote();

  const kit: TextureKit = {
    groundMacro,
    groundDetail: ground.map,
    groundDetailNormal: ground.normal,
    stone: stone.map,
    stoneNormal: stone.normal,
    hedge: hedge.map,
    hedgeNormal: hedge.normal,
    grassCard,
    iron: iron.map,
    ironNormal: iron.normal,
    wood: wood.map,
    woodNormal: wood.normal,
    mist,
    mote,
    all: [],
    dispose(): void {
      for (const texture of kit.all) texture.dispose();
      kit.all.length = 0;
    },
  };
  kit.all = [
    kit.groundMacro,
    kit.groundDetail,
    kit.groundDetailNormal,
    kit.stone,
    kit.stoneNormal,
    kit.hedge,
    kit.hedgeNormal,
    kit.grassCard,
    kit.iron,
    kit.ironNormal,
    kit.wood,
    kit.woodNormal,
    kit.mist,
    kit.mote,
  ];
  return kit;
}
