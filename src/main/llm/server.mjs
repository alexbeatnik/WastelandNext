/**
 * The llama-server child process.
 *
 * Inference runs out-of-process for the same reason OS-Manul does it: a GGUF
 * load is seconds long and a crash inside a native inference library would take
 * the whole window with it. What we get back is an OpenAI-compatible HTTP
 * endpoint, so the client in `client.mjs` talks to a spawned server and to a
 * remote one through exactly the same code path.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { kvBytesPerToken, readGgufMetadata, recommendContext } from './gguf.mjs';
import { contextForFullOffload, detectVram, recommendGpuLayers } from './gpu.mjs';
import { explainCrash, summariseFailure } from './failure.mjs';
import { portInUse } from './port.mjs';
import * as config from '../config.mjs';
import { contextSize } from './client.mjs';
import { downloadLlamaServer, installedServerPath } from './tools.mjs';
import { modelsDir, toolsDir } from '../paths.mjs';

/** How long a model load may take before we give up waiting for /health. */
const READY_TIMEOUT_MS = 180_000;
const POLL_MS = 400;
/** Lines of output kept so a crash can be explained after the fact. */
const LOG_TAIL = 60;
/** How long the binary gets to answer `--version`. A working one takes ~50 ms. */
const PROBE_TIMEOUT_MS = 10_000;

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
 * Does this binary run at all?
 *
 * A build that faults on startup dies before printing a line, so a model load
 * spends a header read, a spawn and a wait only to arrive at an empty log and a
 * bare exit code — which is where "llama-server exited (3221225477) without
 * saying why" came from. `--version` asks the same question in milliseconds,
 * and asks it before the user has been told a model is loading.
 *
 * Only a *crash* is fatal. A build that merely dislikes `--version` exits
 * non-zero with something to say, and grounding a working server over that
 * would be a worse bug than the one this prevents.
 *
 * Asynchronous, and deliberately not `spawnSync`: this runs in the main
 * process, and a binary that neither answers nor exits — the wrong exe picked
 * in SETTINGS is enough, a GUI program never returns — would otherwise freeze
 * the window for the whole timeout. The point of running inference out of
 * process is not blocking the UI; checking the binary must not undo that.
 */
