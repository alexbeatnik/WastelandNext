/**
 * The llama-server child process.
 *
 * Inference runs out-of-process for the same reason OS-Manul does it: a GGUF
 * load is seconds long and a crash inside a native inference library would take
 * the whole window with it. What we get back is an OpenAI-compatible HTTP
 * endpoint, so the client in `client.mjs` talks to a spawned server and to a
 * remote one through exactly the same code path.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { readGgufMetadata, recommendContext } from './gguf.mjs';
import * as config from '../config.mjs';
import { contextSize } from './client.mjs';
import { downloadLlamaServer, installedServerPath } from './tools.mjs';
import { modelsDir, toolsDir } from '../paths.mjs';

/** How long a model load may take before we give up waiting for /health. */
const READY_TIMEOUT_MS = 180_000;
const POLL_MS = 400;

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/**
 * Find `llama-server`: an explicit setting, then our own tools cache, then
 * PATH. Returning the bare name lets the OS resolve it and produces a clearer
 * ENOENT than a wrong absolute path would.
 */
export function resolveServerBinary(settings = config.load()) {
  if (settings.llamaServerPath && existsSync(settings.llamaServerPath)) return settings.llamaServerPath;
  const cached = join(toolsDir(), 'llama', EXE);
  if (existsSync(cached)) return cached;
  return EXE;
}

/**
 * A running (or starting, or dead) llama-server.
 *
 * Events: `state` ({state, detail}), `log` (stderr line), `tool` (download
 * progress while fetching the binary). Note there is deliberately no `error`
 * event: an EventEmitter with no listener for one rethrows, and a missing
 * binary must not take the app down.
 *
 * States: idle → starting → ready → idle, or → error.
 */
export class LlamaServer extends EventEmitter {
  #proc = null;
  #state = 'idle';
  #detail = '';
  #model = '';
  #baseUrl = '';
  #stopping = false;
  #contextSize = 0;
  #autoContext = null;

  get state() {
    return this.#state;
  }

  get status() {
    return {
      state: this.#state,
      detail: this.#detail,
      model: this.#model,
      baseUrl: this.baseUrl,
      contextSize: this.#contextSize,
      autoContext: this.#autoContext,
    };
  }

  /**
   * The context window the endpoint actually has, or 0 if it did not say.
   *
   * Worth asking rather than assuming: a remote endpoint was configured by
   * somebody else, and the local `n_ctx` setting says nothing about it.
   */
  get contextSize() {
    return this.#contextSize;
  }

  /** Where to POST completions — a remote endpoint wins over anything local. */
  get baseUrl() {
    const external = config.get('externalEndpoint');
    if (external) return external.replace(/\/+$/, '');
    return this.#baseUrl;
  }

  /** True when a request would reach *something*, spawned here or not. */
  get usable() {
    return Boolean(config.get('externalEndpoint')) || this.#state === 'ready';
  }

