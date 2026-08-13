/**
 * How fast a download is actually going.
 *
 * Separate and pure because the obvious formula is wrong twice over, and both
 * ways are only visible with the clock in the test's hands.
 *
 * `received / elapsed` is wrong on a **resumed** transfer: `received` starts at
 * whatever was already on disk, so a download resuming at 4 GB reports several
 * gigabytes per second in its first seconds — bytes that arrived yesterday,
 * credited to today. Measuring the *delta* between samples cannot make that
 * mistake, because the first sample is the baseline and the bytes before it are
 * never counted.
 *
 * It is also wrong as an average: a transfer that ran at 40 MB/s for a minute
 * and then stalled to a trickle goes on claiming tens of megabytes per second
 * for a long time. A trailing window follows what the connection is doing now,
 * which is the only reading anyone watches a progress bar for.
 */

/** How much history the reading is drawn from. */
const WINDOW_MS = 5_000;

export class RateMeter {
  #windowMs;
  #samples = [];

  constructor({ windowMs = WINDOW_MS } = {}) {
    this.#windowMs = windowMs;
  }

  /** Record the running total. The first call is the baseline, not a reading. */
  sample(received, now = Date.now()) {
    this.#samples.push({ at: now, received });
    // Two are always kept, however old: a slow transfer whose samples all fall
    // outside the window would otherwise report nothing at all rather than a
    // small number, and "no speed" reads as a stall that has not happened.
    const cutoff = now - this.#windowMs;
    while (this.#samples.length > 2 && this.#samples[0].at < cutoff) this.#samples.shift();
  }

  /** Bytes per second across the window. 0 when nothing can honestly be said. */
  rate(now = Date.now()) {
    if (this.#samples.length < 2) return 0;
    const first = this.#samples[0];
    const last = this.#samples.at(-1);

    // Nothing has landed for a whole window: the honest reading is zero, not
    // the speed it was doing before it went quiet.
    if (now - last.at > this.#windowMs) return 0;

    const seconds = (last.at - first.at) / 1000;
    const bytes = last.received - first.received;
    if (seconds <= 0 || bytes <= 0) return 0;
    return bytes / seconds;
  }

  /**
   * Seconds remaining, or null when the question cannot be answered.
   *
   * Null rather than Infinity or a guess: with no total from the server, or no
   * measured speed yet, there is no estimate — and a progress line that says
   * "0s left" for the first second of a download is worse than one that says
   * nothing until it knows.
   */
  eta(received, total, now = Date.now()) {
    const rate = this.rate(now);
    if (!rate || !total || received >= total) return null;
    return (total - received) / rate;
  }
}
