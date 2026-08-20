/**
 * Action extraction is where a small model's creative JSON gets absorbed, so
 * the malformed cases matter more than the well-formed one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractActions,
  firstJsonObject,
  parseActionPayload,
  splitNarration,
  splitThinking,
  stripBlocks,
} from '../src/main/agent/actions.mjs';

const fence = (body) => '```action\n' + body + '\n```';

test('extracts a well-formed browser action', () => {
  const reply = `Opening YouTube now.\n${fence(
    '{"type":"browser_steps","steps":"NAVIGATE to https://youtube.com\\nPRESS Enter"}',
  )}\nDone.`;
  const actions = extractActions(reply);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'browser_steps');
  assert.equal(actions[0].steps, 'NAVIGATE to https://youtube.com\nPRESS Enter');
});

test('extracts several actions in order', () => {
  const reply = [
    fence('{"type":"web_lookup","steps":"weather kyiv"}'),
    fence('{"type":"browser_close","steps":""}'),
  ].join('\n\n');
  assert.deepEqual(
    extractActions(reply).map((a) => a.type),
    ['web_lookup', 'browser_close'],
  );
});

test('ignores prose written after the closing brace inside the fence', () => {
  const reply = fence('{"type":"web_lookup","steps":"usd rate"} — I will read it back to you.');
  assert.equal(extractActions(reply)[0].steps, 'usd rate');
});

test('repairs the truncation where the outer quote and brace are missing', () => {
  const payload = parseActionPayload('{"type":"browser_steps","steps":"CLICK the \'Sign in\' button');
  assert.ok(payload, 'expected the truncated payload to be repaired');
  assert.equal(payload.type, 'browser_steps');
  assert.equal(payload.steps, "CLICK the 'Sign in' button");
});

test('an unterminated fence still yields its action', () => {
  const reply = 'Searching.\n```action\n{"type":"web_lookup","steps":"btc price"}';
  assert.equal(extractActions(reply)[0].type, 'web_lookup');
});

test('drops payloads that are beyond repair', () => {
  assert.equal(parseActionPayload('not json at all'), null);
  assert.equal(parseActionPayload('{"steps":"no type here"}'), null);
  assert.deepEqual(extractActions(fence('¯\\_(ツ)_/¯')), []);
});

test('a code fence that is not an action fence is left alone', () => {
  const reply = 'Here is some JS:\n```js\nconst a = 1;\n```';
  assert.deepEqual(extractActions(reply), []);
  assert.equal(stripBlocks(reply), reply);
});

test('firstJsonObject respects braces inside strings', () => {
  const raw = '{"type":"x","steps":"a } brace { in a string"} trailing';
  assert.equal(firstJsonObject(raw), '{"type":"x","steps":"a } brace { in a string"}');
});

test('firstJsonObject respects escaped quotes', () => {
  const raw = '{"type":"x","steps":"say \\"hi\\" then stop"}';
  assert.equal(JSON.parse(firstJsonObject(raw)).steps, 'say "hi" then stop');
});

test('splitNarration keeps the prose either side and drops the middle', () => {
  const reply = [
    'First I will search.',
    fence('{"type":"browser_steps","steps":"NAVIGATE to https://a.test"}'),
    'Ignored middle.',
    fence('{"type":"browser_steps","steps":"CLICK the \'Next\' button"}'),
    'All done.',
  ].join('\n');
  const { pre, post } = splitNarration(reply);
  assert.equal(pre, 'First I will search.');
  assert.equal(post, 'All done.');
});

test('splitNarration treats an action-free reply as all prose', () => {
  assert.deepEqual(splitNarration('  just words  '), { pre: 'just words', post: '' });
});

test('stripBlocks leaves only prose, with the fence read as a paragraph break', () => {
  const reply = `Opening it.\n${fence('{"type":"browser_steps","steps":"NAVIGATE to https://a.test"}')}\nOpened.`;
  assert.equal(stripBlocks(reply), 'Opening it.\n\nOpened.');
});

test('stripBlocks collapses the run of blank lines a long fence leaves', () => {
  const reply = `Before.\n\n${fence('{"type":"browser_close","steps":""}')}\n\nAfter.`;
  assert.equal(stripBlocks(reply), 'Before.\n\nAfter.');
});

test('splitThinking separates a reasoning block from the answer', () => {
  const segments = splitThinking('<think>\nweigh the options\n</think>\nThe answer is 42.');
  assert.deepEqual(segments, [
    { kind: 'think', content: 'weigh the options' },
    { kind: 'text', content: 'The answer is 42.' },
  ]);
});

test('splitThinking ignores <think> mentioned mid-sentence', () => {
  const text = 'Models emit a <think> tag when reasoning.';
  assert.deepEqual(splitThinking(text), [{ kind: 'text', content: text }]);
});

test('splitThinking treats an unclosed block as reasoning to the end', () => {
  const segments = splitThinking('Hold on.\n<think>still working through it');
  assert.deepEqual(segments, [
    { kind: 'text', content: 'Hold on.' },
    { kind: 'think', content: 'still working through it' },
  ]);
});

test('splitThinking drops an empty reasoning block', () => {
  assert.deepEqual(splitThinking('<think></think>\nHi.'), [{ kind: 'text', content: 'Hi.' }]);
});

test('splitThinking reads an opener that carries attributes', () => {
  // A finetune emitting `<think seconds="12">` wants the same treatment as one
  // emitting `<think>`, and an unrecognised opener costs twice: the
  // deliberation is shown as the answer and then resent as settled fact.
  const segments = splitThinking('<think seconds="12">\nweigh it\n</think >\nThe answer is 42.');
  assert.deepEqual(segments, [
    { kind: 'think', content: 'weigh it' },
    { kind: 'text', content: 'The answer is 42.' },
  ]);
});

test('splitThinking leaves <thinking> alone — it is a different tag', () => {
  const text = '<thinking>\nnot ours\n</thinking>';
  assert.deepEqual(splitThinking(text), [{ kind: 'text', content: text }]);
});

test('an action written without its fence still runs, for a type that exists', () => {
  // Reported as a playlist that never played: the model emitted the object
  // alone on a line and the JSON was printed at the user instead of being run.
  const reply = 'Роблю плейліст.\n{"type":"queue_music","steps":"pearl jam"}';
  const known = (type) => type === 'queue_music';
  assert.deepEqual(extractActions(reply, { known }), [{ type: 'queue_music', steps: 'pearl jam' }]);
  // And it leaves the prose, rather than the wiring, on screen.
  assert.equal(stripBlocks(reply), 'Роблю плейліст.');
});

test('an unfenced object for a type nobody declares is left as prose', () => {
  // The guard that makes the fallback safe: without it every reply quoting an
  // action object would run one.
  const reply = 'Формат такий:\n{"type":"make_coffee","steps":"double"}';
  assert.deepEqual(extractActions(reply, { known: (type) => type === 'queue_music' }), []);
});

test('a fenced action wins, and the unfenced scan does not run at all', () => {
  // A reply that asked properly must never have a second action found in the
  // sentence where it described what it was doing.
  const reply = [
    'Opening it.',
    '```action',
    '{"type":"queue_music","steps":"pearl jam"}',
    '```',
    '{"type":"queue_music","steps":"something else"}',
  ].join('\n');
  const found = extractActions(reply, { known: () => true });
  assert.deepEqual(found, [{ type: 'queue_music', steps: 'pearl jam' }]);
});

test('a line that merely starts with a brace is prose and stays put', () => {
  const reply = 'Пиши так: {"type": ... } і не забудь steps.';
  assert.deepEqual(extractActions(reply, { known: () => true }), []);
  assert.equal(stripBlocks(reply), reply);
});

test('an object sharing its line with words is not an action', () => {
  // Anchored to both ends of the line on purpose: the safety of this whole
  // fallback rests on "a line holding nothing but an action object is not prose".
  const reply = 'Ось приклад: {"type":"queue_music","steps":"pearl jam"} — зрозуміло?';
  assert.deepEqual(extractActions(reply, { known: () => true }), []);
  assert.equal(stripBlocks(reply), reply);
});
