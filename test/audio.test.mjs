/**
 * The audio service — the smallest part of a music player that cannot be a
 * plugin, and the whole of what keeps it small.
 *
 * It knows one source, whether it is playing, how loud, and what to write on
 * the bar. The queue, shuffle, repeat, the library and what "next" means all
 * belong to whichever plugin registered the transport, and every test below is
 * about that line: a button the transport did not declare is never drawn, a
 * driver that goes away takes its buttons with it, and a plugin that throws
 * reports on the bar rather than out of the call.
 *
 * The allowlist is the other half. `wasteland-media:` reaches anywhere on disk,
 * so what makes that safe is not "is the path well formed" but "did we put this
 * file in front of the user" — which is exactly what `allows` answers, and
 * exactly what `clear` revokes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';
import { mediaUrl } from '../src/shared/schemes.mjs';

// Before the import, not after: the service reads the stored volume on first
// ask precisely because a read taken at construction misses the real root.
setDataRoot(mkdtempSync(join(tmpdir(), 'wl-audio-')));

const { AudioOut, TRANSPORT_BUTTONS } = await import('../src/main/audio.mjs');
const config = await import('../src/main/config.mjs');

const TRACK = 'C:\\Music\\Pearl Jam\\04 Black.mp3';

/** A transport that records what it was asked, as a plugin's would be asked. */
function spyTransport(overrides = {}) {
  const asked = [];
  return {
    asked,
    transport: {
      pluginId: 'audio-player',
      buttons: ['previous', 'next', 'stop'],
      handle: (command) => void asked.push(command),
      ...overrides,
    },
  };
}

test('an empty bar has a source of nothing and buttons to match', () => {
  const audio = new AudioOut();
  const status = audio.status();
  assert.equal(status.source, null);
  assert.equal(status.playing, false);
  assert.equal(status.error, '');
  // An empty list is what hides the transport buttons. A plugin that never
  // registered one must not leave controls on screen that answer nothing.
  assert.deepEqual(status.buttons, []);
  assert.equal(status.driver, '');
});

test('play does nothing with nothing loaded, and says so honestly', () => {
  const audio = new AudioOut();
  assert.equal(audio.play().playing, false, 'a bar with no source cannot claim to be playing');
  assert.equal(audio.toggle().playing, false);
});

test('a track with no tags still shows something true', () => {
  const audio = new AudioOut();
  const status = audio.load({ path: TRACK });
  assert.equal(status.source.label, '04 Black', 'the file name, minus the extension');
  assert.equal(status.source.sublabel, '');
  assert.equal(status.playing, true);

  // The plugin's words win when it has any: only it knows whether the second
  // line is an artist, a station name or "3 of 47".
  const tagged = audio.load({ path: TRACK, label: 'Black', sublabel: 'Pearl Jam — Ten' });
  assert.equal(tagged.source.label, 'Black');
  assert.equal(tagged.source.sublabel, 'Pearl Jam — Ten');

  // Either separator: the path came from a plugin, which got it from a library
  // scan on whichever platform this is.
  assert.equal(audio.load({ path: '/music/Pink Moon.flac' }).source.label, 'Pink Moon');
});

test('loading nothing is not loading', () => {
  const audio = new AudioOut();
  audio.load({ path: TRACK });
  assert.equal(audio.load({}).source.path, TRACK, 'a call with no path leaves the bar as it was');
  assert.equal(audio.load().source.path, TRACK);
});

test('a track can be cued without being played', () => {
  const audio = new AudioOut();
  assert.equal(audio.load({ path: TRACK }, { play: false }).playing, false);
  assert.equal(audio.play().playing, true);
  assert.equal(audio.toggle().playing, false);
  assert.equal(audio.toggle().playing, true);
});

test('the media URL is built here, and never in the renderer', () => {
  // The scheme and its encoding belong to the process that takes them apart
  // again. A second encoder is a second thing to get wrong about a filename
  // holding a `#`, which ends a path and starts a fragment.
  const audio = new AudioOut();
  const awkward = 'C:\\Music\\Track #3 (remix?).mp3';
  const status = audio.load({ path: awkward });
  assert.equal(status.source.src, mediaUrl(awkward));
  assert.equal(status.source.path, awkward, 'the path itself is handed over unencoded');
});

test('the allowlist is the one file that was loaded', () => {
  const audio = new AudioOut();
  audio.load({ path: TRACK });
  assert.equal(audio.allows(TRACK), true);
  // Not the folder, not the queue — the app does not have the queue.
  assert.equal(audio.allows('C:\\Music\\Pearl Jam\\05 Jeremy.mp3'), false);
  assert.equal(audio.allows('C:\\Users\\alexb\\.ssh\\id_rsa'), false);

  audio.clear();
  assert.equal(audio.allows(TRACK), false, 'clear() revokes it');
  assert.equal(audio.status().source, null);
});

test('pause keeps the track cued; clear takes the bar away', () => {
  const audio = new AudioOut();
  audio.load({ path: TRACK });
  assert.equal(audio.pause().source.path, TRACK);
  assert.equal(audio.status().playing, false);
  assert.equal(audio.clear().source, null);
});

