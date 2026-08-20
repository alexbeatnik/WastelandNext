/**
 * The shape a chat template will accept.
 *
 * Mistral's raises from inside the Jinja rather than answering: the request
 * comes back 500 with a template traceback and nothing saying the problem is the
 * conversation's shape. The numbers here are from the session that found it —
 * eleven messages, two `tool` results in a row from one reply that emitted two
 * action blocks, and then three user turns stacked up by retries that could
 * never have worked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitToWindow, promptBudget, shapeForTemplate } from '../src/main/agent/agent.mjs';

const roles = (messages) => messages.map((message) => message.role);

test('neighbours that go over the wire as one role are joined', () => {
  const shaped = shapeForTemplate([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'начать новую игру' },
    { role: 'assistant', content: 'a reply with two action blocks' },
    { role: 'user', content: 'first result' },
    { role: 'user', content: 'second result' },
    { role: 'user', content: 'and the next thing typed' },
  ]);
  assert.deepEqual(roles(shaped), ['system', 'user', 'assistant', 'user']);
  assert.equal(
    shaped[3].content,
    'first result\n\nsecond result\n\nand the next thing typed',
    'the text goes in the same order — the boundary was ours, not the protocol\'s',
  );
});

test('the wedged conversation from the report can be sent again', () => {
  // Repaired on the way out rather than in storage, so a chat already broken by
  // this is usable the next time it is sent rather than lost.
  const stored = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: '1' },
    { role: 'assistant', content: '2' },
    { role: 'user', content: '3' },
    { role: 'assistant', content: '4' },
    { role: 'user', content: '5' },
    { role: 'assistant', content: '6' },
    { role: 'user', content: '7' },
    { role: 'user', content: '8' },
    { role: 'user', content: '9' },
    { role: 'user', content: '10' },
    { role: 'user', content: '11' },
  ];
  const shaped = shapeForTemplate(stored);
  assert.deepEqual(roles(shaped), ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  for (let i = 1; i < shaped.length - 1; i += 1) {
    assert.notEqual(shaped[i].role, shaped[i + 1].role, 'strictly alternating, which is the whole rule');
  }
});

test('a conversation cannot start on an assistant turn', () => {
  // Nothing produces one directly. `fitToWindow` drops oldest-first and can
  // uncover one, and "the first message is the user's" is the other half of the
  // rule that refuses two user turns in a row.
  const shaped = shapeForTemplate([
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'left over after a trim' },
    { role: 'user', content: 'the question' },
  ]);
  assert.deepEqual(roles(shaped), ['system', 'user']);
});

test('a trim that uncovers an assistant turn is shaped after the fact', () => {
  const built = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'y'.repeat(4000) },
    { role: 'user', content: 'the newest question' },
  ];
  const { messages, dropped } = fitToWindow(built, promptBudget(2400));
  assert.ok(dropped > 0, 'the fixture has to actually overflow for this to prove anything');
  assert.deepEqual(roles(shapeForTemplate(messages)), ['system', 'user']);
});

test('shaping an already-shaped list changes nothing', () => {
  const once = shapeForTemplate([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
  ]);
  assert.deepEqual(shapeForTemplate(once), once, 'so it can be applied twice without a second thought');
});

test('nothing to shape is not an error', () => {
  assert.deepEqual(shapeForTemplate([]), []);
  assert.deepEqual(shapeForTemplate(null), []);
  assert.deepEqual(roles(shapeForTemplate([{ role: 'user', content: 'no system prompt' }])), ['user']);
});

test('the originals are not edited', () => {
  const source = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ];
  const copy = JSON.parse(JSON.stringify(source));
  shapeForTemplate(source);
  assert.deepEqual(source, copy);
});
