/**
 * Fetching `llama-server` so a fresh install can actually run a model.
 *
 * Upstream ships prebuilt binaries per release; there is no reason to make
 * someone find and unpack one by hand before the app does anything.
 *
 * The release is resolved from the GitHub API rather than pinned to a tag.
 * A pin goes stale in two directions — the tag can 404, or it can predate a
 * flag we pass and the server exits with "invalid argument" — and neither is
 * visible until a user hits it. `PINNED_TAG` exists only as a fallback for when
 * the API is unreachable.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { removeWhenReleased } from '../models/manager.mjs';
import { assertSafeArchive } from './zip.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { toolsDir } from '../paths.mjs';

const REPO = 'ggml-org/llama.cpp';
/** Only used when the releases API cannot be reached. */
const PINNED_TAG = 'b10068';

export const SERVER_EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/**
 * Which release asset this machine wants, best first.
 *
 * Vulkan is preferred on Windows and Linux because it uses the GPU on both
 * NVIDIA and AMD without a CUDA toolkit — the same reasoning OS-Manul uses. The
 * CPU build is the fallback for machines with no Vulkan runtime.
 */
export function assetPatterns() {
  if (process.platform === 'win32') {
    return [/bin-win-vulkan-x64\.zip$/i, /bin-win-cpu-x64\.zip$/i, /bin-win-.*x64\.zip$/i];
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? [/bin-macos-arm64\.zip$/i] : [/bin-macos-x64\.zip$/i];
  }
  return [/bin-ubuntu-vulkan-x64\.zip$/i, /bin-ubuntu-x64\.zip$/i];
}

/** Pick the first asset matching the highest-priority pattern that hits. */
export function pickAsset(names) {
  for (const pattern of assetPatterns()) {
    const hit = names.find((name) => pattern.test(name));
    if (hit) return hit;
  }
  return null;
}

/** Ask GitHub for the newest release and the asset URL for this platform. */
async function resolveRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const release = await res.json();
      const names = (release.assets ?? []).map((a) => a.name);
      const name = pickAsset(names);
      if (name) {
        const asset = release.assets.find((a) => a.name === name);
        return { tag: release.tag_name, name, url: asset.browser_download_url };
      }
    }
  } catch {
    /* offline, rate-limited, or shaped differently than expected */
  }

  // Fallback: build the pinned URL by hand. Its asset name follows the same
  // scheme every release uses.
  const suffix = process.platform === 'win32' ? 'bin-win-vulkan-x64' : process.platform === 'darwin' ? 'bin-macos-arm64' : 'bin-ubuntu-vulkan-x64';
  const name = `llama-${PINNED_TAG}-${suffix}.zip`;
  return { tag: PINNED_TAG, name, url: `https://github.com/${REPO}/releases/download/${PINNED_TAG}/${name}` };
}

/**
 * Quote a path for a PowerShell single-quoted string.
 *
 * PowerShell escapes an apostrophe by doubling it. Without this a home
 * directory like `C:\Users\O'Connor` closes the string early and the command
 * fails to parse — the user's own name breaking the unpack.
 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Ways to unpack a zip with what the OS already has, best first.
 *
 * `tar` on PATH is deliberately NOT the first choice on Windows: bsdtar in
 * System32 reads zip, but a machine with Git installed usually has **GNU** tar
 * ahead of it on PATH, and GNU tar cannot read zip at all. Resolving System32
 * explicitly is the difference between this working and failing on a developer
 * machine. PowerShell is the last resort — slow, but present on every Windows.
 *
 * Bundling a zip library for one download would be a poor trade.
 */
