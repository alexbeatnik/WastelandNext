/**
 * Choosing which llama.cpp release asset to fetch.
 *
 * A release carries a dozen archives for different backends and platforms.
 * Picking the wrong one downloads hundreds of megabytes that will not run, and
 * the failure surfaces much later as a spawn error.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetPatterns, pickAsset, psQuote } from '../src/main/llm/tools.mjs';

/** A realistic slice of one release's asset list. */
const ASSETS = [
  'llama-b10068-bin-win-cpu-x64.zip',
  'llama-b10068-bin-win-vulkan-x64.zip',
  'llama-b10068-bin-win-cuda-12.4-x64.zip',
  'llama-b10068-bin-win-arm64.zip',
  'llama-b10068-bin-ubuntu-x64.zip',
  'llama-b10068-bin-ubuntu-vulkan-x64.zip',
  'llama-b10068-bin-macos-arm64.zip',
  'llama-b10068-bin-macos-x64.zip',
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'llama-b10068.tar.gz',
];

test('picks an asset that exists for this platform', () => {
  const picked = pickAsset(ASSETS);
  assert.ok(picked, 'expected some asset to match');
  assert.ok(ASSETS.includes(picked));
  assert.match(picked, /\.zip$/);
});

test('the first pattern wins over later ones', () => {
  // Whatever this platform prefers, it must be the highest-priority pattern
  // that matches — not merely any match.
  const [preferred] = assetPatterns();
  const expected = ASSETS.find((name) => preferred.test(name));
  if (expected) assert.equal(pickAsset(ASSETS), expected);
});

test('falls through to the next pattern when the preferred build is absent', () => {
  const [preferred] = assetPatterns();
  const without = ASSETS.filter((name) => !preferred.test(name));
  const picked = pickAsset(without);
  // Windows and Linux both have a documented fallback; macOS has one arch-
  // specific asset and correctly returns null once it is gone.
  if (assetPatterns().length > 1) assert.ok(picked, 'expected a fallback asset');
  assert.ok(picked === null || without.includes(picked));
});

test('returns null rather than guessing when nothing matches', () => {
  assert.equal(pickAsset(['README.md', 'llama-b10068.tar.gz']), null);
  assert.equal(pickAsset([]), null);
});

test('never picks the CUDA runtime archive, which holds no server', () => {
  assert.notEqual(pickAsset(ASSETS), 'cudart-llama-bin-win-cuda-12.4-x64.zip');
});

test('every pattern is anchored to a zip extension', () => {
  for (const pattern of assetPatterns()) {
    assert.match(pattern.source, /\\\.zip\$$/, `${pattern} should end at .zip`);
  }
});

test('psQuote doubles an apostrophe so a path cannot close the string early', () => {
  // A real Windows home directory belonging to someone with an apostrophe in
  // their name. Backslashes are escaped here; the value is C:\Users\O'Connor\…
  assert.equal(psQuote("C:\\Users\\O'Connor\\file.zip"), "'C:\\Users\\O''Connor\\file.zip'");
});

test('psQuote leaves an ordinary path alone but still quotes it', () => {
  assert.equal(psQuote('C:\\Users\\alex\\a b.zip'), "'C:\\Users\\alex\\a b.zip'");
});

test('a quoted path contains no unescaped apostrophe to break out on', () => {
  const quoted = psQuote("C:\\O'Brien\\x.zip");
  assert.equal(quoted.startsWith("'") && quoted.endsWith("'"), true);
  // Every apostrophe in the body must be part of a doubled pair.
  assert.equal(/(^|[^'])'([^']|$)/.test(quoted.slice(1, -1)), false);
});

test('psQuote handles several apostrophes and an empty value', () => {
  assert.equal(psQuote("a'b'c"), "'a''b''c'");
  assert.equal(psQuote(''), "''");
});
