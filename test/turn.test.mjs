/**
 * The turn pipeline, driven end to end against a fake endpoint.
 *
 * Everything here is asserted somewhere already, in pieces: `window.test.mjs`
 * proves `stripThinking` removes reasoning, `actions.test.mjs` proves a fence
 * parses, `plugins.test.mjs` proves a switched-off plugin is still *known*. What
 * none of them can see is whether the pipeline asks. That is the shape of bug
 * `deleted-chat.test.mjs` and `game-prompt.test.mjs` were both written for —
 * two tests passing either side of missing wiring — and this is the same third
 * test for the turn loop itself: a real `Agent`, real chat storage, real action
 * parsing, and nothing faked below `fetch`.
 *
 * The invariants it holds down are the ones whose failure is silent: a
 * `reply:start` with no `reply:end` leaves a blinking cursor in the transcript
 * forever, a plugin throwing must not end the turn, reasoning must never be
 * resent as settled fact, and a model that keeps asking for work must run out
 * of turns.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-turn-')));

const { Agent } = await import('../src/main/agent/agent.mjs');
const chats = await import('../src/main/chats.mjs');

/** One reply, as an endpoint streams it. */
function stream(text) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

/**
 * An endpoint that answers with a queued reply and records what it was asked.
 *
 * The last reply repeats, so a test about a model that will not stop asking for
 * work does not have to guess how many times it will be called.
 */
