/**
 * The game panel.
 *
 * The interesting cases are all about the boundary. A scene is written by a
 * plugin, and most of what a plugin writes into one started life as model
 * output — an item a language model named, a journal line it wrote — so this
 * service is the place where "whatever the plugin passed" becomes "a document
 * with a known shape". What it refuses is the whole of what the renderer is
 * protected from.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOTKEYS, Scene, normaliseScene } from '../src/main/scene.mjs';

test('a scene keeps what it can draw and drops what it cannot', () => {
  const scene = normaliseScene({
    title: 'Village of Mara — day 4',
    subtitle: 'the common room',
    meters: [
      { label: 'HP', value: 12, max: 20, tone: 'bad' },
      { label: 'Gold', value: 14 },
      { value: 3 },
    ],
    fields: [{ label: 'Quest', value: 'find the hunters' }, { value: 'no label' }],
    tags: [{ label: 'Bleeding', tone: 'bad' }, { label: '' }],
    actions: [
      { id: 'look', label: 'Look around' },
      { id: 'inventory', label: 'Inventory' },
      { label: 'no id' },
      { id: 'no-label' },
    ],
  });

  assert.equal(scene.title, 'Village of Mara — day 4');
  assert.deepEqual(
    scene.meters.map((meter) => meter.label),
    ['HP', 'Gold'],
    'a meter with no label has nothing to draw',
  );
  assert.equal(scene.meters[1].max, 0, 'no maximum stays no maximum — a bare number, not a bar');
  assert.deepEqual(scene.fields.map((field) => field.label), ['Quest']);
  assert.deepEqual(scene.tags.map((tag) => tag.label), ['Bleeding']);
  assert.deepEqual(
    scene.actions.map((action) => action.id),
    ['look', 'inventory'],
    'a button with no id has nothing to send back and one with no label nothing to say',
  );
});

test('a tone is one of three words or it is nothing', () => {
  // The one field that becomes a class name. Everything else in a scene lands
  // in a textContent, where the worst a hostile string does is look silly.
  const scene = normaliseScene({
    tags: [{ label: 'ok', tone: 'good' }, { label: 'odd', tone: 'modal-box" onclick="' }],
    actions: [{ id: 'a', label: 'A', tone: 'danger' }],
  });
  assert.equal(scene.tags[0].tone, 'good');
  assert.equal(scene.tags[1].tone, '');
  assert.equal(scene.actions[0].tone, '', 'a word the stylesheet does not know is not a tone');
});

test('the app assigns the hotkeys, by position', () => {
  // Not the plugin: two actions asking for the same key is a conflict with no
  // good answer, and a key that quietly did nothing because something else held
  // it is indistinguishable from a broken button.
  const scene = normaliseScene({
    actions: Array.from({ length: 11 }, (_, index) => ({ id: `a${index}`, label: `Action ${index}` })),
  });
  assert.equal(scene.actions[0].key, '1');
  assert.equal(scene.actions[8].key, '9');
  assert.equal(scene.actions[9].key, '', 'past nine there are no digits left to give');
  assert.equal(HOTKEYS.length, 9);
});

test('a label is one line, however it was written', () => {
  // These are drawn in a flex row. A newline arriving inside one would break the
  // layout from data, which is the one place a plugin should not reach.
  const scene = normaliseScene({ title: 'a\nb\t c', actions: [{ id: 'x', label: `${'y'.repeat(200)}` }] });
  assert.equal(scene.title, 'a b c');
  assert.ok(scene.actions[0].label.length < 100);
});

test('a list row can be pressed when the game gave it something to do', async () => {
  // A list is not always only a list. An inventory is the case: putting the
  // sword in your hand is a thing to do to a row, not a move to pick off a bar.
  const pressed = [];
  const scene = new Scene();
  scene.present({
    pluginId: 'game',
    act: (id) => {
      pressed.push(id);
      return id === 'bag' ? { sheet: true } : { status: 'In hand.' };
    },
  });
  scene.show({
    actions: [{ id: 'bag', label: 'Inventory' }],
    groups: [
      { label: 'ITEMS', items: [{ label: 'Sword', action: 'item-sword' }, { label: 'Herb' }] },
      { label: 'JOURNAL', items: [{ label: 'Day 1', note: 'arrived' }] },
    ],
  });

  const drawn = scene.status().scene;
  assert.equal(drawn.groups[0].items[0].action, 'item-sword');
  assert.equal(drawn.groups[0].items[1].action, '', 'a row with nothing to do stays a row');
  assert.equal(drawn.groups[1].items[0].action, '');

  // Pressable rows are on offer exactly as the moves are — the same guard, so a
  // stale click on a bag emptied three turns ago is refused the same way.
  assert.deepEqual(await scene.act('item-sword'), { status: 'In hand.', submit: '', sheet: false, board: false, cards: false });
  await assert.rejects(() => scene.act('item-herb'), /no longer on offer/);

  // And a move may ask for the sheet, which is the only way a plugin can.
  assert.deepEqual(await scene.act('bag'), { status: '', submit: '', sheet: true, board: false, cards: false });
  assert.deepEqual(pressed, ['item-sword', 'bag']);
});

test('a board is a picture with pressable places on it', async () => {
  /**
   * The markers, the roads and the labels are data, not paint. A game's map can
   * differ from run to run — the one this was built for shuffles which places
   * connect — so a painted map would be confidently wrong most of the time, and
   * a marker would be wherever the artist put it rather than where the game says.
   */
  const pressed = [];
  const scene = new Scene();
  scene.present({ pluginId: 'fantasy-rpg', act: (id) => (pressed.push(id), { status: 'walking' }) });
  scene.show({
    board: {
      image: 'maps/world.png',
      points: [
        { id: 'village', label: 'Village', x: 50, y: 84, here: true },
        { id: 'forest', label: 'Forest', x: 58, y: 56, tone: 'good', action: 'go-forest' },
        { id: 'tower', label: 'Tower', x: 200, y: -9 },
      ],
      links: [{ from: 'village', to: 'forest' }, { from: 'village', to: 'nowhere' }, { from: 'forest', to: 'forest' }],
    },
  });

  const board = scene.status().scene.board;
  assert.equal(board.src, 'wasteland-plugin://fantasy-rpg/%40data/maps/world.png', 'served from the data directory, which updates do not wipe');
  assert.equal(board.points[0].here, true, 'you are here is its own fact, not a shade of good or bad');
  assert.deepEqual([board.points[2].x, board.points[2].y], [100, 0], 'a marker is kept on the board');
  assert.deepEqual(board.links, [{ from: 'village', to: 'forest', tone: '' }], 'a road to nowhere is a line off the edge');

  // A place is on offer exactly as a move is — one guard, so they cannot drift.
  assert.equal((await scene.act('go-forest')).status, 'walking');
  await assert.rejects(() => scene.act('go-tower'), /no longer on offer/);
  assert.deepEqual(pressed, ['go-forest']);
});