test('the volume is clamped, remembered, and refuses nonsense', () => {
  const audio = new AudioOut();
  assert.equal(audio.setVolume(0.25).volume, 0.25);
  assert.equal(config.get('audioVolume'), 0.25, 'it outlives the session, or the bar resets on every launch');

  assert.equal(audio.setVolume(4).volume, 1);
  assert.equal(audio.setVolume(-1).volume, 0);
  assert.equal(audio.setVolume('loud').volume, 0, 'a value that is not a number leaves the last one standing');

  // A second service reads back what the first stored, rather than the default.
  assert.equal(new AudioOut().status().volume, 0);
});

test('a transport is offered only the buttons the bar can draw', () => {
  const audio = new AudioOut();
  const { transport } = spyTransport({ buttons: ['next', 'eject', 'previous', 'launch_missiles'] });
  audio.setTransport(transport);
  assert.deepEqual(audio.status().buttons, ['next', 'previous']);
  assert.deepEqual(TRANSPORT_BUTTONS, ['previous', 'next', 'stop'], 'the whole list the bar can draw');
  assert.equal(audio.status().driver, 'audio-player');
});

test('a transport with nothing to call is refused at registration', () => {
  const audio = new AudioOut();
  assert.throws(() => audio.setTransport({ pluginId: 'broken', buttons: ['next'] }), /handle/);
  assert.deepEqual(audio.status().buttons, [], 'and leaves no buttons behind it');
});

test('the newcomer wins, because it is the thing now playing', () => {
  const audio = new AudioOut();
  const first = spyTransport();
  const second = spyTransport({ pluginId: 'radio', buttons: ['stop'] });
  audio.setTransport(first.transport);
  audio.setTransport(second.transport);

  assert.equal(audio.status().driver, 'radio');
  // Leaving the previous driver's next button up would step through a queue
  // that has nothing to do with the sound now playing.
  assert.deepEqual(audio.status().buttons, ['stop']);
});

test('a button the app can answer itself is never asked of the plugin', async () => {
  const audio = new AudioOut();
  const { asked, transport } = spyTransport();
  audio.setTransport(transport);
  audio.load({ path: TRACK });

  await audio.command('pause');
  await audio.command('play');
  await audio.command('toggle');
  assert.deepEqual(asked, [], 'play, pause and volume are true of any source');

  await audio.command('next');
  await audio.command('ended');
  assert.deepEqual(asked, ['next', 'ended'], "everything else is the transport's to answer");
});

test('a plugin that throws lands on the bar, not in the caller', async () => {
  const audio = new AudioOut();
  audio.setTransport({
    pluginId: 'audio-player',
    buttons: ['next'],
    handle: () => {
      throw new Error('the library moved');
    },
  });
  audio.load({ path: TRACK });

  const status = await audio.command('next');
  assert.match(status.error, /audio-player: the library moved/);
  assert.equal(status.playing, false);
});

test('stop still means something with no driver at all', async () => {
  // A bar left over from a plugin that has been switched off has to be
  // dismissable, or it sits there for the rest of the session.
  const audio = new AudioOut();
  audio.load({ path: TRACK });
  assert.equal((await audio.command('stop')).source, null);

  audio.load({ path: TRACK });
  assert.equal((await audio.command('ended')).source, null);

  // Anything else is nobody's to answer, which is honest rather than an error.
  audio.load({ path: TRACK });
  assert.equal((await audio.command('next')).source.path, TRACK);
});

test('switching a plugin off takes its bar with it', () => {
  const audio = new AudioOut();
  const { transport } = spyTransport();
  audio.setTransport(transport);
  audio.load({ path: TRACK });

  audio.releasePlugin('some-other-plugin');
  assert.equal(audio.status().driver, 'audio-player', 'a plugin that was not driving releases nothing');
  assert.ok(audio.status().source, "somebody else's plugin going away must not stop the music");

  audio.releasePlugin('audio-player');
  const status = audio.status();
  assert.equal(status.driver, '');
  assert.deepEqual(status.buttons, []);
  assert.equal(status.source, null, 'a driver that went away takes the sound with it');
  assert.equal(audio.allows(TRACK), false);
});

test('the renderer could not play it, and the bar says so', () => {
  const audio = new AudioOut();
  audio.load({ path: TRACK });
  const status = audio.fail('unsupported codec');
  assert.equal(status.error, 'unsupported codec');
  assert.equal(status.playing, false);
  assert.equal(status.source.path, TRACK, 'what failed stays named, or there is nothing to explain');

  // And the next thing to play clears it: an error about the previous track
  // sitting under the current one is worse than none.
  assert.equal(audio.load({ path: TRACK }).error, '');
});

test('every change is announced once, because the renderer holds no state', () => {
  const audio = new AudioOut();
  const seen = [];
  audio.on('state', (status) => seen.push(status));

  audio.load({ path: TRACK });
  audio.pause();
  audio.setVolume(0.5);
  audio.clear();
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.at(-1), audio.status(), 'what was announced is what the service now says');
});