function fakeModel(replies, { gate = null, fail = null } = {}) {
  const original = globalThis.fetch;
  const asked = [];
  const queue = [...replies];

  globalThis.fetch = async (_url, init) => {
    asked.push(JSON.parse(init.body));
    if (gate) await gate;
    if (fail) throw new Error(fail);
    return stream(queue.length > 1 ? queue.shift() : (queue[0] ?? ''));
  };

  return {
    asked,
    /** The model calls that are turns, as opposed to titling or compaction. */
    get turns() {
      return asked.filter((body) => String(body.messages[0]?.content).startsWith('You are Wasteland'));
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Enough of the app around the agent to run a turn through it. */
function build({ usable = true, actions = {}, owners = {} } = {}) {
  const events = [];
  const agent = new Agent({
    server: { usable, baseUrl: 'http://127.0.0.1:1', contextSize: 100_000 },
    plugins: {
      ready: Promise.resolve(),
      beginTurn() {},
      promptFragments: () => [],
      context: async () => '',
      action: (type) => actions[type] ?? null,
      owner: (type) => owners[type] ?? null,
    },
  });
  agent.on('event', (event) => events.push(event));
  return { agent, events, named: (name) => events.filter((event) => event.event === name) };
}

const fence = (type, steps) => '```action\n' + JSON.stringify({ type, steps }) + '\n```';

test('a turn with no model behind it writes nothing at all', async () => {
  // Checked before the chat is created, which is what lets the renderer hand
  // the words back to the composer: after `turn:start` the message is recorded,
  // and returning it as well would show it twice.
  const { agent, events } = build({ usable: false });
  const before = chats.list().length;

  await assert.rejects(agent.send('', 'is anyone home?'), /no model loaded/);
  assert.equal(chats.list().length, before, 'a failed send must leave no orphan user turn');
  assert.deepEqual(events, [], 'and nothing on screen to explain away');
});

test('a second turn is refused while the first is running', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const model = fakeModel(['first'], { gate });
  const { agent } = build();

  try {
    const first = agent.send('', 'the one that got there first');
    // Past `await plugins.ready`, which is where the turn takes the lock.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(agent.send('', 'and the one that did not'), /already running/);

    release();
    await first;
  } finally {
    model.restore();
  }
});

test('a dead endpoint still pays the reply:end it owes', async () => {
  // `reply:start` puts a live, cursor-blinking element on screen. Without the
  // matching end it blinks there for the rest of the session.
  const model = fakeModel([], { fail: 'connect ECONNREFUSED' });
  const { agent, events, named } = build();

  try {
    await assert.rejects(agent.send('', 'anyone there?'), /ECONNREFUSED/);
  } finally {
    model.restore();
  }

  assert.equal(named('reply:start').length, 1);
  const [end] = named('reply:end');
  assert.ok(end, 'a start with no end is the bug this test exists for');
  assert.match(end.error, /ECONNREFUSED/);
  assert.equal(end.text, '');

  // And in that order: the end is owed on the way out, not merely emitted
  // somewhere. `turn:end` is the renderer's second backstop for the same fact.
  const order = events.map((event) => event.event).filter((name) => name.startsWith('reply:') || name === 'turn:end');
  assert.deepEqual(order, ['reply:start', 'reply:end', 'turn:end']);
});

test('the fences are stored and the prose is what gets drawn', async () => {
  // The raw reply is persisted because the model needs to see its own actions
  // next turn; stripping it is a view, applied where it is rendered.
  const model = fakeModel([`Looking that up.\n${fence('web_lookup', 'gulls')}`, 'Gulls']);
  const { agent, named } = build();

  let chatId;
  try {
    chatId = await agent.send('', 'what do gulls eat?');
  } finally {
    model.restore();
  }

  const stored = chats.read(chatId).messages.find((message) => message.role === 'assistant');
  assert.match(stored.content, /```action/, 'the model has to see what it did');
  const [end] = named('reply:end');
  assert.equal(end.rendered, 'Looking that up.', 'and the user has to see prose');
});

test('a plugin that throws feeds the model, rather than ending the turn', async () => {
  // A third-party typo must not leave the transcript with a live cursor and no
  // reply. A handler that throws produces feedback the model can act on,
  // exactly as one returning a failure does.
  const model = fakeModel([`Right away.\n${fence('play_music', 'pearl jam')}`, 'The library has moved, it seems.']);
  const { agent, named } = build({
    actions: {
      play_music: {
        pluginId: 'audio-player',
        run() {
          throw new Error('the library moved');
        },
      },
    },
  });

  let chatId;
  try {
    chatId = await agent.send('', 'play some pearl jam');
  } finally {
    model.restore();
  }

  assert.ok(chatId, 'the turn finished');
  const [result] = named('action:result');
  assert.equal(result.ok, false);
  assert.match(result.summary, /the library moved/);

  // The follow-up is the whole point: the model is told, in words it can use.
  assert.equal(model.turns.length, 2);
  const followUp = JSON.stringify(model.turns[1].messages);
  assert.match(followUp, /\[ACTION FAILED\] play_music/);
  assert.match(followUp, /do not retry it/);
  assert.equal(named('reply:end').length, 2, 'every round owes its own end');
  assert.equal(named('turn:end').length, 1);
});

test('a declared action that is switched off is refused in words', async () => {
  // Told "unknown action type", a model retries with different spelling. Told
  // which plugin is off, it tells the user — so the dispatcher asks the
  // manifest, not the map of what happens to be loaded.
  const model = fakeModel([fence('browser_steps', 'open the news'), 'Browser control is switched off.']);
  const { agent, named } = build({ owners: { browser_steps: { id: 'manul-browser', name: 'Browser control' } } });

  try {
    await agent.send('', 'open the news');
  } finally {
    model.restore();
  }

  const [refusal] = named('action:result');
  assert.equal(refusal.ok, false);
  assert.match(refusal.summary, /Browser control is switched off/);
  assert.equal(named('log').some((entry) => /unknown action type/.test(entry.text)), false);
  assert.match(JSON.stringify(model.turns[1].messages), /\[ACTION REFUSED\] Browser control is switched off/);
});

test('a model that will not stop asking for work runs out of turns', async () => {
  // Bounded, or a stubborn model loops forever — and every round is a real
  // completion against a real endpoint.
  const model = fakeModel([`Again.\n${fence('do_thing', 'once more')}`]);
  const { agent, named } = build({
    actions: { do_thing: { pluginId: 'looper', run: async () => ({ ok: true, feedback: 'done; do it again' }) } },
  });

  try {
    await agent.send('', 'keep going');
  } finally {
    model.restore();
  }

  assert.equal(model.turns.length, 4, 'the first turn and three follow-ups');
  assert.ok(
    named('log').some((entry) => /follow-up limit \(3\) reached/.test(entry.text)),
    'and it says so, rather than stopping silently',
  );
});

test('reasoning is kept in the transcript and never sent back', async () => {
  // A model re-reads its own deliberation as settled fact, and on a small
  // window the deliberation dwarfs the answer. `window.test.mjs` proves
  // `stripThinking` removes it; this proves the pipeline calls it.
  const model = fakeModel(['<think>\nThe user wants a number.\n</think>\nForty-two.', 'Still forty-two.']);
  const { agent } = build();

  let chatId;
  try {
    chatId = await agent.send('', 'pick a number');
    await agent.send(chatId, 'are you sure?');
  } finally {
    model.restore();
  }

  const stored = chats.read(chatId).messages.find((message) => message.role === 'assistant');
  assert.match(stored.content, /<think>/, 'the transcript keeps it — the view dims it');

  const resent = JSON.stringify(model.turns.at(-1).messages);
  assert.equal(/<think>/.test(resent), false, 'and the model never reads it back');
  assert.match(resent, /Forty-two\./, 'the answer itself does go back');
});

test('the model names the conversation once, on the first turn only', async () => {
  const model = fakeModel(['A reply worth naming.', 'Gulls and What They Eat', 'A second reply.']);
  const { agent, named } = build();

  let chatId;
  try {
    chatId = await agent.send('', 'what do gulls eat?');
  } finally {
    model.restore();
  }

  assert.equal(chats.read(chatId).title, 'Gulls and What They Eat');
  const [renamed] = named('chat:renamed');
  assert.equal(renamed.chatId, chatId);

  // The second turn is answered and nothing else: the model gets to name a
  // conversation once, from the exchange that opened it.
  const again = fakeModel(['Mostly fish.', 'Another Title Entirely']);
  try {
    await agent.send(chatId, 'and in winter?');
  } finally {
    again.restore();
  }
  assert.equal(again.asked.length, 1, 'no second titling call');
  assert.equal(chats.read(chatId).title, 'Gulls and What They Eat');
});
