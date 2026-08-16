/**
 * Getting plugins: from a registry, or from an archive on disk.
 *
 * The app ships knowing one registry — the `wasteland-plugins` repository — and
 * the user may add others. That is a real widening of trust and it is treated as
 * one: adding a registry is a deliberate act with a URL typed into it, the row
 * it produces says which registry a plugin came from, and nothing installed from
 * any of them runs code until it is separately approved. What a second registry
 * cannot do is quietly *become* the first: when two publish the same id the
 * newest version wins, but the source travels with the entry all the way to the
 * screen, so "my audio player updated" and "somebody else's audio player
 * replaced it" do not look alike.
 *
 * The install path is deliberately paranoid, in this order: the archive is
 * fetched to a scratch directory, its digest is compared against the one the
 * index published, its central directory is read *without unpacking* to refuse
 * a traversing entry, it is unpacked into a staging directory, and only a
 * staging tree that turns out to contain a valid manifest for the plugin we
 * asked for is moved into place. Nothing lands in `plugins/` until all of that
 * has held — a half-unpacked plugin directory would be discovered on the next
 * boot and listed as a broken plugin the user never installed.
 *
 * Installing from a file on disk runs the same checks with one missing: there is
 * no published digest, because there is no index making a claim about the bytes.
 * That is not a gap, it is a different question being asked. The digest exists
 * to tie a download to the index that offered it; a file the user chose in a
 * dialog was not offered by anyone, and the choice is the consent — the same
 * distinction `attach.mjs` draws between a path a model named and a path a
 * person picked. The archive is still read for traversing entries and still
 * has to contain a manifest this build can use, and its code still cannot run
 * until it is approved.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as config from '../config.mjs';
import { pluginsDir, scratchDir } from '../paths.mjs';
import { assertSafeArchive } from '../llm/zip.mjs';
import { extractZip } from '../llm/tools.mjs';
import { PLUGIN_API_VERSION, parseManifest } from './manifest.mjs';
import { normaliseCategory } from '../../shared/categories.mjs';

export const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/alexbeatnik/wasteland-plugins/main/index.json';

/**
 * Further indexes the app ships knowing about.
 *
 * One repository per plugin is a reasonable way to publish something large —
 * Space Trader carries a bundled game engine and has its own release cycle —
 * and asking every user to paste a URL to find a plugin the app already knows
 * exists is a worse answer than listing it. These are asked *as well as* the
 * primary and, like the primary, cannot be removed: they are part of the build,
 * so a remove button on one would come back at the next launch.
 *
 * Adding to this list is a decision about what this build vouches for, and it
 * is not the same act as a user adding a registry. Everything downstream is
 * unchanged — a checksum is still mandatory, an archive is still checked before
 * it is unpacked, and code still runs only once somebody switches it on.
 */
export const BUNDLED_REGISTRIES = [
  'https://raw.githubusercontent.com/alexbeatnik/-wasteland-plugin-space-trader/main/index.json',
];

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

/**
 * The registry the app looks in first.
 *
 * A setting so a developer can point the build at their own index — an override
 * of the default rather than an addition to it, which is why it stays separate
 * from the list the user adds to.
 */
export function registryUrl() {
  return String(config.get('pluginRegistry') || '').trim() || DEFAULT_REGISTRY;
}

/**
 * A short name for a registry, for a row that has no room for a URL.
 *
 * `owner/repo` when it can be worked out, because that is how anyone refers to a
 * repository, and the host otherwise. Nothing here is trusted for anything — it
 * is a label, and the full URL is the tooltip.
 */
