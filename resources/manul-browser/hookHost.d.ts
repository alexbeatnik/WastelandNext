/**
 * The child half of `manul run --hooks`.
 *
 * Everything else in this package spawns the engine and drives it. This module
 * is the one place where that is inverted: the engine spawns *this* process,
 * and this process only answers.
 *
 * Nothing here decides anything. Which script to run, which interpreter runs
 * it, when hooks fire and in what order are all the engine's business — this is
 * a read-a-line, call-a-function, write-a-line loop over the same reverse calls
 * a `Session` already handles, and it reuses that same dispatcher.
 *
 * A hook script is therefore just:
 *
 * ```js
 * import { beforeAll, serveHooks } from 'manul-browser';
 *
 * beforeAll(async (ctx) => { ctx.variables.token = await getToken(); });
 *
 * await serveHooks();
 * ```
 *
 * started with `manul run hunts/ --hooks manul_hooks.js`.
 *
 * **stdout belongs to the protocol.** A `console.log` in a hook script would
 * land in the middle of a JSON line and break the engine's parser, so console
 * output is redirected to stderr for the duration and the real stream is kept
 * private to the writer. That is the same rule the engine imposes on itself in
 * serve mode, applied in the direction a user is likely to trip over.
 */
/**
 * Answer the engine's callbacks until it closes this process's input.
 *
 * Call it at the end of a hook script. It resolves only when the run is over.
 */
export declare function serveHooks(): Promise<number>;
//# sourceMappingURL=hookHost.d.ts.map