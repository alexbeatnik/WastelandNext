/**
 * Checking the llama-server binary before a model load.
 *
 * The failure this exists for printed nothing at all and died with a Windows
 * crash status, so the app had a number and no reason. Asking `--version` first
 * turns that into a sentence before the user has been told a model is loading.
 * `failure.test.mjs` covers what each status means; this covers the asking.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeServerBinary } from '../src/main/llm/server.mjs';

test('a binary that runs passes', async () => {
  // Node is the one executable certain to be here, and it answers --version.
  const probe = await probeServerBinary(process.execPath);
  assert.equal(probe.ok, true);
});

test('a binary that is not there is named, not blamed on the model', async () => {
  const probe = await probeServerBinary('definitely-not-a-real-llama-server');
  assert.equal(probe.ok, false);
  assert.match(probe.detail, /not found/);
});

test('a binary that will not answer gives up instead of hanging the window', async () => {
  // The deadline is set below the time any process takes to start, so the timer
  // is what resolves this — which is the path being tested. A binary that
  // neither answers nor exits (the wrong exe picked in SETTINGS is enough) has
  // to end somewhere, and it must not end in a crash message: nothing crashed.
  const started = Date.now();
  const probe = await probeServerBinary(process.execPath, { timeoutMs: 1 });
  assert.equal(probe.ok, false);
  assert.match(probe.detail, /did not answer/);
  assert.doesNotMatch(probe.detail, /crash/);
  assert.ok(Date.now() - started < 5000, 'the probe outlived its own deadline');
});
