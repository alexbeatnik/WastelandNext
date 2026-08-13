/**
 * Models kept outside the vault.
 *
 * The rule that matters: a file the user pointed us at is a reference, never a
 * copy and never ours to delete. These tests hold that line.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-external-')));

const config = await import('../src/main/config.mjs');
const { addExternal, forgetExternal, listLocal, remove } = await import('../src/main/models/manager.mjs');
const { modelsDir } = await import('../src/main/paths.mjs');

/** A file that starts with the GGUF magic, which is all `addExternal` checks. */
function fakeModel(dir, name, { magic = true, bytes = 2048 } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const body = Buffer.alloc(bytes);
  body.write(magic ? 'GGUF' : 'JUNK', 0, 'ascii');
  writeFileSync(path, body);
  return path;
}

const elsewhere = mkdtempSync(join(tmpdir(), 'wl-elsewhere-'));

test('adds a model from anywhere on disk without copying it', async () => {
  const path = fakeModel(elsewhere, 'faraway-Q4_K_M.gguf');
  const result = await addExternal(path);

  assert.equal(result.added, true);
  assert.deepEqual(config.get('externalModels'), [path]);
  // The point of the feature: the original stays put and nothing lands in the
  // vault directory.
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(join(modelsDir(), 'faraway-Q4_K_M.gguf')), false);
});

test('the added model appears in the list, flagged as external', async () => {
  const models = await listLocal();
  const entry = models.find((m) => m.name === 'faraway-Q4_K_M.gguf');
  assert.ok(entry, 'expected the external model to be listed');
  assert.equal(entry.external, true);
  assert.equal(entry.missing, false);
  assert.equal(entry.size, 2048);
  assert.match(entry.path, /faraway-Q4_K_M\.gguf$/);
});

test('adding the same file twice does not duplicate the row', async () => {
  const path = join(elsewhere, 'faraway-Q4_K_M.gguf');
  const again = await addExternal(path);
  assert.equal(again.added, false);
  assert.match(again.reason, /already added/);
  assert.equal(config.get('externalModels').length, 1);
});

test('a file that is not GGUF is refused at the moment of choosing', async () => {
  const path = fakeModel(elsewhere, 'notamodel.gguf', { magic: false });
  await assert.rejects(() => addExternal(path), /not a GGUF model/);
  assert.equal(config.get('externalModels').length, 1);
});

test('a path that does not exist is refused', async () => {
  await assert.rejects(() => addExternal(join(elsewhere, 'ghost.gguf')), /no such file/);
});

test('a directory is refused', async () => {
  await assert.rejects(() => addExternal(elsewhere), /not a file/);
});

test('an empty path is refused', async () => {
  await assert.rejects(() => addExternal('   '), /no file given/);
});

test('a file already inside the vault is not registered a second time', async () => {
  const path = fakeModel(modelsDir(), 'invault-Q4_K_M.gguf');
  const result = await addExternal(path);
  assert.equal(result.added, false);
  assert.match(result.reason, /already in the vault/);

  // It is still listed — just as a vault model, found by the directory scan.
  const models = await listLocal();
  const entry = models.find((m) => m.name === 'invault-Q4_K_M.gguf');
  assert.equal(entry.external, false);
});

test('vault and external models are listed together, sorted by name', async () => {
  const names = (await listLocal()).map((m) => m.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.ok(names.includes('faraway-Q4_K_M.gguf'));
  assert.ok(names.includes('invault-Q4_K_M.gguf'));
});

test('a vanished external file is listed as missing, not dropped', async () => {
  const path = fakeModel(elsewhere, 'ondrive-Q4_K_M.gguf');
  await addExternal(path);
  await remove('ondrive-Q4_K_M.gguf'); // deletes from the vault, not from `elsewhere`
  assert.equal(existsSync(path), true, 'remove() must not touch a file outside the vault');

  const { rmSync } = await import('node:fs');
  rmSync(path);

  const entry = (await listLocal()).find((m) => m.name === 'ondrive-Q4_K_M.gguf');
  assert.ok(entry, 'a registered model must stay listed when its drive is gone');
  assert.equal(entry.missing, true);
  assert.equal(entry.size, 0);
});

test('forgetting an external model leaves the file alone', async () => {
  const path = fakeModel(elsewhere, 'keepme-Q4_K_M.gguf');
  await addExternal(path);

  forgetExternal(path);

  assert.equal(existsSync(path), true, 'forget must never delete the user\'s file');
  assert.equal(
    (await listLocal()).some((m) => m.path === path),
    false,
  );
});

test('forgetting something never registered is harmless', () => {
  const before = config.get('externalModels').length;
  forgetExternal(join(elsewhere, 'never-added.gguf'));
  assert.equal(config.get('externalModels').length, before);
});
