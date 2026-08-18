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
import { createInterface } from 'node:readline';
import * as controls from './controls.js';
/** One conversation with the engine that started this process. */
class HookHost {
    #nextId = 0;
    #pending = null;
    #write;
    #lines;
    constructor(input, write) {
        this.#write = write;
        this.#lines = createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();
    }
    #send(payload) {
        this.#write(JSON.stringify(payload) + '\n');
    }
    async #next() {
        for (;;) {
            const { value, done } = await this.#lines.next();
            if (done)
                return null;
            const line = String(value).trim().replace(/^﻿/, '');
            if (!line)
                continue;
            return JSON.parse(line);
        }
    }
    /**
     * Send a command to the engine and wait for its reply.
     *
     * Strictly one at a time: the engine is paused inside a step while it waits
     * for this process, so there is never a second exchange to interleave with.
     */
    async #call(cmd, args) {
        const id = ++this.#nextId;
        const payload = { id, cmd };
        if (args)
            payload['args'] = args;
        this.#send(payload);
        const msg = await this.#next();
        if (msg === null)
            throw new Error(`engine closed the stream while ${cmd} was pending`);
        if (!msg['ok']) {
            const err = (msg['error'] ?? {});
            throw new Error(`${cmd}: ${String(err['message'] ?? 'rejected by the engine')}`);
        }
        return msg['result'];
    }
    // Named to match Session, because the handler contexts reach for these on
    // whatever object owns the pipe and must not care which one it is.
    pageEval(js) {
        return this.#call('page.eval', { js });
    }
    async pageUrl() {
        return String((await this.#call('page.url')) ?? '');
    }
    async run() {
        const payload = controls.registrationPayload();
        const empty = payload.controls.length === 0 && payload.calls.length === 0 && payload.hooks.length === 0;
        if (!empty)
            await this.#call('register', payload);
        await this.#call('ready');
        for (;;) {
            const msg = await this.#next();
            if (msg === null)
                return 0;
            if (!('invoke' in msg)) {
                // The engine only ever writes invocations here; anything else means the
                // two sides disagree about the protocol, and guessing would corrupt the
                // stream rather than fail it.
                throw new Error(`expected an invocation, got ${JSON.stringify(msg)}`);
            }
            const reply = { invoke: msg['invoke'] };
            try {
                reply['result'] = (await controls.dispatchInvoke(msg, this)) ?? null;
                reply['ok'] = true;
            }
            catch (exc) {
                // A failing handler is an answer, not a crash.
                const e = exc;
                reply['ok'] = false;
                reply['error'] = { code: 'handler_failed', message: `${e.name}: ${e.message}` };
            }
            this.#send(reply);
        }
    }
}
/**
 * Answer the engine's callbacks until it closes this process's input.
 *
 * Call it at the end of a hook script. It resolves only when the run is over.
 */
export async function serveHooks() {
    const write = (line) => {
        process.stdout.write(line);
    };
    // See the module docstring: keep the protocol stream out of reach of anything
    // that thinks stdout is for humans.
    const realLog = console.log;
    const realInfo = console.info;
    console.log = (...args) => console.error(...args);
    console.info = (...args) => console.error(...args);
    try {
        return await new HookHost(process.stdin, write).run();
    }
    finally {
        console.log = realLog;
        console.info = realInfo;
    }
}
//# sourceMappingURL=hookHost.js.map