/**
 * NDJSON-over-stdio transport for `manul serve`.
 *
 * This module owns the child process and the wire format, and nothing else. It
 * does not know what a page or a step is — that lives in `session.ts`. Keeping
 * the split means the protocol can gain commands without this file changing.
 *
 * The shape differs from the Python transport in one way that matters. Python
 * blocks on a read and holds a lock; Node cannot block, so replies are matched
 * by id against a pending map. That makes nested calls fall out for free — a
 * `page.eval` issued from inside a handler is just another pending id — but it
 * also means two overlapping top-level commands could each trigger a reverse
 * call, and the protocol's reverse calls are strictly nested. So top-level
 * commands are serialised through a queue, which is what Python's lock does.
 */
/**
 * This binding is written against protocol 1.x. Minor bumps only add things, so
 * they are safe; a major bump changes existing shapes and must be refused.
 */
export declare const SUPPORTED_PROTOCOL_MAJOR = 1;
export type Json = unknown;
/** An engine-to-client callback: a custom control, CALL handler or suite hook. */
export interface InvokeMessage {
    invoke: number;
    kind: string;
    [key: string]: Json;
}
export type InvokeHandler = (msg: InvokeMessage) => Json | Promise<Json>;
export interface TransportOptions {
    /**
     * The engine to run. A string is a path; an array is taken verbatim as the
     * command prefix, so the engine can be reached through a wrapper — `wsl`,
     * `docker exec`, a shim script — without this package knowing about any of
     * them. Omitted means "find it".
     */
    binary?: string | readonly string[];
    /** Extra arguments appended after `serve --stdio`. */
    args?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Where engine logs go. Engine logs are on stderr and never parsed; the
     * default inherits this process's stderr so warnings stay visible.
     */
    stderr?: 'inherit' | 'ignore' | 'pipe';
}
/** A live `manul serve --stdio` process. */
export declare class Transport {
    #private;
    /** Protocol version the engine reported in its ready event. */
    protocol: string;
    /** Engine version the engine reported in its ready event. */
    engineVersion: string;
    /**
     * Handles reverse calls — the engine asking this process to run a custom
     * control, a CALL handler or a hook. Set by `Session`; without it an invoke
     * is answered with an error rather than left to hang.
     */
    onInvoke: InvokeHandler | null;
    constructor(options?: TransportOptions);
    /** Resolves once the engine's ready event has been read and accepted. */
    ready(): Promise<void>;
    get closed(): boolean;
    /**
     * Shut the engine down, politely first.
     *
     * `close` gives the engine a chance to release its browser; only a process
     * that ignores that is killed. Safe to call twice.
     */
    close(timeoutMs?: number): Promise<void>;
    /**
     * Send one command and return its result.
     *
     * Rejects with `EngineError` when the engine answers `ok: false` — the
     * session stays usable, so callers may catch it and carry on.
     *
     * Calls are serialised: a second `call` waits for the first to settle. That
     * keeps reverse calls strictly nested, which the protocol requires.
     */
    call(cmd: string, args?: Record<string, Json>): Promise<Json>;
    /**
     * Issue a request from inside a reverse call.
     *
     * Only the engine's `page.*` primitives are available here — everything else
     * would re-enter the step that is currently running. It bypasses the queue
     * deliberately: the caller is already inside a `call` that holds it, and
     * queueing would deadlock.
     */
    nestedCall(cmd: string, args?: Record<string, Json>): Promise<Json>;
}
//# sourceMappingURL=transport.d.ts.map