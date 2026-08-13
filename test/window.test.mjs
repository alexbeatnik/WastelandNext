/**
 * Keeping the prompt inside the window.
 *
 * From a real session: a Ukrainian conversation on a 4608-token context that
 * reported 4594 / 4608 and answered in half a sentence, having lost the start
 * of its own history. Three separate things were wrong, and each is pinned
 * here — the estimate that undercounted Cyrillic, the reasoning that was resent
 * every turn, and the absence of any check between "compaction did what it
 * could" and "send it anyway".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';
import { estimateTokens } from '../src/main/llm/client.mjs';
import { stripThinking } from '../src/shared/render.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-window-')));

const { fitToWindow } = await import('../src/main/agent/agent.mjs');

/* ============================ the estimate ============================ */

test('Cyrillic is counted as costing more than Latin of the same length', () => {
  // Same character count, very different token counts: few tokenizers hold
  // whole Ukrainian words, so most of the text becomes byte pairs.
  const latin = 'a'.repeat(360);
  const cyrillic = 'я'.repeat(360);
  assert.ok(
    estimateTokens(cyrillic) > estimateTokens(latin) * 1.5,
    `${estimateTokens(cyrillic)} should be well above ${estimateTokens(latin)}`,
  );
});

test('a mixed message is counted by its parts', () => {
  const mixed = `${'a'.repeat(360)}${'я'.repeat(360)}`;
  assert.equal(estimateTokens(mixed), estimateTokens('a'.repeat(360)) + estimateTokens('я'.repeat(360)));
});

test('nothing costs nothing', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

/* ============================ resent reasoning ============================ */

test('reasoning is dropped from a reply before it goes back to the model', () => {
  const reply = '<think>\nLet me weigh this at great length.\n</think>\nShort answer.';
  assert.equal(stripThinking(reply), 'Short answer.');
});

test('action fences survive — the model does need to see what it did', () => {
  const reply = '<think>\ndeliberation\n</think>\nOn it.\n\n```action\n{"type":"browser_steps"}\n```';
  const stripped = stripThinking(reply);
  assert.ok(stripped.includes('```action'), 'the action block must not be collateral damage');
  assert.ok(!stripped.includes('deliberation'));
});

test('a reply that never got past thinking strips to nothing', () => {
  // The reported failure itself: the whole budget went on reasoning and the
  // answer never arrived. Nothing is the honest result — and the caller
  // substitutes a short placeholder so the turn is not empty.
  assert.equal(stripThinking('<think>\nstill thinking when the tokens ran out'), '');
});

/* ============================ the backstop ============================ */

const say = (role, content) => ({ role, content });
const words = (n) => 'word '.repeat(n).trim();

test('a prompt that already fits is returned untouched', () => {
  const messages = [say('system', words(10)), say('user', words(10))];
  const fitted = fitToWindow(messages, 1000);
  assert.deepEqual(fitted.messages, messages);
  assert.equal(fitted.dropped, 0);
  assert.equal(fitted.trimmed, false);
});

test('oldest messages go first, and the system prompt is never one of them', () => {
  const messages = [
    say('system', words(50)),
    say('user', words(200)),
    say('assistant', words(200)),
    say('user', words(50)),
  ];
  const fitted = fitToWindow(messages, estimateTokens(words(50)) * 2 + 20);

  assert.ok(fitted.dropped > 0, 'expected something to be dropped');
  assert.equal(fitted.messages[0].role, 'system');
  assert.equal(fitted.messages.at(-1).content, words(50), 'the newest message must survive');
});

test('the newest message survives even when it alone overflows', () => {
  // The reported shape: a pasted README as the latest turn, larger on its own
  // than the window that has to hold it.
  const paste = words(4000);
  const fitted = fitToWindow([say('system', words(50)), say('user', paste)], 500);

  assert.equal(fitted.messages.length, 2);
  assert.equal(fitted.trimmed, true);
  assert.ok(estimateTokens(fitted.messages[1].content) <= 500, 'still over the budget');
  // Head and tail are what carry the sense of a pasted document: what it is,
  // and the question the user appended underneath it.
  assert.ok(fitted.messages[1].content.startsWith('word word'));
  assert.ok(fitted.messages[1].content.endsWith('word'));
  assert.ok(fitted.messages[1].content.includes('trimmed to fit'));
});

test('the original messages are not mutated', () => {
  const paste = words(4000);
  const messages = [say('system', words(50)), say('user', paste)];
  fitToWindow(messages, 500);
  assert.equal(messages[1].content, paste, 'the stored history must be left alone');
});

test('a list with no system prompt still keeps its newest message', () => {
  const fitted = fitToWindow([say('user', words(300)), say('user', words(20))], 40);
  assert.equal(fitted.messages.at(-1).content, words(20));
});

test('an unknown budget is not an excuse to throw anything away', () => {
  const messages = [say('system', words(10)), say('user', words(10))];
  assert.deepEqual(fitToWindow(messages, 0).messages, messages);
  assert.deepEqual(fitToWindow([], 100).messages, []);
});
