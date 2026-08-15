/**
 * Getting plugins from the registry.
 *
 * One source by default — the `wasteland-plugins` repository — because a single
 * source is a single, explainable level of trust. The URL is a setting so a
 * developer can point the app at their own index, not so a plugin can.
 *
 * The install path is deliberately paranoid, in this order: the archive is
 * fetched to a scratch directory, its digest is compared against the one the
 * index published, its central directory is read *without unpacking* to refuse
 * a traversing entry, it is unpacked into a staging directory, and only a
 * staging tree that turns out to contain a valid manifest for the plugin we
 * asked for is moved into place. Nothing lands in `plugins/` until all of that
 * has held — a half-unpacked plugin directory would be discovered on the next
 * boot and listed as a broken plugin the user never installed.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as config from '../config.mjs';
import { pluginsDir } from '../paths.mjs';
import { assertSafeArchive } from '../llm/zip.mjs';
import { extractZip } from '../llm/tools.mjs';
import { PLUGIN_API_VERSION, parseManifest } from './manifest.mjs';

export const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/alexbeatnik/wasteland-plugins/main/index.json';

/** A plugin archive is manifest, code and a stylesheet; megabytes are a mistake. */
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Compare two version strings the way a plugin author writes them.
 *
 * Not a full semver implementation, and it does not need to be: what it has to
 * get right is that `1.10.0` is newer than `1.9.0` — a string comparison says
 * the opposite, and an update button that never appears is indistinguishable
 * from a registry that never publishes. Numeric segments are compared as
 * numbers, a missing segment counts as zero (`1.2` equals `1.2.0`), and a
 * pre-release suffix ranks *below* the release it leads to, so `1.0.0-rc1`
 * does not shadow `1.0.0`.
 *
 * Returns a negative number when `a` is older, 0 when equal, positive when newer.
 */
