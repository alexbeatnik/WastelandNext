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

test('the reply language is the question\'s, and outranks anything a plugin says', () => {
  /**
   * Reported from a real session: "What you can do?" typed in English, answered
   * in Ukrainian, by a model that was doing as it was told. `space-trader` is
   * installed with its language set to `uk`, and its fragment says — every turn,
   * game or no game — "Відповідай користувачеві українською". The base rule said
   * only "reply in the language the user wrote in", which is both vaguer and
   * earlier in the prompt, so the specific instruction won.
   *
   * The app cannot edit a third-party fragment, and should not try. What it can
   * do is stop being ambiguous: the rule now names the message rather than the
   * conversation, and says in as many words that a language named elsewhere in
   * this prompt does not override it. That is the same medicine every fragment
   * in this codebase is required to take — name the failure you exist to
   * prevent — applied to the app's own text for once.
   */
  const prompt = buildSystemPrompt({ fragments: ['Відповідай користувачеві українською.'] });
  assert.match(prompt, /language of the message you are answering/i);
  // The two clauses that do the work. Without the first, a long conversation in
  // one language swallows a question asked in another; without the second, any
  // plugin naming a language quietly becomes the app's language policy.
  assert.match(prompt, /not the language of\s+the conversation so far/i);
  assert.match(prompt, /even when a plugin's own\s+instructions say to write in one/i);
});

test('nothing in the base rules forbids what the protocol demands', () => {
  const prompt = buildSystemPrompt({ fragments: ['ANYTHING'] });
  assert.ok((prompt.match(/```action/g) ?? []).length >= 1, 'expected the protocol to show a fence');
  assert.doesNotMatch(prompt, /no (markdown|code fences|fenced)/i);
});

test('the choice fence is documented whether or not anything can act', () => {
  // Unlike an action, this is not a capability a plugin contributes — it is how
  // the model talks to the user, and it is true of a session with no tools at
  // all. A model that does not know the fence exists writes a numbered list and
  // asks the user to pick from it, which is a menu with nothing to press.
  for (const fragments of [[], ['TOOL — {"type":"do_thing"}']]) {
    const prompt = buildSystemPrompt({ fragments });
    assert.match(prompt, /```choices/);
    assert.match(prompt, /numbered list is not a menu/);
  }
});

test('the choice fence says the options are sent as the user, not acted on', () => {
  // The whole difference from an action: nothing here reaches a handler, the
  // words go down the path typed text takes. A model reading this as a tool
  // call would wait for a result that is never coming.
  assert.match(buildSystemPrompt({ fragments: [] }), /as if the user had typed/);
});

test('a game on screen takes the choice fence out of the prompt', () => {
  // Reported against `fantasy-rpg`, whose own fragment says in as many words to
  // end on the scenery and never list the options — while this section, longer
  // and carrying a worked example, told the model to do exactly that. The panel
  // already draws the moves; a second row under the reply is two menus for one
  // turn. Absent, not forbidden: an exception written into the text would be
  // one more rule for a small model to weigh against a worked example.
  const playing = buildSystemPrompt({ fragments: ['FANTASY RPG'], choices: false });
  assert.doesNotMatch(playing, /```choices/);
  assert.doesNotMatch(playing, /OFFERING A CHOICE/);
  // Everything else is untouched — this removes a section, it does not switch modes.
  assert.match(playing, /FANTASY RPG/);
  assert.match(playing, /```action/);
  assert.match(playing, /You are Wasteland/);
});

test('the fence comes back when no game is drawing its own moves', () => {
  assert.match(buildSystemPrompt({ fragments: ['FANTASY RPG'], choices: true }), /```choices/);
  assert.match(buildSystemPrompt({ fragments: [] }), /```choices/);
});
