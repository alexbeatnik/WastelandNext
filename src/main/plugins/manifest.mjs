/**
 * What a plugin says about itself, and whether we believe it.
 *
 * Kept apart from the host because every function here is pure. A manifest is
 * untrusted input — it arrives inside an archive from a repository we do not
 * control — and the interesting cases are all decidable from the object alone:
 * an id that would escape its own directory, an `apiVersion` from a build that
 * does not exist yet, a `main` pointing at somebody else's file.
 */

/**
 * The contract version this build implements.
 *
 * A plugin naming a higher one is listed and explained rather than loaded: it
 * was written against an API this build does not have, and importing it anyway
 * fails somewhere deep inside `activate` with a message about an undefined
 * function. Bumped only when the shape of `activate(ctx)` changes in a way a
 * plugin can notice.
 */
export const PLUGIN_API_VERSION = 5;

/**
 * Services a plugin may ask the host for.
 *
 * Declared in the manifest and handed over by name, so what a plugin can reach
 * is legible from the manifest alone rather than from reading its code. A name
 * that is not on this list is a manifest error, not a runtime `undefined`.
 */
export const KNOWN_SERVICES = new Set(['browser', 'lookupBrowser', 'audio', 'notify', 'mic']);

/** Setting kinds the plugin row knows how to draw. */
export const SETTING_TYPES = new Set(['folder', 'text', 'toggle', 'select']);

/**
 * An id becomes a directory name and a key in `config.plugins`, so it is
 * validated for exactly the reason `isSafeId` in `chats.mjs` is: it is
 * interpolated into a path, and a `..` in one would reach outside `plugins/`.
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An action type is matched against what the model emitted, so keep it plain. */
const ACTION_TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Is `main` a path inside the plugin's own directory?
 *
 * The same question `assertSafeArchive` asks of an archive entry, and for the
 * same reason: the string was written by whoever built the plugin, and it is
 * about to be turned into a path we import. Backslash counts as a separator
 * even where the format says otherwise — Windows honours both.
 */
export function isContainedPath(value) {
  const path = String(value ?? '');
  if (!path || path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return path
    .split(/[\\/]+/)
    .every((segment) => segment && segment !== '..' && segment !== '.');
}

/**
 * Validate one manifest.
 *
 * Returns `{ok: true, manifest}` with every field normalised, or
 * `{ok: false, reason}` with a sentence fit to put on screen. Never throws: a
 * broken plugin is a row in the list explaining itself, not a failed boot.
 */
export function parseManifest(raw, { builtin = false } = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the manifest is not an object' };

  const id = String(raw.id ?? '').trim();
  if (!ID_RE.test(id)) {
    return { ok: false, reason: `"${id || '(no id)'}" is not a usable id — lowercase letters, digits and dashes only` };
  }

  const apiVersion = Number(raw.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1) {
    return { ok: false, reason: 'the manifest does not say which plugin API it was written for' };
  }
  if (apiVersion > PLUGIN_API_VERSION) {
    return {
      ok: false,
      reason: `written for plugin API ${apiVersion}; this build implements ${PLUGIN_API_VERSION} — update Wasteland Next`,
    };
  }

  /**
   * `main` is optional, and that is the whole difference between a plugin the
   * user has to allow and one they do not.
   *
   * A theme pack is `plugin.json` and some CSS: there is nothing to run, so
   * there is nothing to consent to, and asking for consent anyway would teach
   * people to click through the dialog that matters. Built-ins are compiled in
   * and never name one either. Whatever `main` does say must be one of the
   * plugin's own files.
   */
  const main = raw.main === undefined || raw.main === null ? '' : String(raw.main);
  if (main && !isContainedPath(main)) {
    return { ok: false, reason: `"${main}" is not a path inside the plugin` };
  }

  const actions = Array.isArray(raw.actions) ? raw.actions.map((type) => String(type)) : [];
  const badAction = actions.find((type) => !ACTION_TYPE_RE.test(type));
  if (badAction !== undefined) return { ok: false, reason: `"${badAction}" is not a usable action type` };

  const services = Array.isArray(raw.services) ? raw.services.map((name) => String(name)) : [];
  const unknown = services.find((name) => !KNOWN_SERVICES.has(name));
  if (unknown !== undefined) return { ok: false, reason: `asks for a service this build does not have: "${unknown}"` };

  // Anything that needs code must say where it is, or it would be listed as
  // working while quietly doing nothing.
  if (!builtin && !main && (actions.length > 0 || services.length > 0)) {
    return { ok: false, reason: 'declares actions or services but names no entry point' };
  }

  // Served through the plugin scheme, so it is a path inside the plugin like
  // any other asset. A registry entry carries a data URI instead, because there
  // is nothing on disk to serve before the thing is installed.
  const icon = raw.icon === undefined || raw.icon === null ? '' : String(raw.icon);
  if (icon && !isContainedPath(icon)) return { ok: false, reason: `the icon points outside the plugin: "${icon}"` };

  const themes = [];
  for (const entry of Array.isArray(raw.themes) ? raw.themes : []) {
    const id = String(entry?.id ?? '').trim();
    const file = String(entry?.file ?? '');
    if (!ID_RE.test(id)) return { ok: false, reason: `"${id || '(no id)'}" is not a usable theme id` };
    // The file is about to be handed to a protocol handler and read off disk.
    if (!isContainedPath(file)) return { ok: false, reason: `theme "${id}" points outside the plugin: "${file}"` };
    themes.push({ id, name: String(entry.name ?? id).trim() || id, file });
  }

  /**
   * Languages, keyed by the English text they replace.
   *
   * Declarative for the same reason themes are: a dictionary is data the app
   * reads itself, so a language pack has nothing to run and nothing to approve.
   */
  const locales = [];
  for (const entry of Array.isArray(raw.locales) ? raw.locales : []) {
    const id = String(entry?.id ?? '').trim();
    const file = String(entry?.file ?? '');
    // `uk`, `pt-br` — a tag, and one that is about to become part of a URL.
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(id)) return { ok: false, reason: `"${id || '(no id)'}" is not a usable language tag` };
    if (!isContainedPath(file)) return { ok: false, reason: `language "${id}" points outside the plugin: "${file}"` };
    locales.push({ id, name: String(entry.name ?? id).trim() || id, file });
  }

  const settings = [];
  for (const entry of Array.isArray(raw.settings) ? raw.settings : []) {
    const key = String(entry?.key ?? '').trim();
    const type = String(entry?.type ?? 'text');
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) return { ok: false, reason: `"${key || '(no key)'}" is not a usable setting key` };
    if (!SETTING_TYPES.has(type)) return { ok: false, reason: `setting "${key}" has an unknown type: "${type}"` };

    /**
     * A `select` is the manifest naming what the choices are.
     *
     * It exists because "which of these three models" is a real question a
     * plugin has to ask and a text box is the wrong way to ask it — the answer
     * is one of a fixed set the plugin already knows. The options are part of
     * the manifest rather than something the plugin supplies at runtime, so the
     * row can be drawn before a line of its code has run, and so what a plugin
     * may be set to stays readable without reading it.
     */
    const options = [];
    for (const option of Array.isArray(entry?.options) ? entry.options : []) {
      const value = String(option?.value ?? '').trim();
      if (!value) return { ok: false, reason: `setting "${key}" has an option with no value` };
      options.push({ value, label: String(option.label ?? value).trim() || value });
    }
    // A picker with nothing to pick is a control that cannot be used, and a
    // plugin listed as working while offering one is worse than a refusal.
    if (type === 'select' && options.length === 0) {
      return { ok: false, reason: `setting "${key}" is a picker with no options` };
    }

    settings.push({
      key,
      type,
      label: String(entry.label ?? key).trim() || key,
      placeholder: String(entry.placeholder ?? ''),
      options,
    });
  }

  return {
    ok: true,
    manifest: {
      id,
      name: String(raw.name ?? id).trim() || id,
      version: String(raw.version ?? '0.0.0'),
      description: String(raw.description ?? '').trim(),
      apiVersion,
      main,
      actions,
      services,
      builtin,
      /** Where this one sits in the system prompt; lower goes first. */
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
      enabledByDefault: raw.enabledByDefault !== false,
      themes,
      locales,
      settings,
      /** Settings keys this plugin replaced, for the one-time migration below. */
      legacy: Array.isArray(raw.legacy) ? raw.legacy.map((key) => String(key)) : [],
    },
  };
}

