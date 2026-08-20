/**
 * What the prompt says while a game is running.
 *
 * Reported against `fantasy-rpg`, a third-party plugin whose whole interaction
 * is "press what the panel offers" and whose fragment says in as many words to
 * end a turn on the scenery and never list the options. Shipping the app's own
 * "OFFERING A CHOICE" section unconditionally put those two instructions
 * against each other, with the worked example on the app's side. Two symptoms,
 * one cause: replies that ended in a menu the panel had already drawn, and —
 * worse — "press one of the class cards on screen" from a model that had never
 * called the action that deals them, because the game starts only when it does.
 *
 * That second symptom is why the gate is a *registered presenter* and not a
 * scene on screen: a run starts with the panel empty, so the tighter-looking
 * question was open at exactly the turn that mattered.
 *
 * This file is the wiring. `prompts.test.mjs` proves `choices: false` removes
 * the section and `scene.test.mjs` proves `hasPresenter` answers correctly —
 * and both would go on passing if the agent simply never asked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

// Before the import, not after: an ESM graph is evaluated in full before this
// body runs, and anything reading settings at module scope would resolve the
// platform default root instead.
setDataRoot(mkdtempSync(join(tmpdir(), 'wl-game-prompt-')));

const { Agent } = await import('../src/main/agent/agent.mjs');
const { Scene } = await import('../src/main/scene.mjs');

/** Enough of the app for `contextFor`, which is the cheapest view of a prompt's size. */
function build() {
  const scene = new Scene();
  const agent = new Agent({
    server: { contextSize: 100_000 },
    plugins: { promptFragments: () => ['FANTASY RPG — {"type":"fantasy_rpg","steps":"<move>"}'] },
    scene,
  });
  return { agent, scene };
}

const present = (scene) => scene.present({ pluginId: 'fantasy-rpg', act: () => ({}) });

test('a game driving the session takes the choice section out of the prompt', () => {
  const { agent, scene } = build();
  const idle = agent.contextFor('chat-a').used;

  present(scene);
  const playing = agent.contextFor('chat-a').used;

  assert.ok(playing < idle, `the section should be gone: ${idle} → ${playing}`);
  // Roughly the size of what was removed, rather than a stray word: a check
  // that only asked for "different" would pass on almost any mistake.
  assert.ok(idle - playing > 100, `expected a whole section, lost ${idle - playing} tokens`);
});

test('and it is gone before the first scene is ever shown', () => {
  // The reported failure, exactly. A run begins with nothing on the panel, and
  // the turn that starts it is the one the model has to spend calling the
  // game's action rather than describing cards it has not dealt.
  const { agent, scene } = build();
  present(scene);

  assert.equal(scene.status().active, false, 'no scene yet — this is the opening turn');
  const opening = agent.contextFor('chat-a').used;

  scene.setTurn('chat-a');
  scene.show({ title: 'Village of Mara — day 4' });
  assert.equal(agent.contextFor('chat-a').used, opening, 'the panel appearing changes nothing either way');
});

test('a game reaches every conversation, because the model does', () => {
  // Blunter than gating per chat, and deliberately so: the plugin's fragment is
  // in the prompt of every conversation while it is switched on, so the section
  // it competes with has to be out of every one of them too.
  const { agent, scene } = build();
  const idle = agent.contextFor('chat-b').used;
  present(scene);
  assert.ok(agent.contextFor('chat-b').used < idle);
});

test('switching the game off hands the choice section back', () => {
  const { agent, scene } = build();
  present(scene);
  const playing = agent.contextFor('chat-a').used;

  scene.releasePlugin('fantasy-rpg');
  assert.ok(agent.contextFor('chat-a').used > playing, 'the section should be back once nothing is driving');
});

test('an app with no scene service at all still builds a prompt', () => {
  // `scene` is optional on the constructor, and a build without one must not
  // fall over on an optional call written as if it were always there.
  const agent = new Agent({ server: { contextSize: 100_000 }, plugins: { promptFragments: () => [] } });
  assert.ok(agent.contextFor('chat-a').used > 0);
});