function extractors(zipPath, targetDir) {
  if (process.platform === 'win32') {
    const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    return [
      [system32, ['-xf', zipPath, '-C', targetDir]],
      ['tar', ['-xf', zipPath, '-C', targetDir]],
      [
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(targetDir)} -Force`,
        ],
      ],
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ['tar', ['-xf', zipPath, '-C', targetDir]],
      ['unzip', ['-o', '-q', zipPath, '-d', targetDir]],
    ];
  }
  // GNU tar cannot read zip, so `unzip` leads on Linux; bsdtar may be present.
  return [
    ['unzip', ['-o', '-q', zipPath, '-d', targetDir]],
    ['bsdtar', ['-xf', zipPath, '-C', targetDir]],
  ];
}

/** Unpack, trying each extractor until one succeeds. */
function extractZip(zipPath, targetDir) {
  const failures = [];
  for (const [command, args] of extractors(zipPath, targetDir)) {
    const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (result.status === 0) return command;
    failures.push(`${command}: ${result.error?.code ?? String(result.stderr ?? '').trim().split('\n')[0] ?? `exit ${result.status}`}`);
  }
  throw new Error(
    `could not unpack the archive (${failures.join('; ')})${
      process.platform === 'linux' ? ' — install `unzip`' : ''
    }`,
  );
}

/** Depth-first search for the server binary, wherever the archive put it. */
async function findServerBinary(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === SERVER_EXE.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findServerBinary(join(dir, entry.name));
    if (found) return found;
  }
  return null;
}

/** Where a previous download put the binary, or null. */
export async function installedServerPath() {
  return findServerBinary(join(toolsDir(), 'llama'));
}

/**
 * Download and unpack `llama-server`.
 *
 * Returns the absolute path to the binary. `onProgress({received, total,
 * percent, filename})` fires as bytes land, matching the model downloader so
 * the UI can reuse its meter.
 */
export async function downloadLlamaServer({ onProgress, onStatus, signal } = {}) {
  const dir = join(toolsDir(), 'llama');
  // `toolsDir()` makes `tools/`, not this subdirectory — without it the very
  // first download fails on opening the write stream.
  mkdirSync(dir, { recursive: true });

  const release = await resolveRelease();
  onStatus?.(`llama.cpp ${release.tag} — ${release.name}`);

  const zipPath = join(dir, release.name);
  const res = await fetch(release.url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${release.name}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    onProgress?.({
      filename: release.name,
      received,
      total,
      percent: total ? Math.min(100, (received / total) * 100) : 0,
    });
  });

  try {
    await pipeline(source, createWriteStream(zipPath), { signal });
    // Every extractor here trusts the names in the archive, so they are read
    // and checked first: a substituted release could otherwise drop a file
    // anywhere this process can write, and the binary we then go looking for is
    // one we spawn.
    await assertSafeArchive(zipPath);
    onStatus?.('Unpacking…');
    extractZip(zipPath, dir);
  } finally {
    // Same Windows handle-release race as the model downloader: a plain `rm`
    // here can throw EBUSY and bury the real failure.
    await removeWhenReleased(zipPath);
  }

  const binary = await findServerBinary(dir);
  if (!binary) throw new Error(`${SERVER_EXE} was not in ${release.name}`);

  // Upstream archives are not always mode-correct once they have been through
  // a browser download; the spawn would fail with EACCES rather than say why.
  if (process.platform !== 'win32') {
    try {
      const { chmod } = await import('node:fs/promises');
      const info = await stat(binary);
      await chmod(binary, info.mode | 0o111);
    } catch {
      /* reported by the spawn if it actually matters */
    }
  }

  return binary;
}

/** True when something on disk can already serve inference. */
export async function llamaServerStatus(configuredPath) {
  if (configuredPath && existsSync(configuredPath)) return { found: true, path: configuredPath, source: 'configured' };
  const installed = await installedServerPath();
  if (installed) return { found: true, path: installed, source: 'downloaded' };

  // `where`/`which` is the cheapest honest answer for "is it on PATH".
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [SERVER_EXE], { encoding: 'utf8' });
  if (probe.status === 0) {
    const path = String(probe.stdout).split('\n')[0].trim();
    if (path) return { found: true, path, source: 'PATH' };
  }
  return { found: false, path: '', source: '' };
}