/**
 * Does running this plugin mean running code that came from outside the app?
 *
 * A theme pack does not: it is a manifest and some CSS, read by the app's own
 * protocol handler. Only a plugin with an entry point has to be allowed.
 */
export function needsApproval(manifest) {
  return !manifest.builtin && Boolean(manifest.main);
}

/**
 * Should this plugin be on, for a user who has never seen the plugin list?
 *
 * The four built-ins were checkboxes in the CAPABILITIES section before they
 * were plugins, and a user who deliberately switched browser control off must
 * not find it back on after an update. The old keys are only consulted when
 * *all* of them are present — a fresh install has none, and reading an absent
 * key as `false` would ship with every capability disabled.
 */
export function enabledByLegacy(manifest, settings = {}) {
  const keys = manifest.legacy ?? [];
  if (keys.length === 0 || keys.some((key) => settings[key] === undefined)) {
    return manifest.enabledByDefault;
  }
  return keys.every((key) => Boolean(settings[key]));
}

/**
 * Fold newly discovered plugins into the stored enablement map.
 *
 * Returns a new map and never edits the one passed in. An id already recorded
 * keeps its state untouched — that is the user's decision, and rediscovering
 * the plugin on the next boot must not overrule it.
 */
export function mergeEnablement(stored, manifests, settings = {}) {
  const next = { ...(stored ?? {}) };
  for (const manifest of manifests) {
    const existing = next[manifest.id];
    const approved = manifest.builtin ? true : Boolean(existing?.approved);
    next[manifest.id] = {
      // Spread first: a plugin's own settings live in here too, and rebuilding
      // the record field by field would empty them on every boot.
      ...existing,
      // A plugin that has not been allowed to run cannot default to on. It
      // did, and the result was a ticked checkbox beside a plugin the host
      // never imported — "installed" reading as "running", with nothing left to
      // click to make it true, because the box was already ticked. Installing
      // is not switching on.
      enabled: existing?.enabled ?? (needsApproval(manifest) && !approved ? false : enabledByLegacy(manifest, settings)),
      // A built-in ships inside the signed application; anything else has to be
      // approved by the person whose machine is about to run it.
      approved,
    };
  }
  return next;
}
