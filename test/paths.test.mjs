/**
 * Where everything on disk lives.
 *
 * The module is forty lines of `join` and reads as though there is nothing in
 * it to get wrong — and three of the traps this codebase records happened
 * inside exactly these forty lines. `toolsDir()` creates one directory and not
 * the one the download writes into; `scratchDir()` is inside the data root
 * rather than in `tmpdir()`, because the last step of an install is a rename
 * onto that root and a rename across volumes fails with `EXDEV`; and a
 * plugin's own files sit outside the installed tree, which every update
 * deletes and rewrites.
 *
 * None of those are visible in a name. They are asserted here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import {
  chatsDir,
  configPath,
  dataRoot,
  ensureDir,
  logsDir,
  modelsDir,
  pluginDataDir,
  pluginStateDir,
  pluginsDir,
  scratchDir,
  setDataRoot,
  toolsDir,
} from '../src/main/paths.mjs';

/** A fresh root per test, so one test's directories cannot answer another's. */
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wl-paths-'));
  setDataRoot(root);
  return root;
}

test('the platform default stands in until a root is injected', () => {
  // Deliberately only `dataRoot()`, never a directory helper: with nothing
  // injected those would create directories in the user's real data root.
  setDataRoot(null);
  const fallback = dataRoot();
  assert.ok(isAbsolute(fallback), 'a relative root would land wherever the app was started from');
  assert.ok(fallback.endsWith('wasteland-next'));

  const root = freshRoot();
  assert.equal(dataRoot(), root, 'main.mjs injects Electron userData, and everything below reads through here');
});

test('a directory is created on first ask, and asking twice is not an error', () => {
  const root = freshRoot();
  const dir = ensureDir('one', 'two', 'three');
  assert.equal(dir, join(root, 'one', 'two', 'three'));
  assert.ok(existsSync(dir), 'nested parents are created too');
  assert.equal(ensureDir('one', 'two', 'three'), dir, 'the second ask is answered, not refused');
});

test('every directory the app keeps is inside the data root', () => {
  const root = freshRoot();
  for (const dir of [modelsDir(), chatsDir(), toolsDir(), logsDir(), pluginsDir(), pluginStateDir(), scratchDir()]) {
    assert.ok(dir.startsWith(root + sep), `${dir} escaped the data root`);
    assert.ok(existsSync(dir));
  }
});

test('toolsDir creates tools/, and nothing inside it', () => {
  // The very first llama-server download failed on opening the write stream,
  // because `tools/llama/` did not exist yet and nothing had said it would.
  // Anything writing in there creates its own directory first.
  const root = freshRoot();
  assert.equal(toolsDir(), join(root, 'tools'));
  assert.ok(existsSync(join(root, 'tools')));
  assert.equal(existsSync(join(root, 'tools', 'llama')), false, 'a subdirectory nobody created must not appear');
});

test('staging happens on the same volume as the data root', () => {
  // The last step of an install is a rename onto the data root. In `tmpdir()`
  // that is a cross-volume rename on any machine whose TEMP is on another
  // drive — `EXDEV`, at the very end, after the download, the checksum and the
  // unpacking have all worked.
  const root = freshRoot();
  assert.equal(dirname(scratchDir()), root);
  assert.equal(parse(scratchDir()).root, parse(dataRoot()).root, 'a rename across volumes is not atomic; it fails');
});

test("a plugin's own files are outside the tree an update replaces", () => {
  const root = freshRoot();
  const installed = pluginsDir();

  // `plugin-state` holds the one JSON document a plugin keeps — a list of
  // reminders nobody declared and nobody typed in. `plugin-data` holds files it
  // fetched, up to a 1.5 GB speech model. Both would be destroyed on every
  // version bump if they lived inside the plugin's directory.
  for (const dir of [pluginStateDir(), pluginDataDir('fantasy-rpg')]) {
    assert.ok(dir.startsWith(root + sep));
    assert.equal(dir.startsWith(installed + sep), false, `${dir} is inside the tree an update deletes`);
  }
});

test('each plugin gets its own data directory, created on first ask', () => {
  freshRoot();
  const rpg = pluginDataDir('fantasy-rpg');
  const music = pluginDataDir('audio-player');
  assert.notEqual(rpg, music);
  assert.ok(existsSync(rpg) && existsSync(music));
  assert.equal(pluginDataDir('fantasy-rpg'), rpg, 'the same plugin is answered with the same directory');
});

test('asking where the settings file is does not create one', () => {
  const root = freshRoot();
  assert.equal(configPath(), join(root, 'config.json'));
  assert.equal(existsSync(configPath()), false, 'an empty config.json reads back as a user with no settings');

  // And it is a file at the top of the root, not a directory below it: the
  // whole point is that it can be opened in an editor and fixed by hand.
  writeFileSync(configPath(), '{"model":"a.gguf"}\n', 'utf8');
  assert.equal(dirname(configPath()), dataRoot());
});
