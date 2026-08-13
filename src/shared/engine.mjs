/**
 * Finding the manul-browser checkout.
 *
 * The engine binary and its Node binding both come from the same sibling
 * checkout of https://github.com/alexbeatnik/manul-browser, because the npm
 * package publishes no platform packages yet — there is nowhere else for either
 * to come from. Resolving both here means the build script and the runtime can
 * never end up pointed at different copies.
 *
 * A `file:` dependency in package.json would have to hard-code one directory
 * name, and npm resolves dependencies before any script could correct it. So
 * the binding is loaded by path at runtime instead.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Sibling directory names the checkout might have.
 *
 * `manul-browser` is the repository's real name and so what a fresh
 * `git clone` produces; the others are what earlier clones of the same
 * repository were called locally. Guessing costs one `existsSync` each and
 * saves everyone an environment variable.
 */
export const CANDIDATE_DIRS = ['manul-browser', 'Manul', 'ManulEngineGo'];

/**
 * The repository root of the checkout, or null.
 *
 * `MANUL_SOURCE` wins when set, and may name either the repository root or the
 * `core` directory inside it — both are things a person reasonably types.
 */
export function findCheckout(repoRoot) {
  const override = process.env['MANUL_SOURCE'];
  if (override) {
    for (const candidate of [override, resolve(override, '..')]) {
      if (existsSync(join(candidate, 'core', 'go.mod'))) return candidate;
    }
    return null;
  }
  for (const name of CANDIDATE_DIRS) {
    const candidate = resolve(repoRoot, '..', name);
    if (existsSync(join(candidate, 'core', 'go.mod'))) return candidate;
  }
  return null;
}

/** The Go engine source directory (`<checkout>/core`), or null. */
export function findEngineSource(repoRoot) {
  const checkout = findCheckout(repoRoot);
  return checkout ? join(checkout, 'core') : null;
}

/**
 * The built Node binding's entry point, or null.
 *
 * `dist/` is checked in rather than built here: the binding ships compiled, and
 * running `tsc` on someone else's repository during our install would be rude.
 */
export function findBindingEntry(repoRoot) {
  const checkout = findCheckout(repoRoot);
  if (!checkout) return null;
  const entry = join(checkout, 'bindings', 'node', 'dist', 'index.js');
  return existsSync(entry) ? entry : null;
}

/** What was tried, for an error message worth reading. */
export function describeSearch() {
  return process.env['MANUL_SOURCE']
    ? `MANUL_SOURCE=${process.env['MANUL_SOURCE']}`
    : CANDIDATE_DIRS.map((name) => `../${name}`).join(', ');
}
