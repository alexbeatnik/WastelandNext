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
 */
import * as browserControl from './browser-control.mjs';
import * as webLookup from './web-lookup.mjs';
import * as readFile from './read-file.mjs';
import * as systemShell from './system-shell.mjs';

export const BUILTIN_PLUGINS = [browserControl, webLookup, readFile, systemShell];
