/**
 * Reading a file for the model to talk about.
 *
 * Read-only by construction — there is no write path in this module. The path
 * check exists so an offhand "what's in my config?" cannot turn into the model
 * reading key material back into a chat log; it is a guardrail on a convenience
 * feature, not a security boundary.
 */
import { readFile as fsReadFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/**
 * Directory names that hold credentials often enough to be worth refusing.
 *
 * Exported because attachments apply the same list. A model naming a path and a
 * user dropping a folder differ in how much they may reach, but neither has any
 * business pasting a private key into a chat log.
 */
export const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store', '.netrc']);

/** Biggest file we will paste into a prompt. Beyond this we read the head. */
export const MAX_READ_BYTES = 64 * 1024;

/**
 * Resolve a user-supplied path and say whether it may be read.
 *
 * Returns `{ok: true, path}` or `{ok: false, reason}`. `~` is expanded because
 * people type it, and a relative path is taken as relative to home rather than
 * to wherever the app happens to be running.
 */
export function resolveReadablePath(input, home = homedir()) {
  const raw = String(input ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return { ok: false, reason: 'no path given' };

  const expanded = raw.startsWith('~') ? resolve(home, raw.slice(1).replace(/^[/\\]/, '')) : raw;
  const full = normalize(isAbsolute(expanded) ? expanded : resolve(home, expanded));

  const rel = relative(home, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'outside the home directory' };
  }

  const segments = rel.split(sep);
  const secret = segments.find((s) => SECRET_DIRS.has(s.toLowerCase()));
  if (secret) return { ok: false, reason: `${secret} holds credentials` };

  return { ok: true, path: full };
}

/**
 * Follow symlinks and vet where the path ends up.
 *
 * Returns `{ok: true, path}` with the resolved path, or `{ok: false, reason}`.
 * A path that resolves to itself is passed straight back, so the ordinary case
 * costs one `realpath` and nothing else.
 */
export async function resolveThroughLinks(path, home = homedir()) {
  let real;
  try {
    real = await realpath(path);
  } catch {
    return { ok: false, reason: 'no such file' };
  }
  if (real === path) return { ok: true, path };

  const realHome = await realpath(home).catch(() => home);
  const again = resolveReadablePath(real, realHome);
  if (!again.ok) return { ok: false, reason: `${again.reason} — that path is a link` };
  return { ok: true, path: real };
}

/**
 * Read a vetted file as text.
 *
 * Oversized files are truncated with a marker rather than refused: the head of
 * a big log usually answers the question, and a refusal answers nothing.
 */
export async function readForModel(input, home = homedir()) {
  const vetted = resolveReadablePath(input, home);
  if (!vetted.ok) return { ok: false, reason: vetted.reason };

  // The check above reads text; `stat` and `readFile` follow links. A link
  // sitting in home and pointing at `~/.ssh/id_rsa` passes every rule above by
  // its *name* and then hands over the key, so what is vetted is where the path
  // actually lands. Home itself is a link on some systems (macOS resolves
  // `/Users/x` to `/System/Volumes/…`), so the real path is measured against a
  // resolved home or every read would be refused as "outside".
  const landed = await resolveThroughLinks(vetted.path, home);
  if (!landed.ok) return { ok: false, reason: landed.reason };

  let info;
  try {
    info = await stat(landed.path);
  } catch {
    return { ok: false, reason: 'no such file' };
  }
  if (info.isDirectory()) return { ok: false, reason: 'that is a directory' };

  try {
    const buffer = await fsReadFile(landed.path);
    const truncated = buffer.length > MAX_READ_BYTES;
    const text = buffer.subarray(0, MAX_READ_BYTES).toString('utf8');
    return {
      ok: true,
      path: landed.path,
      size: info.size,
      truncated,
      content: truncated ? `${text}\n… (truncated at ${MAX_READ_BYTES} bytes of ${info.size})` : text,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