export function registryLabel(url) {
  try {
    const target = new URL(url);
    const parts = target.pathname.split('/').filter(Boolean);
    if (/(^|\.)(githubusercontent\.com|github\.com)$/i.test(target.hostname) && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return target.hostname || String(url);
  } catch {
    return String(url ?? '');
  }
}

/**
 * Make sense of what somebody pasted into the box.
 *
 * Two things happen here. A GitHub repository URL is expanded into the raw
 * `index.json` inside it, because that is the URL people actually have in their
 * clipboard and asking them to construct the raw one by hand is asking them to
 * get `raw.githubusercontent.com` and a branch name right from memory. And the
 * scheme is checked: an index over plain `http` is a list of URLs and checksums
 * that anything on the path can rewrite, which is precisely the list this app
 * decides what to download and unpack from. Loopback is the exception, and only
 * because there is no path — a developer serving an index from their own machine
 * is not exposed to anything the rest of this rule protects against.
 *
 * Returns `{ok: true, url}` or `{ok: false, reason}`; never throws, because the
 * reason is going on screen next to the box.
 */
export function normaliseRegistryUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: 'nothing to add' };

  let target;
  try {
    target = new URL(text);
  } catch {
    return { ok: false, reason: `"${text}" is not a URL` };
  }

  if (/(^|\.)github\.com$/i.test(target.hostname)) {
    const parts = target.pathname.split('/').filter(Boolean);
    if (parts.length === 2) {
      const [owner, repo] = parts;
      target = new URL(`https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/i, '')}/main/index.json`);
    }
  }

  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(target.hostname);
  if (target.protocol === 'http:' && loopback) return { ok: true, url: target.toString() };
  if (target.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'a plugin registry has to be served over https — it is a list of things to download and run',
    };
  }
  return { ok: true, url: target.toString() };
}

/**
 * Every index to ask, in the order they are asked.
 *
 * The first is the app's own — or whatever `pluginRegistry` overrode it with —
 * and is not removable: a list with nothing in it and no way back to the default
 * is a plugin section that can only be repaired by editing `config.json`.
 */
export function registries() {
  const primary = registryUrl();
  const stored = Array.isArray(config.get('pluginRegistries')) ? config.get('pluginRegistries') : [];

  /**
   * The bundled ones come along only while the primary is the app's own.
   *
   * `pluginRegistry` is documented as an override of the default rather than an
   * addition to it, and that has to mean the whole default. A developer who has
   * pointed this build at their own index wants their index — not their index
   * plus whatever else this build happened to ship knowing about, quietly
   * fetched from the network behind them. It is also what keeps the smoke run
   * offline: it overrides the primary, and so is asked nothing else.
   */
  const bundled = config.get('pluginRegistry') ? [] : BUNDLED_REGISTRIES;

  const seen = new Set();
  const list = [];
  // Shipped ones are marked so the row that draws them leaves the remove button
  // off: they are part of the build and would be back at the next launch, and a
  // button that undoes itself overnight is worse than no button.
  const shipped = new Set([primary, ...bundled]);
  for (const url of [primary, ...bundled, ...stored.map((entry) => String(entry ?? '').trim())]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    list.push({ url, label: registryLabel(url), primary: list.length === 0, shipped: shipped.has(url) });
  }
  return list;
}

/** Add one, refusing a duplicate and anything that is not a usable index URL. */
export function addRegistry(input) {
  const parsed = normaliseRegistryUrl(input);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (registries().some((source) => source.url === parsed.url)) {
    throw new Error('that registry is already in the list');
  }
  const stored = Array.isArray(config.get('pluginRegistries')) ? config.get('pluginRegistries') : [];
  config.update({ pluginRegistries: [...stored, parsed.url] });
  return registries();
}

/**
 * Remove one.
 *
 * The primary is refused rather than silently ignored: it is drawn without a
 * remove button, so an attempt to take it away is a bug somewhere and saying so
 * is more use than pretending it worked.
 */
export function removeRegistry(url) {
  const target = String(url ?? '').trim();
  if (target === registryUrl()) throw new Error('that is the registry the app ships with');
  if (BUNDLED_REGISTRIES.includes(target)) throw new Error('that registry ships with the app');
  const stored = Array.isArray(config.get('pluginRegistries')) ? config.get('pluginRegistries') : [];
  config.update({ pluginRegistries: stored.filter((entry) => String(entry ?? '').trim() !== target) });
  return registries();
}

/**
 * One entry of the published index, normalised.
 *
 * Returns null rather than throwing: an index with one malformed row should
 * still show the others, and a registry that grows a field this build does not
 * know must not empty the list.
 */
