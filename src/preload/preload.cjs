/**
 * The renderer's whole view of the main process.
 *
 * CommonJS on purpose: an ESM preload only loads with the sandbox off, and
 * there is no reason to give this window more privilege than it needs.
 *
 * Every call is a named method over a fixed channel list. The renderer cannot
 * name a channel of its own, so adding an API here is a deliberate act.
 */
const { contextBridge, ipcRenderer } = require('electron');

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

  /** Subscribe to the single event stream. Returns an unsubscribe function. */
  on(handler) {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
});
