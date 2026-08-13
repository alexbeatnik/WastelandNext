/**
 * The bridge to manul-browser.
 *
 * Its engine is a Go binary that speaks a stdio protocol, driven by the thin
 * Node client shipped in the same repository. Nothing about element scoring,
 * CDP or the DSL lives here — if a capability is missing, it belongs in the
 * engine, not in this file.
 *
 * Chrome is opened lazily, on the first step that actually needs a browser. An
 * app that spawns Chrome at boot and then never uses it is just a slower app.
 */
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as config from '../config.mjs';
import { describeSearch, findBindingEntry } from '../../shared/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const BINARY = process.platform === 'win32' ? 'manul.exe' : 'manul';

/**
 * Directories that may hold the staged `resources/`.
 *
 * A packaged app has them under `process.resourcesPath`; running from source
 * has them in the repository. In development `process.resourcesPath` points
 * into Electron's own dist, which holds neither, so the check simply falls
 * through — no `app.isPackaged` and therefore no dependency on `electron` here.
 */
function resourceRoots() {
  return [process.resourcesPath, join(repoRoot, 'resources')].filter(Boolean);
}

/** The first existing candidate, or null. */
function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/**
 * Load the `manul-browser` client.
 *
 * Order: an installed package (so this keeps working the day one is published),
 * then the staged copy that ships inside the app, then the sibling checkout for
 * anyone running from source who has not staged yet.
 */
async function loadBinding() {
  try {
    return await import('manul-browser');
  } catch {
    /* not installed — fall back to the staged copy or the checkout */
  }

  const entry = firstExisting([
    ...resourceRoots().map((root) => join(root, 'manul-browser', 'index.js')),
    findBindingEntry(repoRoot),
  ]);
  if (!entry) {
    throw new Error(
      `manul-browser binding not found (tried the installed package, the bundled copy, then ${describeSearch()}) — ` +
        'clone https://github.com/alexbeatnik/manul-browser beside this repo, or set MANUL_SOURCE.',
    );
  }
  return import(pathToFileURL(entry).href);
}

/**
 * The engine binary that ships with the app.
 *
 * `findBinary` checks `MANUL_BINARY` before PATH, so pointing it here makes the
 * bundled engine win over a stray global install — the app should behave the
 * same on a machine that happens to have `manul` installed and one that
 * doesn't. An existing `MANUL_BINARY` is left alone: that override is
 * deliberate, and it is the documented way for a developer working on the
 * engine to test their own build.
 */
export function bundledBinaryPath() {
  return firstExisting(resourceRoots().map((root) => join(root, 'bin', BINARY))) ?? join(repoRoot, 'resources', 'bin', BINARY);
}

export function engineAvailable() {
  return Boolean(process.env['MANUL_BINARY']) || existsSync(bundledBinaryPath());
}

/**
 * One browser session, opened on demand.
 *
 * Events: `state` ({open, mode, url}), `step` (one StepOutcome), `log`.
 */
export class BrowserBridge extends EventEmitter {
  #session = null;
  #opening = null;
  #url = '';

  get open() {
    return Boolean(this.#session);
  }

  get status() {
    return { open: this.open, mode: this.#session?.mode ?? '', url: this.#url, engine: engineAvailable() };
  }

  /** Open the session if it isn't already. Concurrent callers share one open. */
  async ensureOpen() {
    if (this.#session) return this.#session;
    if (this.#opening) return this.#opening;

    this.#opening = this.#open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #open() {
    // Loaded here rather than at module scope so a missing or broken binding
    // degrades to "browser control unavailable" instead of failing app boot.
    const { Session } = await loadBinding();

    const settings = config.load();
    const options = {
      // Passed per session rather than written into `process.env`: mutating the
      // environment is permanent for the life of the process and invisible to
      // anything reading it later. Omitted when the user set `MANUL_BINARY`,
      // because an explicit option outranks the env var inside the binding and
      // that would invert their override.
      ...(process.env['MANUL_BINARY'] || !existsSync(bundledBinaryPath())
        ? {}
        : { binary: bundledBinaryPath() }),
      headless: Boolean(settings.browserHeadless),
      ...(settings.chromePath ? { executablePath: settings.chromePath } : {}),
    };

    this.emit('log', `engine: ${options.binary ?? process.env['MANUL_BINARY'] ?? `${BINARY} (resolved by the binding)`}`);
    // Always a browser of our own. Attaching to one the user is already using
    // means driving their tabs and leaving it open afterwards, and every
    // failure then looks like the app interfering with their session.
    this.#session = await Session.launch(options);

    this.emit('state', this.status);
    return this.#session;
  }

  /**
   * Run a DSL batch, one line at a time.
   *
   * Stepping line by line rather than handing the engine a whole `.hunt` is
   * what makes the UI able to show progress and lets a failure stop the batch
   * with the rest of it still legible.
   */
  async runSteps(dslText, { signal } = {}) {
    const session = await this.ensureOpen();
    const lines = String(dslText)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const outcomes = [];
    for (const line of lines) {
      if (signal?.aborted) break;
      let outcome;
      try {
        outcome = await session.step(line);
      } catch (err) {
        outcome = { ok: false, step: line, action: '', value: '', url: this.#url, reason: '', error: err.message, score: 0, near: [] };
      }
      if (outcome.url) this.#url = outcome.url;
      outcomes.push(outcome);
      this.emit('step', outcome);
      // A failed step invalidates every assumption the following ones make
      // about where the browser is. Carrying on just piles up noise.
      if (!outcome.ok) break;
    }

    this.emit('state', this.status);
    return outcomes;
  }

  /** A landmark-grouped view of the current page, for feeding back to the model. */
  async pageMap(budget = { maxPerGroup: 12 }) {
    if (!this.#session) return null;
    try {
      return await this.#session.map(budget);
    } catch (err) {
      this.emit('log', `map failed: ${err.message}`);
      return null;
    }
  }

  async readText(selector, maxChars = 4000) {
    const session = await this.ensureOpen();
    return session.readText(selector, { maxChars });
  }

  async close() {
    const session = this.#session;
    this.#session = null;
    this.#url = '';
    if (session) {
      try {
        await session.close();
      } catch (err) {
        this.emit('log', `close failed: ${err.message}`);
      }
    }
    this.emit('state', this.status);
  }
}

export const browser = new BrowserBridge();
