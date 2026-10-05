/**
 * Serving a file to the renderer.
 *
 * `parseRange` is the reason a seek in a long track works at all, and every
 * interesting case is a header string — so it is tested here rather than
 * discovered by dragging a slider. Carried over from A-Player along with the
 * code, because the cases it gets right were found the hard way.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTime, isAudioFile, mimeFor, parseRange } from '../src/shared/media.mjs';
import { DATA_SEGMENT, MEDIA_SCHEME, PLUGIN_SCHEME, mediaUrl, pluginAssetUrl, pluginDataUrl } from '../src/shared/schemes.mjs';

test('audio types are recognised, and a stylesheet is not audio', () => {
  assert.equal(mimeFor('/music/track.mp3'), 'audio/mpeg');
  assert.equal(mimeFor('/music/track.FLAC'), 'audio/flac');
  assert.equal(mimeFor('themes/green.css'), 'text/css; charset=utf-8');
  // An unknown type is served as bytes rather than guessed at.
  assert.equal(mimeFor('/music/notes.txt'), 'application/octet-stream');
  assert.ok(isAudioFile('a.opus') && !isAudioFile('a.css'));
});

test('no Range header means the whole file', () => {
  assert.equal(parseRange(null, 100).kind, 'none');
  assert.equal(parseRange('', 100).kind, 'none');
});

test('an ordinary range is answered with the slice that was asked for', () => {
  assert.deepEqual(parseRange('bytes=10-19', 100), { kind: 'satisfiable', range: { start: 10, end: 19 } });
  // An open-ended range runs to the last byte, not past it.
  assert.deepEqual(parseRange('bytes=10-', 100), { kind: 'satisfiable', range: { start: 10, end: 99 } });
  assert.deepEqual(parseRange('bytes=10-500', 100), { kind: 'satisfiable', range: { start: 10, end: 99 } });
});

test('a suffix range means the last N bytes, not the first', () => {
  // `bytes=-500` is the one spec that reads backwards, and getting it wrong
  // sends the start of a track to a client asking for the end.
  assert.deepEqual(parseRange('bytes=-20', 100), { kind: 'satisfiable', range: { start: 80, end: 99 } });
  assert.deepEqual(parseRange('bytes=-500', 100), { kind: 'satisfiable', range: { start: 0, end: 99 } });
});

test('a range entirely past the end is refused rather than answered with the file', () => {
  // The one case that must not fall back to 200: a client that asked for bytes
  // beyond the end and got the whole file sees the beginning where it expected
  // the end, and the player silently rewinds.
  assert.equal(parseRange('bytes=100-', 100).kind, 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100).kind, 'unsatisfiable');
  assert.equal(parseRange('bytes=-5', 0).kind, 'unsatisfiable');
});

test('a malformed range is ignored, not rejected', () => {
  // RFC 9110: an unusable Range is ignored and the whole file sent.
  for (const header of ['bytes=', 'bytes=-', 'items=1-2', 'bytes=abc-def', 'bytes=20-10', 'nonsense']) {
    assert.equal(parseRange(header, 100).kind, 'none', header);
  }
});

test('a plugin asset URL keeps its path separators', () => {
  // Encoding the whole path would turn the slash into %2F and the two segments
  // into one nonsense filename the handler cannot find.
  assert.equal(pluginAssetUrl('phosphor-themes', 'themes/green.css'), `${PLUGIN_SCHEME}://phosphor-themes/themes/green.css`);
  assert.equal(pluginAssetUrl('a', 'themes\\green.css'), `${PLUGIN_SCHEME}://a/themes/green.css`);
  assert.match(pluginAssetUrl('a', 'themes/a b.css'), /a%20b\.css$/);
});

test('a media URL survives a filename that would otherwise cut it short', () => {
  // A `#` in a filename ends the path and starts a fragment; a `?` starts a
  // query. Both are ordinary in music libraries.
  const url = mediaUrl('C:\\Music\\Track #3 (remix?).mp3');
  assert.ok(url.startsWith(`${MEDIA_SCHEME}://track/`));
  assert.equal(decodeURIComponent(url.slice(`${MEDIA_SCHEME}://track/`.length)), 'C:\\Music\\Track #3 (remix?).mp3');
});

test('times are written the way a player writes them', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9), '0:09');
  assert.equal(formatTime(187), '3:07');
  // The hour only appears when it has to.
  assert.equal(formatTime(3753), '1:02:33');
  assert.equal(formatTime(NaN), '0:00');
});

test('a file a plugin generated is addressed through the reserved first segment', () => {
  // The installed tree is deleted and rewritten on every update, so a map the
  // *user* generated cannot live in it. `@data` is the door to the directory
  // that survives, and the handler decides on it by decoding the whole path
  // once and reading the first segment — so what the builder writes has to
  // come back out of that round trip unchanged.
  const url = pluginDataUrl('fantasy-rpg', 'maps/run-7.png');
  assert.ok(url.startsWith(`${PLUGIN_SCHEME}://fantasy-rpg/`));

  const decoded = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  assert.equal(decoded, `${DATA_SEGMENT}/maps/run-7.png`);
  assert.equal(decoded.startsWith(`${DATA_SEGMENT}/`), true, 'this is the whole of what routes it to the data root');
});

test('the reserved segment is reserved, and that is the trade', () => {
  // A plugin shipping a real directory called `@data` in its installed tree
  // cannot address it: the two spell the same URL, and the handler answers with
  // the data root. Reserved rather than guessed at — asserted here so nobody
  // "fixes" the collision without knowing which half is deliberate.
  assert.equal(pluginAssetUrl('fantasy-rpg', '@data/maps/run-7.png'), pluginDataUrl('fantasy-rpg', 'maps/run-7.png'));
});

test('a generated filename cannot cut its own URL short', () => {
  // Same hazard as a track called `Black #3.mp3`, and the same cure: every
  // segment is encoded, so a `#` stays part of the path instead of starting a
  // fragment. Portraits and maps are named by a model at one remove.
  const url = pluginDataUrl('fantasy-rpg', 'portraits/Kára #2 (draft?).png');
  assert.equal(
    decodeURIComponent(new URL(url).pathname.replace(/^\//, '')),
    `${DATA_SEGMENT}/portraits/Kára #2 (draft?).png`,
  );
});
