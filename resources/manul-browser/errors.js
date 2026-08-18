/** Errors raised by the Manul binding. Mirrors `manul.errors` in Python. */
/** Base class for every error this package raises. */
export class ManulError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
/**
 * The `manul` binary could not be located.
 *
 * Carries the places that were searched, so the message is actionable rather
 * than a bare "not found".
 */
export class EngineNotFound extends ManulError {
    searched;
    constructor(searched) {
        super('could not find the manul engine. Looked in:\n  ' +
            searched.join('\n  ') +
            '\nSet MANUL_BINARY to an explicit path, or put `manul` on PATH.');
        this.searched = searched;
    }
}
/**
 * The engine spoke something this binding does not understand.
 *
 * Raised for an unreadable line, a missing ready event, or a major protocol
 * version this binding was not written against.
 */
export class ProtocolError extends ManulError {
}
/**
 * The engine rejected a request.
 *
 * This is a normal, recoverable answer — the session stays usable. `code` is
 * the machine-readable reason (`bad_request`, `not_open`, `internal`…).
 */
export class EngineError extends ManulError {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
    }
}
/** A call was made on a session that is already closed. */
export class SessionClosed extends ManulError {
}
//# sourceMappingURL=errors.js.map