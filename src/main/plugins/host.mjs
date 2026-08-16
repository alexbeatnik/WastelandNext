/**
 * The plugin registry.
 *
 * A plugin contributes four things and nothing else: action types the model may
 * emit, a slice of the system prompt describing them, context appended to that
 * prompt each turn, and a hook run at the start of a turn. Everything it needs
 * from the app arrives as a named service it declared in its manifest, so what
 * a plugin can reach is legible without reading its code.
 *
 * Built-ins are imported statically from `src/plugins/index.mjs` rather than
 * discovered on disk. They ship inside the app, so there is nothing to discover
 * — and a packaged build keeps `src/` inside `app.asar`, where a dynamic import
 * is a question worth not asking. Installed plugins live in the data directory,
 * on the ordinary filesystem, and are imported by path.
 *
 * Nothing here may throw at the caller. A plugin that fails to load is a row in
 * the list with a reason on it; a plugin that fails to activate takes its own
 * contributions down and leaves the rest of the app alone.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as config from '../config.mjs';
import { pluginDataDir, pluginStateDir, pluginsDir } from '../paths.mjs';
import { PluginStateStore } from './state.mjs';
import { PLUGIN_API_VERSION, mergeEnablement, needsApproval, parseManifest } from './manifest.mjs';
import { pluginAssetUrl } from '../../shared/schemes.mjs';
import { DEFAULT_CATEGORY } from '../../shared/categories.mjs';
import { BUILTIN_PLUGINS } from '../../plugins/index.mjs';

export { PLUGIN_API_VERSION };

/** Sort key: built-ins first, then by the order they asked for, then by id. */
function rank(entry) {
  return [entry.manifest.builtin ? 0 : 1, entry.manifest.order, entry.manifest.id];
}

function byRank(a, b) {
  const [aBuiltin, aOrder, aId] = rank(a);
  const [bBuiltin, bOrder, bId] = rank(b);
  return aBuiltin - bBuiltin || aOrder - bOrder || aId.localeCompare(bId);
}

export class PluginHost extends EventEmitter {
  #services;
  #userDir;
  #entries = new Map();
  /** Active action handlers, by type. Rebuilt whenever activation changes. */
  #actions = new Map();
  #fragments = [];
  #contexts = [];
  #turnHooks = [];
  /** Stylesheets offered by enabled plugins, whether or not they run code. */
  #themes = [];
  /** Dictionaries, same deal: data the app reads, no code involved. */
  #locales = [];
  /** `id → [fn]`, called when the user edits one of a plugin's settings. */
  #settingsHooks = new Map();
  /**
   * `id → version-mtime` of the code actually imported, for the life of the
   * process. Kept outside `#entries` because rediscovery rebuilds those, and
   * the whole point is to remember what an earlier discovery loaded.
   */
  #loadedStamps = new Map();
  /** Each plugin's own JSON document. Created on first use, so tests can inject. */
  #stateDir;
  #state = null;
  #ready = null;

  /**
   * @param services  named objects plugins may ask for — see `KNOWN_SERVICES`
   * @param userDir   where installed plugins live; defaults to the data root
   * @param stateDir  where their own documents live; defaults to the data root
   */
  constructor({ services = {}, userDir = null, stateDir = null } = {}) {
    super();
    this.#services = services;
    this.#userDir = userDir;
    this.#stateDir = stateDir;
  }

  /**
   * Resolved late rather than in the constructor: `pluginStateDir()` creates the
   * directory, and the host is constructed at import time — before `main.mjs`
   * has told `paths.mjs` where the data root is.
   */
  #states() {
    if (!this.#state) this.#state = new PluginStateStore(this.#stateDir ?? pluginStateDir());
    return this.#state;
  }

  /** Resolves once the first load has finished. Awaited before a turn runs. */
  get ready() {
    return this.#ready ?? Promise.resolve();
  }

