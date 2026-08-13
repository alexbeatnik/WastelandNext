/**
 * The read path is the only place the model can name a file, so the tests are
 * mostly about what it must refuse to name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { MAX_READ_BYTES, readForModel, resolveReadablePath } from '../src/main/agent/readfile.mjs';

const home = mkdtempSync(join(tmpdir(), 'wl-home-'));

/**
 * Make a symlink, or say it could not be made.
 *
 * Windows refuses file symlinks to an unprivileged process unless Developer
 * Mode is on, so these tests skip rather than fail there — the check they cover
 * still runs on CI and on every other platform.
 */
function linkOrSkip(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

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

test('a link into a credential directory is refused, name notwithstanding', async (t) => {
  // The path check reads text; `readFile` follows links. `notes.txt` sitting in
  // home and pointing at `~/.ssh/id_rsa` satisfies every rule about the name and
  // then hands over the key, so what is vetted is where the path lands.
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY', 'utf8');
  if (!linkOrSkip(join(home, '.ssh', 'id_rsa'), join(home, 'notes.txt'), 'file')) {
    return t.skip('this platform will not let an unprivileged process make a symlink');
  }

  const result = await readForModel('notes.txt', home);
  assert.equal(result.ok, false);
  assert.match(result.reason, /credential/);
  assert.match(result.reason, /link/);
});

test('a link to a credential directory is refused through the link name', async (t) => {
  // A directory link, which is the one shape Windows lets an unprivileged
  // process create — so this is the version of the check that actually runs
  // there, where the app runs.
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY', 'utf8');
  if (!linkOrSkip(join(home, '.ssh'), join(home, 'keys'), 'junction')) {
    return t.skip('this platform will not let an unprivileged process make a link');
  }

  const result = await readForModel(join('keys', 'id_rsa'), home);
  assert.equal(result.ok, false);
  assert.match(result.reason, /credential/);
});

test('a link out of the home directory is refused too', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'wl-elsewhere-'));
  writeFileSync(join(outside, 'secret.env'), 'TOKEN=1', 'utf8');
  if (!linkOrSkip(join(outside, 'secret.env'), join(home, 'innocent.env'), 'file')) {
    return t.skip('this platform will not let an unprivileged process make a symlink');
  }

  const result = await readForModel('innocent.env', home);
  assert.equal(result.ok, false);
  assert.match(result.reason, /outside/);
});

test('a link that stays inside home is still readable', async (t) => {
  // The check refuses where a link *lands*, not the fact of it being one: a
  // project symlinked into home is ordinary, and refusing it would break a
  // working setup to fix nothing.
  mkdirSync(join(home, 'project'), { recursive: true });
  writeFileSync(join(home, 'project', 'main.c'), 'int main(void) { return 0; }\n', 'utf8');
  if (!linkOrSkip(join(home, 'project', 'main.c'), join(home, 'shortcut.c'), 'file')) {
    return t.skip('this platform will not let an unprivileged process make a symlink');
  }

  const result = await readForModel('shortcut.c', home);
  assert.equal(result.ok, true);
  assert.match(result.content, /int main/);
});
