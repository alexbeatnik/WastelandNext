/**
 * The main↔renderer boundary.
 *
 * Every handler is a request/response `invoke`; everything the renderer needs
 * to hear about asynchronously arrives on one `event` channel as
 * `{event, ...payload}`. One channel rather than twenty keeps the preload
 * surface small and means a new event type needs no changes here or there.
 */
import { Notification, dialog, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import * as chats from './chats.mjs';
import * as config from './config.mjs';
import * as models from './models/manager.mjs';
import { listGgufFiles, searchModels } from './models/search.mjs';
import { planFor } from './models/placement.mjs';
import { detectVram, placementForSize } from './llm/gpu.mjs';
import { server } from './llm/server.mjs';
import { downloadLlamaServer, llamaServerStatus } from './llm/tools.mjs';
import { BrowserBridge, browser, engineAvailable } from './browser/manul-browser.mjs';
import { PluginHost } from './plugins/host.mjs';
import { serveProtocols } from './plugins/protocol.mjs';
import * as registry from './plugins/registry.mjs';
import { audio } from './audio.mjs';
import { notify } from './notify.mjs';
import { Agent } from './agent/agent.mjs';
import { Updater } from './updater.mjs';

/**
 * The build's version, for the About box.
 *
 * Read from our own `package.json` rather than through `app.getVersion()`.
 * That call answers with *Electron's* version whenever it cannot find the app's
 * manifest — which is what `electron scripts/smoke.mjs` does — and a version
 * field confidently displaying 34.5.8 is worse than one that fails. Resolving
 * relative to this module works packaged too: inside `app.asar` this file sits
 * at `src/main/ipc.mjs` and the manifest at the archive root, exactly as here.
 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '';
  } catch {
    return '';
  }
})();

/** Lookups get their own headless browser so they never touch the visible one. */
const lookupBrowser = new BrowserBridge();

/**
 * The two browsers are handed to the host as *services*, not imported by the
 * plugins that use them. That is what makes "which plugin can reach what" a
 * fact readable from a manifest, and what lets the host be tested with a stub
 * browser and no Chrome anywhere.
 */
const plugins = new PluginHost({ services: { browser, lookupBrowser, audio, notify } });
const agent = new Agent({ server, plugins });

/**
 * Install the custom-scheme handlers. Called from `main.mjs` once the app is
 * ready; the schemes themselves were registered before that.
 *
 * Both questions the handlers ask are answered by the objects that know: which
 * directory a plugin owns is the host's business, and which file may be read
 * right now is the audio service's.
 */
export function serveAssets() {
  serveProtocols({
    pluginDir: (id) => plugins.dirFor(id),
    mediaAllows: (path) => audio.allows(path),
  });
}

let getWindow = () => null;
let download = null;
/** Created in `registerIpc`, because it reports through the window it needs. */
let updater = null;

function send(event, payload = {}) {
  const window = getWindow();
  if (window && !window.isDestroyed()) window.webContents.send('event', { event, ...payload });
}

/** Everything the status bar and left panel need to render themselves. */
function snapshot() {
  return {
    settings: config.load(),
    llm: server.status,
    browser: browser.status,
    engine: engineAvailable(),
    busy: agent.busy,
    version: VERSION,
    update: updater?.status ?? { state: 'idle' },
    plugins: plugins.list(),
    themes: plugins.themes(),
    locales: plugins.locales(),
    audio: audio.status(),
    /**
     * Anything said before the window was listening.
     *
     * A reminder can come due during boot — the plugin host starts before the
     * renderer has subscribed — and that is the exact case this whole path
     * exists for: the app was closed, something was missed, say so on the way
     * in. Each notice carries an id so one that arrived both ways is drawn once.
     */
    notices: notify.recent(),
  };
}

/**
 * Raise an operating system notification.
 *
 * The card in the transcript is what survives; this is what arrives. Somebody
 * looking at another window sees nothing at all otherwise, which for a reminder
 * is the only case that matters.
 *
 * Failing to show one is not worth reporting: a Linux desktop with no
 * notification daemon, or Windows with them switched off for this app, is a
 * setting rather than a fault, and the card has already been drawn.
 */
function showDesktopNotice(notice) {
  try {
    if (!Notification.isSupported()) return;
    const toast = new Notification({ title: notice.title, body: notice.body, silent: false });
    toast.on('click', () => {
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    toast.show();
  } catch {
    /* no notification service on this machine */
  }
}

export function registerIpc(windowGetter) {
  getWindow = windowGetter;

  agent.on('event', ({ event, ...payload }) => send(event, payload));
  plugins.on('changed', (list) =>
    send('plugins:changed', { plugins: list, themes: plugins.themes(), locales: plugins.locales() }),
  );
  plugins.on('log', (line) => send('log', { text: line }));
  audio.on('state', (status) => send('audio:state', status));
  notify.on('notice', (notice) => {
    send('notice', { notice });
    if (notice.desktop) showDesktopNotice(notice);
  });
  notify.on('log', (line) => send('log', { text: line }));
  server.on('state', (status) => send('llm:state', status));
  server.on('log', (line) => send('llm:log', { line }));
  server.on('tool', (progress) => send('tool:progress', progress));
  browser.on('state', (status) => send('browser:state', status));
  browser.on('step', (outcome) => send('browser:step', { outcome }));
  browser.on('log', (line) => send('browser:log', { line }));

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

  /* ---------- state ---------- */
  handle('app:snapshot', () => snapshot());
  handle('config:get', () => config.load());
  handle('config:set', (patch) => {
    const next = config.update(patch ?? {});
    send('config:changed', { settings: next });
    return next;
  });

  /* ---------- models ---------- */
  handle('models:search', (query) => searchModels({ query }));
  handle('models:files', async (repoId) => {
    const files = await listGgufFiles(repoId);
    // Judged from size alone — the header is inside the file we have not
    // downloaded yet — so the UI labels it as an estimate.
    const vram = detectVram() ?? 0;
    return files.map((file) => ({ ...file, placement: placementForSize(file.size, vram) }));
  });
  handle('models:partials', () => models.listPartials());
  handle('models:discardPartial', async (name) => {
    await models.discardPartial(name);
    return models.listPartials();
  });
  handle('models:list', async () => {
    const local = await models.listLocal();
    // The plan is what turns "4.4 GB" into "will it run on my card" — the
    // question a size alone cannot answer.
    return Promise.all(
      local.map(async (model) => ({
        ...model,
        plan: model.missing ? null : await planFor(model.path).catch(() => null),
      })),
    );
  });
  handle('models:resolve', (input) => models.resolveTarget(input));
  handle('models:delete', async (name) => {
    await models.remove(name);
    return models.listLocal();
  });
  handle('models:forget', async (path) => {
    models.forgetExternal(path);
    return models.listLocal();
  });

  /**
   * Register a model from anywhere on disk.
   *
   * The dialog is opened from the main process because that is the only place
   * that can — and it is parented to the window so it behaves as a sheet on
   * macOS rather than a stray window.
   */
  handle('models:addFile', async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: 'Choose a GGUF model',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'GGUF models', extensions: ['gguf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { added: false, canceled: true };

    const outcome = await models.addExternal(result.filePaths[0]);
    return { ...outcome, models: await models.listLocal() };
  });
  handle('models:download', async (input) => {
    if (download) throw new Error('a download is already running');
    const target = await models.resolveTarget(input);
    download = new AbortController();
    send('download:start', target);
    try {
      const result = await models.download({
        ...target,
        signal: download.signal,
        onProgress: (progress) => send('download:progress', progress),
      });
      send('download:done', result);
      return result;
    } catch (err) {
      const cancelled = download.signal.aborted;
      send('download:done', { cancelled, error: cancelled ? '' : err.message });
      throw cancelled ? new Error('download cancelled') : err;
    } finally {
      download = null;
    }
  });
  handle('models:cancelDownload', () => {
    download?.abort();
    return true;
  });

  /* ---------- inference ---------- */
  handle('llm:toolStatus', () => llamaServerStatus(config.get('llamaServerPath')));
  handle('llm:fetchTool', async () => {
    const binary = await downloadLlamaServer({
      onStatus: (detail) => send('tool:progress', { stage: 'status', detail }),
      onProgress: (progress) => send('tool:progress', { stage: 'progress', ...progress }),
    });
    config.update({ llamaServerPath: binary });
    send('tool:progress', { stage: 'done', path: binary });
    send('config:changed', { settings: config.load() });
    return binary;
  });
  /**
   * Load a model, and remember which one.
   *
   * Recorded here rather than in `server.mjs`, which has no business knowing
   * about settings — and only on success, so a name that could not be loaded
   * does not become the thing tried again on every start.
   */
  handle('llm:load', async (name) => {
    const status = await server.load(name);
    config.update({ model: name });
    send('config:changed', { settings: config.load() });
    return status;
  });
  handle('llm:unload', async () => {
    await server.unload();
    // Unloading is a decision, not a crash: bringing it back on the next start
    // would override the thing the user just chose.
    config.update({ model: '' });
    send('config:changed', { settings: config.load() });
    return server.status;
  });
  handle('llm:status', () => server.status);

  /* ---------- chats ---------- */
  handle('chats:list', () => chats.list());
  handle('chats:read', (id) => chats.read(id));
  handle('chats:delete', (id) => {
    chats.remove(id);
    return chats.list();
  });
  handle('chats:rename', (id, title) => chats.rename(id, title));

  /* ---------- agent ---------- */
  handle('agent:send', (chatId, prompt) => agent.send(chatId, prompt));
  handle('agent:stop', () => {
    agent.stop();
    return true;
  });
  handle('agent:compact', (chatId) => agent.compact(chatId));
  handle('agent:context', (chatId) => agent.contextFor(chatId));
  handle('shell:respond', (id, approved) => agent.answerShell(id, approved));

  /* ---------- updates ---------- */

  updater = new Updater({
    onStatus: (status) => send('update:status', status),
    // The installer replaces this build the moment `quitAndInstall` returns, so
    // everything this process owns has to be gone first — an orphaned
    // llama-server keeps port 8080 and makes the *next* run report a model as
    // loaded while talking to a stranger. Bounded, because an update must not
    // be held hostage by a Chrome that will not close.
    teardown: () =>
      Promise.race([
        Promise.allSettled([shutdown(), server.unload()]),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]).then(() => {}),
  });
  updater.start();

  handle('update:status', () => updater.status);
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());

  /* ---------- attachments ---------- */

  /**
   * Add paths, reporting per-path failures instead of losing the batch.
   *
   * Dropping six folders of which one is a symlink to nowhere should attach
   * five and say why the sixth did not — throwing would discard all six and
   * name only the first thing that went wrong.
   */
  const addAttachments = async (paths) => {
    const errors = [];
    for (const path of Array.isArray(paths) ? paths : [paths]) {
      try {
        await agent.attachments.add(path);
      } catch (err) {
        errors.push(err.message);
      }
    }
    const items = agent.attachments.list();
    send('attach:changed', { items, errors });
    return { items, errors };
  };

  handle('attach:add', (paths) => addAttachments(paths));
  handle('attach:list', () => agent.attachments.list());
  handle('attach:remove', (id) => {
    const items = agent.attachments.remove(id);
    send('attach:changed', { items, errors: [] });
    return items;
  });
  handle('attach:clear', () => {
    const items = agent.attachments.clear();
    send('attach:changed', { items, errors: [] });
    return items;
  });

  /**
   * `openFile` and `openDirectory` cannot be combined on Windows — the dialog
   * silently honours only one — so the two are separate commands rather than
   * one button that behaves differently per platform.
   */
  const pick = async (properties, title) => {
    const result = await dialog.showOpenDialog(getWindow() ?? undefined, {
      title,
      properties: [...properties, 'multiSelections', 'dontAddToRecent'],
    });
    if (result.canceled || result.filePaths.length === 0) return { items: agent.attachments.list(), errors: [], canceled: true };
    return addAttachments(result.filePaths);
  };

  handle('attach:pickFiles', () => pick(['openFile'], 'Add files to the conversation'));
  handle('attach:pickFolder', () => pick(['openDirectory'], 'Add a folder to the conversation'));

  /* ---------- plugins ---------- */

  /**
   * Awaited rather than answered from whatever is registered so far.
   *
   * Discovery is asynchronous, so a renderer that asked at exactly the wrong
   * moment would paint an empty list and then be corrected by an event — which
   * looks like the plugins section flickering into existence on every boot.
   */
  handle('plugins:list', async () => {
    await plugins.ready;
    return plugins.list();
  });
  handle('plugins:setEnabled', (id, enabled) => plugins.setEnabled(id, enabled));
  handle('plugins:setSetting', (id, key, value) => plugins.setSetting(id, key, value));

  /**
   * A click on one of the options an action put in the transcript.
   *
   * Routed by action type rather than by plugin id, because the type is what
   * the result event already carries and what identifies the handler — and a
   * type can only be claimed by one plugin at a time.
   */
  handle('plugins:choose', (type, choiceId) =>
    plugins.choose(type, choiceId, {
      status: (text) => send('status', { text }),
      log: (text) => send('log', { text }),
    }),
  );

  /**
   * A folder setting, picked through the native dialog.
   *
   * Opened here because only the main process can, and parented to the window
   * so it behaves as a sheet on macOS rather than a stray window — the same
   * reason `models:addFile` lives here.
   */
  handle('plugins:pickFolder', async (id, key) => {
    const result = await dialog.showOpenDialog(getWindow() ?? undefined, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, plugins: plugins.list() };
    return { canceled: false, plugins: await plugins.setSetting(id, key, result.filePaths[0]) };
  });
  handle('plugins:themes', async () => {
    await plugins.ready;
    return plugins.themes();
  });
  handle('plugins:locales', async () => {
    await plugins.ready;
    return plugins.locales();
  });

  /* ---------- the registry ---------- */

  handle('plugins:available', () => registry.fetchIndex());

  /**
   * The registries themselves.
   *
   * Adding one widens what the app will offer to download, so it is a typed URL
   * and an explicit button rather than anything a page or a plugin can do. The
   * list is returned from all three so the section repaints from what was
   * actually stored, never from what the click assumed.
   */
  handle('plugins:registries', () => registry.registries());
  handle('plugins:addRegistry', (url) => registry.addRegistry(url));
  handle('plugins:removeRegistry', (url) => registry.removeRegistry(url));

  /**
   * Install or update — the same operation, because an update is an install
   * over the top of one that is already there. The plugin keeps whatever the
   * user had decided about it: `mergeEnablement` never overrules a record that
   * already exists, so a plugin switched on stays on across an update and one
   * that was never allowed to run does not become allowed by being newer.
   */
  const afterInstall = async (installed) => {
    send('plugins:progress', { stage: 'done', id: installed.id });
    await plugins.refresh();
    // Replacing a plugin that has already been imported does not replace what
    // is running: Node caches modules by URL for the life of the process. The
    // row says so, and this is the same fact where the install happened.
    const row = plugins.list().find((plugin) => plugin.id === installed.id);
    return { ...installed, restartRequired: Boolean(row?.stale) };
  };

  handle('plugins:install', async (entry) =>
    afterInstall(await registry.install(entry, { onProgress: (progress) => send('plugins:progress', progress) })),
  );

  /**
   * Install from an archive on this machine.
   *
   * The dialog is opened here because only the main process can, and because it
   * is what makes the file a *choice*: the renderer never names a path, it asks
   * for the picker and is told what came back. Same reason as `models:addFile`.
   */
  handle('plugins:installFile', async () => {
    const result = await dialog.showOpenDialog(getWindow() ?? undefined, {
      title: 'Choose a plugin archive',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'Plugin archives', extensions: ['zip'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };

    return afterInstall(
      await registry.installArchive(result.filePaths[0], {
        onProgress: (progress) => send('plugins:progress', progress),
      }),
    );
  });

  handle('plugins:uninstall', async (id) => {
    const entry = plugins.list().find((plugin) => plugin.id === id);
    // A built-in has no directory to delete, and offering it would be a button
    // that cannot work.
    if (entry?.builtin) throw new Error(`${entry.name} ships with the app and cannot be removed`);
    await registry.uninstall(id);
    // Its own document goes with it. Leaving it behind would mean reinstalling a
    // plugin brought back reminders the user had removed along with it.
    plugins.forgetState(id);
    await plugins.refresh();
    return plugins.list();
  });

  /* ---------- audio ---------- */

  handle('audio:status', () => audio.status());
  /**
   * One command channel rather than a method per button: the set of buttons is
   * the transport's to declare, so a fixed list of IPC names here would be a
   * second, competing account of what the player can do.
   */
  handle('audio:command', (name) => audio.command(name));
  handle('audio:volume', (value) => audio.setVolume(value));
  /** The renderer reporting what only it can know. */
  handle('audio:ended', () => audio.command('ended'));
  handle('audio:failed', (message) => audio.fail(message));

  /* ---------- browser ---------- */
  handle('browser:status', () => browser.status);
  handle('browser:open', async () => {
    await browser.ensureOpen();
    return browser.status;
  });
  handle('browser:close', async () => {
    await browser.close();
    return browser.status;
  });

  // Started last and deliberately not awaited: registering the handlers is what
  // lets the window boot, and a plugin that is slow to import must not hold the
  // window back. Anything that needs the list waits on `plugins.ready`.
  plugins.load();
  restoreModel();
}

/**
 * Bring back the model that was loaded when the app was last closed.
 *
 * Unawaited, and quiet about most failures: a load takes tens of seconds and
 * the window must not wait for it, while a model on an unplugged drive is an
 * ordinary Tuesday rather than something to open with an error. The status bar
 * shows the attempt through the `state` event like any other load, so nothing
 * here has to narrate it.
 *
 * The name is only recorded on a successful load, so this cannot get stuck
 * retrying something that has never worked.
 */
async function restoreModel() {
  const name = String(config.get('model') ?? '').trim();
  if (!name) return;
  try {
    await server.load(name);
  } catch (err) {
    send('log', { text: `could not reload ${name} — ${err.message}` });
  }
}

/** Called from `before-quit`. Stops the browsers; the model is unloaded after. */
export async function shutdown() {
  download?.abort();
  agent.stop();
  await Promise.allSettled([plugins.shutdown(), browser.close(), lookupBrowser.close()]);
}
