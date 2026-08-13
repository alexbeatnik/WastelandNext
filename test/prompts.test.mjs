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