export function probeServerBinary(bin, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, detail: err.message });
      return;
    }

    let printed = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      // Not a crash, and saying so would be a guess. A binary that will not
      // answer the cheapest question there is has still failed the check.
      finish({ ok: false, detail: `${bin} did not answer --version within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      printed += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      printed += chunk;
    });
    child.on('error', (err) => {
      finish({ ok: false, detail: err.code === 'ENOENT' ? `${bin} not found` : err.message });
    });
    // `close` rather than `exit`, for the same reason it is used for the server
    // itself: whether anything was printed is the question being asked.
    child.on('close', (code) => {
      const crash = explainCrash(code, { silent: !printed.trim() });
      finish(crash ? { ok: false, detail: crash.summary, hint: crash.hint } : { ok: true });
    });
  });
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
  #autoGpu = null;
  #logTail = [];
  /** The in-flight `load()`, and what it is loading. See `load()`. */
  #loading = null;
  #loadingModel = '';

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
      autoGpu: this.#autoGpu,
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
   *
   * The in-flight load is held in a field so a second call cannot walk past the
   * guard. Reading `#state` is not enough: `starting` is only set several awaits
   * in — after the binary probe and the port check — and two clicks in that
   * window both saw `idle`, both probed, and both spawned a server. The second
   * one loses the port, and its failure is reported over the top of a load that
   * was working.
   */
  load(modelFile) {
    if (this.#loading) {
      // Asking twice for the same model is a double click, not a mistake:
      // joining the load already running is what was wanted either way.
      if (this.#loadingModel === modelFile) return this.#loading;
      return Promise.reject(new Error('a model is already loading — please wait'));
    }
    const started = this.#load(modelFile).finally(() => {
      if (this.#loading === started) {
        this.#loading = null;
        this.#loadingModel = '';
      }
    });
    this.#loading = started;
    this.#loadingModel = modelFile;
    return started;
  }

  async #load(modelFile) {
    const path = modelFile.includes('/') || modelFile.includes('\\') ? modelFile : join(modelsDir(), modelFile);
    if (!existsSync(path)) throw new Error(`model not found: ${path}`);
    if (this.#state === 'ready' && this.#model === modelFile) return this.status;

    await this.unload();

    const settings = config.load();
    const bin = await this.#ensureBinary(settings);
    // Checked before anything is reported as loading: a binary that cannot
    // start has nothing to do with the model, and saying so while the status
    // bar reads "LOADING <model>" sends the user to the wrong question.
    const probe = await probeServerBinary(bin);
    if (!probe.ok) {
      // The hint carries what will not fit in a status bar — a URL, a folder to
      // delete — so it goes to the log, which has room for it.
      if (probe.hint) this.emit('log', `${probe.detail} — ${probe.hint}`);
      this.#setState('error', probe.detail);
      throw new Error(probe.detail);
    }
    const host = settings.llamaHost || '127.0.0.1';
    const port = Number(settings.llamaPort) || 8080;
    // Before anything is spawned: a server already on this port would answer
    // our readiness poll, and we would report a model as loaded while actually
    // talking to whatever that other process is serving.
    if (await portInUse(host, port)) {
      const detail = `port ${port} is already in use — stop the other llama-server, or change the port in SETTINGS`;
      this.#setState('error', detail);
      throw new Error(detail);
    }

    const plan = await this.#plan(path, settings);
    const args = [
      '-m', path,
      '--host', host,
      '--port', String(port),
      '-c', String(plan.context),
      '-ngl', String(plan.gpuLayers),
      '--no-webui',
      // Thinking is asked for, or asked against, in two ways because neither
      // works everywhere: the budget is a hard stop llama.cpp applies itself,
      // while `enable_thinking` is what Qwen-style chat templates read. Models
      // that honour neither still think, which is why the view can hide it.
      '--reasoning-budget', settings.thinking ? '-1' : '0',
      ...(settings.thinking ? [] : ['--chat-template-kwargs', '{"enable_thinking":false}']),
      // The default reasoning format is kept on purpose. llama.cpp knows each
      // family's thinking syntax — <think> tags, harmony channel markers — and
      // parses it into `reasoning_content`, which the client folds back into a
      // <think> block for display. Asking for `none` instead leaves that syntax
      // unparsed, and a harmony model then prints `to=self<|message|>` at the
      // user. The field must be read, though: an OpenAI client that looks only
      // at `content` shows an empty reply for a model that thinks first.
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
    // `close`, not `exit`. `exit` fires when the process is gone, which can be
    // before stdout and stderr have been drained — so concluding there can read
    // an empty log for a server that said exactly what was wrong on its way
    // out, and report "without saying why" over the top of the answer. `close`
    // is the one that waits for the pipes, and it carries the same code.
    //
    // That lateness is why this asks whether the process it is reporting on is
    // still the current one, rather than trusting `#stopping`. `unload()` waits
    // for `exit` and clears the flag as soon as it arrives; `close` can land
    // after that, and a deliberate unload would then be written up as a crash —
    // the status bar reading MODEL: ... instead of NONE for a model the user
    // just unloaded.
    const child = this.#proc;
    child.on('close', (code, signal) => {
      if (this.#proc !== child) return;
      this.#proc = null;
      if (this.#stopping) return;
      // A spawn failure emits `error` first and `close` straight after. The
      // first carries the real reason ("llama-server.exe not found"); this one
      // would replace it with a generic line derived from an empty log.
      if (this.#state === 'error') return;
      // Otherwise the exit code alone names no cause, and the reason is in the
      // last lines it printed — or, when it printed none, in the code itself.
      this.#setState('error', summariseFailure(this.#logTail, { code, signal }));
    });

    this.#logTail = [];
    const relay = (stream) => {
      let buffer = '';
      const take = (line) => {
        if (!line.trim()) return;
        this.emit('log', line.trim());
        this.#logTail.push(line.trim());
        if (this.#logTail.length > LOG_TAIL) this.#logTail.shift();
      };
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) take(line);
      });
      // The last line is the one worth keeping and the one most likely to
      // arrive without a trailing newline: a failed GGML_ASSERT prints and
      // aborts on the spot. Held in `buffer` and never flushed, exactly that
      // line was dropped.
      stream.on('end', () => {
        const rest = buffer;
        buffer = '';
        take(rest);
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
    // first, since a download is the expensive answer. Asked asynchronously for
    // the reason `probeServerBinary` explains: `spawnSync` on a binary that
    // never answers freezes the whole window, and the wrong `llama-server` on
    // PATH — a GUI program, a wrapper waiting on input — is exactly that.
    if ((await probeServerBinary(EXE)).ok) return EXE;

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
   * Decide context size and GPU offload for this model.
   *
   * Both read the same GGUF header, and the GPU decision depends on the context
   * one — the KV cache shares the card with the weights — so they are settled
   * together rather than in two places that each re-read the file.
   *
   * With AUTO off, the slider is obeyed exactly, including a value that cannot
   * work: an explicit setting quietly overridden is worse than one that fails
   * loudly.
   */
  async #plan(path, settings) {
    const context = Number(settings.nCtx) || 8192;
    const gpuLayers = Number(settings.ngl) || 0;
    const plan = { context, gpuLayers };

    if (!settings.autoContext && !settings.autoGpuLayers) return plan;

    let meta = null;
    let fileSize = 0;
    try {
      [meta, { size: fileSize }] = await Promise.all([readGgufMetadata(path), stat(path)]);
    } catch (err) {
      this.emit('log', `could not read the model header (${err.message}); using the configured settings`);
      return plan;
    }

    if (settings.autoContext) {
      const choice = recommendContext({ meta, fileSize, totalMemory: totalmem() });
      this.#autoContext = choice;
      plan.context = choice.context;
      this.emit(
        'log',
        [
          `auto context: ${choice.context} tokens (${choice.reason})`,
          choice.modelMax ? `model max ${choice.modelMax}` : null,
          choice.kvPerToken ? `KV ${(choice.kvPerToken / 1024).toFixed(1)} KB/token` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
    }

    if (settings.autoGpuLayers) {
      const vramBytes = detectVram();

      // With both AUTOs on, the context is traded down to whatever keeps every
      // layer on the card. A layer left on the CPU is paid on every token, so
      // full offload at a shorter context is usually much faster than a long
      // context with a third of the model on the processor. Only ever a
      // reduction: `maxContext` is the ceiling already decided above.
      if (settings.autoContext && vramBytes) {
        const kv = kvBytesPerToken(meta) ?? 0;
        const fitted = contextForFullOffload({
          fileSize,
          kvBytesPerToken: kv,
          vramBytes,
          maxContext: plan.context,
        });
        if (fitted && fitted < plan.context) {
          this.emit(
            'log',
            `context ${plan.context} → ${fitted} so the whole model stays on the GPU ` +
              `(KV ${(kv / 1024).toFixed(1)} KB/token)`,
          );
          plan.context = fitted;
          this.#autoContext = {
            ...this.#autoContext,
            context: fitted,
            reason: 'reduced to keep every layer on the GPU',
          };
        }
      }

      const choice = recommendGpuLayers({
        meta,
        fileSize,
        contextTokens: plan.context,
        kvBytesPerToken: kvBytesPerToken(meta) ?? 0,
        vramBytes: vramBytes ?? 0,
      });
      this.#autoGpu = { ...choice, vramBytes };
      plan.gpuLayers = choice.layers;
      this.emit(
        'log',
        `auto GPU layers: ${choice.layers === 999 ? 'all' : choice.layers} (${choice.reason})` +
          (vramBytes ? ` · ${(vramBytes / 1024 ** 3).toFixed(1)} GB VRAM` : ''),
      );
    }

    return plan;
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
    this.#autoGpu = null;
    if (!proc) {
      this.#setState('idle');
      return;
    }
    this.#stopping = true;
    // An already-dead process emits no further `exit`, so waiting for one costs
    // the full timeout on every unload after a crash — including the one on the
    // way out of the app, where it is three seconds of a window that will not
    // close.
    if (proc.exitCode === null && proc.signalCode === null && !proc.killed) {
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
    }
    this.#proc = null;
    this.#stopping = false;
    this.#setState('idle');
  }
}

export const server = new LlamaServer();
