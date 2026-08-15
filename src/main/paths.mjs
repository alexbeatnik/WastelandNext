/**
 * Where everything on disk lives.
 *
 * The data root is injected once at boot rather than read from `electron` here,
 * so every module below this one (config, chats, models) stays importable from
 * a plain `node --test` process with no Electron around it.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let root = null;

/** Platform default, used when nothing was injected (tests, CLI tools). */
function defaultRoot() {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'wasteland-next');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'wasteland-next');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'wasteland-next');
}

/** Called once from `main.mjs` with Electron's userData directory. */
export function setDataRoot(dir) {
  root = dir;
}

export function dataRoot() {
  return root ?? defaultRoot();
}

/** A subdirectory of the data root, created on first ask. */
export function ensureDir(...parts) {
  const dir = join(dataRoot(), ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const modelsDir = () => ensureDir('models');
export const chatsDir = () => ensureDir('chats');
export const toolsDir = () => ensureDir('tools');
export const logsDir = () => ensureDir('logs');
/** Installed plugins, one directory each. Built-ins ship inside the app. */
export const pluginsDir = () => ensureDir('plugins');
/**
 * A plugin's own document, one JSON file each.
 *
 * Deliberately not inside the plugin's directory: that whole tree is deleted and
 * replaced on every update, which would make an update the thing that loses your
 * reminders.
 */
export const pluginStateDir = () => ensureDir('plugin-state');
/**
 * Somewhere to unpack before moving into place.
 *
 * Inside the data root rather than in the system temporary directory, because
 * the last step of an install is a rename onto the data root — and a rename
 * across volumes fails with `EXDEV`. On a machine whose `TEMP` is on a different
 * drive from `%LOCALAPPDATA%`, staging in `tmpdir()` makes every install fail at
 * the very end, after the download, the checksum and the unpacking all worked.
 */
export const scratchDir = () => ensureDir('scratch');
export const configPath = () => join(dataRoot(), 'config.json');
