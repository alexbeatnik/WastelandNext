/**
 * Audio output — the smallest part of a music player that cannot be a plugin.
 *
 * The sound comes out of an `<audio>` element in the renderer, and the renderer
 * runs the app's own code and nothing else: `script-src 'self'`, context
 * isolation, a sandboxed preload. Letting a plugin ship renderer JS would hand
 * it the transcript, the composer and the whole `window.wasteland` bridge —
 * a far wider surface than "Node code in the main process, once approved".
 * Playing audio from the main process instead would mean a native module or
 * spawning somebody else's player, with no transport control either way.
 *
 * So this is the piece the app keeps, and it is deliberately not a music
 * player: it knows one source, whether it is playing, how loud, and what to
 * write on the bar. It has no queue, no shuffle, no library and no idea what
 * "next" means — a plugin registers a transport handler and answers that. Two
 * different plugins can therefore drive the same bar, and a plugin that plays a
 * single sound does not inherit a next button it cannot honour.
 */
import { EventEmitter } from 'node:events';
import { basename, extname } from 'node:path';
import * as config from './config.mjs';
import { mediaUrl } from '../shared/schemes.mjs';

/** Buttons the bar can offer. Which of them appear is the transport's to say. */
export const TRANSPORT_BUTTONS = ['previous', 'next', 'stop'];

export class AudioOut extends EventEmitter {
  /** `{path, label, sublabel, position}` — everything the bar draws. */
  #source = null;
  #playing = false;
  /** Null until asked for: the stored value cannot be read at construction. */
  #volume = null;
  #error = '';
  /** Registered by a plugin: `{pluginId, buttons, handle(command)}`. */
  #transport = null;

  /**
   * The stored volume, read on first ask rather than in the constructor.
   *
   * This object is created at module scope — `ipc.mjs` imports it, `main.mjs`
   * imports `ipc.mjs` — and an ESM import graph is evaluated in full *before*
   * the importing module's body runs. So at construction `setDataRoot` has not
   * been called yet, and `config.get` here read `config.json` from the platform
   * default root: a path that does not exist under Electron, whose userData
   * directory is somewhere else entirely. The read failed, the defaults were
   * cached, and every later reader in the process got them — the real settings
   * file was invisible for the whole session and then overwritten from those
   * defaults by the first `config.update`. What that looked like was plugins
   * asking to be approved again on every launch, having forgotten the music
   * folder and the speech model along with it.
   *
   * `PluginHost.#states()` defers `pluginStateDir()` for exactly this reason.
   * `config.mjs` now notices a root that arrives late as well, but the read
   * that is never made too early is the one that cannot be got wrong.
   */
  #storedVolume() {
    if (this.#volume === null) {
      const stored = Number(config.get('audioVolume'));
      this.#volume = Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 1;
    }
    return this.#volume;
  }

  status() {
    return {
      source: this.#source
        ? {
            ...this.#source,
            // The renderer never turns a path into a URL itself: the scheme and
            // its encoding belong to the protocol handler, and a second encoder
            // is a second thing to get wrong about a filename containing `#`.
            src: mediaUrl(this.#source.path),
          }
        : null,
      playing: this.#playing,
      volume: this.#storedVolume(),
      error: this.#error,
      // An empty list is what hides the transport buttons, so a plugin that
      // never registered one cannot leave dead controls on screen.
      buttons: this.#transport?.buttons ?? [],
      driver: this.#transport?.pluginId ?? '',
    };
  }

  #announce() {
    this.emit('state', this.status());
  }

  /** May the renderer read this file? Only the one thing it was handed. */
  allows(filePath) {
    return Boolean(this.#source && this.#source.path === filePath);
  }

  /**
   * Put a file in front of the user.
   *
   * `label` and `sublabel` are the plugin's words, not ours: it knows whether
   * the second line should be an artist, a station name or "3 of 47". Falling
   * back to the file name means a plugin with no tags still shows something
   * true rather than an empty bar.
   */
  load({ path, label = '', sublabel = '' } = {}, { play = true } = {}) {
    const file = String(path ?? '');
    if (!file) return this.status();

    this.#source = {
      path: file,
      label: String(label) || basename(file, extname(file)),
      sublabel: String(sublabel),
    };
    this.#error = '';
    this.#playing = Boolean(play);
    this.#announce();
    return this.status();
  }

  play() {
    if (!this.#source) return this.status();
    this.#error = '';
    this.#playing = true;
    this.#announce();
    return this.status();
  }

  pause() {
    this.#playing = false;
    this.#announce();
    return this.status();
  }

  toggle() {
    return this.#playing ? this.pause() : this.play();
  }

  /** Nothing loaded, bar gone. Distinct from pause, which keeps the track cued. */
  clear() {
    this.#source = null;
    this.#playing = false;
    this.#error = '';
    this.#announce();
    return this.status();
  }

  setVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return this.status();
    this.#volume = Math.min(1, Math.max(0, volume));
    config.update({ audioVolume: this.#volume });
    this.#announce();
    return this.status();
  }

  /**
   * A plugin taking charge of the transport.
   *
   * One at a time, and the newcomer wins: a plugin loading a track is saying it
   * is the thing now playing, and leaving the previous one's next button on
   * screen would step through a queue that has nothing to do with the sound.
   */
  setTransport({ pluginId, buttons = [], handle }) {
    if (typeof handle !== 'function') throw new Error('a transport needs a handle() function');
    this.#transport = {
      pluginId,
      buttons: buttons.filter((button) => TRANSPORT_BUTTONS.includes(button)),
      handle,
    };
    this.#announce();
  }

  /**
   * Called by the host when a plugin is switched off, so its buttons go with
   * it. Every service may implement this; the host does not know what any
   * particular one holds.
   */
  releasePlugin(pluginId) {
    if (this.#transport?.pluginId !== pluginId) return;
    this.#transport = null;
    this.clear();
  }

  /**
   * Something happened that only the driver can answer: a button was pressed,
   * or the track ran out.
   *
   * `play`, `pause` and the volume are answered here because they are true of
   * any source. Everything else is asked of the transport, and if there is
   * none, nothing happens — which is the honest outcome, not an error.
   */
  async command(name) {
    if (name === 'play') return this.play();
    if (name === 'pause') return this.pause();
    if (name === 'toggle') return this.toggle();

    const transport = this.#transport;
    if (!transport) {
      // `stop` still has to mean something without a driver, or a bar left over
      // from a disabled plugin cannot be dismissed.
      if (name === 'stop' || name === 'ended') return this.clear();
      return this.status();
    }

    try {
      await transport.handle(name);
    } catch (err) {
      this.fail(`${transport.pluginId}: ${err.message}`);
    }
    return this.status();
  }

  /** The renderer could not play what it was given. */
  fail(message) {
    this.#error = String(message ?? 'could not play this file');
    this.#playing = false;
    this.#announce();
    return this.status();
  }
}

export const audio = new AudioOut();
