/**
 * Locating the `manul` engine binary.
 *
 * A published install normally carries the binary in a platform package, but a
 * developer working on the engine wants their own build to win without
 * reinstalling anything. Hence the order below: an installed package is
 * preferred over whatever PATH happens to hold, because an install should be
 * self-contained and predictable, and MANUL_BINARY exists for the developer who
 * wants to override that.
 *
 * The order matches `manul/_binary.py` deliberately. Two bindings that disagree
 * about which engine they picked would be very hard to debug.
 */
export declare const BINARY_NAME: string;
/**
 * The platform package that would carry the engine for this host.
 *
 * These are published by the release workflow as `optionalDependencies`, one
 * per target, so npm installs exactly the one that matches. None exists yet —
 * the release pipeline that would build them is switched off — so resolution
 * failing here is the expected case today, not an error.
 */
export declare function platformPackage(): string;
/**
 * Return the path to the engine binary.
 *
 * Resolution order:
 *
 * 1. `explicit`, when the caller passed one.
 * 2. `$MANUL_BINARY`.
 * 3. The platform package for this host.
 * 4. `manul` on `PATH`.
 *
 * @throws {EngineNotFound} listing everything that was tried.
 */
export declare function findBinary(explicit?: string): string;
//# sourceMappingURL=binary.d.ts.map