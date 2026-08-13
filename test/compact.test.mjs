/**
 * When the conversation gets compressed.
 *
 * The trigger used to run only at the start of a user turn. A browsing turn
 * grows its own history — every batch appends a page map — so three follow-ups
 * could carry a conversation past the window without the user saying anything,
 * which is how a real session reached 8562 of 15360 with no compaction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-compact-')));

const { shouldCompact } = await import('../src/main/agent/agent.mjs');

const usage = (used, max = 10_000) => ({ used, max, percent: (used / max) * 100 });
const LONG = 12; // comfortably more than the kept tail

test('a conversation well inside the window is left alone', () => {
  assert.equal(shouldCompact(usage(1000), LONG), false);
  assert.equal(shouldCompact(usage(7000), LONG), false);
});

test('crossing the threshold triggers compaction', () => {
  assert.equal(shouldCompact(usage(7500), LONG), true);
  assert.equal(shouldCompact(usage(9500), LONG), true);
});

test('the boundary itself counts as full enough', () => {
  assert.equal(shouldCompact(usage(7500), LONG), true, '75% exactly should trigger');
  assert.equal(shouldCompact(usage(7499), LONG), false);
});

test('a conversation with nothing older than the tail is never compacted', () => {
  // The summary would replace the very messages it summarised, so the prompt
  // would not shrink — and the next check would fire again immediately.
  for (const count of [0, 1, 4, 5, 6]) {
    assert.equal(shouldCompact(usage(9900), count), false, `${count} messages should be left alone`);
  }
  assert.equal(shouldCompact(usage(9900), 7), true, 'one message past the tail can be compacted');
});

test('an unknown window size is not treated as full', () => {
  // Before a model loads there is no reported context; guessing "compact" there
  // would summarise a conversation for no reason.
  assert.equal(shouldCompact({ used: 5000, max: 0 }, LONG), false);
  assert.equal(shouldCompact(null, LONG), false);
  assert.equal(shouldCompact(undefined, LONG), false);
});

test('the threshold and tail size are adjustable', () => {
  assert.equal(shouldCompact(usage(5000), LONG, { threshold: 0.4 }), true);
  assert.equal(shouldCompact(usage(5000), LONG, { threshold: 0.9 }), false);
  assert.equal(shouldCompact(usage(9900), 8, { keep: 10 }), false, 'a longer tail needs a longer conversation');
});

test('a small window fills sooner, which is the point', () => {
  // The GPU trade can drop the window to 15360; the same conversation that was
  // comfortable at 32768 needs compacting there.
  assert.equal(shouldCompact({ used: 12_000, max: 32_768 }, LONG), false);
  assert.equal(shouldCompact({ used: 12_000, max: 15_360 }, LONG), true);
});
