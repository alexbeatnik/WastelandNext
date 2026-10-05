/**
 * One load at a time.
 *
 * `#state` cannot answer "is a load running": it only becomes `starting` after
 * the binary probe and the port check, several awaits in, and two clicks inside
 * that window both read `idle` and both went on to spawn a server. The second
 * one loses the port to the first and reports a failure over the top of a load
 * that was working.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlamaServer } from '../src/main/llm/server.mjs';

/** A path that certainly does not exist, so no load ever reaches a spawn. */
const MISSING = `${process.cwd()}/no-such-model.gguf`;
const OTHER = `${process.cwd()}/another-model.gguf`;

test('a second load for a different model is refused while one is in flight', async () => {
  const server = new LlamaServer();
  // Both calls happen before any microtask runs — which is the point: the guard
  // has to be set synchronously, or there is a window with nothing holding it.
  const first = server.load(MISSING);
  const second = server.load(OTHER);

  await assert.rejects(second, /already loading/);
  await assert.rejects(first, /model not found/);
});

test('asking twice for the same model joins the load already running', async () => {
  const server = new LlamaServer();
  const first = server.load(MISSING);
  const again = server.load(MISSING);

  assert.equal(again, first, 'a double click should not start a second load');
  await assert.rejects(first, /model not found/);
});

test('the guard is released when a load fails, not held for the session', async () => {
  const server = new LlamaServer();
  await assert.rejects(server.load(MISSING), /model not found/);
  // If the failure left the guard up, this would be refused as "already
  // loading" and the vault would be dead until a restart.
  await assert.rejects(server.load(OTHER), /model not found/);
});

/*
 * Pressing UNLOAD during a load.
 *
 * The pre-spawn half of a load is several awaits long — the binary fetch, the
 * `--version` probe, the port check, the header read — and there is no process
 * in it yet. An unload arriving there stopped nothing, reported `idle`, and the
 * load then spawned a server anyway: the user asked for no model and got one.
 *
 * Reaching that window without a real llama-server means pointing the binary
 * setting at something that exists and answers `--version`, which `node` does.
 * The load is cancelled before the port check, so no server is ever spawned.
 */
test('an unload during a load stops it instead of being outlived by it', async () => {
  const { setDataRoot } = await import('../src/main/paths.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const config = await import('../src/main/config.mjs');

  setDataRoot(mkdtempSync(join(tmpdir(), 'wl-unload-')));
  config.update({ llamaServerPath: process.execPath });

  const model = join(mkdtempSync(join(tmpdir(), 'wl-model-')), 'fake.gguf');
  writeFileSync(model, 'not really a gguf — the load never gets as far as reading it');

  const server = new LlamaServer();
  const loading = server.load(model);
  await server.unload();

  await assert.rejects(loading, /cancelled/);
  // The point of the whole thing: nothing came up behind the refusal.
  assert.equal(server.state, 'idle');
});