export function parseEntry(raw, source = null) {
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
    /**
     * The heading it is listed under, before anything has been installed.
     *
     * Published in the index rather than read out of the manifest, because the
     * manifest is inside an archive that has not been downloaded — and the whole
     * point of a heading is to help somebody decide whether to download it.
     */
    category: normaliseCategory(raw.category),
    /** `code` needs approval to run; `theme` is manifest and CSS. */
    kind: raw.kind === 'theme' ? 'theme' : 'code',
    url,
    sha256: String(raw.sha256 ?? '').toLowerCase(),
    size: Number(raw.size) || 0,
    /**
     * Which index offered this.
     *
     * Carried to the screen and no further — nothing is fetched from it, and the
     * download URL is the one field that decides where the bytes come from. It
     * exists so that a plugin appearing from a registry the user added last week
     * says so on its own row.
     */
    source: String(source?.url ?? raw.source ?? ''),
    sourceLabel: String(source?.label ?? raw.sourceLabel ?? '').slice(0, 80),
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

/**
 * A URL the CDN in front of the registry cannot answer from yesterday.
 *
 * The published index is served with `Cache-Control: max-age=300`, so a check
 * made in the five minutes after a release is answered from an edge still
 * holding the previous one — and the update does not exist as far as the app is
 * concerned. That is not a hypothetical: it is how a freshly published 1.0.1
 * went unnoticed. A unique query is a different cache key, and the request
 * headers say the same thing to anything that reads them instead.
 *
 * The clean URL is what gets reported back; this one is only for the wire.
 */
export function cacheBusted(url) {
  try {
    const target = new URL(url);
    target.searchParams.set('_', Date.now().toString(36));
    return target.toString();
  } catch {
    // A URL that will not parse is about to fail the fetch anyway, and failing
    // there produces a better message than failing here.
    return url;
  }
}

/** One index, fetched and parsed. Throws with a sentence worth showing. */
async function fetchOne(source) {
  let response;
  try {
    response = await fetchWithTimeout(cacheBusted(source.url), {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
  } catch (err) {
    throw new Error(`could not be reached — ${err.name === 'AbortError' ? 'it did not answer' : err.message}`);
  }
  if (!response.ok) throw new Error(`answered ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('did not return an index');
  }

  return {
    updated: String(body?.updated ?? ''),
    plugins: (Array.isArray(body?.plugins) ? body.plugins : []).map((raw) => parseEntry(raw, source)).filter(Boolean),
  };
}

/**
 * Everything on offer, from every registry.
 *
 * Asked in parallel and reported per source, because one unreachable registry
 * must not empty the list: a user who added a colleague's index should not lose
 * the app's own the day that colleague's server goes down. The failure is on the
 * row for that registry, where it can be acted on, instead of replacing the
 * whole section with one error.
 *
 * Nothing answering at all is reported the same way, as `error` on the result
 * rather than as a rejection. It is the same failure in a larger degree, and
 * throwing lost the very thing worth showing: *which* registries were asked and
 * what each of them said. That is exactly the state where the user needs it.
 */
export async function fetchIndex() {
  const sources = registries();
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const { updated, plugins } = await fetchOne(source);
        return { ...source, ok: true, error: '', updated, count: plugins.length, plugins };
      } catch (err) {
        return { ...source, ok: false, error: err.message, updated: '', count: 0, plugins: [] };
      }
    }),
  );

  const reached = results.filter((source) => source.ok);

  /**
   * Two registries offering the same id is not an error — a fork, a mirror, or
   * somebody publishing a build of their own — so the newest wins, which is what
   * an update button would have offered anyway. What matters is that it is not
   * silent: the entry keeps the label of the registry it came from, and the row
   * shows it whenever that is not the app's own.
   */
  const merged = new Map();
  for (const source of reached) {
    for (const entry of source.plugins) {
      const held = merged.get(entry.id);
      if (!held || compareVersions(entry.version, held.version) > 0) merged.set(entry.id, entry);
    }
  }

  return {
    // The primary, for anything that still asks a single-registry question.
    url: sources[0]?.url ?? '',
    updated: reached[0]?.updated ?? '',
    sources: results.map(({ plugins: _plugins, ...source }) => source),
    plugins: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    /** Empty unless *no* registry answered; each one's own failure is on its row. */
    error:
      reached.length > 0
        ? ''
        : `could not reach the plugin registry — ${results[0]?.error ?? 'there is none configured'}`,
  };
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
 * Check an archive, unpack it, and move the result into `plugins/`.
 *
 * Shared by both ways in, because everything after "how did these bytes get
 * here" is the same question: is the archive safe to unpack, does it hold a
 * plugin this build can use, and is it the plugin we were promised. Nothing
 * touches `plugins/` until all three have been answered.
 */
async function place(archive, staging, { expectId = '' } = {}) {
  // Reads the central directory only; nothing is unpacked to find this out.
  await assertSafeArchive(archive);
  extractZip(archive, staging);

  const root = await findManifestRoot(staging);
  if (!root) throw new Error('the archive contains no plugin.json');

  let raw;
  try {
    raw = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  } catch (err) {
    // A parser's own message ("Unexpected token } in JSON at position 412") is
    // no use to somebody who was handed the file by a colleague.
    throw new Error(`the archive's plugin.json could not be read — ${err.message}`);
  }

  const parsed = parseManifest(raw, { builtin: false });
  if (!parsed.ok) throw new Error(`the archive holds an unusable plugin — ${parsed.reason}`);
  // The index said one thing and the archive another; whichever is wrong, the
  // plugin would be installed under a name it does not answer to.
  if (expectId && parsed.manifest.id !== expectId) {
    throw new Error(`the archive contains "${parsed.manifest.id}" but the registry offered "${expectId}"`);
  }

  const target = join(pluginsDir(), parsed.manifest.id);
  // An existing installation is replaced by two renames with a restore between
  // them, never by a delete followed by hope: a failure after the `rm` and
  // before the `rename` would leave neither the old plugin nor the new one.
  // The old directory is moved aside into the scratch tree the staging already
  // lives in — the same volume, so the rename cannot hit `EXDEV`, and outside
  // `plugins/`, so a crash right here is not discovered on the next boot as a
  // broken plugin the user never installed.
  const retired = `${staging}-retired`;
  let hadPrevious = false;
  try {
    await rename(target, retired);
    hadPrevious = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await rename(root, target);
  } catch (err) {
    // Put the old installation back, and report the error that stopped the
    // install rather than anything the restore itself has to say.
    if (hadPrevious) await rename(retired, target).catch(() => {});
    throw err;
  }
  if (hadPrevious) await rm(retired, { recursive: true, force: true }).catch(() => {});

  return {
    id: parsed.manifest.id,
    name: parsed.manifest.name,
    version: parsed.manifest.version,
    // Taken from the manifest, not from what the index claimed: `kind` is what
    // decides whether this needs approval before it runs, and the manifest is
    // the thing that actually decides that.
    kind: parsed.manifest.main ? 'code' : 'theme',
  };
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

  const scratch = await mkdtemp(join(scratchDir(), 'plugin-'));
  const archive = join(scratch, 'plugin.zip');

  try {
    onProgress?.({ stage: 'download', id: item.id });
    const { digest } = await download(item.url, archive, (progress) =>
      onProgress?.({ stage: 'download', id: item.id, ...progress }),
    );
    if (digest !== item.sha256) {
      throw new Error('the download does not match the checksum the registry published');
    }

    onProgress?.({ stage: 'verify', id: item.id });
    onProgress?.({ stage: 'unpack', id: item.id });
    return await place(archive, join(scratch, 'unpacked'), { expectId: item.id });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Install from an archive the user picked off their own disk.
 *
 * For a plugin that was never published, a build handed over on a stick, or a
 * machine that has no way to reach the registry at all. There is no checksum to
 * compare against — an index is what publishes one, and there is no index here —
 * so what is being trusted is the person who chose the file, exactly as it is
 * when they attach a folder or register a model from outside the vault.
 *
 * Everything else holds: the archive is refused if any entry would unpack
 * outside its own directory, the manifest has to be one this build can use, and
 * the code inside it does not run until the plugin is approved on its row. The
 * digest is computed anyway and handed back, so somebody who *does* have a
 * published hash can compare the two.
 *
 * The chosen file is only ever read. Nothing is written beside it and nothing is
 * moved out of it.
 */
export async function installArchive(archivePath, { onProgress } = {}) {
  const file = String(archivePath ?? '').trim();
  if (!file) throw new Error('no archive was chosen');

  let info;
  try {
    info = await stat(file);
  } catch {
    throw new Error(`${basename(file)} could not be read`);
  }
  if (!info.isFile()) throw new Error('that is a folder, not a plugin archive');
  if (info.size === 0) throw new Error('that file is empty');
  if (info.size > MAX_ARCHIVE_BYTES) throw new Error('that archive is far larger than a plugin should be');

  const name = basename(file);
  const scratch = await mkdtemp(join(scratchDir(), 'plugin-'));
  try {
    onProgress?.({ stage: 'verify', id: name });
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');

    onProgress?.({ stage: 'unpack', id: name });
    const placed = await place(file, join(scratch, 'unpacked'));
    return { ...placed, sha256: digest, from: 'file' };
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
