/**
 * The main↔renderer boundary.
 *
 * Every handler is a request/response `invoke`; everything the renderer needs
 * to hear about asynchronously arrives on one `event` channel as
 * `{event, ...payload}`. One channel rather than twenty keeps the preload
 * surface small and means a new event type needs no changes here or there.
 */
import { dialog, ipcMain } from 'electron';
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
const agent = new Agent({ server, browser, lookupBrowser });

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
  };
}

export function registerIpc(windowGetter) {
  getWindow = windowGetter;

  agent.on('event', ({ event, ...payload }) => send(event, payload));
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
  handle('llm:load', (name) => server.load(name));
  handle('llm:unload', async () => {
    await server.unload();
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
}

/** Called from `before-quit`. Stops the browsers; the model is unloaded after. */
export async function shutdown() {
  download?.abort();
  agent.stop();
  await Promise.allSettled([browser.close(), lookupBrowser.close()]);
}
