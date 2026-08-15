/**
 * The renderer's whole view of the main process.
 *
 * CommonJS on purpose: an ESM preload only loads with the sandbox off, and
 * there is no reason to give this window more privilege than it needs.
 *
 * Every call is a named method over a fixed channel list. The renderer cannot
 * name a channel of its own, so adding an API here is a deliberate act.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Unwrap the `{ok, value|error}` envelope every handler returns. */
async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply?.ok) throw new Error(reply?.error ?? `${channel} failed`);
  return reply.value;
}

contextBridge.exposeInMainWorld('wasteland', {
  snapshot: () => call('app:snapshot'),

  config: {
    get: () => call('config:get'),
    set: (patch) => call('config:set', patch),
  },

  models: {
    search: (query) => call('models:search', query),
    files: (repoId) => call('models:files', repoId),
    list: () => call('models:list'),
    resolve: (input) => call('models:resolve', input),
    download: (input) => call('models:download', input),
    cancelDownload: () => call('models:cancelDownload'),
    remove: (name) => call('models:delete', name),
    addFile: () => call('models:addFile'),
    forget: (path) => call('models:forget', path),
    partials: () => call('models:partials'),
    discardPartial: (name) => call('models:discardPartial', name),
  },

  llm: {
    load: (name) => call('llm:load', name),
    unload: () => call('llm:unload'),
    status: () => call('llm:status'),
    toolStatus: () => call('llm:toolStatus'),
    fetchTool: () => call('llm:fetchTool'),
  },

  chats: {
    list: () => call('chats:list'),
    read: (id) => call('chats:read', id),
    remove: (id) => call('chats:delete', id),
    rename: (id, title) => call('chats:rename', id, title),
  },

  agent: {
    send: (chatId, prompt) => call('agent:send', chatId, prompt),
    stop: () => call('agent:stop'),
    compact: (chatId) => call('agent:compact', chatId),
    context: (chatId) => call('agent:context', chatId),
    answerShell: (id, approved) => call('shell:respond', id, approved),
  },

  browser: {
    status: () => call('browser:status'),
    open: () => call('browser:open'),
    close: () => call('browser:close'),
  },

  plugins: {
    list: () => call('plugins:list'),
    setEnabled: (id, enabled) => call('plugins:setEnabled', id, enabled),
    setSetting: (id, key, value) => call('plugins:setSetting', id, key, value),
    pickFolder: (id, key) => call('plugins:pickFolder', id, key),
    choose: (type, choiceId) => call('plugins:choose', type, choiceId),
    themes: () => call('plugins:themes'),
    available: () => call('plugins:available'),
    install: (entry) => call('plugins:install', entry),
    uninstall: (id) => call('plugins:uninstall', id),
  },

  audio: {
    status: () => call('audio:status'),
    command: (name) => call('audio:command', name),
    volume: (value) => call('audio:volume', value),
    ended: () => call('audio:ended'),
    failed: (message) => call('audio:failed', message),
  },

  updates: {
    status: () => call('update:status'),
    check: () => call('update:check'),
    install: () => call('update:install'),
  },

  attach: {
    list: () => call('attach:list'),
    add: (paths) => call('attach:add', paths),
    remove: (id) => call('attach:remove', id),
    clear: () => call('attach:clear'),
    pickFiles: () => call('attach:pickFiles'),
    pickFolder: () => call('attach:pickFolder'),

    /**
     * The filesystem path behind a dropped `File`.
     *
     * `File.path` was Electron's own extension to the web File object and was
     * removed in Electron 32; this app is on 34, so reading it yields
     * `undefined` and every drop looks like an empty selection. `webUtils` is
     * the replacement and it only exists in the preload — which is the point,
     * since it is what keeps the renderer from turning an arbitrary File into a
     * path on its own. Available in a sandboxed preload, so the sandbox stays
     * on.
     */
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
  },

  /** Subscribe to the single event stream. Returns an unsubscribe function. */
  on(handler) {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
});
