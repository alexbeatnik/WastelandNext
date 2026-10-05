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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, shellCommandFor } from '../src/plugins/system-shell.mjs';

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

test('the runner the plugin uses reads the same names the wrapped command prints', onWindows, async () => {
  // Everything above drives `exec` by hand, to compare the wrapped command with
  // the bare one. The plugin itself goes through `runCommand`, which spawns the
  // shell differently — so the reported case is asked of that as well, or the
  // two could part company with every test here still passing.
  const dir = folderWithCyrillicFile();
  if (!original) return;

  await raw(dir, 'chcp 437>nul');
  const listed = await runCommand(`dir /b "${dir}"`);
  assert.equal(listed.ok, true, listed.text);
  assert.match(listed.text, /привіт-файл\.txt/);
});

/* ============================ stopping one ============================ */

/**
 * A command that never finishes, and a file that says whether it is alive.
 *
 * Written to disk rather than passed as `node -e "…"`: the point is what
 * happens to the process, and a second layer of quoting through two `cmd`s
 * would be testing something else.
 */
function heartbeat() {
  const dir = mkdtempSync(join(tmpdir(), 'wl-shell-stop-'));
  const script = join(dir, 'beat.cjs');
  const pulse = join(dir, 'pulse.txt');
  writeFileSync(
    script,
    // The write is allowed to fail: the test reads this file while it is being
    // written, and a sharing violation must cost one beat, not the process —
    // a heartbeat that died of its own accord would look like a command that
    // finished by itself.
    "const fs = require('fs'); let n = 0; setInterval(() => { try { fs.writeFileSync(process.argv[2], String(n += 1)); } catch {} }, 50);",

  );
  const read = () => {
    try {
      return readFileSync(pulse, 'utf8');
    } catch {
      return '';
    }
  };
  return { command: `"${process.execPath}" "${script}" "${pulse}"`, read };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the heartbeat has written at least once, so there is something to stop. */
async function beating(read) {
  // Read once per look, and judged on that reading. Asking the file a second
  // time to assert on it lands, now and then, in the instant between the
  // heartbeat truncating it and writing the next number — and reports a command
  // that is plainly running as one that never started.
  let seen = '';
  for (let i = 0; i < 100 && !seen; i += 1) {
    seen = read();
    if (!seen) await wait(50);
  }
  assert.ok(seen, 'the command never started');
}

/** Has the heartbeat stopped changing? */
async function still(read) {
  await wait(400);
  const before = read();
  await wait(400);
  return read() === before;
}

test('Stop ends the command, and everything the command started', async () => {
  // Stop did nothing to a running command: the turn sat on "Running…" for the
  // two minutes the timeout allows. And ending only the shell is not ending the
  // command — on Windows it is two `cmd`s deep, and killing the outer one left
  // the thing the user asked to stop running with nothing on screen to say so.
  const { command, read } = heartbeat();
  const controller = new AbortController();

  const started = Date.now();
  const pending = runCommand(command, { signal: controller.signal });
  await beating(read);
  controller.abort();
  const result = await pending;

  assert.equal(result.ended, 'stopped', result.text);
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 20_000, 'the turn was held until the command gave up on its own');
  assert.equal(await still(read), true, 'the command outlived the Stop that ended its turn');
});

test('a command that outstays the timeout is ended the same way', async () => {
  const { command, read } = heartbeat();
  const result = await runCommand(command, { timeoutMs: 1500 });

  assert.equal(result.ended, 'timeout', result.text);
  assert.equal(result.ok, false);
  assert.match(result.text, /did not finish/);
  assert.equal(await still(read), true, 'the timeout ended the wait, not the command');
});

test('a command that finishes by itself is reported as it always was', async () => {
  const done = await runCommand(`"${process.execPath}" -e "console.log('fine')"`);
  assert.deepEqual(done, { ok: true, ended: '', text: 'fine' });

  const failed = await runCommand(`"${process.execPath}" -e "process.exit(3)"`);
  assert.equal(failed.ok, false);
  assert.equal(failed.ended, '');
});

test('a turn already stopped does not start the command at all', async () => {
  const { command, read } = heartbeat();
  const controller = new AbortController();
  controller.abort();

  const result = await runCommand(command, { signal: controller.signal });
  assert.equal(result.ended, 'stopped');
  await wait(300);
  assert.equal(read(), '', 'a command was started for a turn that had been stopped');
});
