/**
 * Electron entry point.
 *
 * Owns the window and the lifetime of the two child processes (llama-server,
 * the manul-browser engine). Everything else is wired in `ipc.mjs`; this file stays
 * short enough to read in one go.
 */
import { app, BrowserWindow, shell } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDataRoot } from './paths.mjs';
import * as config from './config.mjs';
import { server } from './llm/server.mjs';
import { registerSchemes } from './plugins/protocol.mjs';
import { registerIpc, serveAssets, shutdown } from './ipc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

setDataRoot(app.getPath('userData'));

// Before `whenReady`, and therefore at module scope: after the app is ready the
// scheme table is fixed, and a scheme registered late is an ordinary opaque one
// — no Range support, so a seek in a long track would do nothing.
registerSchemes();

let window = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    // 4:3 at a readable font size is the tightest shape the layout supports;
    // below this the left panel has nowhere to go.
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#050505',
    title: 'Wasteland Next',
    icon: join(repoRoot, 'assets', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  /**
   * Exactly one permission, and only when it was asked for.
   *
   * Electron grants everything by default, which for a window that never wanted
   * geolocation, notifications or a camera is a wider surface than the app uses.
   * Dictation needs `media` and nothing else needs anything — so the list is a
   * list of one, and adding to it is a deliberate act rather than the default
   * quietly covering something new.
   *
   * The microphone still has to be allowed at the operating system level as
   * well; this only decides whether the page may ask.
   */
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media');
  });

  window.once('ready-to-show', () => window.show());
  window.loadFile(join(repoRoot, 'src', 'renderer', 'index.html'));

  // Links the model surfaces belong in the user's own browser, not in a
  // chrome-less Electron window they cannot navigate out of.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) {
    window.webContents.openDevTools({ mode: 'detach' });
    // A renderer error is otherwise invisible from the terminal, which makes
    // "the window is blank" impossible to diagnose without clicking around.
    window.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
  }
  return window;
}

app.whenReady().then(() => {
  config.load();
  // The handlers, as opposed to the schemes, can only be installed now.
  serveAssets();
  registerIpc(() => window);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Tear the children down before we go.
 *
 * A llama-server holding a multi-gigabyte model, or a Chrome we launched, would
 * otherwise outlive the window that owns it.
 */
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;

  // Everything is awaited before `app.exit`, and the whole sequence — not just
  // the browser half — is what the timeout races. An earlier version called
  // `server.unload()` without awaiting it and exited in the same tick, which
  // left llama-server holding several gigabytes as an orphan.
  // Concurrent, not sequential: the browser and the model are independent, and
  // a Chrome that refuses to close must not eat the budget that would have
  // stopped llama-server.
  const teardown = Promise.allSettled([shutdown(), server.unload()]);

  Promise.race([teardown, new Promise((r) => setTimeout(r, 8000))]).finally(() => app.exit(0));
});
