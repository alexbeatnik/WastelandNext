/**
 * Locating the manul-browser checkout.
 *
 * The repository is named `manul-browser`; a local clone may sit under an older
 * directory name. Getting this wrong is invisible until browser control simply
 * does not work, so both spellings are pinned here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANDIDATE_DIRS, describeSearch, findBindingEntry, findCheckout, findEngineSource } from '../src/shared/engine.mjs';

/** Build `<parent>/<name>/core/go.mod`, plus the binding when asked. */
function fakeCheckout(parent, name, { binding = false } = {}) {
  const root = join(parent, name);
  mkdirSync(join(root, 'core'), { recursive: true });
  writeFileSync(join(root, 'core', 'go.mod'), 'module github.com/alexbeatnik/manul-browser/core\n');
  if (binding) {
    mkdirSync(join(root, 'bindings', 'node', 'dist'), { recursive: true });
    writeFileSync(join(root, 'bindings', 'node', 'dist', 'index.js'), 'export const Session = {};\n');
  }
  return root;
}

/** A scratch `GitHub/` directory holding a sibling app repo. */
function scratch() {
  const parent = mkdtempSync(join(tmpdir(), 'wl-siblings-'));
  const appRoot = join(parent, 'WastelandNext');
  mkdirSync(appRoot, { recursive: true });
  return { parent, appRoot };
}

/** Run `fn` with MANUL_SOURCE set to `value` (or unset), then restore. */
function withSource(value, fn) {
  const previous = process.env['MANUL_SOURCE'];
  if (value === undefined) delete process.env['MANUL_SOURCE'];
  else process.env['MANUL_SOURCE'] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['MANUL_SOURCE'];
    else process.env['MANUL_SOURCE'] = previous;
  }
}

test('finds a checkout under the repository name', () => {
  const { parent, appRoot } = scratch();
  const expected = fakeCheckout(parent, 'manul-browser');
  withSource(undefined, () => {
    assert.equal(findCheckout(appRoot), expected);
    assert.equal(findEngineSource(appRoot), join(expected, 'core'));
  });
});

test('finds a checkout under an older local directory name', () => {
  const { parent, appRoot } = scratch();
  const expected = fakeCheckout(parent, 'Manul');
  withSource(undefined, () => assert.equal(findCheckout(appRoot), expected));
});

test('prefers the real repository name when several exist', () => {
  const { parent, appRoot } = scratch();
  const canonical = fakeCheckout(parent, 'manul-browser');
  fakeCheckout(parent, 'Manul');
  withSource(undefined, () => assert.equal(findCheckout(appRoot), canonical));
});

test('returns null when there is no checkout at all', () => {
  const { appRoot } = scratch();
  withSource(undefined, () => {
    assert.equal(findCheckout(appRoot), null);
    assert.equal(findEngineSource(appRoot), null);
    assert.equal(findBindingEntry(appRoot), null);
  });
});

test('a directory without go.mod is not a checkout', () => {
  const { parent, appRoot } = scratch();
  mkdirSync(join(parent, 'manul-browser', 'core'), { recursive: true });
  withSource(undefined, () => assert.equal(findCheckout(appRoot), null));
});

test('MANUL_SOURCE may name the repository root', () => {
  const { parent, appRoot } = scratch();
  const checkout = fakeCheckout(parent, 'somewhere-else');
  withSource(checkout, () => assert.equal(findCheckout(appRoot), checkout));
});

test('MANUL_SOURCE may name the core directory inside it', () => {
  const { parent, appRoot } = scratch();
  const checkout = fakeCheckout(parent, 'somewhere-else');
  withSource(join(checkout, 'core'), () => assert.equal(findCheckout(appRoot), checkout));
});

test('a wrong MANUL_SOURCE fails rather than falling back to a sibling', () => {
  const { parent, appRoot } = scratch();
  fakeCheckout(parent, 'manul-browser');
  withSource(join(parent, 'nothing-here'), () => assert.equal(findCheckout(appRoot), null));
});

test('finds the built binding entry point', () => {
  const { parent, appRoot } = scratch();
  const checkout = fakeCheckout(parent, 'manul-browser', { binding: true });
  withSource(undefined, () =>
    assert.equal(findBindingEntry(appRoot), join(checkout, 'bindings', 'node', 'dist', 'index.js')),
  );
});

test('an unbuilt binding is reported as absent, not as a broken path', () => {
  const { parent, appRoot } = scratch();
  fakeCheckout(parent, 'manul-browser');
  withSource(undefined, () => assert.equal(findBindingEntry(appRoot), null));
});

test('describeSearch names what was actually tried', () => {
  withSource(undefined, () => {
    const description = describeSearch();
    for (const name of CANDIDATE_DIRS) assert.match(description, new RegExp(name));
  });
  withSource('/tmp/custom', () => assert.match(describeSearch(), /MANUL_SOURCE=\/tmp\/custom/));
});
