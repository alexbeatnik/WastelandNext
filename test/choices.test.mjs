/**
 * Reading the options a reply offers.
 *
 * This exists because a model holding a browser found the video it had been
 * asked for and then wrote "1. Open it 2. Pick another version. Which would you
 * like?" — a menu with nothing to press. The fence is how it draws real
 * buttons, and everything here is about surviving the JSON a small model
 * actually emits rather than the JSON the prompt asked for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CHOICES, parseChoices, stripBlocks } from '../src/shared/render.mjs';

const fence = (body) => `Which would you like?\n\n\`\`\`choices\n${body}\n\`\`\``;

test('a reply with no fence offers nothing', () => {
  assert.deepEqual(parseChoices('Just an answer.'), []);
  assert.deepEqual(parseChoices(''), []);
  assert.deepEqual(parseChoices(null), []);
});

test('bare strings are both halves at once', () => {
  const offered = parseChoices(fence('{"options":["Open and play it","Show other versions"]}'));
  assert.deepEqual(offered, [
    { label: 'Open and play it', send: 'Open and play it' },
    { label: 'Show other versions', send: 'Show other versions' },
  ]);
});

test('label and send are kept apart when they differ', () => {
  const offered = parseChoices(fence('{"options":[{"label":"Play it","send":"open the video and play it"}]}'));
  assert.deepEqual(offered, [{ label: 'Play it', send: 'open the video and play it' }]);
});

test('one half is enough — the other is taken from it', () => {
  assert.deepEqual(parseChoices(fence('{"options":[{"label":"Play it"}]}')), [{ label: 'Play it', send: 'Play it' }]);
  assert.deepEqual(parseChoices(fence('{"options":[{"send":"play it"}]}')), [{ label: 'play it', send: 'play it' }]);
});

test('a second line survives as a note', () => {
  const offered = parseChoices(fence('{"options":[{"label":"Black","note":"Pearl Jam · 5:46"}]}'));
  assert.deepEqual(offered, [{ label: 'Black', send: 'Black', note: 'Pearl Jam · 5:46' }]);
});

test('a bare array is accepted — small models improvise about the wrapper', () => {
  assert.deepEqual(parseChoices(fence('["Yes","No"]')), [
    { label: 'Yes', send: 'Yes' },
    { label: 'No', send: 'No' },
  ]);
});

test('the wrapper may be called something else', () => {
  for (const key of ['options', 'choices', 'items']) {
    assert.deepEqual(parseChoices(fence(`{"${key}":["Yes"]}`)), [{ label: 'Yes', send: 'Yes' }], key);
  }
});

test('prose left inside the fence does not lose the options', () => {
  // The same creativity `firstJsonObject` was written for, in a different fence.
  const offered = parseChoices(fence('{"options":["Yes","No"]}\nPick one of these.'));
  assert.deepEqual(offered.map((c) => c.label), ['Yes', 'No']);
});

test('a malformed block offers nothing rather than throwing', () => {
  // The reply is already on screen by the time this runs. A parse error that
  // took the prose with it would lose the answer to a missing brace.
  for (const body of ['{"options":', 'not json at all', '{}', '{"options":"a string"}', '']) {
    assert.deepEqual(parseChoices(fence(body)), [], body);
  }
});

test('blank and unusable entries are dropped, not drawn empty', () => {
  const offered = parseChoices(fence('{"options":["Yes","   ",null,42,{},{"note":"orphan"},"No"]}'));
  assert.deepEqual(offered.map((c) => c.label), ['Yes', 'No']);
});

test('two buttons that send the same words are one button', () => {
  const offered = parseChoices(fence('{"options":["Play it","play IT",{"label":"Different","send":"play it"}]}'));
  assert.deepEqual(offered.map((c) => c.label), ['Play it']);
});

test('a runaway list is capped', () => {
  const many = Array.from({ length: 20 }, (_, i) => `option ${i}`);
  assert.equal(parseChoices(fence(JSON.stringify({ options: many }))).length, MAX_CHOICES);
});

test('a paragraph is not a button', () => {
  // A label that long is prose the model should have written as prose, and
  // shortening it would make the button lie about what pressing it sends.
  const essay = 'x'.repeat(201);
  assert.deepEqual(parseChoices(fence(JSON.stringify({ options: [essay, 'Fine'] }))).map((c) => c.label), ['Fine']);
});

test('the last block wins when a model emits two', () => {
  const reply = `${fence('{"options":["First"]}')}\n\nOn reflection:\n\n${fence('{"options":["Second"]}')}`;
  assert.deepEqual(parseChoices(reply).map((c) => c.label), ['Second']);
});

test('an unclosed fence still parses — a truncated stream is the common case', () => {
  assert.deepEqual(parseChoices('Pick:\n```choices\n{"options":["Yes","No"]}').map((c) => c.label), ['Yes', 'No']);
});

test('the fence is stripped out of the prose the user reads', () => {
  const reply = `Found it.\n\n\`\`\`choices\n{"options":["Yes"]}\n\`\`\``;
  assert.equal(stripBlocks(reply), 'Found it.');
});

test('the choices fence and the action fence are stripped together', () => {
  const reply = [
    'Opening it.',
    '```action',
    '{"type":"browser_steps","steps":"NAVIGATE to https://a.test"}',
    '```',
    'Opened. Now what?',
    '```choices',
    '{"options":["Play it"]}',
    '```',
  ].join('\n');
  assert.equal(stripBlocks(reply), 'Opening it.\n\nOpened. Now what?');
});

test('a fence mentioned in prose is not an offer', () => {
  // The opener has to start a line, like every other fence in this app.
  assert.deepEqual(parseChoices('Emit a ```choices block when you want buttons.'), []);
});
