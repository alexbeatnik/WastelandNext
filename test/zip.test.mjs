/**
 * Reading a downloaded archive's entry names before unpacking it.
 *
 * `tar`, `unzip` and `Expand-Archive` all write wherever the entry names tell
 * them to, and the archive comes off the network — so the names are checked
 * first, and the binary we spawn afterwards is one that came out of a folder
 * nothing else could reach into.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeArchive, unsafeEntry, zipEntryNames } from '../src/main/llm/zip.mjs';

const dir = mkdtempSync(join(tmpdir(), 'wl-zip-'));

/**
 * Build a zip with stored (uncompressed) entries.
 *
 * Small enough to keep here, and it means the parser is tested against bytes
 * rather than against a mock of itself. CRCs are left at zero: nothing here
 * extracts anything, and the central directory is what is being read.
 */
function buildZip(names) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const raw = Buffer.from(name, 'utf8');
    const body = Buffer.from(`contents of ${name}`, 'utf8');

    const local = Buffer.alloc(30 + raw.length + body.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(body.length, 22); // uncompressed size
    local.writeUInt16LE(raw.length, 26);
    raw.copy(local, 30);
    body.copy(local, 30 + raw.length);
    locals.push(local);

    const entry = Buffer.alloc(46 + raw.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(raw.length, 28);
    entry.writeUInt32LE(offset, 42);
    raw.copy(entry, 46);
    central.push(entry);

    offset += local.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

function writeZip(name, entries) {
  const path = join(dir, name);
  writeFileSync(path, buildZip(entries));
  return path;
}

test('an ordinary entry name is not an escape', () => {
  for (const name of ['llama-server.exe', 'build/bin/llama-server', 'a..b/x', 'dir/..name']) {
    assert.equal(unsafeEntry(name), false, `${name} should be allowed`);
  }
});

test('refuses every shape of path that leaves the target directory', () => {
  for (const name of [
    '../evil.dll',
    'build/../../evil.dll',
    '..\\..\\Windows\\System32\\evil.dll',
    '/etc/cron.d/evil',
    '\\evil.dll',
    'C:\\Windows\\System32\\evil.dll',
  ]) {
    assert.equal(unsafeEntry(name), true, `${name} should be refused`);
  }
});

test('reads the names out of a real archive without unpacking it', async () => {
  const path = writeZip('good.zip', ['build/bin/llama-server.exe', 'build/bin/ggml.dll', 'LICENSE']);
  assert.deepEqual(await zipEntryNames(path), [
    'build/bin/llama-server.exe',
    'build/bin/ggml.dll',
    'LICENSE',
  ]);
  assert.ok(await assertSafeArchive(path));
});

test('a traversing entry stops the unpack and is named in the error', async () => {
  const path = writeZip('evil.zip', ['build/bin/llama-server.exe', '..\\..\\startup\\evil.exe']);
  await assert.rejects(assertSafeArchive(path), /startup/);
});

test('an archive whose directory cannot be read is refused, not unpacked anyway', async () => {
  // Half a download, a substituted body, an HTML error page saved as a zip: all
  // arrive as bytes that are not an archive, and "could not check" must not
  // become "unpack it and see".
  const path = join(dir, 'truncated.zip');
  writeFileSync(path, buildZip(['a.txt']).subarray(0, 12));
  await assert.rejects(assertSafeArchive(path), /could not check/);
});
