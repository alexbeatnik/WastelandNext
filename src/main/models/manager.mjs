/**
 * The model vault: what is on disk, and how new files get there.
 *
 * Downloads stream straight to a `.part` file and are renamed on completion, so
 * a cancelled or crashed download can never be mistaken for a usable model.
 */
import { createWriteStream } from 'node:fs';
import { open as fsOpen, readdir, rm, stat, rename as renameFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { basename, dirname, join, resolve } from 'node:path';
import * as config from '../config.mjs';
import { modelsDir } from '../paths.mjs';
import { RateMeter } from './rate.mjs';

/** Quantisations we prefer when a repo offers several, best trade-off first. */
const QUANT_PREFERENCE = ['q4_k_m', 'q4_k_s', 'q4_0', 'q5_k_m', 'q8_0'];

/**
 * Rewrite a HuggingFace page URL into a download URL.
 *
 * `/blob/` serves an HTML page; `/resolve/` serves the file. Pasting the URL
 * from the address bar is the common case, so it is handled rather than
 * rejected. Anything that is already a `/resolve/` URL passes through.
 */
export function rewriteHuggingFaceUrl(url) {
  const input = String(url ?? '').trim();
  if (!input) return '';
  return input.replace(/(https?:\/\/huggingface\.co\/[^\s]*?)\/blob\//, '$1/resolve/');
}

/** True when the input looks like `owner/name` rather than a URL. */
export function looksLikeRepoId(input) {
  const value = String(input ?? '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(value) && !value.includes('://');
}

/**
 * Delete a file that a stream may only just have released.
 *
 * On Windows the write handle from an aborted `pipeline` is not always gone by
 * the time we try to clean up, and `rm` throws `EBUSY` — which then replaces
 * the real error ("cancelled") with a confusing one. Retrying briefly is
 * enough; giving up quietly is correct, because a leftover `.part` file is
 * harmless and the cancellation is the thing worth reporting.
 */
export async function removeWhenReleased(path, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { force: true });
      return true;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') return false;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  return false;
}

/** One piece of a model split across several files: `…-00001-of-00003.gguf`. */
export function isShard(filename) {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(String(filename));
}

/**
 * Rank the GGUF files in a repo and return the best one's filename.
 *
 * Shards are not candidates, and a repo offering nothing else returns null
 * rather than the first piece. Downloading one shard produces a file that
 * passes every check this app makes — it is a real GGUF, of a plausible size,
 * with a readable header — and then fails inside llama-server minutes later,
 * long after the download the user was watching said it had succeeded.
 */
export function pickGgufFile(filenames) {
  const candidates = filenames.filter((f) => f.toLowerCase().endsWith('.gguf') && !isShard(f));
  if (candidates.length === 0) return null;
  for (const quant of QUANT_PREFERENCE) {
    const hit = candidates.find((f) => f.toLowerCase().includes(quant));
    if (hit) return hit;
  }
  return candidates[0];
}

/**
 * Turn whatever the user typed into a concrete download URL.
 *
 * A repo id costs one HF API call to list the files; a URL costs nothing.
 */
export async function resolveTarget(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('nothing to resolve');

  if (!looksLikeRepoId(value)) {
    const url = rewriteHuggingFaceUrl(value);
    if (!/^https?:\/\//.test(url)) throw new Error(`not a repo id or URL: ${value}`);
    // A URL ending in a slash has no basename, and an empty filename would end
    // up as a write to the models directory itself.
    const filename = basename(decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '')));
    if (!filename) throw new Error(`that URL names no file: ${value}`);
    return { url, filename };
  }

  const res = await fetch(`https://huggingface.co/api/models/${value}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HuggingFace says ${res.status} for ${value}`);
  const meta = await res.json();
  const files = (meta.siblings ?? []).map((s) => s.rfilename);
  const filename = pickGgufFile(files);
  if (!filename) {
    // "No .gguf files" would be a lie for a repo full of shards, and would send
    // the user looking for a different repo when the model is right there —
    // it simply cannot arrive as one file.
    const shards = files.filter((f) => isShard(f));
    if (shards.length > 0) {
      throw new Error(
        `${value} ships only as ${shards.length} multi-part shards; this downloads one file at a time. ` +
          'Pick a repo with a single-file quantisation, or merge the parts yourself and add the result with OPEN FILE.',
      );
    }
    throw new Error(`no .gguf files in ${value}`);
  }
  return {
    url: `https://huggingface.co/${value}/resolve/main/${encodeURI(filename)}`,
    filename: basename(filename),
  };
}

/** The first bytes of every GGUF file. Cheaper and clearer than a full parse. */
const GGUF_MAGIC = 'GGUF';

/**
 * Register a model that lives outside the vault.
 *
 * The file stays where it is — only its path is remembered. Checked for the
 * magic bytes here so a mistaken pick fails at the moment of choosing rather
 * than minutes later inside llama-server.
 */
export async function addExternal(path) {
  // Emptiness is checked before resolving: `resolve('')` yields the working
  // directory, which is truthy, so the guard would never fire and an empty
  // pick would be reported as "not a file" instead.
  const raw = String(path ?? '').trim();
  if (!raw) throw new Error('no file given');
  const full = resolve(raw);

  let info;
  try {
    info = await stat(full);
  } catch {
    throw new Error(`no such file: ${full}`);
  }
  if (!info.isFile()) throw new Error('that is not a file');

  const handle = await fsOpen(full, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    if (head.toString('ascii') !== GGUF_MAGIC) {
      throw new Error(`${basename(full)} is not a GGUF model`);
    }
  } finally {
    await handle.close().catch(() => {});
  }

  const known = config.get('externalModels') ?? [];
  // Already in the vault, or already registered: adding it twice would show it
  // twice, and the second row would be indistinguishable from the first.
  if (resolve(dirname(full)) === resolve(modelsDir())) {
    return { path: full, added: false, reason: 'already in the vault' };
  }
  if (known.some((entry) => resolve(entry) === full)) {
    return { path: full, added: false, reason: 'already added' };
  }

  config.update({ externalModels: [...known, full] });
  return { path: full, added: true };
}

/** Stop tracking an external model. The file itself is never touched. */
export function forgetExternal(path) {
  const full = resolve(String(path ?? ''));
  const known = config.get('externalModels') ?? [];
  config.update({ externalModels: known.filter((entry) => resolve(entry) !== full) });
}

/**
 * Every model available to load: the vault plus registered external files.
 *
 * A missing external file is listed as missing rather than dropped — it was
 * added deliberately, and silently losing the row looks like a bug when the
 * drive is merely unplugged.
 */
export async function listLocal() {
  const dir = modelsDir();
  const models = [];

  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    /* no vault directory yet */
  }

  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.gguf')) continue;
    try {
      const info = await stat(join(dir, name));
      models.push({ name, size: info.size, path: join(dir, name), external: false, missing: false });
    } catch {
      /* vanished between readdir and stat */
    }
  }

  for (const path of config.get('externalModels') ?? []) {
    try {
      const info = await stat(path);
      models.push({ name: basename(path), size: info.size, path, external: true, missing: false });
    } catch {
      models.push({ name: basename(path), size: 0, path, external: true, missing: true });
    }
  }

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** Delete a file from the vault. External models are forgotten, never deleted. */
export async function remove(name) {
  await rm(join(modelsDir(), basename(name)), { force: true });
}