test('a board picture cannot point outside the plugin', () => {
  const scene = new Scene();
  scene.present({ pluginId: 'game', act: () => ({}) });
  for (const image of ['../../secrets.png', '/etc/passwd', String.raw`C:\Windows\win.ini`, 'a/../../b.png']) {
    scene.show({ board: { image, points: [] } });
    assert.equal(scene.status().scene.board.src, '', image);
  }
  scene.show({ board: { image: 'ok/map.png', points: [] } });
  assert.ok(scene.status().scene.board.src.endsWith('ok/map.png'));
});

test('a move can ask for the board, as it can for the sheet', async () => {
  const scene = new Scene();
  scene.present({ pluginId: 'game', act: () => ({ board: true }) });
  scene.show({ actions: [{ id: 'map', label: 'Map' }] });
  assert.deepEqual(await scene.act('map'), { status: '', submit: '', sheet: false, board: true, cards: false });
});

test('a chooser is cards, and a card is on offer like anything else', async () => {
  /**
   * Picking who you are at the start of a run is not the same act as reading an
   * inventory, so it is not the same window. Cards are equal by construction —
   * the grid gives each the same width — so a longer paragraph cannot make one
   * of them look like the recommended answer.
   */
  const pressed = [];
  const scene = new Scene();
  scene.present({ pluginId: 'fantasy-rpg', act: (id) => (pressed.push(id), { status: 'chosen' }) });
  scene.show({
    cards: {
      label: 'Кто ты',
      items: [
        { label: 'Воин', note: 'тяжёлый и живучий', image: 'class-warrior.jpg', action: 'class-warrior' },
        { label: 'Маг', note: 'хрупкий', image: 'class-mage.jpg', action: 'class-mage' },
        { label: '', note: 'no name, no card' },
      ],
    },
  });

  const cards = scene.status().scene.cards;
  assert.equal(cards.label, 'Кто ты');
  assert.equal(cards.items.length, 2, 'a card with no name has nothing to choose');
  assert.equal(cards.items[0].src, 'wasteland-plugin://fantasy-rpg/%40data/class-warrior.jpg');

  assert.equal((await scene.act('class-mage')).status, 'chosen');
  await assert.rejects(() => scene.act('class-rogue'), /no longer on offer/);

  // Answering is what closes it: a scene redrawn without cards has nothing left
  // to ask, and the renderer keys on exactly that.
  scene.show({ title: 'Мира, Маг' });
  assert.equal(scene.status().scene.cards, null);
  assert.deepEqual(pressed, ['class-mage']);
});

test('a move can ask for the chooser', async () => {
  const scene = new Scene();
  scene.present({ pluginId: 'game', act: () => ({ cards: true }) });
  scene.show({ actions: [{ id: 'who', label: 'Who' }] });
  assert.deepEqual(await scene.act('who'), { status: '', submit: '', sheet: false, board: false, cards: true });
});