export function compareVersions(a, b) {
  const split = (value) => {
    const [core, pre = ''] = String(value ?? '').trim().replace(/^v/i, '').split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);

  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Is the published version worth offering as an update over the installed one? */
export function isNewer(published, installed) {
  return compareVersions(published, installed) > 0;
}

export function registryUrl() {
  return String(config.get('pluginRegistry') || '').trim() || DEFAULT_REGISTRY;
}

/**
 * One entry of the published index, normalised.
 *
 * Returns null rather than throwing: an index with one malformed row should
 * still show the others, and a registry that grows a field this build does not
 * know must not empty the list.
 */
export function parseEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const url = String(raw.url ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return null;
  // Only over TLS, and only somewhere a hostile index cannot turn into a local
  // file read — `file:` and `data:` URLs are not downloads.
  if (!/^https:\/\//i.test(url)) return null;

  const apiVersion = Number(raw.apiVersion ?? 1);
  return {
    id,
    name: String(raw.name ?? id).trim() || id,
    version: String(raw.version ?? '0.0.0'),
    description: String(raw.description ?? '').trim(),
    // Data URI or nothing: the page's CSP allows `data:` images and no remote
    // host, so an icon cannot become a request to a third party that learns who
    // opened the plugin list.
    icon: /^data:image\//i.test(String(raw.icon ?? '')) ? String(raw.icon) : '',
    author: String(raw.author ?? '').trim(),
    homepage: /^https:\/\//i.test(String(raw.homepage ?? '')) ? String(raw.homepage) : '',
    apiVersion,
    /** `code` needs approval to run; `theme` is manifest and CSS. */
    kind: raw.kind === 'theme' ? 'theme' : 'code',
    url,
    sha256: String(raw.sha256 ?? '').toLowerCase(),
    size: Number(raw.size) || 0,
    /** Listed but not installable here, and the row says why. */
    compatible: Number.isInteger(apiVersion) && apiVersion <= PLUGIN_API_VERSION,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The published index. Throws with a sentence worth showing on failure. */
export async function fetchIndex() {
  const url = registryUrl();
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`could not reach the plugin registry — ${err.name === 'AbortError' ? 'it did not answer' : err.message}`);
  }
  if (!response.ok) throw new Error(`the plugin registry answered ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('the plugin registry did not return an index');
  }

  const entries = (Array.isArray(body?.plugins) ? body.plugins : []).map(parseEntry).filter(Boolean);
  return { url, updated: String(body?.updated ?? ''), plugins: entries };
}

/** Download to `target`, refusing anything oversized or unreadable. */
async function download(url, target, onProgress) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`download failed with ${response.status}`);

  const total = Number(response.headers.get('content-length')) || 0;
  if (total > MAX_ARCHIVE_BYTES) throw new Error('that archive is far larger than a plugin should be');
  if (!response.body) throw new Error('the download was empty');

  let received = 0;
  const hash = createHash('sha256');
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      // Checked while streaming as well as from the header: a server may simply
      // not have declared a length.
      if (received > MAX_ARCHIVE_BYTES) throw new Error('that archive is far larger than a plugin should be');
      hash.update(chunk);
      onProgress?.({ received, total });
      controller.enqueue(chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), createWriteStream(target));
  return { digest: hash.digest('hex'), bytes: received };
}

/**
 * Find the directory in a staging tree that actually holds the plugin.
 *
 * A zip built by the release workflow has `plugin.json` at its root, but one
 * made by hand — right-click, "compress" — wraps everything in a folder named
 * after it. Accepting one level of wrapper costs ten lines and removes the most
 * common way to package a plugin wrongly.
 */
async function findManifestRoot(dir) {
  try {
    await stat(join(dir, 'plugin.json'));
    return dir;
  } catch {
    /* look one level down */
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) return null;
  const inner = join(dir, dirs[0].name);
  try {
    await stat(join(inner, 'plugin.json'));
    return inner;
  } catch {
    return null;
  }
}

/**
 * Install one entry from the index.
 *
 * Returns `{id, name, version, kind}`. An existing installation of the same id
 * is replaced only once the new one has been validated in staging.
 */
export async function install(entry, { onProgress } = {}) {
  const item = parseEntry(entry);
  if (!item) throw new Error('that registry entry cannot be installed');
  if (!item.compatible) {
    throw new Error(`${item.name} needs plugin API ${item.apiVersion}; this build implements ${PLUGIN_API_VERSION}`);
  }
  if (!/^[a-f0-9]{64}$/.test(item.sha256)) {
    // Without a digest there is nothing tying the bytes to the index, and the
    // index is the only thing being trusted here.
    throw new Error(`${item.name} is published without a checksum and will not be installed`);
  }

  const scratch = await mkdtemp(join(tmpdir(), 'wl-plugin-'));
  const archive = join(scratch, 'plugin.zip');
  const staging = join(scratch, 'unpacked');

  try {
    onProgress?.({ stage: 'download', id: item.id });
    const { digest } = await download(item.url, archive, (progress) =>
      onProgress?.({ stage: 'download', id: item.id, ...progress }),
    );
    if (digest !== item.sha256) {
      throw new Error('the download does not match the checksum the registry published');
    }

    onProgress?.({ stage: 'verify', id: item.id });
    // Reads the central directory only; nothing is unpacked to find this out.
    await assertSafeArchive(archive);

    onProgress?.({ stage: 'unpack', id: item.id });
    extractZip(archive, staging);

    const root = await findManifestRoot(staging);
    if (!root) throw new Error('the archive contains no plugin.json');

    const parsed = parseManifest(JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8')), { builtin: false });
    if (!parsed.ok) throw new Error(`the archive holds an unusable plugin — ${parsed.reason}`);
    // The index said one thing and the archive another; whichever is wrong, the
    // plugin would be installed under a name it does not answer to.
    if (parsed.manifest.id !== item.id) {
      throw new Error(`the archive contains "${parsed.manifest.id}" but the registry offered "${item.id}"`);
    }

    const target = join(pluginsDir(), item.id);
    await rm(target, { recursive: true, force: true });
    await rename(root, target);

    return { id: item.id, name: parsed.manifest.name, version: parsed.manifest.version, kind: item.kind };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Delete an installed plugin. Built-ins are not ours to remove. */
export async function uninstall(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(id))) throw new Error('not a plugin id');
  const target = join(pluginsDir(), id);
  await rm(target, { recursive: true, force: true });
  return true;
}
