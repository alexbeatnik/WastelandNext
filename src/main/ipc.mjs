/**
 * The main↔renderer boundary.
 *
 * Every handler is a request/response `invoke`; everything the renderer needs
 * to hear about asynchronously arrives on one `event` channel as
 * `{event, ...payload}`. One channel rather than twenty keeps the preload
 * surface small and means a new event type needs no changes here or there.
 */
import { dialog, ipcMain } from 'electron';
import * as chats from './chats.mjs';
import * as config from './config.mjs';
import * as models from './models/manager.mjs';
import { listGgufFiles, searchModels } from './models/search.mjs';
import { server } from './llm/server.mjs';
import { downloadLlamaServer, llamaServerStatus } from './llm/tools.mjs';
import { BrowserBridge, browser, engineAvailable } from './browser/manul-browser.mjs';
import { Agent } from './agent/agent.mjs';

/** Lookups get their own headless browser so they never touch the visible one. */
const lookupBrowser = new BrowserBridge();
const agent = new Agent({ server, browser, lookupBrowser });

let getWindow = () => null;
let download = null;

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
  handle('models:files', (repoId) => listGgufFiles(repoId));
  handle('models:list', () => models.listLocal());
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