test('a scene belongs to the conversation it was painted in', () => {
  // The first version drew the strip over every chat in the app: open a new
  // conversation with an empty transcript and there was still a character sheet
  // and a row of moves, offering a game that was not being played.
  const scene = new Scene();
  scene.present({ pluginId: 'game', act: () => ({}) });

  scene.show({ title: 'before any turn' });
  assert.equal(scene.status().chatId, '', 'nothing outside a turn knows which chat this is');

  scene.setTurn('chat-a');
  scene.show({ title: 'a move' });
  assert.equal(scene.status().chatId, 'chat-a');

  // Between turns the claim stands: a timer redrawing the panel must not hand
  // the game to whichever conversation happens to be open.
  scene.setTurn('');
  scene.show({ title: 'a tick' });
  assert.equal(scene.status().chatId, 'chat-a');

  // A turn in a different conversation only moves it if the game draws there.
  scene.setTurn('chat-b');
  assert.equal(scene.status().chatId, 'chat-a', 'a turn elsewhere is not a move in this game');
  scene.show({ title: 'played here now' });
  assert.equal(scene.status().chatId, 'chat-b');
});

test('a cleared scene belongs to nobody', () => {
  const scene = new Scene();
  scene.present({ pluginId: 'game', act: () => ({}) });
  scene.setTurn('chat-a');
  scene.show({ title: 'a place' });
  scene.clear();
  assert.equal(scene.status().chatId, '');
  assert.equal(scene.status().active, false);
});

test('a scene with no presenter offers no moves', () => {
  // The rule the audio bar already follows: a driver that went away takes its
  // buttons with it. What the hero looked like is still worth showing — that is
  // a readable end state — but the moves would be dead controls.
  const scene = new Scene();
  scene.present({ pluginId: 'game', pluginName: 'Game', act: () => ({}) });
  scene.show({ title: 'A place', actions: [{ id: 'look', label: 'Look' }] });
  assert.equal(scene.status().scene.actions.length, 1);

  scene.releasePlugin('someone-else');
  assert.equal(scene.status().scene.actions.length, 1, 'another plugin going away is not this one going away');

  scene.releasePlugin('game');
  assert.equal(scene.status().active, false);
});

test('a scene survives being replaced, and every change is announced', () => {
  const scene = new Scene();
  const heard = [];
  scene.on('state', (status) => heard.push(status.scene?.title ?? null));

  scene.present({ pluginId: 'game', act: () => ({}) });
  scene.show({ title: 'first' });
  scene.show({ title: 'second' });
  scene.clear();
  assert.deepEqual(heard, [null, 'first', 'second', null]);
});

test('a button that is not on screen cannot be pressed', async () => {
  // A click carries an id the renderer read off a button, and a button can
  // outlive the scene that drew it. A stale one firing a move in a world three
  // turns further on is impossible to reproduce and easy to refuse.
  const pressed = [];
  const scene = new Scene();
  scene.present({
    pluginId: 'game',
    act: (id) => {
      pressed.push(id);
      return { submit: `I ${id}` };
    },
  });
  scene.show({ actions: [{ id: 'look', label: 'Look' }] });

  assert.deepEqual(await scene.act('look'), { status: '', submit: 'I look', sheet: false, board: false, cards: false });
  await assert.rejects(() => scene.act('attack'), /no longer on offer/);

  scene.show({ actions: [{ id: 'attack', label: 'Attack' }] });
  await assert.rejects(() => scene.act('look'), /no longer on offer/);
  assert.deepEqual(pressed, ['look']);
});

test('pressing a button with no game running says so', async () => {
  const scene = new Scene();
  await assert.rejects(() => scene.act('look'), /no game is running/);
});

test('a plugin answering with nothing is answered with nothing', async () => {
  // A move that only redraws the panel — opening the inventory — returns no
  // words to send, and that is the ordinary case rather than a failure.
  const scene = new Scene();
  scene.present({ pluginId: 'game', act: () => undefined });
  scene.show({ actions: [{ id: 'bag', label: 'Bag' }] });
  assert.deepEqual(await scene.act('bag'), { status: '', submit: '', sheet: false, board: false, cards: false });
});

test('a game cannot start a turn on its own', () => {
  // `act` hands the words back rather than sending them, and nothing else here
  // returns a `submit` at all. A move is sent because a person pressed a key.
  const scene = new Scene();
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(scene));
  assert.deepEqual(
    surface.filter((name) => name !== 'constructor' && !name.startsWith('#')).sort(),
    ['act', 'clear', 'present', 'releasePlugin', 'setTurn', 'show', 'status'],
  );
});

test('a presenter without an act() is refused', () => {
  const scene = new Scene();
  assert.throws(() => scene.present({ pluginId: 'game' }), /act\(\)/);
});

test('showing something that is not a scene changes nothing', () => {
  const scene = new Scene();
  scene.present({ pluginId: 'game', act: () => ({}) });
  scene.show({ title: 'here' });
  scene.show(null);
  scene.show('a string');
  assert.equal(scene.status().scene.title, 'here');
});
