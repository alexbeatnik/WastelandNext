/**
 * Settings persistence, and the one way it silently stopped working.
 *
 * The data root is injected by `main.mjs` in its own body, which an ESM import
 * graph is evaluated in full *before*. Anything constructed at module scope
 * further down therefore reads settings from the platform default root instead
 * of Electron's userData directory — a path that does not exist — and the
 * defaults it caches are what every later reader in the process gets. That is
 * the case reproduced below, verbatim: it is what made the plugins ask to be
 * approved again on every launch, having forgotten the music folder, the speech
 * model and the language along with them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

const config = await import('../src/main/config.mjs');

/** A data root with settings already in it, as a returning user's would be. */
function rootWithSettings(settings) {
  const root = mkdtempSync(join(tmpdir(), 'wl-config-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify(settings), 'utf8');
  return root;
}

test('a read taken before the data root is injected does not outlive it', () => {
  // Nothing injected yet: this resolves the platform default, where — under
  // Electron — there is no settings file at all, so the defaults win.
  setDataRoot(null);
  const early = config.load();
  assert.equal(typeof early, 'object');

  const root = rootWithSettings({
    model: 'gemma-4-E4B-it-UD-Q6_K_XL.gguf',
    locale: 'ukrainian/uk',
    plugins: {
      'audio-player': { enabled: true, approved: true, settings: { library: 'C:\\MUSIC' } },
      'voice-input': { enabled: true, approved: true, settings: { model: 'large', language: 'uk' } },
    },
  });
  setDataRoot(root);

  // The whole bug in one assertion: before the fix this answered with the
  // defaults, and the first `update` then wrote them over the real file.
  assert.equal(config.get('model'), 'gemma-4-E4B-it-UD-Q6_K_XL.gguf');
  assert.equal(config.get('locale'), 'ukrainian/uk');

  const plugins = config.get('plugins');
  assert.equal(plugins['audio-player'].approved, true);
  assert.equal(plugins['audio-player'].settings.library, 'C:\\MUSIC');
  assert.equal(plugins['voice-input'].settings.model, 'large');
  assert.equal(plugins['voice-input'].settings.language, 'uk');
});

test('unknown keys from a newer build survive a round-trip', () => {
  setDataRoot(rootWithSettings({ model: 'a.gguf', somethingNewer: 42 }));
  config.update({ temperature: 0.5 });
  assert.equal(config.get('somethingNewer'), 42);
  assert.equal(config.get('model'), 'a.gguf');
  assert.equal(config.get('temperature'), 0.5);
});

test('a saved value is not discarded by the next load', () => {
  setDataRoot(rootWithSettings({}));
  config.update({ plugins: { 'voice-input': { enabled: true, approved: true } } });
  assert.equal(config.load().plugins['voice-input'].approved, true);
});

test('settings survive a restart against the same root', async () => {
  const root = rootWithSettings({});
  setDataRoot(root);
  config.update({ plugins: { 'audio-player': { enabled: true, approved: true, settings: { library: 'C:\\MUSIC' } } } });

  // A second process reading the same directory: a fresh module, nothing cached.
  setDataRoot(null);
  const restarted = await import(`../src/main/config.mjs?restart=${Date.now()}`);
  setDataRoot(root);
  assert.equal(restarted.get('plugins')['audio-player'].settings.library, 'C:\\MUSIC');
});

test('the audio service does not read settings while it is being constructed', async () => {
  // `ipc.mjs` imports this at module scope, so its constructor runs before any
  // root has been injected. Reading the stored volume there is what poisoned
  // the cache; it must wait until it is actually asked for.
  setDataRoot(null);
  const { AudioOut } = await import('../src/main/audio.mjs');
  const out = new AudioOut();

  setDataRoot(rootWithSettings({ audioVolume: 0.25 }));
  assert.equal(out.status().volume, 0.25);
});
