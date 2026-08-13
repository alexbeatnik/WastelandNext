/**
 * Where a packaged app finds manul-browser.
 *
 * This resolution only ever runs inside a build, which is exactly why it is
 * worth pinning here: a mistake in it is invisible from source and shows up as
 * "browser control silently missing" in a shipped .exe.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledBinaryPath, engineAvailable } from '../src/main/browser/manul-browser.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = process.platform === 'win32' ? 'manul.exe' : 'manul';

/** Run `fn` with `process.resourcesPath` set as a packaged app would have it. */
function withResourcesPath(value, fn) {
  const had = Object.hasOwn(process, 'resourcesPath');
  const previous = process.resourcesPath;
  process.resourcesPath = value;
  try {
    return fn();
  } finally {
    if (had) process.resourcesPath = previous;
    else delete process.resourcesPath;
  }
}

/** Run `fn` with MANUL_BINARY set (or cleared), then restore. */
function withBinaryEnv(value, fn) {
  const previous = process.env['MANUL_BINARY'];
  if (value === undefined) delete process.env['MANUL_BINARY'];
  else process.env['MANUL_BINARY'] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['MANUL_BINARY'];
    else process.env['MANUL_BINARY'] = previous;
  }
}

/** A fake packaged `resources/` directory holding a staged engine. */
function packagedResources() {
  const root = mkdtempSync(join(tmpdir(), 'wl-packaged-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', BINARY), 'not a real engine');
  return root;
}

test('a packaged app takes the engine from its own resources', () => {
  const resources = packagedResources();
  withBinaryEnv(undefined, () =>
    withResourcesPath(resources, () => {
      assert.equal(bundledBinaryPath(), join(resources, 'bin', BINARY));
      assert.equal(engineAvailable(), true);
    }),
  );
});

test('running from source ignores Electron own resources directory', () => {
  // In development `process.resourcesPath` points into Electron's dist, which
  // holds no engine — the repository copy has to win.
  const empty = mkdtempSync(join(tmpdir(), 'wl-electron-dist-'));
  withBinaryEnv(undefined, () =>
    withResourcesPath(empty, () => {
      assert.equal(bundledBinaryPath(), join(repoRoot, 'resources', 'bin', BINARY));
    }),
  );
});

test('with no resourcesPath at all it falls back to the repository path', () => {
  // Plain Node — and the main process before Electron sets the property.
  withBinaryEnv(undefined, () =>
    withResourcesPath(undefined, () => {
      assert.equal(bundledBinaryPath(), join(repoRoot, 'resources', 'bin', BINARY));
    }),
  );
});

test('MANUL_BINARY reports the engine as available whatever is staged', () => {
  const empty = mkdtempSync(join(tmpdir(), 'wl-env-only-'));
  withBinaryEnv('/somewhere/of/my/own/manul', () =>
    withResourcesPath(empty, () => assert.equal(engineAvailable(), true)),
  );
});
