/**
 * Telling the user something when nobody asked.
 *
 * Every other thing this app says is an answer: the user typed, a turn ran, a
 * reply came back. A reminder is the one message with no question in front of
 * it, and there was nowhere for it to go — the transcript belongs to a
 * conversation, the status bar is overwritten by the next thing that happens,
 * and a plugin cannot reach the window at all.
 *
 * So this is the smallest service that can carry one: a title, a line of body
 * text, and who it came from. It goes two places at once — a card in the
 * transcript, so it is still there when the user comes back, and an operating
 * system notification, so it arrives when they are looking at something else.
 * Neither alone is enough: the first is invisible to somebody in another window,
 * and the second is gone the moment it is dismissed.
 *
 * Electron-free on purpose, like `audio.mjs`. The OS notification is raised in
 * `ipc.mjs`, which already imports `electron`; this file only decides what a
 * notice *is*, so it can be tested in plain Node.
 */
import { EventEmitter } from 'node:events';

/** Long enough for a sentence, short enough that a notification is readable. */
const MAX_TITLE = 120;
const MAX_BODY = 400;

/**
 * How many notices are kept for a renderer that was not listening yet.
 *
 * A reminder can come due during boot — the plugin host starts before the window
 * has subscribed — and a notice emitted into nothing would be lost precisely in
 * the case the whole feature exists for: the app was closed, something was
 * missed, say so on the way in.
 */
const KEEP_RECENT = 20;

/**
 * A plugin in a loop must not be able to bury the machine in notifications.
 *
 * The limit is per plugin and generous — nothing legitimate raises six notices
 * in a minute — and going over it is reported through the log rather than
 * silently dropped, because a plugin that has started shouting is a thing worth
 * knowing about.
 */
const BURST_LIMIT = 6;
const BURST_WINDOW_MS = 60_000;

export class Notifier extends EventEmitter {
  #recent = [];
  #seq = 0;
  /** `pluginId → [timestamps]`, trimmed to the burst window on each ask. */
  #rate = new Map();

  #allowed(pluginId, now) {
    const times = (this.#rate.get(pluginId) ?? []).filter((at) => now - at < BURST_WINDOW_MS);
    times.push(now);
    this.#rate.set(pluginId, times);
    return times.length <= BURST_LIMIT;
  }

  /**
   * Put something in front of the user.
   *
   * Returns the notice as it was recorded, or null if it was refused. Never
   * throws: this is called from a timer inside a plugin, where there is nobody
   * to catch anything and no turn to fail.
   */
  show({ title = '', body = '', pluginId = '', desktop = true } = {}) {
    const heading = String(title ?? '').trim().slice(0, MAX_TITLE);
    if (!heading) return null;

    const now = Date.now();
    if (pluginId && !this.#allowed(pluginId, now)) {
      this.emit('log', `${pluginId}: too many notifications at once — one was dropped`);
      return null;
    }

    this.#seq += 1;
    const notice = {
      id: `n${now.toString(36)}-${this.#seq}`,
      title: heading,
      body: String(body ?? '').trim().slice(0, MAX_BODY),
      /**
       * Who it came from, as an id.
       *
       * The *name* is looked up from the plugin list where the notice is drawn,
       * rather than travelling with it: a plugin should not be able to sign a
       * message with a name other than the one on its own row.
       */
      pluginId: String(pluginId ?? ''),
      at: now,
      /**
       * Whether to raise an OS notification as well as drawing the card.
       *
       * False for the report of what was missed while the app was closed: that
       * one lands as the window is opening, and a desktop notification for
       * something the user is already looking at is noise.
       */
      desktop: desktop !== false,
    };

    this.#recent.push(notice);
    if (this.#recent.length > KEEP_RECENT) this.#recent.shift();
    this.emit('notice', notice);
    return notice;
  }

  /** For the boot snapshot: what was said before anyone was listening. */
  recent() {
    return [...this.#recent];
  }

  /** A plugin switched off stops being able to speak, and its budget resets. */
  releasePlugin(pluginId) {
    this.#rate.delete(pluginId);
  }
}

export const notify = new Notifier();
