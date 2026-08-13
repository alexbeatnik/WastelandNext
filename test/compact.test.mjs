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

const { promptBudget, shouldCompact } = await import('../src/main/agent/agent.mjs');

const usage = (used, max = 10_000) => ({ used, max, percent: (used / max) * 100 });
const LONG = 12; // comfortably more than the kept tail

// The threshold is a share of the *prompt budget*, not of the whole window:
// 10_000 less the 1536 reserved for the reply leaves 8464, and 75% of that is
// 6348. Measuring against the window instead is what let a prompt reach 4594 of
// 4608 — a conversation that was, on paper, only 99% full and in practice had
// fourteen tokens left to answer in.
const BOUNDARY = 6348;

test('a conversation well inside the window is left alone', () => {
  assert.equal(shouldCompact(usage(1000), LONG), false);
  assert.equal(shouldCompact(usage(5000), LONG), false);
});

test('crossing the threshold triggers compaction', () => {
  assert.equal(shouldCompact(usage(BOUNDARY + 500), LONG), true);
  assert.equal(shouldCompact(usage(9500), LONG), true);
});

test('the boundary itself counts as full enough', () => {
  assert.equal(shouldCompact(usage(BOUNDARY), LONG), true, '75% of the budget exactly should trigger');
  assert.equal(shouldCompact(usage(BOUNDARY - 1), LONG), false);
});

test('room for the reply is reserved before the threshold is applied', () => {
  // The reported case: a 4608-token window with the prompt all but filling it.
  // Judged against the window that is 99% and only just over the line; judged
  // against what the prompt may actually have, it is long past it.
  assert.equal(shouldCompact({ used: 4594, max: 4608 }, LONG), true);
  // And it fires early enough to leave something to answer with, rather than at
  // the point where the model can emit a dozen tokens and stop mid-sentence.
  assert.equal(shouldCompact({ used: 2400, max: 4608 }, LONG), true);
  assert.equal(shouldCompact({ used: 1200, max: 4608 }, LONG), false);
});

test('the reserve is adjustable and cannot swallow a small window whole', () => {
  assert.equal(promptBudget(15_360), 15_360 - 1536);
  assert.equal(promptBudget(10_000, 2000), 8000);
  // A window at or below twice the reserve would otherwise budget zero or less,
  // and every conversation would compact forever.
  assert.equal(promptBudget(2048), 1024);
  assert.equal(promptBudget(0), 0);
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
