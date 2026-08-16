/**
 * The headings the plugin list is drawn under.
 *
 * Pure data and one grouping function, shared by both processes — which is the
 * point of testing it on its own: the main process decides what a manifest is
 * allowed to claim, the renderer decides what the heading says, and the two
 * disagreeing would put a plugin under a heading that does not exist.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORIES, DEFAULT_CATEGORY, categoryLabel, groupByCategory, normaliseCategory } from '../src/shared/categories.mjs';
import { parseManifest } from '../src/main/plugins/manifest.mjs';

test('every category has an id and a label, and no id appears twice', () => {
  const ids = CATEGORIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of CATEGORIES) {
    assert.match(entry.id, /^[a-z]+$/);
    assert.ok(entry.label.length > 0);
  }
  assert.ok(ids.includes(DEFAULT_CATEGORY));
});

test('an unknown category is folded into "other" rather than refused', () => {
  // Deliberately the opposite of what `setSetting` does with a `select` value.
  // A setting is a control the plugin has code for; a category is a word above
  // its row, and refusing to load a working plugin over that word is absurd.
  assert.equal(normaliseCategory('spaceships'), 'other');
  assert.equal(normaliseCategory(''), 'other');
  assert.equal(normaliseCategory(undefined), 'other');
  assert.equal(normaliseCategory('  GAMES  '), 'games');
});

test('a manifest naming a category this build has never heard of still loads', () => {
  const parsed = parseManifest({ id: 'x', apiVersion: 1, main: 'main.mjs', category: 'from-the-future' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.category, 'other');
});

test('a manifest that says nothing gets the default', () => {
  const parsed = parseManifest({ id: 'x', apiVersion: 1, main: 'main.mjs' });
  assert.equal(parsed.manifest.category, DEFAULT_CATEGORY);
});

test('a category a manifest does name is kept', () => {
  const parsed = parseManifest({ id: 'x', apiVersion: 1, main: 'main.mjs', category: 'games' });
  assert.equal(parsed.manifest.category, 'games');
  assert.equal(categoryLabel(parsed.manifest.category), 'GAMES');
});

test('grouping leaves out a heading with nothing under it', () => {
  // An empty section is a promise of plugins that are not there, and on the
  // narrow layout it costs a whole line to say nothing.
  const groups = groupByCategory([{ id: 'a', category: 'games' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'games');
  assert.deepEqual(groups[0].rows.map((row) => row.id), ['a']);
});

test('sections come in the declared order, not the order rows arrived in', () => {
  const groups = groupByCategory([
    { id: 'theme', category: 'appearance' },
    { id: 'game', category: 'games' },
    { id: 'browser', category: 'capability' },
  ]);
  assert.deepEqual(groups.map((group) => group.id), ['capability', 'games', 'appearance']);
});

test('the order the host sorted rows into survives inside a section', () => {
  // The host sorts built-ins first, then by the order a plugin asked for. That
  // ordering is the reason a capability list reads sensibly, and grouping must
  // not shuffle it.
  const groups = groupByCategory([
    { id: 'browser-control', category: 'capability' },
    { id: 'web-lookup', category: 'capability' },
    { id: 'read-file', category: 'capability' },
  ]);
  assert.deepEqual(groups[0].rows.map((row) => row.id), ['browser-control', 'web-lookup', 'read-file']);
});

test('a row with no category at all is still drawn somewhere', () => {
  // `#broken` in the host builds an entry for a plugin that could not be
  // understood, and a row that vanishes because it has no category is worse
  // than one under the wrong heading.
  const groups = groupByCategory([{ id: 'broken' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'other');
});

test('every built-in files itself under a category this build knows', async () => {
  const { BUILTIN_PLUGINS } = await import('../src/plugins/index.mjs');
  for (const builtin of BUILTIN_PLUGINS) {
    const parsed = parseManifest(builtin.manifest, { builtin: true });
    assert.equal(parsed.ok, true, builtin.manifest.id);
    // Not `other`: the four capabilities are what the section is mostly for,
    // and a built-in landing in the catch-all means a manifest was missed.
    assert.notEqual(parsed.manifest.category, DEFAULT_CATEGORY, `${builtin.manifest.id} has no category`);
  }
});
