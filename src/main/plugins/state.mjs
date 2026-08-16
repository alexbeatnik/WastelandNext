/**
 * Where a plugin keeps its own things.
 *
 * `ctx.store` is the *user's* answer to a question the manifest asked — a music
 * folder, an endpoint — and every key in it has to be declared, because every
 * key is a control drawn on the plugin's row. That is exactly the wrong shape
 * for a list of reminders: nobody declares those, nobody types them into a
 * settings field, and there is no row to draw them on.
 *
 * So a plugin also gets one JSON document of its own, keyed by id, which the app
 * never reads the inside of. It is not in `config.json` on purpose: that file is
 * settings, small enough to open in an editor and fix by hand, and a plugin
 * appending to it every few minutes would end that. One file per plugin also
 * means a plugin whose document is corrupt loses only its own.
 *
 * Writes are synchronous, like `config.update`, and for the same reason: these
 * are kilobytes, the caller almost always wants the write to have happened
 * before it answers, and an async write is one more thing that can be in flight
 * when the app quits.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A plugin's document is state, not storage.
 *
 * A megabyte is thousands of reminders or a large cache; past that a plugin
 * wants a file of its own, and letting it grow without limit here turns every
 * boot into reading it back.
 */
export const MAX_STATE_BYTES = 1024 * 1024;

/** The same shape ids are validated against everywhere else they become a path. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class PluginStateStore {
  #dir;
  /** `id → parsed document`. Read once, then answered from here. */
  #cache = new Map();

  constructor(dir) {
    this.#dir = dir;
  }

  /**
   * A manifest id has already passed the same test before it reaches here, so
   * this is the second lock on a door that is meant to be locked once: the value
   * is about to be interpolated into a file name, and the cost of checking is a
   * regex.
   */
  #pathFor(id) {
    if (!ID_RE.test(String(id))) throw new Error('not a plugin id');
    return join(this.#dir, `${id}.json`);
  }

  /**
   * The plugin's document, or `{}` if it has none.
   *
   * A file that cannot be parsed answers `{}` rather than throwing: a plugin
   * failing to activate because of its own scratch file would be a plugin the
   * user cannot switch off from inside, and the sane recovery — start again — is
   * what an empty document already is.
   */
  read(id) {
    if (this.#cache.has(id)) return this.#cache.get(id);
    let value = {};
    try {
      const parsed = JSON.parse(readFileSync(this.#pathFor(id), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
    } catch {
      /* never written, or written badly — either way there is nothing to load */
    }
    this.#cache.set(id, value);
    return value;
  }

  /**
   * Replace it.
   *
   * Written to a temporary file and renamed over the target, because the failure
   * this protects against is specific and silent: a process that dies halfway
   * through writing leaves a truncated JSON file, and a truncated JSON file
   * reads back as `{}` — every reminder the user had set, gone, with nothing
   * anywhere saying so. A rename is atomic on both filesystems this app runs on.
   */
  write(id, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('plugin state must be an object');
    }
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
      throw new Error('that is more state than a plugin may keep');
    }

    const target = this.#pathFor(id);
    const scratch = `${target}.tmp`;
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(scratch, text, 'utf8');
    renameSync(scratch, target);
    this.#cache.set(id, value);
    return value;
  }

  /**
   * Drop a plugin's document, on uninstall.
   *
   * Kept in step with the directory rather than outliving it: a user who pressed
   * REMOVE said to remove the plugin, and finding its old reminders waiting after
   * a reinstall is a surprise nothing on screen prepared them for.
   */
  forget(id) {
    try {
      rmSync(this.#pathFor(id), { force: true });
    } catch {
      /* nothing there, or nothing we can do about it */
    }
    this.#cache.delete(id);
  }
}
