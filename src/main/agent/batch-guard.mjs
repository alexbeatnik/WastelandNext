/**
 * Refusing a browser batch that already ran this turn.
 *
 * From a real session: asked for the cheapest lawnmower on a shop, a model sent
 * the same "open the sort menu, choose price ascending" batch five times. Every
 * one of them *resolved* — the engine found a target and clicked it — so
 * nothing told the model the sort had not applied, and nothing stopped it
 * trying the identical thing again.
 *
 * An identical batch cannot produce a different result, so the second one is
 * answered with a refusal that says what to try instead. Kept apart from the
 * pipeline because it is a decision, not plumbing, and a decision is worth
 * testing on its own.
 */

/**
 * What the model is told when a batch is refused.
 *
 * Naming a way forward matters as much as the refusal: "no" on its own tends to
 * produce the same batch a third time, phrased as an apology.
 */
export const REPEAT_FEEDBACK =
  '[BROWSER SKIPPED] You already ran exactly these steps this turn and the page did not end up where you wanted. ' +
  'Running them again will do the same thing. Try a different route: pick a different label from CURRENT PAGE, or ' +
  'NAVIGATE to a URL that encodes what you want (sorting and filtering on shops are usually query parameters). ' +
  'If neither is available, tell the user plainly what you could not do.';

/** Whitespace and blank lines must not disguise the same batch. */
export function batchSignature(steps) {
  return String(steps ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

export class BatchGuard {
  #seen = new Set();

  /** Called at the start of every user turn; the same steps are fair again. */
  beginTurn() {
    this.#seen.clear();
  }

  /**
   * Record this batch, or refuse it.
   *
   * Returns the refusal text when the batch has already run this turn, and null
   * when it is free to proceed.
   */
  check(steps) {
    const signature = batchSignature(steps);
    if (!signature) return null;

    if (this.#seen.has(signature)) return REPEAT_FEEDBACK;
    this.#seen.add(signature);
    return null;
  }
}
