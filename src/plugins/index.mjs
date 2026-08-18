/**
 * The plugins that ship with the app.
 *
 * Imported statically rather than discovered on disk. There is nothing to
 * discover — they are part of this build — and a packaged app keeps `src/`
 * inside `app.asar`, where whether a dynamic import resolves is a question
 * worth not having to answer. Installed plugins live on the ordinary
 * filesystem and are imported by path; these do not.
 *
 * Each module exports a `manifest` object and an `activate(ctx)` function, the
 * same contract an installed plugin declares in `plugin.json` — one shape, one
 * validator, so a built-in cannot quietly rely on something a third party
 * could not have.
 *
 * Browser control is no longer among them, and that is a statement about what
 * the app is rather than tidying: it lives in
 * https://github.com/alexbeatnik/wasteland-plugin-manul-browser, engine and
 * all. Built in, it made the app the owner of a Chrome that only ever ran
 * because a plugin asked it to, and put a Go toolchain between somebody and a
 * working build. What is left here is what has nowhere else to live — the two
 * capabilities that reach this machine's own files and shell.
 */
import * as readFile from './read-file.mjs';
import * as systemShell from './system-shell.mjs';

export const BUILTIN_PLUGINS = [readFile, systemShell];
