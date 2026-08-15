/**
 * The plugin registry, at the boundary.
 *
 * Nothing here touches the network: what is worth testing is what the app
 * believes about an index it did not write. Every field in an entry is input,
 * and two of them decide whether code from elsewhere gets downloaded and run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-registry-')));

const { DEFAULT_REGISTRY, cacheBusted, compareVersions, fetchIndex, isNewer, parseEntry, registryUrl } = await import(
  '../src/main/plugins/registry.mjs'
);

const GOOD = {
  id: 'audio-player',
  name: 'Audio player',
  version: '1.0.0',
  apiVersion: 2,
  url: 'https://github.com/a/b/releases/download/plugins/audio-player-1.0.0.zip',
  sha256: 'a'.repeat(64),
};

test('a well-formed entry is normalised', () => {
  const entry = parseEntry({ ...GOOD, description: ' Plays music. ' });
  assert.equal(entry.id, 'audio-player');
  assert.equal(entry.description, 'Plays music.');
  assert.equal(entry.kind, 'code');
  assert.equal(entry.compatible, true);
});

test('an entry that could not be installed is dropped from the list', () => {
  assert.equal(parseEntry({ ...GOOD, id: '../evil' }), null);
  assert.equal(parseEntry({ ...GOOD, id: 'Audio' }), null);
  assert.equal(parseEntry(null), null);
});

test('a download is only ever over TLS', () => {
  // `file:` and `data:` are the interesting refusals: an index is fetched from
  // the network, and a URL scheme is all that stands between "download an
  // archive" and "read something off this machine and unpack it".
  for (const url of ['http://a/b.zip', 'file:///C:/x.zip', 'data:application/zip;base64,AA==', 'ftp://a/b.zip', '']) {
    assert.equal(parseEntry({ ...GOOD, url }), null, url);
  }
});

test('an icon is a data URI or nothing at all', () => {
  // A remote icon would fail the page's CSP anyway, and asking for one turns
  // opening the plugin list into a request that tells somebody who opened it.
  assert.equal(parseEntry({ ...GOOD, icon: 'https://example.com/icon.png' }).icon, '');
  assert.equal(parseEntry({ ...GOOD, icon: 'javascript:alert(1)' }).icon, '');
  assert.match(parseEntry({ ...GOOD, icon: 'data:image/svg+xml;base64,AAA' }).icon, /^data:image\//);
});

test('a plugin from a future API is listed but marked', () => {
  // Listed, because "it exists but this build is too old" is useful; marked,
  // because installing it would produce a plugin that cannot load.
  const entry = parseEntry({ ...GOOD, apiVersion: 99 });
  assert.ok(entry);
  assert.equal(entry.compatible, false);
});

test('a theme is distinguished from code, because only one of them is run', () => {
  assert.equal(parseEntry({ ...GOOD, kind: 'theme' }).kind, 'theme');
  // Anything unrecognised is treated as code — the cautious reading.
  assert.equal(parseEntry({ ...GOOD, kind: 'something-new' }).kind, 'code');
});

test('versions are compared as numbers, not as strings', () => {
  // The whole reason this function exists: `'1.10.0' < '1.9.0'` as strings, and
  // an update button that never appears looks exactly like a registry that
  // never publishes.
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('1.2.0', '1.2'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('a pre-release ranks below the release it leads to', () => {
  assert.ok(compareVersions('1.0.0-rc1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc1') > 0);
  assert.ok(compareVersions('1.0.0-rc2', '1.0.0-rc1') > 0);
});

test('an update is only offered when there is one', () => {
  assert.equal(isNewer('1.1.0', '1.0.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.9.0', '1.0.0'), false);
  // Garbage on either side must not produce a phantom update.
  assert.equal(isNewer('', '1.0.0'), false);
  assert.equal(isNewer(undefined, undefined), false);
});

test('the index is fetched past the CDN, not from it', () => {
  // The published index is served with max-age=300, so a check inside five
  // minutes of a release is answered with the previous one — which is how a
  // freshly published 1.0.1 went unnoticed until the app was restarted.
  const first = cacheBusted('https://raw.githubusercontent.com/a/b/main/index.json');
  assert.match(first, /[?&]_=/);
  assert.ok(first.startsWith('https://raw.githubusercontent.com/a/b/main/index.json?'));

  // A registry URL that already carries a query keeps it.
  const withQuery = cacheBusted('https://example.test/index.json?token=abc');
  assert.match(withQuery, /token=abc/);
  assert.match(withQuery, /[?&]_=/);

  // Nonsense is passed through rather than thrown on: the fetch that follows
  // produces a better message than a URL parser would.
  assert.equal(cacheBusted('not a url'), 'not a url');
});

test('fetchIndex asks for a fresh copy and reports the clean URL', async () => {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    asked.push({ url: String(url), headers: options?.headers ?? {} });
    return new Response(JSON.stringify({ plugins: [GOOD] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const index = await fetchIndex();
    assert.match(asked[0].url, /[?&]_=/);
    assert.equal(asked[0].headers['Cache-Control'], 'no-cache');
    // What is reported back is the registry the user configured, not the
    // one-off URL used to get past a cache.
    assert.equal(index.url, registryUrl());
    assert.doesNotMatch(index.url, /[?&]_=/);
    assert.equal(index.plugins.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('the registry defaults to the published one and can be pointed elsewhere', async () => {
  const config = await import('../src/main/config.mjs');
  assert.equal(registryUrl(), DEFAULT_REGISTRY);
  config.update({ pluginRegistry: 'https://example.test/index.json' });
  assert.equal(registryUrl(), 'https://example.test/index.json');
  // Whitespace is not a registry.
  config.update({ pluginRegistry: '   ' });
  assert.equal(registryUrl(), DEFAULT_REGISTRY);
});