/**
 * Download one file into the vault.
 *
 * `onProgress({filename, received, total, percent})` fires as bytes land. Abort
 * through `signal`; the partial file is cleaned up on the way out.
 */
/** A transfer with no bytes for this long is treated as dead. */
const STALL_MS = 90_000;

/** How often progress is reported, however fast the bytes arrive. */
const PROGRESS_MS = 250;

/** Interrupted downloads, still on disk and resumable. */
export async function listPartials() {
  const dir = modelsDir();
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const partials = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.gguf.part')) continue;
    try {
      const info = await stat(join(dir, name));
      partials.push({ name: name.replace(/\.part$/i, ''), received: info.size, path: join(dir, name) });
    } catch {
      /* vanished */
    }
  }
  return partials.sort((a, b) => a.name.localeCompare(b.name));
}

/** Throw away an interrupted download. */
export async function discardPartial(filename) {
  await removeWhenReleased(join(modelsDir(), `${basename(filename)}.part`));
}

/**
 * Download one file into the vault, resuming an interrupted attempt.
 *
 * A partial file is offered back to the server as a `Range` request. A server
 * that honours it answers 206 and we append; one that does not answers 200 and
 * we start over, which is correct rather than merely tolerable — appending to a
 * full body would corrupt the file silently.
 *
 * The transfer is abandoned if it goes quiet for `STALL_MS`. Without that a
 * dead connection leaves the download "running" forever, and — because only one
 * runs at a time — every later attempt is refused as busy while nothing moves.
 */
export async function download({ url, filename, signal, onProgress }) {
  const target = join(modelsDir(), basename(filename));
  const partial = `${target}.part`;

  let already = 0;
  try {
    already = (await stat(partial)).size;
  } catch {
    /* nothing to resume */
  }

  const headers = already > 0 ? { Range: `bytes=${already}-` } : {};
  const res = await fetch(url, { signal, redirect: 'follow', headers });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${filename}`);

  // Only a 206 in answer to a range we actually asked for means "carry on".
  // A server volunteering 206 with nothing to resume from would otherwise put
  // the write stream into append mode for no reason.
  const resumed = res.status === 206 && already > 0;
  if (already > 0 && !resumed) already = 0; // server ignored the range: start again

  const total = (Number(res.headers.get('content-length')) || 0) + already;
  let received = already;
  let lastByteAt = Date.now();

  const meter = new RateMeter();
  // The baseline goes in before a single new byte, so bytes resumed from disk
  // are never credited to this session's speed.
  meter.sample(received, lastByteAt);
  let lastEmit = 0;

  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    lastByteAt = now;
    meter.sample(received, now);

    // Chunks land hundreds of times a second. Reporting every one of them puts
    // that many IPC messages and that many re-renders through for a number no
    // one can read as it flickers; four times a second is smooth to watch and
    // long enough for the rate to mean something.
    if (now - lastEmit < PROGRESS_MS) return;
    lastEmit = now;

    onProgress?.({
      filename,
      received,
      total,
      resumed,
      percent: total ? Math.min(100, (received / total) * 100) : 0,
      bytesPerSecond: meter.rate(now),
      etaSeconds: meter.eta(received, total, now),
    });
  });

  const stalled = new AbortController();
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > STALL_MS) stalled.abort();
  }, 5_000);

  try {
    await pipeline(source, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }), {
      signal: AbortSignal.any([stalled.signal, ...(signal ? [signal] : [])]),
    });
  } catch (err) {
    clearInterval(watchdog);
    // The partial file is deliberately kept: it is what makes a resume
    // possible, and it is the user's decision whether to continue or discard.
    if (stalled.signal.aborted && !signal?.aborted) {
      throw new Error(`${filename} stalled with no data for ${STALL_MS / 1000}s — resume or discard it`);
    }
    throw err;
  }
  clearInterval(watchdog);

  await renameFile(partial, target);
  return { name: basename(filename), path: target, size: received };
}
