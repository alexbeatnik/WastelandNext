/**
 * Self-update from GitHub Releases.
 *
 * The provider and repository come from `publish` in `electron-builder.yml`;
 * the release workflow uploads `latest.yml` beside the installer, and that file
 * is what this reads to decide whether a newer build exists.
 *
 * Downloads run in the background and install on quit, so an update never
 * interrupts a turn. Nothing is forced — the renderer is told what is happening
 * and offers to restart early.
 *
 * Status is reported through a callback rather than sent from here, so it goes
 * out on the app's single `event` channel with everything else. A second
 * channel for one feature is exactly what that design exists to avoid.
 */
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { classifyError } from '../shared/updates.mjs';

// electron-updater is CommonJS with a default export. Under ESM the named
// import is not there to be had, so it comes off the default object — a plain
// `import { autoUpdater }` fails at load with no useful message.
const { autoUpdater } = electronUpdater;

export class Updater {
  #status = { state: 'idle' };
  #publish;
  #teardown;
  #started = false;

  /**
   * @param onStatus  called with every status change; the caller forwards it.
   * @param teardown  awaited before the installer replaces this build.
   */
  constructor({ onStatus = () => {}, teardown = async () => {} } = {}) {
    this.#publish = (next) => {
      this.#status = next;
      onStatus(next);
    };
    this.#teardown = teardown;
  }

  get status() {
    return this.#status;
  }

  /** Attach the listeners and make the first check. Safe to call once. */
  start({ delayMs = 4000 } = {}) {
    if (this.#started) return;
    this.#started = true;

    // A development run has no installed build to replace, and electron-updater
    // throws rather than no-ops when asked to check. Saying so plainly beats an
    // error the developer has to recognise every time they start the app.
    if (!app.isPackaged) {
      this.#publish({ state: 'unsupported' });
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Its own logging goes nowhere useful on Windows — see the note about
    // Electron having no attached console — and the status event is what the
    // user actually sees.
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.#publish({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.#publish({ state: 'current' }));
    autoUpdater.on('update-available', (info) => this.#publish({ state: 'available', version: info?.version ?? '' }));
    autoUpdater.on('download-progress', (progress) =>
      this.#publish({
        state: 'downloading',
        version: this.#status.version ?? '',
        percent: Math.round(progress?.percent ?? 0),
      }),
    );
    autoUpdater.on('update-downloaded', (info) => this.#publish({ state: 'ready', version: info?.version ?? '' }));
    autoUpdater.on('error', (err) => this.#publish(classifyError(err)));

    // Let the window paint and a model start loading before touching the
    // network: a check competing with the first render is invisible work that
    // makes the app look slow to open.
    setTimeout(() => void this.check(), delayMs);
  }

  async check() {
    if (!app.isPackaged) {
      this.#publish({ state: 'unsupported' });
      return this.#status;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // No network, a rate limit, a release without `latest.yml` — none of it
      // should reach the user as anything worse than "could not check".
      this.#publish(classifyError(err));
    }
    return this.#status;
  }

  /**
   * Replace this build and restart.
   *
   * `quitAndInstall` spawns the installer and only then asks the app to quit,
   * so everything this process owns must already be gone: llama-server holds a
   * port, and an orphan of it makes the *next* run report a model as loaded
   * while talking to a stranger. Chrome is torn down for the same reason.
   *
   * Silent, because the alternative runs the full NSIS wizard — which opens by
   * asking the user to close an app the updater has just closed for them.
   */
  async install() {
    if (this.#status.state !== 'ready') return false;
    await this.#teardown();
    autoUpdater.quitAndInstall(true, true);
    return true;
  }
}
