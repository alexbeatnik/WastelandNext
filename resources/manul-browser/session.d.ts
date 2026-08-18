/**
 * The JavaScript face of the Manul engine.
 *
 * `Session` mirrors `pkg/agent.Session` in Go and `manul.Session` in Python,
 * method for method, so the three describe the same thing the same way.
 * Everything here is a thin call over the protocol — no scoring, no DSL
 * parsing, no CDP.
 */
import type { PagePeer } from './controls.js';
import { Transport, type Json, type TransportOptions } from './transport.js';
export interface MapElement {
    label: string;
    role: string;
    editable: boolean;
}
export interface MapGroup {
    name: string;
    elements: MapElement[];
    truncated: number;
}
/** A landmark-grouped view of the page, budgeted for an LLM's context. */
export interface PageMap {
    url: string;
    groups: MapGroup[];
    /** Every element label on the page, flattened — handy for a quick look. */
    labels(): string[];
}
/**
 * The result of reading one labelled thing off the page.
 *
 * `found: false` is a normal answer, not an error: the label simply is not
 * there right now.
 */
export interface Value {
    value: string;
    found: boolean;
    reason: string;
}
/** What happened when one DSL line ran. */
export interface StepOutcome {
    ok: boolean;
    step: string;
    action: string;
    value: string;
    url: string;
    reason: string;
    error: string;
    score: number;
    near: Array<Record<string, Json>>;
}
/** The aggregate of running a whole .hunt script. */
export interface RunOutcome {
    ok: boolean;
    url: string;
    totalSteps: number;
    passed: number;
    failed: number;
}
/** One hunt's outcome inside a suite. */
export interface SuiteHunt {
    path: string;
    ok: boolean;
    /** True when a before_group hook refused this hunt. The suite carried on. */
    skipped: boolean;
    tags: string[];
    steps: number;
    passed: number;
    failed: number;
    error: string;
}
/** The aggregate of a suite run. */
export interface SuiteResult {
    ok: boolean;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    hunts: SuiteHunt[];
}
export interface SessionOptions extends TransportOptions {
    /** `'launch'` starts a Chrome this session owns; `'attach'` joins one. */
    mode?: 'launch' | 'attach';
    /** CDP endpoint to dial when attaching. */
    cdp?: string;
    /** Attach to the first tab whose URL contains this substring. */
    tab?: string;
    headless?: boolean;
    port?: number;
    executablePath?: string;
}
/**
 * A live engine and the browser it owns.
 *
 * Create one with `launch` or `attach` rather than calling the constructor:
 * opening is asynchronous, and a half-open session is not a useful object.
 */
export declare class Session implements PagePeer {
    #private;
    /** Which mode the engine actually resolved: `launch` or `attach`. */
    mode: string;
    /** The CDP endpoint in use, when attaching. */
    cdp: string;
    /** What `register` reported when handlers were published. */
    published: {
        controls: number;
        calls: number;
        hooks: number;
    };
    private constructor();
    /**
     * Start an engine and open a browser session.
     *
     * Registered handlers are published before the browser exists: they describe
     * this process, and a registration at import time must not depend on a
     * session having been created yet.
     */
    static open(options?: SessionOptions): Promise<Session>;
    /** Start a Chrome this session owns. */
    static launch(options?: Omit<SessionOptions, 'mode'>): Promise<Session>;
    /**
     * Join a Chrome that is already running.
     *
     * That browser is left open when the session ends — Manul did not open it.
     */
    static attach(cdp: string, options?: Omit<SessionOptions, 'mode' | 'cdp'>): Promise<Session>;
    /**
     * Tell the engine which custom controls, CALL handlers and hooks exist here.
     *
     * Called automatically by `open`. Call it again after registering more
     * handlers on a session that is already running.
     */
    publishHandlers(): Promise<{
        controls: number;
        calls: number;
        hooks: number;
    }>;
    /** End the session and stop the engine. Safe to call twice. */
    close(): Promise<void>;
    /** Enables `await using session = await Session.launch()`. */
    [Symbol.asyncDispose](): Promise<void>;
    get closed(): boolean;
    get opened(): boolean;
    /**
     * The live protocol connection.
     *
     * An escape hatch, and deliberately a supported one: the engine gains
     * commands faster than this package wraps them, and `session.transport.call`
     * is a better answer than a fork. Nothing here interprets what it returns.
     */
    get transport(): Transport;
    get engineVersion(): string;
    get protocol(): string;
    /**
     * Run one DSL line.
     *
     * A step that resolves nothing is a normal answer with `ok: false`, not a
     * thrown error — the session stays usable either way.
     */
    step(instruction: string): Promise<StepOutcome>;
    /** Run a whole .hunt script, given either its text or a path to it. */
    run(source: {
        source: string;
    } | {
        path: string;
    }): Promise<RunOutcome>;
    /**
     * Run several .hunt files with the suite lifecycle applied.
     *
     * This is not a loop over `run`: `beforeAll`/`afterAll` bracket the whole
     * set, and the group hooks fire per hunt according to its tags.
     */
    runSuite(paths: readonly string[]): Promise<SuiteResult>;
    /** A landmark-grouped view of what is on the page. */
    map(budget?: {
        maxPerGroup?: number;
        includeUnlabeled?: boolean;
    }): Promise<PageMap>;
    /** Read one labelled value off the page. */
    read(label: string, options?: {
        maxChars?: number;
    }): Promise<Value>;
    /** Read the text of a CSS selector. */
    readText(selector: string, options?: {
        maxChars?: number;
    }): Promise<string>;
    /** URL and title of the current page. */
    state(): Promise<Record<string, string>>;
    /** Read DSL variables. With no names, every variable. */
    vars(...names: string[]): Promise<Record<string, string>>;
    /** Set DSL variables, and get the full set back. */
    setVars(values: Record<string, string>): Promise<Record<string, string>>;
    /** The engine's own description of its DSL and JSON shapes. */
    schema(): Promise<Record<string, Json>>;
    pageEval(js: string): Promise<Json>;
    pageUrl(): Promise<string>;
}
//# sourceMappingURL=session.d.ts.map