/**
 * The handler registry: custom controls, CALL handlers and suite hooks.
 *
 * These describe *this process*, not any one session, so they are registered at
 * module scope and published to whichever engine turns up — the one a `Session`
 * spawns, or the one that spawned this process with `--hooks`. That is why the
 * registry is module-level state rather than a field on `Session`.
 *
 * Registration is by name, and matching is case- and whitespace-insensitive, so
 * `'Sign In'` and `'sign in'` are one target. It matches how the engine
 * normalises labels; a binding that disagreed would silently miss handlers.
 */
import type { Json } from './transport.js';
/** Page label that matches any page. */
export declare const ANY_PAGE = "*";
export declare const BEFORE_ALL = "before_all";
export declare const AFTER_ALL = "after_all";
export declare const BEFORE_GROUP = "before_group";
export declare const AFTER_GROUP = "after_group";
/** What a handler can reach while the engine is paused inside its step. */
export interface PagePeer {
    pageEval(js: string): Promise<Json>;
    pageUrl(): Promise<string>;
}
/** Context handed to a custom control. */
export interface ControlContext {
    readonly target: string;
    readonly action: string;
    readonly value: string;
    readonly page: string;
    readonly step: string;
    readonly vars: Record<string, string>;
    /** Evaluate JavaScript in the live page. */
    eval(js: string): Promise<Json>;
    /** The page's current URL. */
    url(): Promise<string>;
}
/** Context handed to a `CALL HOST` handler. */
export interface CallContext {
    readonly name: string;
    readonly args: string[];
    readonly vars: Record<string, string>;
    eval(js: string): Promise<Json>;
    url(): Promise<string>;
}
/**
 * Context handed to a suite hook.
 *
 * Anything written into `variables` is published to every hunt that follows as
 * a `{placeholder}`. `before_all` runs before a browser exists, so `eval` there
 * has nothing to talk to and rejects.
 */
export interface GlobalContext {
    readonly variables: Record<string, string>;
    eval(js: string): Promise<Json>;
    url(): Promise<string>;
}
export type ControlHandler = (ctx: ControlContext) => void | Promise<void>;
export type CallHandler = (ctx: CallContext) => Json | Promise<Json>;
export type HookHandler = (ctx: GlobalContext) => void | Promise<void>;
/**
 * Handle a specific element yourself instead of letting the engine resolve it.
 *
 * The `.hunt` line stays an ordinary CLICK or FILL; this intercepts it before
 * DOM resolution, which is what makes a datepicker or a canvas widget
 * expressible in one readable step.
 */
export declare function customControl(target: string, handler: ControlHandler): void;
export declare function customControl(spec: {
    page?: string;
    target: string;
}, handler: ControlHandler): void;
/** Register a handler reachable from a hunt as `CALL HOST <name>`. */
export declare function call(name: string, handler: CallHandler): void;
/** Runs once, before any hunt in the suite and before any browser exists. */
export declare function beforeAll(handler: HookHandler): void;
/** Runs once after the suite, whatever happened. */
export declare function afterAll(handler: HookHandler): void;
/** Runs before each hunt carrying `tag` in its `@tags:` header. */
export declare function beforeGroup(tag: string, handler: HookHandler): void;
/** Runs after each hunt carrying `tag`. */
export declare function afterGroup(tag: string, handler: HookHandler): void;
export declare function getCustomControl(page: string, target: string): ControlHandler | null;
export declare function getCall(name: string): CallHandler | null;
export declare function getHooks(kind: string, tag: string): HookHandler[];
export declare function listCustomControls(): Array<{
    page: string;
    target: string;
}>;
export declare function listCalls(): string[];
export declare function listHooks(): Array<{
    kind: string;
    tag: string;
}>;
/** Drop every registration. For tests. */
export declare function resetRegistry(): void;
/**
 * Explain a custom-control miss in terms of what *is* registered.
 *
 * A wrong page label looks identical to a missing handler from the engine's
 * side, and that is the mistake people actually make.
 */
export declare function diagnoseCustomControlMiss(page: string, target: string): string | null;
/** What gets published to the engine as a `register` command. */
export declare function registrationPayload(): {
    controls: Array<{
        page: string;
        target: string;
    }>;
    calls: string[];
    hooks: Array<{
        kind: string;
        tag: string;
    }>;
};
/**
 * Route one engine callback to the handler that claimed it.
 *
 * `peer` is whatever owns the pipe the callback arrived on: a `Session` when
 * this process drives the engine, the hook host when the engine drives this
 * process. The callbacks are identical either way, so they are dispatched in
 * one place rather than once per direction.
 */
export declare function dispatchInvoke(msg: Record<string, Json>, peer: PagePeer): Promise<Json>;
//# sourceMappingURL=controls.d.ts.map