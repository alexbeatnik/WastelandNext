/**
 * The prompt must not describe a tool the dispatcher will refuse: a model told
 * about a capability reaches for it, and the refusal reads to the user as a bug.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, pageMapContext } from '../src/main/agent/prompts.mjs';

test('a disabled capability is absent, not forbidden', () => {
  const prompt = buildSystemPrompt({ capabilities: { browser: true } });
  assert.match(prompt, /browser_steps/);
  assert.doesNotMatch(prompt, /system_shell/);
  assert.doesNotMatch(prompt, /read_file/);
  assert.doesNotMatch(prompt, /web_lookup/);
});

test('every capability on documents every action type', () => {
  const prompt = buildSystemPrompt({
    capabilities: { browser: true, webLookup: true, readFile: true, shell: true },
  });
  for (const type of ['browser_steps', 'browser_close', 'web_lookup', 'read_file', 'system_shell']) {
    assert.match(prompt, new RegExp(type), `${type} should be documented`);
  }
});

test('with no capabilities the model is told it has none', () => {
  const prompt = buildSystemPrompt({ capabilities: {} });
  assert.match(prompt, /no tools enabled/);
  assert.doesNotMatch(prompt, /```action/);
});

test('the user prompt is appended last so it wins', () => {
  const prompt = buildSystemPrompt({ capabilities: {}, userPrompt: 'Always answer in Ukrainian.' });
  assert.ok(prompt.trimEnd().endsWith('Always answer in Ukrainian.'));
});

test('an empty user prompt adds no empty section', () => {
  assert.doesNotMatch(buildSystemPrompt({ capabilities: {}, userPrompt: '   ' }), /ADDITIONAL INSTRUCTIONS/);
});

test('page context is included when there is a page', () => {
  const prompt = buildSystemPrompt({ capabilities: { browser: true }, pageContext: "URL: https://a.test\nMain: 'Sign in'" });
  assert.match(prompt, /CURRENT PAGE/);
  assert.match(prompt, /Sign in/);
});

test('pageMapContext flattens a map into quoted labels', () => {
  const context = pageMapContext({
    url: 'https://a.test',
    groups: [
      { name: 'Main', elements: [{ label: 'Sign in' }, { label: 'Register' }], truncated: 0 },
      { name: 'Nav', elements: [{ label: 'Home' }], truncated: 3 },
    ],
  });
  assert.match(context, /URL: https:\/\/a\.test/);
  assert.match(context, /Main: 'Sign in', 'Register'/);
  assert.match(context, /Nav: 'Home' \(\+3 more\)/);
});

test('pageMapContext is empty when there is nothing to describe', () => {
  assert.equal(pageMapContext(null), '');
  assert.equal(pageMapContext({ url: 'https://a.test', groups: [] }), '');
});

test('markdown is permitted, and formatting is not up for debate', () => {
  // The rule used to forbid markdown — inherited from the C build, which drew
  // glyphs and could not render it — while the next paragraph demanded a fenced
  // action block. A model spent an entire budget deliberating over that
  // contradiction instead of answering. The view renders markdown now, so the
  // rule allows it and says explicitly not to agonise.
  const prompt = buildSystemPrompt({ capabilities: { browser: true } });
  assert.match(prompt, /Markdown is rendered/i);
  assert.match(prompt, /Never deliberate about formatting/i);
  assert.doesNotMatch(prompt, /no markdown headings/i);
});

test('the browser section shows the two-turn search flow', () => {
  // "Never use positional targets" with no recipe for an unknown title left the
  // model stuck between guessing and refusing.
  const prompt = buildSystemPrompt({ capabilities: { browser: true } });
  assert.match(prompt, /TWO turns/);
  assert.match(prompt, /search_query=/);
  assert.match(prompt, /CLICK the 'Exact Title As Listed'/);
});

test('the action fence is shown, and nothing forbids it', () => {
  const prompt = buildSystemPrompt({
    capabilities: { browser: true, webLookup: true, readFile: true, shell: true },
  });
  assert.ok((prompt.match(/```action/g) ?? []).length >= 1, 'expected the protocol to show a fence');
  // No rule anywhere may tell the model not to produce the thing the protocol
  // requires of it.
  assert.doesNotMatch(prompt, /no (markdown|code fences|fenced)/i);
});

test('the browser section says a resolved step is not a reached goal', () => {
  // A model told "all steps succeeded" stops checking and repeats itself; this
  // is what let one loop five times on a sort that never applied.
  const prompt = buildSystemPrompt({ capabilities: { browser: true } });
  assert.match(prompt, /does NOT mean the page did what you wanted/i);
  assert.match(prompt, /check CURRENT PAGE/i);
});

test('the browser section offers a route out of a stuck interaction', () => {
  const prompt = buildSystemPrompt({ capabilities: { browser: true } });
  assert.match(prompt, /do not send the same steps again/i);
  assert.match(prompt, /query parameters/i);
  assert.match(prompt, /will be refused/i);
});
