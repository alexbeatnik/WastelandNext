/**
 * How the system prompt is assembled.
 *
 * What each capability *says* moved out with the plugin that provides it, and
 * is asserted in `plugins.test.mjs` — through the host, against the real
 * built-ins, which is the only place the pairing of "documented" and
 * "dispatchable" can actually be checked. What is left here is the assembly
 * itself: the invariant that a capability nobody contributed is absent rather
 * than forbidden, because a model told about a tool it may not use reaches for
 * it anyway and the refusal reads to the user as a bug.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt } from '../src/main/agent/prompts.mjs';

test('a contributed fragment is in the prompt, and nothing else is', () => {
  const prompt = buildSystemPrompt({ fragments: ['TOOL — {"type":"do_thing"}'] });
  assert.match(prompt, /do_thing/);
  assert.doesNotMatch(prompt, /system_shell/);
  assert.doesNotMatch(prompt, /read_file/);
});

test('fragments appear in the order they were given', () => {
  const prompt = buildSystemPrompt({ fragments: ['FIRST THING', 'SECOND THING'] });
  assert.ok(prompt.indexOf('FIRST THING') < prompt.indexOf('SECOND THING'));
});

test('the action protocol is present only when something can act', () => {
  assert.match(buildSystemPrompt({ fragments: ['ANYTHING'] }), /```action/);
  const bare = buildSystemPrompt({ fragments: [] });
  assert.match(bare, /no tools enabled/);
  assert.doesNotMatch(bare, /```action/);
});

test('an empty fragment does not conjure the protocol out of nothing', () => {
  // A plugin that registers an action but no prompt text still leaves the model
  // with nothing to write, and an ACTIONS heading with no actions under it is
  // an invitation to invent one.
  const prompt = buildSystemPrompt({ fragments: ['', '   '] });
  assert.match(prompt, /no tools enabled/);
});

test('the user prompt is appended last so it wins', () => {
  const prompt = buildSystemPrompt({ fragments: [], userPrompt: 'Always answer in Ukrainian.' });
  assert.ok(prompt.trimEnd().endsWith('Always answer in Ukrainian.'));
});

test('an empty user prompt adds no empty section', () => {
  assert.doesNotMatch(buildSystemPrompt({ fragments: [], userPrompt: '   ' }), /ADDITIONAL INSTRUCTIONS/);
});

test('turn context is included, heading and all', () => {
  // The heading travels with the text rather than being added here: a second
  // plugin contributing context would otherwise have its lines filed under the
  // first one's heading.
  const prompt = buildSystemPrompt({
    fragments: ['ANYTHING'],
    context: "CURRENT PAGE\nURL: https://a.test\nMain: 'Sign in'",
  });
  assert.match(prompt, /CURRENT PAGE/);
  assert.match(prompt, /Sign in/);
});

test('empty context adds nothing', () => {
  assert.doesNotMatch(buildSystemPrompt({ fragments: [], context: '  \n ' }), /CURRENT PAGE/);
});

test('markdown is permitted, and formatting is not up for debate', () => {
  // The rule used to forbid markdown — inherited from the C build, which drew
  // glyphs and could not render it — while the next paragraph demanded a fenced
  // action block. A model spent an entire budget deliberating over that
  // contradiction instead of answering. The view renders markdown now, so the
  // rule allows it and says explicitly not to agonise.
  const prompt = buildSystemPrompt({ fragments: ['ANYTHING'] });
  assert.match(prompt, /Markdown is rendered/i);
  assert.match(prompt, /Never deliberate about formatting/i);
  assert.doesNotMatch(prompt, /no markdown headings/i);
});

test('nothing in the base rules forbids what the protocol demands', () => {
  const prompt = buildSystemPrompt({ fragments: ['ANYTHING'] });
  assert.ok((prompt.match(/```action/g) ?? []).length >= 1, 'expected the protocol to show a fence');
  assert.doesNotMatch(prompt, /no (markdown|code fences|fenced)/i);
});
