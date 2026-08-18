/** Errors raised by the Manul binding. Mirrors `manul.errors` in Python. */
/** Base class for every error this package raises. */
export declare class ManulError extends Error {
    constructor(message: string);
}
/**
 * The `manul` binary could not be located.
 *
 * Carries the places that were searched, so the message is actionable rather
 * than a bare "not found".
 */
export declare class EngineNotFound extends ManulError {
    readonly searched: readonly string[];
    constructor(searched: readonly string[]);
}
/**
 * The engine spoke something this binding does not understand.
 *
 * Raised for an unreadable line, a missing ready event, or a major protocol
 * version this binding was not written against.
 */
export declare class ProtocolError extends ManulError {
}
/**
 * The engine rejected a request.
 *
 * This is a normal, recoverable answer — the session stays usable. `code` is
 * the machine-readable reason (`bad_request`, `not_open`, `internal`…).
 */
export declare class EngineError extends ManulError {
    readonly code: string;
    constructor(code: string, message: string);
}
/** A call was made on a session that is already closed. */
export declare class SessionClosed extends ManulError {
}
//# sourceMappingURL=errors.d.ts.map