  /**
   * Discover everything, then activate whatever is switched on.
   *
   * Safe to call again: rediscovery keeps each plugin's recorded state, so a
   * reload never overrules a decision the user made.
   */
  load() {
    this.#ready = this.#load().catch((err) => {
      // Discovery itself failing is not a reason to have no app. The list will
      // be empty, the log will say why.
      this.emit('log', `plugins: ${err.message}`);
    });
    return this.#ready;
  }

  async #load() {
    this.#entries.clear();
    for (const entry of this.#discover()) this.#entries.set(entry.manifest.id, entry);

    // Newly discovered ids get a default; ids already recorded keep what the
    // user chose. The legacy capability checkboxes are read here, once.
    const settings = config.load();
    const plugins = mergeEnablement(settings.plugins, [...this.#entries.values()].map((e) => e.manifest), settings);
    if (JSON.stringify(plugins) !== JSON.stringify(settings.plugins ?? {})) config.update({ plugins });

    await this.#reactivate();
  }

  /**
   * Every plugin this build can see, valid or not.
   *
   * A manifest that does not parse still produces an entry — a plugin that is
   * silently absent is indistinguishable from one that was never installed, and
   * the user has no way to find out which.
   */
  #discover() {
    const entries = [];

    for (const builtin of BUILTIN_PLUGINS) {
      const parsed = parseManifest(builtin.manifest, { builtin: true });
      if (!parsed.ok) {
        // Ours, so this is a bug rather than bad input — but it still must not
        // stop the others from loading.
        entries.push(this.#broken(builtin.manifest?.id ?? 'builtin', parsed.reason, true));
        continue;
      }
      entries.push({ manifest: parsed.manifest, module: builtin, error: '', active: false, contributions: null });
    }

    for (const found of this.#discoverInstalled()) entries.push(found);
    return entries.sort(byRank);
  }

  #discoverInstalled() {
    const root = this.#userDir ?? pluginsDir();
    let names = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
    } catch {
      return [];
    }

    const entries = [];
    for (const name of names) {
      const dir = join(root, name);
      const manifestPath = join(dir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;

      let raw;
      try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        entries.push(this.#broken(name, `plugin.json could not be read — ${err.message}`, false));
        continue;
      }

      const parsed = parseManifest(raw, { builtin: false });
      if (!parsed.ok) {
        entries.push(this.#broken(name, parsed.reason, false));
        continue;
      }
      // The directory is what the installer keys on, so a manifest whose id
      // disagrees with it would be installed under one name and looked up under
      // another.
      if (parsed.manifest.id !== name) {
        entries.push(this.#broken(name, `the manifest calls itself "${parsed.manifest.id}" but it is installed as "${name}"`, false));
        continue;
      }
      entries.push({ manifest: parsed.manifest, module: null, dir, error: '', active: false, contributions: null, stale: false });
    }
    return entries;
  }

  /** A listable entry for something that could not be understood. */
  #broken(id, reason, builtin) {
    return {
      manifest: {
        id,
        name: id,
        version: '',
        description: '',
        apiVersion: 0,
        main: '',
        actions: [],
        services: [],
        // Every field `list()` reads, present and empty. A broken entry is
        // still a row on screen, and a row that throws while being drawn takes
        // the whole list with it.
        themes: [],
        locales: [],
        settings: [],
        icon: '',
        category: DEFAULT_CATEGORY,
        builtin,
        order: 100,
        enabledByDefault: false,
        legacy: [],
      },
      module: null,
      error: reason,
      broken: true,
      active: false,
      contributions: null,
    };
  }

  /** Is this plugin allowed to run at all, whatever the user switched on? */
  #loadable(entry) {
    if (entry.broken) return false;
    // Code from outside the application is not run because it is present. It is
    // run because somebody said so, once, knowing what it means. A theme pack
    // has no code and therefore nothing to say yes to.
    return !needsApproval(entry.manifest) || this.#stateOf(entry.manifest.id).approved;
  }

  /** Does this one bring code at all, or only files the app reads itself? */
  #hasCode(entry) {
    return entry.manifest.builtin || Boolean(entry.manifest.main);
  }

  #stateOf(id) {
    const plugins = config.get('plugins') ?? {};
    return plugins[id] ?? { enabled: false, approved: false, settings: {} };
  }

  /**
   * Tear down every contribution and put back the ones that should be there.
   *
   * Rebuilding wholesale rather than adding and removing pieces is what keeps a
   * disabled plugin from leaving an action behind: there is one place where the
   * flat maps are filled, and it only ever reads from active entries.
   */
  async #reactivate() {
    for (const entry of this.#entries.values()) {
      if (!entry.active) continue;
      entry.active = false;
      entry.contributions = null;
      try {
        await entry.module?.deactivate?.();
      } catch (err) {
        this.emit('log', `${entry.manifest.id}: deactivate failed — ${err.message}`);
      }
      // A service holding something on this plugin's behalf — the audio
      // transport is the case that exists — is told to let go. Done through a
      // hook every service may implement rather than by naming them here, so
      // the host does not have to know what any of them are for.
      for (const name of entry.manifest.services) {
        try {
          this.#services[name]?.releasePlugin?.(entry.manifest.id);
        } catch (err) {
          this.emit('log', `${entry.manifest.id}: ${name} would not release — ${err.message}`);
        }
      }
    }

    this.#actions.clear();
    this.#fragments = [];
    this.#contexts = [];
    this.#turnHooks = [];
    this.#themes = [];
    this.#locales = [];
    this.#settingsHooks.clear();

    for (const entry of [...this.#entries.values()].sort(byRank)) {
      if (entry.broken) continue;
      // A previous activation failure is cleared before trying again: the
      // reason it failed may be the thing the user has just fixed.
      entry.error = '';
      if (!this.#stateOf(entry.manifest.id).enabled) continue;

      // Themes come off the manifest, not out of an activation. A theme pack is
      // data the app reads with its own protocol handler, so it works with no
      // code involved — which is the whole reason it needs no approval.
      for (const theme of entry.manifest.themes) {
        this.#themes.push({
          ...theme,
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          key: `${entry.manifest.id}/${theme.id}`,
          url: pluginAssetUrl(entry.manifest.id, theme.file),
        });
      }

      for (const locale of entry.manifest.locales ?? []) {
        this.#locales.push({
          ...locale,
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          key: `${entry.manifest.id}/${locale.id}`,
          url: pluginAssetUrl(entry.manifest.id, locale.file),
        });
      }

      if (!this.#hasCode(entry)) continue;
      if (!this.#loadable(entry)) continue;
      await this.#activate(entry);
    }

    this.emit('changed', this.list());
  }

  async #activate(entry) {
    const { manifest } = entry;
    try {
      if (!entry.module) entry.module = await this.#import(entry);

      const contributions = { actions: [], fragments: [], contexts: [], turnHooks: [], settingsHooks: [] };
      const activate = entry.module?.activate ?? entry.module?.default?.activate;
      if (typeof activate !== 'function') throw new Error('exports no activate() function');

      await activate(this.#contextFor(manifest, contributions));

      // Registered only once the whole activation succeeded: a plugin that
      // registers two actions and throws between them would otherwise leave
      // half of itself running, which is worse than none of it. Every conflict
      // is looked for *before* anything is committed, for the same reason —
      // finding one on the second action after the first had already gone into
      // the map would recreate exactly the half-registered state this block
      // exists to prevent: a dispatchable action whose prompt fragment never
      // arrived.
      const claimed = new Set();
      for (const action of contributions.actions) {
        const taken = this.#actions.get(action.type);
        if (taken) {
          // Built-ins are activated first, so the one already there is either a
          // built-in or an earlier plugin — and quietly letting the newcomer
          // shadow `system_shell` is how an action stops meaning what the
          // prompt says it means.
          throw new Error(`action "${action.type}" is already provided by ${taken.pluginId}`);
        }
        if (claimed.has(action.type)) {
          throw new Error(`action "${action.type}" is registered twice`);
        }
        claimed.add(action.type);
      }
      for (const action of contributions.actions) {
        this.#actions.set(action.type, { ...action, pluginId: manifest.id, pluginName: manifest.name });
      }
      this.#fragments.push(...contributions.fragments);
      this.#contexts.push(...contributions.contexts.map((fn) => ({ id: manifest.id, fn })));
      this.#turnHooks.push(...contributions.turnHooks.map((fn) => ({ id: manifest.id, fn })));
      if (contributions.settingsHooks.length) this.#settingsHooks.set(manifest.id, contributions.settingsHooks);

      entry.active = true;
      entry.contributions = contributions;
      entry.error = '';
    } catch (err) {
      entry.active = false;
      entry.contributions = null;
      entry.error = err.message;
      this.emit('log', `${manifest.id}: ${err.message}`);
    }
  }

  /**
   * Import a plugin's entry point, and notice when what is on disk has moved
   * on from what is running.
   *
   * Node caches ES modules by resolved URL, and an update writes over the same
   * path, so an updated plugin goes on executing the code it was first loaded
   * with until the app restarts. An earlier version tried to defeat that by
   * importing the entry point under a unique query — and made it worse. The
   * query is not inherited by the plugin's own `import './library.mjs'`, which
   * resolves without it and comes back from the cache: a *new* entry point
   * against *old* dependencies. The observed result was
   * `does not provide an export named 'readTracks'` — a plugin that had been
   * working, broken by being updated.
   *
   * So the cache is left alone and the mismatch is reported instead. The old
   * code keeps running, which it was doing anyway, and the row says a restart
   * is what finishes the update. Hot-swapping a module graph needs a loader
   * hook, and a loader hook in the main process affects every import in the
   * app to fix one that a restart fixes for free.
   */
  async #import(entry) {
    const target = join(entry.dir, entry.manifest.main);
    if (!existsSync(target)) throw new Error(`${entry.manifest.main} is missing`);

    let stamp = entry.manifest.version;
    try {
      stamp += `-${statSync(target).mtimeMs}`;
    } catch {
      /* the version alone still distinguishes an update */
    }

    const loaded = this.#loadedStamps.get(entry.manifest.id);
    if (loaded === undefined) this.#loadedStamps.set(entry.manifest.id, stamp);
    // Anything already imported answers from the loader's registry whatever we
    // pass, so this is a statement about what the user will get, not a choice.
    else if (loaded !== stamp) entry.stale = true;

    return import(pathToFileURL(target).href);
  }

  /** The object a plugin's `activate` is handed. */
  #contextFor(manifest, contributions) {
    const services = this.#services;
    return {
      id: manifest.id,
      apiVersion: PLUGIN_API_VERSION,

      /**
       * A service named in the manifest.
       *
       * Refused otherwise, on purpose: the manifest is what the user and the
       * plugin list can read, and a plugin reaching for something it never
       * declared makes that listing a lie.
       */
      service(name) {
        if (!manifest.services.includes(name)) {
          throw new Error(`service "${name}" was not declared in the manifest`);
        }
        const service = services[name];
        if (!service) throw new Error(`service "${name}" is not available in this session`);
        return service;
      },

      /**
       * Register an action type the model may emit.
       *
       * `choose` is optional and is what makes an answer interactive: a `run`
       * that returns `choices` has them drawn as buttons under its result, and
       * clicking one calls `choose`. It exists because the alternative — the
       * model guessing which of five near-identical matches was meant, or the
       * user retyping a file name — is worse at both ends. A click arrives long
       * after the turn has finished, so `choose` gets no abort signal: it is a
       * user action, like pressing the player's next button.
       */
      action({ type, run, choose }) {
        if (!manifest.actions.includes(type)) {
          throw new Error(`action "${type}" was not declared in the manifest`);
        }
        if (typeof run !== 'function') throw new Error(`action "${type}" has no run()`);
        if (choose !== undefined && typeof choose !== 'function') {
          throw new Error(`action "${type}" has a choose that is not a function`);
        }
        contributions.actions.push({ type, run, choose });
      },

      /** The slice of the system prompt that documents those actions. */
      prompt(text) {
        const value = String(text ?? '').trim();
        if (value) contributions.fragments.push(value);
      },

      /** Context recomputed each turn — the browser's page map, for instance. */
      context(fn) {
        if (typeof fn === 'function') contributions.contexts.push(fn);
      },

      /** Called once per user message, before the first model call. */
      onTurnStart(fn) {
        if (typeof fn === 'function') contributions.turnHooks.push(fn);
      },

      /**
       * The plugin's own settings, as the user filled them in.
       *
       * Read live rather than captured at activation, so a plugin that asks for
       * its music folder on every scan sees the folder the user picked a moment
       * ago without the host having to restart it.
       */
      store: {
        get: (key, fallback = '') => {
          if (!manifest.settings.some((setting) => setting.key === key)) {
            throw new Error(`setting "${key}" was not declared in the manifest`);
          }
          const stored = (config.get('plugins') ?? {})[manifest.id]?.settings ?? {};
          return stored[key] ?? fallback;
        },
        all: () => ({ ...((config.get('plugins') ?? {})[manifest.id]?.settings ?? {}) }),
      },

      /** Called after the user edits one of those settings. */
      onSettingsChanged(fn) {
        if (typeof fn === 'function') contributions.settingsHooks.push(fn);
      },

      /**
       * The plugin's own document, for what nobody declares.
       *
       * `store` is the user's answers to the manifest's questions, and every key
       * in it is a control on the plugin's row. A list of reminders is neither:
       * it is written by the plugin, read by the plugin, and has no business
       * being drawn as a settings field or living in `config.json`. Undeclared
       * by design — the manifest describes what a plugin can *reach*, and this
       * reaches nothing but itself.
       */
      state: {
        get: () => this.#states().read(manifest.id),
        set: (value) => this.#states().write(manifest.id, value),
      },

      /**
       * A directory of its own, for what does not fit in a JSON document.
       *
       * A function rather than a field, so a plugin that never wants one never
       * causes an empty directory to be created. It sits outside the plugin's
       * installed tree, which is deleted and rewritten on every update — a
       * speech model downloaded into that tree would be downloaded again on
       * every version bump.
       */
      dataDir: () => pluginDataDir(manifest.id),

      log: (text) => this.emit('log', `${manifest.id}: ${text}`),

      /**
       * A long job, reported on the plugin's own row.
       *
       * The activity log is the wrong place for a 1.5 GB download: it scrolls,
       * it is a column the narrow layout hides, and a percentage that has to be
       * hunted for is one nobody watches. This draws where the thing being
       * waited for was started. An empty text takes the line away, which is how
       * a finished job stops claiming to be running.
       */
      progress: (text, { received = 0, total = 0 } = {}) =>
        this.emit('progress', {
          id: manifest.id,
          text: String(text ?? ''),
          received: Number(received) || 0,
          total: Number(total) || 0,
        }),
    };
  }

  /* ---------- what the rest of the app asks for ---------- */

  /** The active handler for an action type, or null. */
  action(type) {
    return this.#actions.get(type) ?? null;
  }

  /**
   * The plugin that *declares* an action type, active or not.
   *
   * A disabled capability must be refused in words the model can act on. Told
   * only "unknown action type", it retries with different spelling; told
   * "browser control is switched off", it tells the user. The manifest is what
   * makes that answer possible without loading the plugin.
   */
  owner(type) {
    for (const entry of this.#entries.values()) {
      if (entry.manifest.actions.includes(type)) return entry.manifest;
    }
    return null;
  }

  /** System-prompt fragments from every active plugin, in prompt order. */
  promptFragments() {
    return [...this.#fragments];
  }

  /** Every stylesheet on offer, for the theme picker. */
  themes() {
    return [...this.#themes];
  }

  /** Every language on offer, for the language picker. */
  locales() {
    return [...this.#locales];
  }

  /** Where an installed plugin's files are, for the protocol handler. */
  dirFor(id) {
    return this.#entries.get(id)?.dir ?? null;
  }

  /** Dynamic context for this turn, gathered from every active plugin. */
  async context() {
    const parts = [];
    for (const { id, fn } of this.#contexts) {
      try {
        const text = await fn();
        if (text) parts.push(String(text).trim());
      } catch (err) {
        this.emit('log', `${id}: context failed — ${err.message}`);
      }
    }
    return parts.filter(Boolean).join('\n\n');
  }

  /**
   * The user clicked one of the choices an action offered.
   *
   * Outside any turn, by definition — the reply finished long before. The
   * handler is given a context with the two things that still make sense, and
   * the answer it returns is what the status line says.
   */
  async choose(type, choiceId, { status = () => {}, log = () => {} } = {}) {
    const handler = this.#actions.get(type);
    if (!handler) throw new Error('that choice belongs to a plugin that is no longer running');
    if (!handler.choose) throw new Error(`${handler.pluginName} does not take choices`);
    return handler.choose(String(choiceId ?? ''), { status, log });
  }

  /** Run the per-turn hooks. A throwing plugin must not stop the turn. */
  beginTurn() {
    for (const { id, fn } of this.#turnHooks) {
      try {
        fn();
      } catch (err) {
        this.emit('log', `${id}: turn hook failed — ${err.message}`);
      }
    }
  }

  /* ---------- what the UI asks for ---------- */

  list() {
    return [...this.#entries.values()].sort(byRank).map((entry) => {
      const state = this.#stateOf(entry.manifest.id);
      const values = state.settings ?? {};
      return {
        id: entry.manifest.id,
        name: entry.manifest.name,
        version: entry.manifest.version,
        description: entry.manifest.description,
        builtin: entry.manifest.builtin,
        /** The heading it is drawn under; the renderer owns what that is called. */
        category: entry.manifest.category ?? DEFAULT_CATEGORY,
        actions: entry.manifest.actions,
        services: entry.manifest.services,
        themes: entry.manifest.themes,
        locales: entry.manifest.locales ?? [],
        // Declaration and value together: the row draws the control from the
        // first and fills it from the second, and neither is useful alone.
        settings: entry.manifest.settings.map((setting) => ({ ...setting, value: values[setting.key] ?? '' })),
        icon: entry.manifest.icon && entry.dir ? pluginAssetUrl(entry.manifest.id, entry.manifest.icon) : '',
        enabled: Boolean(state.enabled),
        approved: Boolean(state.approved),
        /** Switching this one on means running code that came from elsewhere. */
        needsApproval: needsApproval(entry.manifest),
        // What the user asked for and what is actually running are different
        // facts, and a plugin switched on that failed to load has to be able to
        // say so. A theme pack is never "active": it has nothing to activate,
        // and enabled is the whole of its state.
        active: entry.active || (Boolean(state.enabled) && !this.#hasCode(entry) && !entry.broken),
        /**
         * Newer on disk than in memory. The version shown is the manifest's —
         * what the user installed — while the behaviour is still the old
         * code's, and saying so is the only way that difference is visible.
         */
        stale: Boolean(entry.stale),
        error: entry.error,
      };
    });
  }

  /** Switch a plugin on or off and put the contributions back in step. */
  async setEnabled(id, on) {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`no plugin called "${id}"`);

    const plugins = { ...(config.get('plugins') ?? {}) };
    const state = plugins[id] ?? { enabled: false, approved: entry.manifest.builtin };
    plugins[id] = {
      ...state,
      enabled: Boolean(on),
      // Switching an installed plugin on *is* the consent to run its code —
      // the warning sits on the row being clicked. Recorded so the decision is
      // made once, by a person, rather than implied by the plugin being present
      // on disk: a directory that appeared in `plugins/` is not an instruction.
      approved: state.approved || (Boolean(on) && !entry.manifest.builtin) || entry.manifest.builtin,
    };
    config.update({ plugins });

    await this.#reactivate();
    return this.list();
  }

  /**
   * Store one of a plugin's own settings.
   *
   * The plugin is not restarted for it — `ctx.store` reads live — but it is
   * told, because the interesting settings are the ones that invalidate work
   * already done. A music folder is the case in point: nothing else would make
   * the library rescan.
   */
  async setSetting(id, key, value) {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`no plugin called "${id}"`);
    const declared = entry.manifest.settings.find((setting) => setting.key === key);
    if (!declared) throw new Error(`"${id}" has no setting called "${key}"`);

    const next = declared.type === 'toggle' ? Boolean(value) : String(value ?? '');
    // A picker can only hold one of the things it offered. Anything else is a
    // row displaying a state the plugin has no code for, and the plugin reading
    // it back would be entitled to assume otherwise.
    if (declared.type === 'select' && next && !declared.options.some((option) => option.value === next)) {
      throw new Error(`"${next}" is not one of the choices for "${key}"`);
    }
    const plugins = { ...(config.get('plugins') ?? {}) };
    const state = plugins[id] ?? { enabled: false, approved: entry.manifest.builtin };
    plugins[id] = { ...state, settings: { ...(state.settings ?? {}), [key]: next } };
    config.update({ plugins });

    for (const hook of this.#settingsHooks.get(id) ?? []) {
      try {
        await hook(key, next);
      } catch (err) {
        this.emit('log', `${id}: settings hook failed — ${err.message}`);
      }
    }

    this.emit('changed', this.list());
    return this.list();
  }

  /**
   * Throw away everything a plugin kept, on uninstall.
   *
   * Its document and its data directory both, and the second matters more than
   * it looks: a speech model is over a gigabyte, and leaving one behind means an
   * uninstalled plugin is still the largest thing in the data directory with
   * nothing on screen to explain it.
   *
   * Called by the uninstall path rather than done inside it, because deleting
   * the installed directory and deleting what the plugin wrote are two different
   * questions and only this object knows the answer to the second.
   */
  forgetData(id) {
    this.#states().forget(id);
    try {
      rmSync(pluginDataDir(id), { recursive: true, force: true });
    } catch (err) {
      this.emit('log', `${id}: its data directory could not be removed — ${err.message}`);
    }
  }

  /** Rediscover after an install or a removal, keeping every recorded decision. */
  async refresh() {
    await this.#load();
    return this.list();
  }

  /** Called on the way out, so a plugin can release what it holds. */
  async shutdown() {
    for (const entry of this.#entries.values()) {
      if (!entry.active) continue;
      entry.active = false;
      try {
        await entry.module?.deactivate?.();
      } catch {
        /* going away anyway */
      }
    }
  }
}
