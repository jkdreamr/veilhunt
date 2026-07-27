/**
 * Renderer, post-processing chain and adaptive resolution.
 *
 * The chain is deliberately short — bloom for authored emissive, then one grade
 * pass that does vignette, grain and the dread tint. Stable frame rate beats
 * extravagance, so DPR is capped and adapts downward if frames get expensive.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { QualityLevel } from '../contracts.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.82 },
    uVignetteSize: { value: 0.78 },
    uGrain: { value: 0.016 },
    uTime: { value: 0 },
    uDread: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(0xffffff) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uVignetteSize;
    uniform float uGrain;
    uniform float uTime;
    uniform float uDread;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));

      // Vignette. Kept off the play area so it frames rather than obscures.
      float vig = mix(1.0, smoothstep(uVignetteSize, uVignetteSize - 0.5, d), uVignette);
      color.rgb *= vig;

      // Dread pushes a red-black pressure in from the corners only.
      float dreadMask = smoothstep(0.34, 0.72, d) * uDread;
      color.rgb = mix(color.rgb, color.rgb * vec3(1.25, 0.42, 0.46), dreadMask * 0.7);
      color.rgb *= 1.0 - dreadMask * 0.28;

      // Subtle film grain; animated so it does not look like a dirty lens.
      float grain = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
      color.rgb += grain * uGrain;

      color.rgb = mix(color.rgb, uFlashColor, clamp(uFlash, 0.0, 1.0));

      gl_FragColor = color;
    }
  `,
};

export interface RendererStats {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  pixelRatio: number;
}

export class RenderSystem {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private gradePass: ShaderPass | null = null;
  private quality: QualityLevel = 'high';
  private dprCap = 2;
  private frameTimes: number[] = [];
  private lastStats: RendererStats = {
    fps: 0,
    frameMs: 0,
    calls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
    pixelRatio: 1,
  };
  private adaptTimer = 0;
  private flash = 0;
  private flashDecay = 6;
  private environment: THREE.WebGLRenderTarget | null = null;
  private readonly resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: { preserveDrawingBuffer?: boolean } = {}) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      // Only enabled for dev/E2E builds so the canvas pixel probe can read the
      // frame back after compositing. It costs performance, so production is off.
      preserveDrawingBuffer: options.preserveDrawingBuffer === true,
    });
    // `info` resets on every draw call by default, which with a post-processing
    // chain means the reported counts would only cover the final full-screen
    // pass. Reset manually per frame so the numbers cover the whole frame.
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.85;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x05070b, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.12, 420);

    this.applyPixelRatio();
    this.resize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement ?? canvas);
    }
    window.addEventListener('resize', this.onWindowResize);
  }

  private readonly onWindowResize = (): void => this.resize();

  setQuality(quality: QualityLevel): void {
    this.quality = quality;
    this.dprCap = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
    this.renderer.shadowMap.enabled = quality !== 'low';
    if (this.bloom) {
      this.bloom.strength = quality === 'low' ? 0.28 : 0.46;
    }
    this.applyPixelRatio();
    this.rebuildComposer();
    this.resize();
  }

  /** Builds the post chain. Called once the scene has content worth grading. */
  enablePostProcessing(): void {
    this.rebuildComposer();
  }

  /**
   * Bakes a small moonlit-sky gradient into an environment map.
   *
   * Without one, PBR surfaces facing away from the single directional moon
   * receive nothing but the hemisphere term and read as flat black. This is one
   * bake at match start and near-zero per frame, and it is what makes the ruins
   * legible without flattening them with a second dynamic light.
   */
  installEnvironment(): void {
    this.disposeEnvironment();

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();

    const skyGeometry = new THREE.SphereGeometry(60, 24, 16);
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color(0x18243a) },
        uHorizon: { value: new THREE.Color(0x3d5878) },
        uGround: { value: new THREE.Color(0x0a0d13) },
        uMoonDir: { value: new THREE.Vector3(-46, 72, -36).normalize() },
        uMoonColor: { value: new THREE.Color(0xbcd4f0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uZenith, uHorizon, uGround, uMoonColor;
        uniform vec3 uMoonDir;
        void main() {
          float h = vDir.y;
          vec3 col = h > 0.0
            ? mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.7))
            : mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.55));
          float d = clamp(dot(normalize(vDir), normalize(uMoonDir)), 0.0, 1.0);
          col += uMoonColor * pow(d, 6.0) * 0.9;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
    envScene.add(skyMesh);

    const target = pmrem.fromScene(envScene, 0.04);
    this.environment = target;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.75;

    skyGeometry.dispose();
    skyMaterial.dispose();
    pmrem.dispose();
  }

  private disposeEnvironment(): void {
    if (!this.environment) return;
    this.scene.environment = null;
    this.environment.dispose();
    this.environment = null;
  }

  private rebuildComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.gradePass = null;

    const size = this.renderer.getSize(new THREE.Vector2());
    const composer = new EffectComposer(this.renderer);
    composer.setSize(size.x, size.y);
    composer.setPixelRatio(this.renderer.getPixelRatio());
    composer.addPass(new RenderPass(this.scene, this.camera));

    // Threshold 0.85 keeps mid-bright stone out of the bloom so only authored
    // emissive (runes, lanterns, seals) blooms.
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      this.quality === 'low' ? 0.28 : 0.46,
      0.34,
      0.85,
    );
    composer.addPass(bloom);
    this.bloom = bloom;

    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    this.gradePass = grade;

    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  private applyPixelRatio(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.renderer.setPixelRatio(dpr);
    this.composer?.setPixelRatio(dpr);
  }

  resize(): void {
    if (this.disposed) return;
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const width = Math.max(1, Math.floor(parent?.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.floor(parent?.clientHeight || window.innerHeight));

    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.bloom) this.bloom.resolution.set(width, height);
  }

  setDread(value: number): void {
    if (this.gradePass) this.gradePass.uniforms.uDread.value = value;
  }

  setGrain(value: number): void {
    if (this.gradePass) this.gradePass.uniforms.uGrain.value = value;
  }

  /** One-frame full-screen tint, used for wound and capture impacts. */
  punchFlash(color: number, strength: number, decay = 6): void {
    if (!this.gradePass) return;
    (this.gradePass.uniforms.uFlashColor.value as THREE.Color).setHex(color);
    this.flash = Math.max(this.flash, strength);
    this.flashDecay = decay;
  }

  render(dt: number, elapsed: number): void {
    if (this.disposed) return;

    if (this.gradePass) {
      this.gradePass.uniforms.uTime.value = elapsed;
      this.flash = Math.max(0, this.flash - this.flashDecay * dt);
      this.gradePass.uniforms.uFlash.value = this.flash;
    }

    const start = performance.now();
    this.renderer.info.reset();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    const frameMs = performance.now() - start;

    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 90) this.frameTimes.shift();

    const info = this.renderer.info;
    this.lastStats = {
      fps: dt > 0 ? 1 / dt : 0,
      frameMs,
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      pixelRatio: this.renderer.getPixelRatio(),
    };

    this.adaptResolution(dt);
  }

  /**
   * If the GPU is consistently missing frame budget, step the pixel ratio down
   * once. A steady 60 fps at a slightly lower resolution beats a jittery one.
   */
  private adaptResolution(dt: number): void {
    this.adaptTimer += dt;
    if (this.adaptTimer < 3 || this.frameTimes.length < 60) return;
    this.adaptTimer = 0;

    const sorted = this.frameTimes.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const current = this.renderer.getPixelRatio();

    if (p95 > 22 && current > 1) {
      const next = Math.max(1, current - 0.25);
      this.renderer.setPixelRatio(next);
      this.composer?.setPixelRatio(next);
      this.resize();
    }
    this.frameTimes.length = 0;
  }

  get stats(): RendererStats {
    return this.lastStats;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onWindowResize);
    this.resizeObserver?.disconnect();
    this.disposeEnvironment();
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
