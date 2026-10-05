/**
 * Sending into a conversation that is no longer there.
 *
 * Reported as a deleted chat coming back: a turn was running, the conversation
 * was deleted from the picker, and the reply landing afterwards reappeared as a
 * fresh `New Chat` holding the reply and none of the words it was answering.
 *
 * `chats.test.mjs` covers the storage half — `append` refusing an id it was
 * given. This is the half above it: `send()` opened the conversation with
 * `read(chatId) ?? create(...)`, so a deleted id was answered by making a new
 * chat *before* any of those refusals could be reached, and every one of them
 * was then handed an id that had just been created. Two tests that both pass
 * while the wiring between them is missing, which is why this file exists.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

// Before the import: an ESM graph is evaluated in full before this body runs,
// and anything reading settings at module scope would resolve the wrong root.
setDataRoot(mkdtempSync(join(tmpdir(), 'wl-deleted-chat-')));

const { Agent } = await import('../src/main/agent/agent.mjs');
const chats = await import('../src/main/chats.mjs');

/**
 * Enough of the app to reach the first line of a turn.
 *
 * The refusal happens before any model call, so a server that only claims to be
 * usable is the whole of what is needed — and if the refusal ever stops
 * happening, the test fails by trying to talk to a `#complete` that is not
 * there, rather than by passing quietly.
 */
function build() {
  return new Agent({
    server: { usable: true, contextSize: 100_000 },
    plugins: { ready: Promise.resolve(), beginTurn() {}, promptFragments: () => [] },
  });
}

test('a chat deleted before the message is sent is refused, not recreated', async () => {
  const agent = build();
  const chat = chats.create('Deleted from the picker');
  chats.remove(chat.id);
  const before = chats.list().length;

  await assert.rejects(agent.send(chat.id, 'are you still there?'), /no longer exists/);

  // The point: the refusal, and nothing behind it. A new row here is the bug.
  assert.equal(chats.list().length, before);
  assert.equal(chats.read(chat.id), null);
});

test('an empty id still opens a new conversation', async () => {
  // The other half of the same branch, and the reason it cannot simply refuse
  // whatever it cannot read: every first message arrives with no id at all.
  const agent = build();
  const before = chats.list().length;

  // Rejects further in — there is no model behind this stub — but only after
  // the chat has been created, which is what is being asserted.
  await agent.send('', 'first thing said').catch(() => {});

  assert.equal(chats.list().length, before + 1);
  const opened = chats.list()[0];
  assert.equal(chats.read(opened.id).messages[0].content, 'first thing said');
});

test('a turn is still refused for a chat that never existed', async () => {
  const agent = build();
  await assert.rejects(agent.send('20260101000000-abcdef', 'hello?'), /no longer exists/);
});
