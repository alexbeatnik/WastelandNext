/**
 * Microphone input — the smallest part of dictation that cannot be a plugin.
 *
 * The mirror image of `audio.mjs`, and it exists for the same reason. Capture
 * has to happen in the renderer, because `getUserMedia` lives there and nowhere
 * else; the renderer runs the application's own code and nothing else
 * (`script-src 'self'`, context isolation, a sandboxed preload), so a plugin
 * cannot reach a microphone however much it would like to. The app therefore
 * owns the button, the capture and the encoding, and a plugin owns the part
 * that turns sound into words.
 *
 * It is deliberately not a speech engine and must not become one. It knows
 * whether it is listening, whether something is being transcribed, and who to
 * hand the audio to. Which model, which language, where the binary came from
 * and how the words are extracted are all the plugin's, which is what lets a
 * second plugin drive the same button with an entirely different engine.
 *
 * The button is drawn only when a transcriber says it is ready. A microphone
 * that records into nothing — because no model has been downloaded yet — is a
 * dead control, and the plugin's own row is where a model is obtained.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDir } from './paths.mjs';

/**
 * Longest single recording.
 *
 * Enforced in the renderer, which is what holds the stream, but the limit is
 * stated here because it is a property of the feature rather than of the button:
 * whisper.cpp transcribes a two-minute clip in seconds and a forty-minute one in
 * minutes, and a recording nobody stopped is always the second kind.
 */
export const MAX_SECONDS = 120;

/** Refused before it is written: 16 kHz mono at two bytes a sample, plus slack. */
const MAX_BYTES = MAX_SECONDS * 16_000 * 2 + 1024 * 1024;

export class MicIn extends EventEmitter {
  /** `{pluginId, label, ready, transcribe(wavPath)}` — registered by a plugin. */
  #transcriber = null;
  #listening = false;
  #working = false;
  #error = '';

  status() {
    const transcriber = this.#transcriber;
    return {
      /**
       * Whether to draw the button at all.
       *
       * A transcriber that is registered but not `ready` — the plugin is
       * enabled, no model downloaded yet — deliberately does not count. The
       * alternative is a microphone button that records and then explains, and
       * the explanation belongs on the plugin's row where it can be acted on.
       */
      available: Boolean(transcriber?.ready),
      listening: this.#listening,
      working: this.#working,
      /** Whose engine this is, for the button's tooltip. */
      label: transcriber?.label ?? '',
      driver: transcriber?.pluginId ?? '',
      error: this.#error,
    };
  }

  #announce() {
    this.emit('state', this.status());
  }

  /**
   * A plugin taking charge of dictation.
   *
   * One at a time and the newcomer wins, exactly as with the audio transport:
   * two engines answering the same button would race for the same recording.
   */
  setTranscriber({ pluginId, label = '', ready = false, transcribe }) {
    if (typeof transcribe !== 'function') throw new Error('a transcriber needs a transcribe() function');
    this.#transcriber = { pluginId, label: String(label), ready: Boolean(ready), transcribe };
    this.#error = '';
    this.#announce();
  }

  /**
   * The same plugin saying whether it can actually work yet.
   *
   * Separate from registration because the answer changes without the plugin
   * restarting: a model finishes downloading, or the file it was using is gone.
   */
  setReady(pluginId, ready, label) {
    if (!this.#transcriber || this.#transcriber.pluginId !== pluginId) return;
    this.#transcriber.ready = Boolean(ready);
    if (label !== undefined) this.#transcriber.label = String(label);
    this.#announce();
  }

  /** Called by the host when the plugin is switched off, so the button goes. */
  releasePlugin(pluginId) {
    if (this.#transcriber?.pluginId !== pluginId) return;
    this.#transcriber = null;
    this.#listening = false;
    this.#working = false;
    this.#announce();
  }

  /** The renderer reporting what only it can know: the stream is open, or shut. */
  setListening(on) {
    this.#listening = Boolean(on);
    if (this.#listening) this.#error = '';
    this.#announce();
    return this.status();
  }

  /**
   * A recording, as a 16 kHz mono WAV.
   *
   * Written to a file because that is what a speech engine consumes — every one
   * of them takes a path — and deleted in a `finally` whether or not the plugin
   * succeeded. This is a recording of somebody's voice: leaving it in a scratch
   * directory because the transcriber threw is not litter, it is a recording of
   * somebody's voice left on their disk.
   */
  async hear(bytes) {
    const transcriber = this.#transcriber;
    if (!transcriber?.ready) throw new Error('nothing is set up to transcribe audio');
    if (this.#working) throw new Error('something is already being transcribed');

    const buffer = Buffer.from(bytes ?? []);
    if (buffer.length === 0) throw new Error('nothing was recorded');
    if (buffer.length > MAX_BYTES) throw new Error('that recording is longer than this can take');

    const path = join(scratchDir(), `mic-${randomUUID()}.wav`);
    this.#working = true;
    this.#error = '';
    this.#announce();

    try {
      await writeFile(path, buffer);
      const text = String((await transcriber.transcribe(path)) ?? '').trim();
      return text;
    } catch (err) {
      this.#error = err.message;
      throw err;
    } finally {
      this.#working = false;
      await rm(path, { force: true }).catch(() => {});
      this.#announce();
    }
  }

  /** The renderer could not open a microphone, or the user refused one. */
  fail(message) {
    this.#error = String(message ?? 'the microphone could not be used');
    this.#listening = false;
    this.#working = false;
    this.#announce();
    return this.status();
  }
}

export const mic = new MicIn();
