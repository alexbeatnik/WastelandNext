/**
 * The llama-server child process.
 *
 * Inference runs out-of-process because a GGUF load is seconds long and a crash
 * inside a native inference library would take the whole window with it. What we
 * get back is an OpenAI-compatible HTTP endpoint, so the client in `client.mjs`
 * talks to a spawned server and to a remote one through exactly the same code
 * path.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { kvBudget, readGgufMetadata, recommendContext } from './gguf.mjs';
import { contextForFullOffload, detectVram, recommendGpuLayers } from './gpu.mjs';
import { explainCrash, summariseFailure } from './failure.mjs';
import { PlacementReader } from './offload.mjs';
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

/** llama.cpp's timestamp and severity field: `0.01.369.125 I load_tensors: …`. */
const PREFIXED_LINE = /^\d[\d.]*\s+[EWID]\s/;
/** The two severities it uses for things that are merely going to plan. */
const ROUTINE_LINE = /^\d[\d.]*\s+[ID]\s/;
/** Something is wrong, whatever the line above it was. */
const COMPLAINT_LINE = /\b(?:error|failed|assert|abort|out of memory|unsupported)\b/i;

/**
 * Decides which of llama-server's lines are worth a person's attention.
 *
 * Trace output is asked for because placement is only stated there, and
 * llama.cpp answers with that and with everything else it knows: 246 lines for
 * a load, half of them every key-value pair in the GGUF header, and 38 more on
 * every turn describing slots and sampler chains. The activity log is where the
 * user watches the browser and the agent work, and burying that under a
 * per-turn dump of sampler parameters would trade one complaint for another.
 *
 * So the two audiences are split. The placement reader and the failure tail see
 * every line; the log sees what this keeps. The test is llama.cpp's own
 * severity field — the one `failure.mjs` already trusts — rather than a list of
 * which internals are dull, because that list is precisely what goes stale:
 * this filter exists because the lines it reads moved once already.
 *
 * The lifecycle lines it hides (`loading model`, `model loaded`, `listening
 * on`) are not lost. The status bar is already saying each of them, in the
 * user's own words, off the `state` event.
 *
 * One filter per stream: a wrapped line continues within its own.
 */
export function logFilter() {
  let shown = true;
  let prefixed = false;
  return (line) => {
    if (PREFIXED_LINE.test(line)) {
      prefixed = true;
      shown = !ROUTINE_LINE.test(line);
    } else if (!prefixed) {
      // Nothing so far has carried a severity field, so this build does not
      // print one and there is nothing to filter on. Older ones do not.
      shown = true;
    } else if (COMPLAINT_LINE.test(line)) {
      // A failed GGML_ASSERT prints bare and aborts on the spot. Reading it as
      // a continuation of whatever routine line preceded it would hide the one
      // line worth seeing.
      shown = true;
    }
    // Anything else is the line above, wrapped — llama.cpp continues both
    // indented (the sampler parameters) and at column 0 (the chat template it
    // echoes back) — and a continuation shown without its heading is worse than
    // one not shown at all. So it shares that line's fate, whichever it was.
    return shown;
  };
}

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
  /** What llama.cpp said it did, as opposed to what `#autoGpu` asked for. */
  #placement = null;
  #logTail = [];
  /** The in-flight `load()`, and what it is loading. See `load()`. */
  #loading = null;
  #loadingModel = '';
  /**
   * Set by `unload()`, cleared by `load()`. See `unload()` for why the teardown
   * itself is `#stop()` and not this.
   */
  #loadCancelled = false;

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
      // The plan above is a request. This is the outcome, and where the two
      // disagree the outcome is what the user is shown.
      placement: this.#placement,
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
    // Cleared here rather than inside `#load`, for the same reason `#loading` is
    // set here: both must be true before the first await, or a cancel arriving
    // in that window lands on a load that has not started claiming anything yet.
    this.#loadCancelled = false;
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

    // `#stop()`, not `unload()`: a load clearing the way for itself is not a
    // request to have no model, and going through the public door would cancel
    // the very load doing it.
    await this.#stop();

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
    if (this.#loadCancelled) throw new Error('cancelled');
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
      // Where the weights went is printed at llama.cpp's `trace` threshold, and
      // the default threshold is one below it. A current build (10405) loads a
      // model in seventeen lines, none of which mention a device, so the badge
      // read `RUN: ?` on a machine running every layer on the GPU — the reading
      // was honest and the evidence had simply stopped arriving. The log is the
      // only place it is stated: /props, /v1/models and /slots were all checked
      // and none of them mentions a device.
      //
      // Level 4 exactly. 5 is llama.cpp's debug level and holds nothing
      // placement needs, and what 4 costs — 246 lines a load, 38 a turn — is
      // already more than the activity log wants, which is what `logFilter` is
      // for.
      '-lv', '4',
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

    // The last moment at which nothing has been started. Past here an unload is
    // an ordinary kill, which `#waitForReady` and the `close` handler already
    // account for; before it there is no process to kill, so an UNLOAD pressed
    // during the fetch, the probe, the port check or the header read used to
    // stop nothing, report `idle`, and then watch this load spawn a server on
    // top of the answer it had just given.
    if (this.#loadCancelled) throw new Error('cancelled');

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
    // Read as the lines arrive, not from the tail afterwards: the tail holds 60
    // lines, a model load prints several times that, and the ones that say
    // where the weights went are near the start.
    const placement = new PlacementReader();
    const relay = (stream) => {
      let buffer = '';
      const worthShowing = logFilter();
      const take = (line) => {
        if (!line.trim()) return;
        // Read and kept whatever it is — where the weights went, and why a
        // server died, are both questions the dullest line might answer.
        placement.feed(line);
        this.#placement = placement.placement;
        this.#logTail.push(line.trim());
        if (this.#logTail.length > LOG_TAIL) this.#logTail.shift();
        if (worthShowing(line)) this.emit('log', line.trim());
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
      const kvCost = kvBudget(meta) ?? { perToken: 0, fixedBytes: 0 };

      // With both AUTOs on, the context is traded down to whatever keeps every
      // layer on the card. A layer left on the CPU is paid on every token, so
      // full offload at a shorter context is usually much faster than a long
      // context with a third of the model on the processor. Only ever a
      // reduction: `maxContext` is the ceiling already decided above.
      if (settings.autoContext && vramBytes) {
        const fitted = contextForFullOffload({
          fileSize,
          kvBytesPerToken: kvCost.perToken,
          kvFixedBytes: kvCost.fixedBytes,
          vramBytes,
          maxContext: plan.context,
        });
        if (fitted && fitted < plan.context) {
          this.emit(
            'log',
            `context ${plan.context} → ${fitted} so the whole model stays on the GPU ` +
              `(KV ${(kvCost.perToken / 1024).toFixed(1)} KB/token)`,
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
        kvBytesPerToken: kvCost.perToken,
        kvFixedBytes: kvCost.fixedBytes,
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
    await this.#stop();
    throw new Error('llama-server did not become ready in time');
  }

  /**
   * Have no model running.
   *
   * The request and the teardown are separate because a load tears down before
   * it starts, and that must not read as a request to stop: `unload()` is what
   * a person pressing UNLOAD means, `#stop()` is what both of them do. The flag
   * is set before the first await, so a load cannot slip past between the press
   * and the kill.
   */
  async unload() {
    this.#loadCancelled = true;
    await this.#stop();
  }

  async #stop() {
    const proc = this.#proc;
    this.#model = '';
    this.#baseUrl = '';
    this.#contextSize = 0;
    this.#autoContext = null;
    this.#autoGpu = null;
    this.#placement = null;
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