  #setState(state, detail = '') {
    this.#state = state;
    this.#detail = detail;
    this.emit('state', this.status);
  }

  /**
   * Boot a server for `modelFile` (a name inside the models directory, or an
   * absolute path). Loading a model that is already loaded is a no-op.
   */
  async load(modelFile) {
    const path = modelFile.includes('/') || modelFile.includes('\\') ? modelFile : join(modelsDir(), modelFile);
    if (!existsSync(path)) throw new Error(`model not found: ${path}`);
    if (this.#state === 'ready' && this.#model === modelFile) return this.status;

    await this.unload();

    const settings = config.load();
    const bin = await this.#ensureBinary(settings);
    const host = settings.llamaHost || '127.0.0.1';
    const port = Number(settings.llamaPort) || 8080;
    const nCtx = await this.#chooseContext(path, settings);
    const args = [
      '-m', path,
      '--host', host,
      '--port', String(port),
      '-c', String(nCtx),
      '-ngl', String(settings.ngl),
      '--no-webui',
      // Gemma/Qwen turn chain-of-thought on whenever a system prompt is present,
      // and we always send one. A silent <think> block before every answer is
      // pure latency here.
      '--reasoning-budget', '0',
    ];

    this.#model = modelFile;
    this.#baseUrl = `http://${host}:${port}`;
    this.#setState('starting', `loading ${modelFile}`);

    try {
      this.#proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.#setState('error', `spawn failed: ${err.message}`);
      throw err;
    }

    this.#proc.on('error', (err) => {
      // Nulled here as well as in `exit`: a spawn failure emits `error` and may
      // never emit `exit`, and `#waitForReady` watches this field to know it
      // should stop waiting.
      this.#proc = null;
      const hint = err.code === 'ENOENT' ? `${bin} not found` : err.message;
      this.#setState('error', hint);
      // Deliberately NOT `this.emit('error', ...)`: an EventEmitter with no
      // 'error' listener rethrows, and a missing binary would take the whole
      // app down with an "uncaught exception" dialog. The state event and the
      // rejected `load()` promise are how this is reported.
    });
    this.#proc.on('exit', (code, signal) => {
      this.#proc = null;
      if (this.#stopping) return;
      this.#setState('error', `llama-server exited (${signal ?? code})`);
    });

    const relay = (stream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) this.emit('log', line.trim());
      });
    };
    relay(this.#proc.stdout);
    relay(this.#proc.stderr);

    await this.#waitForReady();
    this.#contextSize = (await contextSize(this.#baseUrl)) ?? 0;
    this.#setState('ready', modelFile);
    return this.status;
  }

  /**
   * The path to spawn, fetching the binary first if there is nothing to spawn.
   *
   * A fresh install has no `llama-server` anywhere, and "put it on PATH
   * yourself" is a poor answer when upstream publishes a build for this exact
   * platform. Downloading only happens when nothing is already resolvable, so
   * a user who installed their own is never second-guessed.
   */
  async #ensureBinary(settings) {
    const resolved = resolveServerBinary(settings);
    if (resolved !== EXE) return resolved;

    const installed = await installedServerPath();
    if (installed) return installed;

    // Nothing configured, nothing cached. It may still be on PATH — try that
    // first, since a download is the expensive answer.
    if (spawnSync(EXE, ['--version'], { stdio: 'ignore' }).error === undefined) return EXE;

    this.#setState('starting', 'downloading llama-server');
    this.emit('tool', { stage: 'start', tool: 'llama-server' });
    try {
      const binary = await downloadLlamaServer({
        onStatus: (detail) => this.emit('tool', { stage: 'status', detail }),
        onProgress: (progress) => this.emit('tool', { stage: 'progress', ...progress }),
      });
      config.update({ llamaServerPath: binary });
      this.emit('tool', { stage: 'done', path: binary });
      return binary;
    } catch (err) {
      this.emit('tool', { stage: 'done', error: err.message });
      throw new Error(`could not fetch llama-server: ${err.message}`);
    }
  }

  /**
   * The context window to start with.
   *
   * With AUTO on, the model's own header decides: its trained maximum is a hard
   * cap, and the KV-cache cost per token — which varies tenfold between models
   * of the same file size — sets what memory allows. With AUTO off the slider
   * is obeyed exactly, including a value the model cannot honour, because an
   * explicit setting that gets quietly overridden is worse than one that fails
   * loudly.
   */
  async #chooseContext(path, settings) {
    const requested = Number(settings.nCtx) || 8192;
    if (!settings.autoContext) return requested;

    try {
      const [meta, info] = await Promise.all([readGgufMetadata(path), stat(path)]);
      const choice = recommendContext({ meta, fileSize: info.size, totalMemory: totalmem() });
      this.#autoContext = choice;

      const detail = [
        `auto context: ${choice.context} tokens (${choice.reason})`,
        choice.modelMax ? `model max ${choice.modelMax}` : null,
        choice.kvPerToken ? `KV ${(choice.kvPerToken / 1024).toFixed(1)} KB/token` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      this.emit('log', detail);
      return choice.context;
    } catch (err) {
      this.emit('log', `auto context failed (${err.message}); using ${requested}`);
      return requested;
    }
  }

  async #waitForReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.#proc) throw new Error(this.#detail || 'llama-server stopped before it was ready');
      try {
        const res = await fetch(`${this.#baseUrl}/health`, { signal: AbortSignal.timeout(POLL_MS * 2) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    await this.unload();
    throw new Error('llama-server did not become ready in time');
  }

  async unload() {
    const proc = this.#proc;
    this.#model = '';
    this.#baseUrl = '';
    this.#contextSize = 0;
    this.#autoContext = null;
    if (!proc) {
      this.#setState('idle');
      return;
    }
    this.#stopping = true;
    proc.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#proc = null;
    this.#stopping = false;
    this.#setState('idle');
  }
}

export const server = new LlamaServer();
