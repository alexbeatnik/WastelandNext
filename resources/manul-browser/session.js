/**
 * The JavaScript face of the Manul engine.
 *
 * `Session` mirrors `pkg/agent.Session` in Go and `manul.Session` in Python,
 * method for method, so the three describe the same thing the same way.
 * Everything here is a thin call over the protocol — no scoring, no DSL
 * parsing, no CDP.
 */
import * as controls from './controls.js';
import { Transport } from './transport.js';
function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function str(v, fallback = '') {
    return v === undefined || v === null ? fallback : String(v);
}
/**
 * A live engine and the browser it owns.
 *
 * Create one with `launch` or `attach` rather than calling the constructor:
 * opening is asynchronous, and a half-open session is not a useful object.
 */
export class Session {
    #t;
    #opened = false;
    /** Which mode the engine actually resolved: `launch` or `attach`. */
    mode = '';
    /** The CDP endpoint in use, when attaching. */
    cdp = '';
    /** What `register` reported when handlers were published. */
    published = {
        controls: 0,
        calls: 0,
        hooks: 0,
    };
    constructor(options) {
        this.#t = new Transport(options);
        this.#t.onInvoke = (msg) => controls.dispatchInvoke(msg, this);
    }
    /**
     * Start an engine and open a browser session.
     *
     * Registered handlers are published before the browser exists: they describe
     * this process, and a registration at import time must not depend on a
     * session having been created yet.
     */
    static async open(options = {}) {
        const s = new Session(options);
        try {
            await s.#t.ready();
            await s.publishHandlers();
            const res = ((await s.#t.call('open', {
                mode: options.mode,
                cdp: options.cdp,
                tab: options.tab,
                headless: options.headless,
                port: options.port,
                executablePath: options.executablePath,
            })) ?? {});
            s.#opened = true;
            s.mode = str(res['mode']);
            s.cdp = str(res['cdp']);
            return s;
        }
        catch (err) {
            await s.#t.close();
            throw err;
        }
    }
    /** Start a Chrome this session owns. */
    static launch(options = {}) {
        return Session.open({ ...options, mode: 'launch' });
    }
    /**
     * Join a Chrome that is already running.
     *
     * That browser is left open when the session ends — Manul did not open it.
     */
    static attach(cdp, options = {}) {
        return Session.open({ ...options, mode: 'attach', cdp });
    }
    /**
     * Tell the engine which custom controls, CALL handlers and hooks exist here.
     *
     * Called automatically by `open`. Call it again after registering more
     * handlers on a session that is already running.
     */
    async publishHandlers() {
        const payload = controls.registrationPayload();
        const empty = payload.controls.length === 0 && payload.calls.length === 0 && payload.hooks.length === 0;
        if (empty) {
            this.published = { controls: 0, calls: 0, hooks: 0 };
            return this.published;
        }
        const res = ((await this.#t.call('register', payload)) ??
            {});
        this.published = {
            controls: num(res['controls']),
            calls: num(res['calls']),
            hooks: num(res['hooks']),
        };
        return this.published;
    }
    /** End the session and stop the engine. Safe to call twice. */
    async close() {
        await this.#t.close();
        this.#opened = false;
    }
    /** Enables `await using session = await Session.launch()`. */
    async [Symbol.asyncDispose]() {
        await this.close();
    }
    get closed() {
        return this.#t.closed;
    }
    get opened() {
        return this.#opened;
    }
    /**
     * The live protocol connection.
     *
     * An escape hatch, and deliberately a supported one: the engine gains
     * commands faster than this package wraps them, and `session.transport.call`
     * is a better answer than a fork. Nothing here interprets what it returns.
     */
    get transport() {
        return this.#t;
    }
    get engineVersion() {
        return this.#t.engineVersion;
    }
    get protocol() {
        return this.#t.protocol;
    }
    // ── page commands ─────────────────────────────────────────────────────────
    /**
     * Run one DSL line.
     *
     * A step that resolves nothing is a normal answer with `ok: false`, not a
     * thrown error — the session stays usable either way.
     */
    async step(instruction) {
        const raw = ((await this.#t.call('run-step', { step: instruction })) ?? {});
        return {
            ok: Boolean(raw['ok']),
            step: str(raw['step']),
            action: str(raw['action']),
            value: str(raw['value']),
            url: str(raw['url']),
            reason: str(raw['reason']),
            error: str(raw['error']),
            score: num(raw['score']),
            near: (raw['near'] ?? []),
        };
    }
    /** Run a whole .hunt script, given either its text or a path to it. */
    async run(source) {
        const args = 'source' in source ? { source: source.source } : { path: source.path };
        const raw = ((await this.#t.call('run', args)) ?? {});
        return {
            ok: Boolean(raw['ok']),
            url: str(raw['url']),
            totalSteps: num(raw['total_steps']),
            passed: num(raw['passed']),
            failed: num(raw['failed']),
        };
    }
    /**
     * Run several .hunt files with the suite lifecycle applied.
     *
     * This is not a loop over `run`: `beforeAll`/`afterAll` bracket the whole
     * set, and the group hooks fire per hunt according to its tags.
     */
    async runSuite(paths) {
        const raw = ((await this.#t.call('run-suite', { paths: [...paths] })) ?? {});
        const hunts = (raw['hunts'] ?? []).map((h) => ({
            path: str(h['path']),
            ok: Boolean(h['ok']),
            skipped: Boolean(h['skipped']),
            tags: (h['tags'] ?? []),
            steps: num(h['steps']),
            passed: num(h['passed']),
            failed: num(h['failed']),
            error: str(h['error']),
        }));
        return {
            ok: Boolean(raw['ok']),
            total: num(raw['total']),
            passed: num(raw['passed']),
            failed: num(raw['failed']),
            skipped: num(raw['skipped']),
            hunts,
        };
    }
    /** A landmark-grouped view of what is on the page. */
    async map(budget = {}) {
        const raw = ((await this.#t.call('map', {
            maxPerGroup: budget.maxPerGroup,
            includeUnlabeled: budget.includeUnlabeled,
        })) ?? {});
        const groups = (raw['groups'] ?? []).map((g) => ({
            name: str(g['name']),
            truncated: num(g['truncated']),
            elements: (g['elements'] ?? []).map((e) => ({
                label: str(e['label']),
                role: str(e['role']),
                editable: Boolean(e['editable']),
            })),
        }));
        return {
            url: str(raw['url']),
            groups,
            labels() {
                return groups.flatMap((g) => g.elements.map((e) => e.label));
            },
        };
    }
    /** Read one labelled value off the page. */
    async read(label, options = {}) {
        const raw = ((await this.#t.call('read', { label, maxChars: options.maxChars })) ??
            {});
        return {
            value: str(raw['value']),
            found: Boolean(raw['found']),
            reason: str(raw['reason']),
        };
    }
    /** Read the text of a CSS selector. */
    async readText(selector, options = {}) {
        const raw = ((await this.#t.call('read', { selector, maxChars: options.maxChars })) ??
            {});
        return str(raw['text']);
    }
    /** URL and title of the current page. */
    async state() {
        return ((await this.#t.call('state')) ?? {});
    }
    /** Read DSL variables. With no names, every variable. */
    async vars(...names) {
        return ((await this.#t.call('vars', { get: names.length ? names : undefined })) ??
            {});
    }
    /** Set DSL variables, and get the full set back. */
    async setVars(values) {
        return ((await this.#t.call('vars', { set: values })) ?? {});
    }
    /** The engine's own description of its DSL and JSON shapes. */
    async schema() {
        return ((await this.#t.call('schema')) ?? {});
    }
    // ── page primitives ───────────────────────────────────────────────────────
    //
    // Valid only while a handler is running. They exist so a JavaScript handler
    // can inspect and touch the page the way an embedded Go handler does with its
    // browser.Page.
    async pageEval(js) {
        return this.#t.nestedCall('page.eval', { js });
    }
    async pageUrl() {
        return str(await this.#t.nestedCall('page.url'));
    }
}
//# sourceMappingURL=session.js.map