/**
 * What the shell plugin actually hands to the shell.
 *
 * The command the user approved must survive untouched; the only thing added is
 * what makes its output readable on Windows, and the round trip below is the
 * reported case rather than an abstraction of it — a folder holding a file with
 * a Cyrillic name, listed with `dir`.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { exec } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellCommandFor } from '../src/plugins/system-shell.mjs';

/** Run a command as `exec` would, with no wrapping at all. */
function raw(dir, command) {
  return new Promise((resolve) => {
    exec(command, { cwd: dir, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: String(stdout).trim(), err: String(stderr).trim() });
    });
  });
}

/** Run a command the way the plugin runs it. */
const runIn = (dir, command) => raw(dir, shellCommandFor(command, 'win32'));

/** The console's output code page, or 0 where there is no console to ask. */
async function codePage() {
  const { out } = await raw(tmpdir(), 'chcp');
  const digits = out.match(/(\d+)\s*$/);
  return digits ? Number(digits[1]) : 0;
}

/** A directory holding one file whose name needs more than ASCII. */
function folderWithCyrillicFile() {
  const dir = mkdtempSync(join(tmpdir(), 'wl-shell-'));
  writeFileSync(join(dir, 'привіт-файл.txt'), 'x');
  return dir;
}

const onWindows = { skip: process.platform !== 'win32' };
const original = process.platform === 'win32' ? await codePage() : 0;

// These tests change the code page of the console they share with whoever ran
// them, which is the developer's terminal during `npm test`.
after(async () => {
  if (original) await raw(tmpdir(), `chcp ${original}>nul`);
});

test('a command is handed to a POSIX shell exactly as approved', () => {
  assert.equal(shellCommandFor('ls -la', 'darwin'), 'ls -la');
  assert.equal(shellCommandFor('ls -la', 'linux'), 'ls -la');
});

test('on Windows the code page is set in a shell of its own', () => {
  // Not `chcp 65001>nul & dir /b`: an instance caches the code page at startup,
  // so the change lands on the console and that same instance still writes the
  // old one. Only a process started afterwards reads the new page.
  const line = shellCommandFor('dir /b', 'win32');
  assert.match(line, /^chcp 65001>nul & cmd \/d \/s \/c "/);
  assert.ok(line.endsWith('"dir /b"'));
});

test('cmd keeps a Cyrillic filename instead of replacing it with ?', onWindows, async () => {
  const dir = folderWithCyrillicFile();
  if (!original) return; // no console, so no code page to be wrong about

  // The console is shared with whatever ran before this, so it is put back to a
  // legacy page each time: a run that happened to leave it at 65001 would let
  // the unwrapped command pass too, and a check the bug also passes is no check.
  await raw(dir, 'chcp 437>nul');
  const control = await raw(dir, 'dir /b');
  assert.doesNotMatch(control.out, /привіт-файл\.txt/);

  await raw(dir, 'chcp 437>nul');
  const wrapped = await runIn(dir, 'dir /b');
  assert.match(wrapped.out, /привіт-файл\.txt/);
});

test('the approved command still decides the exit code', onWindows, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wl-shell-'));
  assert.equal((await runIn(dir, 'exit 3')).code, 3);
  assert.equal((await runIn(dir, 'exit 0')).code, 0);
});

test('the shell syntax the model writes still means what it says', onWindows, async () => {
  // `&`, `|` and quotes sit inside the nested quotes, where cmd leaves them for
  // the shell that is meant to read them.
  const dir = folderWithCyrillicFile();
  assert.equal((await runIn(dir, 'echo "hi there"')).out, '"hi there"');
  assert.match((await runIn(dir, 'echo a & echo b')).out, /^a\s*\r?\nb$/);
  assert.equal((await runIn(dir, 'dir /b | findstr txt')).out, 'привіт-файл.txt');
});
