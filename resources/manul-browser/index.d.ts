/**
 * manul-browser — browser automation in plain English.
 *
 * A thin client for the Manul engine. It ships the platform binary, starts
 * `manul serve --stdio`, and speaks the protocol in `spec/protocol.md`. It
 * contains no element scoring, no DSL parsing and no CDP: if something is
 * missing here, the fix is a protocol command in the engine, not an
 * implementation in this package.
 *
 * ```js
 * import { Session } from 'manul-browser';
 *
 * const s = await Session.launch({ headless: true });
 * try {
 *   await s.step('NAVIGATE to https://example.com');
 *   await s.step("CLICK the 'Sign in' button");
 *   console.log((await s.map()).labels());
 * } finally {
 *   await s.close();
 * }
 * ```
 */
export { Session } from './session.js';
export type { MapElement, MapGroup, PageMap, RunOutcome, SessionOptions, StepOutcome, SuiteHunt, SuiteResult, Value, } from './session.js';
export { ANY_PAGE, afterAll, afterGroup, beforeAll, beforeGroup, call, customControl, diagnoseCustomControlMiss, getCall, getCustomControl, getHooks, listCalls, listCustomControls, listHooks, resetRegistry, } from './controls.js';
export type { CallContext, CallHandler, ControlContext, ControlHandler, GlobalContext, HookHandler, } from './controls.js';
export { serveHooks } from './hookHost.js';
export { findBinary, BINARY_NAME, platformPackage } from './binary.js';
export { EngineError, EngineNotFound, ManulError, ProtocolError, SessionClosed, } from './errors.js';
export { Transport, SUPPORTED_PROTOCOL_MAJOR } from './transport.js';
export type { Json, TransportOptions } from './transport.js';
//# sourceMappingURL=index.d.ts.map