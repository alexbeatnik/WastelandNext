/**
 * Persisted settings.
 *
 * One JSON file, read once at boot and rewritten on every change. Unknown keys
 * from a newer build survive a round-trip: the defaults are merged *under* what
 * was on disk, never over it, so downgrading does not silently drop settings.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from './paths.mjs';

export const DEFAULTS = {
  /** Inference */
  model: '',
  /**
   * Absolute paths to models kept outside the vault.
   *
   * Stored as references, never copied: a GGUF is gigabytes, and a user who
   * keeps their models on another drive means to keep them there.
   */
  externalModels: [],
  /** Size the context from the model's own header instead of the slider. */
  autoContext: true,
  nCtx: 8192,
  temperature: 0.7,
  /** Fit the offload to the card instead of demanding all of it. */
  autoGpuLayers: true,
  ngl: 999,
  /**
   * Let the model think before answering.
   *
   * Off by default: for a chat assistant a silent chain-of-thought before every
   * reply is mostly latency. Not every model obeys being told to skip it, so
   * the chat view also hides whatever still arrives — see `showThinking`.
   */
  thinking: false,
  systemPrompt: '',

  /** llama-server */
  llamaServerPath: '',
  llamaHost: '127.0.0.1',
  llamaPort: 8080,
  /** Point at an already-running OpenAI-compatible endpoint instead of spawning one. */
  externalEndpoint: '',

  /** Browser */
  browserHeadless: false,
  chromePath: '',

  /**
   * Plugin state, keyed by id: `{enabled, approved}`.
   *
   * What the model may do is decided here now, not by the four `allow*` flags
   * this replaced. Those keys are deliberately *not* in the defaults any more:
   * `mergeEnablement` reads them only when every one of them is present on
   * disk, which is exactly the case of a config written by an older build, and
   * a fresh install must not inherit a decision nobody made.
   */
  plugins: {},
  /** Where GET PLUGINS looks. A setting so a developer can point it elsewhere. */
  pluginRegistry: '',
  /** `<plugin-id>/<theme-id>`, or empty for the app's own amber. */
  theme: '',

  /** Audio output, shared by whichever plugin is driving it. */
  audioVolume: 0.8,

  /** UI */
  activeChat: '',
  leftPanelOpen: true,
  density: 'auto', // 'auto' | 'compact' | 'comfortable'
  crtEffects: true,
};

let cache = null;

export function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    /* first run, or a file we cannot parse — defaults win */
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

export function get(key) {
  return load()[key];
}

/** Merge a patch in and flush. Returns the whole config so callers can echo it. */
export function update(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  try {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[config] save failed:', err.message);
  }
  return next;
}
