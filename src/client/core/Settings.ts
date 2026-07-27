import { DEFAULT_SETTINGS, type GameSettings, type QualityLevel } from '../contracts.js';

const STORAGE_KEY = 'veilhunt.settings.v1';

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function coerce(raw: unknown): GameSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const quality = source.quality;
  return {
    masterVolume: clamp01(source.masterVolume, DEFAULT_SETTINGS.masterVolume),
    ambienceVolume: clamp01(source.ambienceVolume, DEFAULT_SETTINGS.ambienceVolume),
    effectsVolume: clamp01(source.effectsVolume, DEFAULT_SETTINGS.effectsVolume),
    muted: source.muted === true,
    mouseSensitivity:
      typeof source.mouseSensitivity === 'number' && Number.isFinite(source.mouseSensitivity)
        ? Math.max(0.2, Math.min(3, source.mouseSensitivity))
        : DEFAULT_SETTINGS.mouseSensitivity,
    reducedShake: source.reducedShake === true,
    reducedMotion: source.reducedMotion === true,
    invertY: source.invertY === true,
    quality:
      quality === 'low' || quality === 'medium' || quality === 'high'
        ? (quality as QualityLevel)
        : DEFAULT_SETTINGS.quality,
    showSoundIndicators: source.showSoundIndicators !== false,
    highContrastPrompts: source.highContrastPrompts === true,
  };
}

export class SettingsStore {
  private current: GameSettings;
  private readonly listeners = new Set<(settings: GameSettings) => void>();

  constructor() {
    this.current = coerce(this.read());
    // Honour the OS-level motion preference the first time we ever run.
    if (this.read() === null && typeof matchMedia === 'function') {
      const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) {
        this.current.reducedMotion = true;
        this.current.reducedShake = true;
      }
    }
  }

  private read(): unknown {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  get value(): GameSettings {
    return this.current;
  }

  update(patch: Partial<GameSettings>): GameSettings {
    this.current = coerce({ ...this.current, ...patch });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Private-browsing or storage-full: settings simply do not persist.
    }
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  subscribe(listener: (settings: GameSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const NAME_KEY = 'veilhunt.name';

export function loadPlayerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function savePlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Ignore storage failures; the name just will not persist.
  }
}
