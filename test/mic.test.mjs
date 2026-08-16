/**
 * Dictation, from the app's side of it.
 *
 * The app owns capture and knows nothing about speech; a plugin owns speech and
 * cannot reach a microphone. What is worth testing here is exactly the seam:
 * whether the button is offered, who gets the audio, and — the one that matters
 * — whether the recording is deleted afterwards however the engine behaved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot, scratchDir } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-mic-')));

const { MicIn } = await import('../src/main/mic.mjs');

/** A 16 kHz mono WAV header with a little silence after it. */
function wav(samples = 160) {
  return Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(samples * 2)]);
}

test('with nothing registered there is no button and no way in', async () => {
  const mic = new MicIn();
  assert.equal(mic.status().available, false);
  // Refused rather than silently discarded: the renderer would otherwise think
  // it had dictated something.
  await assert.rejects(() => mic.hear(wav()), /nothing is set up to transcribe/);
});

test('a transcriber that is not ready still draws no button', () => {
  // Registered means "this plugin drives dictation"; ready means "there is a
  // model on disk". A microphone that records into nothing is a dead control,
  // and the explanation belongs on the plugin's row.
  const mic = new MicIn();
  mic.setTranscriber({ pluginId: 'voice', label: 'Whisper', ready: false, transcribe: async () => 'x' });
  assert.equal(mic.status().available, false);

  mic.setReady('voice', true);
  assert.equal(mic.status().available, true);
  assert.equal(mic.status().label, 'Whisper');

  // A different plugin cannot flip somebody else's switch.
  mic.setReady('impostor', false);
  assert.equal(mic.status().available, true);
});

test('a recording reaches the plugin as a file, and does not outlive it', async () => {
  const mic = new MicIn();
  let seen = '';
  mic.setTranscriber({
    pluginId: 'voice',
    ready: true,
    transcribe: async (path) => {
      seen = path;
      assert.ok(existsSync(path), 'the engine is handed a file that is actually there');
      return '  open the browser  ';
    },
  });

  assert.equal(await mic.hear(wav()), 'open the browser');
  // The one that matters. This is a recording of somebody's voice: leaving it
  // in a scratch directory is not litter, it is a recording of somebody's voice
  // left on their disk.
  assert.equal(existsSync(seen), false, 'the recording is deleted once it has been read');
});

test('a failing engine still takes the recording with it', async () => {
  const before = readdirSync(scratchDir()).length;
  const mic = new MicIn();
  mic.setTranscriber({
    pluginId: 'voice',
    ready: true,
    transcribe: async () => {
      throw new Error('whisper-cli exited (1)');
    },
  });

  await assert.rejects(() => mic.hear(wav()), /whisper-cli exited/);
  assert.equal(readdirSync(scratchDir()).length, before, 'nothing is left behind by a failure');
  // And the reason is on the status, so the button can say what went wrong.
  assert.match(mic.status().error, /whisper-cli exited/);
});

test('an empty or oversized recording is refused before anything is written', async () => {
  const mic = new MicIn();
  mic.setTranscriber({ pluginId: 'voice', ready: true, transcribe: async () => 'x' });

  await assert.rejects(() => mic.hear(Buffer.alloc(0)), /nothing was recorded/);
  await assert.rejects(() => mic.hear(Buffer.alloc(80 * 1024 * 1024)), /longer than this can take/);
});

test('switching the plugin off takes the button with it', () => {
  const mic = new MicIn();
  mic.setTranscriber({ pluginId: 'voice', ready: true, transcribe: async () => 'x' });
  assert.equal(mic.status().available, true);

  // The host calls this for every service a plugin declared; a button left on
  // screen for a plugin that is no longer running is a control that cannot work.
  mic.releasePlugin('someone-else');
  assert.equal(mic.status().available, true);
  mic.releasePlugin('voice');
  assert.equal(mic.status().available, false);
});

test('the newcomer wins, exactly as with the audio transport', () => {
  const mic = new MicIn();
  mic.setTranscriber({ pluginId: 'first', label: 'One', ready: true, transcribe: async () => '1' });
  mic.setTranscriber({ pluginId: 'second', label: 'Two', ready: true, transcribe: async () => '2' });
  assert.equal(mic.status().driver, 'second');
  // And the loser cannot take the button down on its way past.
  mic.releasePlugin('first');
  assert.equal(mic.status().available, true);
});

test('a transcriber without a transcribe function is refused', () => {
  const mic = new MicIn();
  assert.throws(() => mic.setTranscriber({ pluginId: 'voice', ready: true }), /needs a transcribe/);
});
