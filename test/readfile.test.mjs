/**
 * The read path is the only place the model can name a file, so the tests are
 * mostly about what it must refuse to name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { MAX_READ_BYTES, readForModel, resolveReadablePath } from '../src/main/agent/readfile.mjs';

const home = mkdtempSync(join(tmpdir(), 'wl-home-'));

test('accepts an absolute path inside home', () => {
  const target = join(home, 'notes.txt');
  assert.deepEqual(resolveReadablePath(target, home), { ok: true, path: target });
});

test('takes a bare relative path as relative to home', () => {
  const result = resolveReadablePath('project/main.c', home);
  assert.equal(result.ok, true);
  assert.equal(result.path, join(home, 'project', 'main.c'));
});

test('expands a leading tilde', () => {
  const result = resolveReadablePath('~/notes.txt', home);
  assert.equal(result.path, join(home, 'notes.txt'));
});

test('strips quotes a model wrapped the path in', () => {
  assert.equal(resolveReadablePath(`"${join(home, 'a.txt')}"`, home).path, join(home, 'a.txt'));
});

test('refuses a path that climbs out of home', () => {
  const result = resolveReadablePath(`..${sep}..${sep}etc${sep}passwd`, home);
  assert.equal(result.ok, false);
  assert.match(result.reason, /outside/);
});

test('refuses an absolute path elsewhere on the disk', () => {
  const elsewhere = process.platform === 'win32' ? 'C:\\Windows\\System32\\config' : '/etc/shadow';
  assert.equal(resolveReadablePath(elsewhere, home).ok, false);
});

test('refuses credential stores even though they are inside home', () => {
  for (const dir of ['.ssh/id_rsa', '.aws/credentials', '.gnupg/secring.gpg']) {
    const result = resolveReadablePath(dir, home);
    assert.equal(result.ok, false, `${dir} should be refused`);
    assert.match(result.reason, /credential/);
  }
});

test('refuses an empty path', () => {
  assert.equal(resolveReadablePath('   ', home).ok, false);
});

test('reads a file back for the model', async () => {
  writeFileSync(join(home, 'hello.txt'), 'Привіт, світе\n', 'utf8');
  const result = await readForModel('hello.txt', home);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'Привіт, світе\n');
  assert.equal(result.truncated, false);
});

test('truncates a file that would swamp the context', async () => {
  writeFileSync(join(home, 'big.log'), 'x'.repeat(MAX_READ_BYTES * 2), 'utf8');
  const result = await readForModel('big.log', home);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.match(result.content, /truncated at/);
});

test('reports a directory as such rather than reading it', async () => {
  mkdirSync(join(home, 'somedir'), { recursive: true });
  const result = await readForModel('somedir', home);
  assert.equal(result.ok, false);
  assert.match(result.reason, /directory/);
});

test('reports a missing file plainly', async () => {
  const result = await readForModel('nope.txt', home);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no such file/);
});
