/**
 * The game surface — a panel a plugin fills in and the app draws.
 *
 * A plugin cannot reach this window. `script-src 'self'`, context isolation and
 * a sandboxed preload are what make "approved to run Node code in the main
 * process" a smaller promise than "approved to run code beside the transcript",
 * and a plugin shipping renderer JS would collapse the two. So the same bargain
 * the audio bar struck is struck again here: the plugin holds the state and
 * decides what the panel *says*, the app owns every pixel that says it.
 *
 * What crosses the boundary is therefore one plain document with a fixed set of
 * keys, and the renderer builds nodes from it — never markup. That is the same
 * rule model output already lives under, and it applies for the same reason:
 * much of what ends up in here *is* model output at one remove. An item a
 * language model invented the name of, an NPC it introduced, a line it wrote
 * into a journal — all of that reaches the panel through the plugin that
 * recorded it, and none of it is any more trustworthy for having been stored on
 * the way.
 *
 * Deliberately not a game engine. It knows a title, some meters, some lists,
 * and which buttons are on offer. It has no idea what a hit point is, what an
 * inventory means, or what happens when a button is pressed — the plugin
 * answers that, which is what lets a second plugin drive the same panel with a
 * completely different game behind it.
 *
 * Electron-free, like `audio.mjs` and `notify.mjs`: this file only decides what
 * a scene *is*, so it can be tested in plain Node.
 */
import { EventEmitter } from 'node:events';
import { pluginDataUrl } from '../shared/schemes.mjs';

/**
 * Tone words a scene may use.
 *
 * This is the one field that becomes a CSS class, so it is the one field that
 * cannot be passed through. Everything else in a scene is text going into a
 * `textContent`, where the worst a hostile string can do is look silly; a tone
 * taken on trust would let a plugin — or the model writing through it — name
 * any class in the stylesheet.
 */
const TONES = new Set(['good', 'warn', 'bad']);

/**
 * Accent words a meter may use.
 *
 * A tone says how something is *going* — good, warn, bad. What colour a bar is
 * says what it *stands for*, which is a different question and one the plugin
 * is the only one able to answer: health, mana and stamina sit side by side in
 * the same strip, and a player finds the one they want by colour long before
 * reading its label. A closed vocabulary for exactly the reason tones have one
 * — this becomes a class name, and a plugin naming its own colour would be a
 * plugin writing the stylesheet. The words are roles rather than colours, so a
 * theme stays free to decide what "life" looks like.
 */
const ACCENTS = new Set(['life', 'mana', 'vigour', 'growth', 'time']);

const MAX_TITLE = 80;
const MAX_LABEL = 48;
const MAX_VALUE = 32;
const MAX_NOTE = 120;
const MAX_HINT = 200;
const MAX_ID = 64;
/** A line for the status bar, and the words a button puts in the composer. */
const MAX_STATUS = 200;
const MAX_SUBMIT = 400;
/** What a player may type into a scene's one field: a name, not a paragraph. */
const MAX_ENTRY = 40;

const MAX_METERS = 8;
const MAX_FIELDS = 10;
const MAX_TAGS = 10;
/**
 * Lists behind the sheet button.
 *
 * Six was an arbitrary guess and a game outgrew it: quest, inventory, wounds,
 * who is here, journal, map and graveyard is seven, and the seventh was being
 * dropped in silence. The dialog scrolls, so the real limit is what a reader
 * will scan, not what fits.
 */
const MAX_GROUPS = 10;
const MAX_ITEMS = 60;
/**
 * Buttons on the action row.
 *
 * Twelve is already more than fits on a narrow window, and the row wraps rather
 * than scrolling sideways — an action scrolled out of sight is one the player
 * cannot see to press, which is the same complaint the attachment chips answer.
 */
const MAX_ACTIONS = 12;
/** Places on a board, and the roads between them. */
const MAX_POINTS = 24;
const MAX_LINKS = 60;
/** Cards in a chooser. More than eight is a list, and a list is the sheet. */
const MAX_CARDS = 8;

/**
 * The digits the app puts on the first nine actions.
 *
 * Assigned here, by position, rather than chosen by the plugin. Two plugins —
 * or one plugin on two turns — asking for the same key is a conflict with no
 * good resolution, and a key that silently did nothing because something else
 * had claimed it would be indistinguishable from a broken button. The cost is
 * that a key means a different thing after the list changes, which is true of
 * the buttons themselves anyway.
 */
export const HOTKEYS = '123456789';

/**
 * One label, as it will be drawn.
 *
 * Whitespace is collapsed rather than preserved: these are single-line labels in
 * a flex row, and a newline arriving inside one would break the row's layout
 * from data — the one place a plugin should not be able to reach.
 */
function text(value, limit) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function tone(value) {
  const word = String(value ?? '').trim();
  return TONES.has(word) ? word : '';
}

function accent(value) {
  const word = String(value ?? '').trim();
  return ACCENTS.has(word) ? word : '';
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A file inside the plugin's own data directory, or ''.
 *
 * The protocol handler checks confinement again where it reads, but a path that
 * could never work should fail here, where the plugin author can see why.
 */
function safeFile(value) {
  const path = String(value ?? '').trim();
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return '';
  return path.split(/[\\/]+/).every((part) => part && part !== '.' && part !== '..') ? path.slice(0, 120) : '';
}

function list(value, limit) {
  return (Array.isArray(value) ? value : []).slice(0, limit);
}

/**
 * Turn whatever a plugin passed into the document the renderer draws.
 *
 * Every field is optional and every one of them has a shape. A plugin that
 * leaves half of them out gets a panel with half of them missing, which is the
 * useful outcome; a plugin that fills one in wrongly gets that field dropped
 * rather than a throw, because a game that stops working because one label was
 * a number is worse than a game with one label missing.
 *
 * Exported for the tests: what this function refuses is the whole of what the
 * renderer is protected from.
 */
export function normaliseScene(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const scene = {
    title: text(raw.title, MAX_TITLE),
    subtitle: text(raw.subtitle, MAX_TITLE),
    /** A bar with a number under it: health, mana, the day out of thirty. */
    meters: [],
    /** A label and a value, for what has no maximum: gold, a location. */
    fields: [],
    /** A word that is either true of the hero or absent: bleeding, hunted. */
    tags: [],
    /** The collapsible lists behind the sheet button: items, journal, who is here. */
    groups: [],
    /** The row of buttons above the composer. */
    actions: [],
    /** A picture with pressable places on it, or null. */
    board: null,
    /** A row of pressable cards — a picture, a name, a paragraph — or null. */
    cards: null,
    /** One line for the player to fill in — a hero's name — or null. */
    entry: null,
  };

  for (const entry of list(raw.meters, MAX_METERS)) {
    const label = text(entry?.label, MAX_LABEL);
    if (!label) continue;
    const max = number(entry?.max, 0);
    scene.meters.push({
      label,
      value: number(entry?.value, 0),
      // A meter with no maximum is drawn as a bare number rather than as a bar
      // filled to an imaginary limit, so this is kept as given, zero included.
      max: max > 0 ? max : 0,
      tone: tone(entry?.tone),
      /** Which resource this is, so the strip can be read by colour. */
      accent: accent(entry?.accent),
    });
  }

  for (const entry of list(raw.fields, MAX_FIELDS)) {
    const label = text(entry?.label, MAX_LABEL);
    if (!label) continue;
    scene.fields.push({ label, value: text(entry?.value, MAX_VALUE), tone: tone(entry?.tone) });
  }

  for (const entry of list(raw.tags, MAX_TAGS)) {
    const label = text(entry?.label, MAX_LABEL);
    if (label) scene.tags.push({ label, tone: tone(entry?.tone) });
  }

  for (const entry of list(raw.groups, MAX_GROUPS)) {
    const label = text(entry?.label, MAX_LABEL);
    if (!label) continue;
    const items = [];
    for (const item of list(entry?.items, MAX_ITEMS)) {
      const itemLabel = text(item?.label, MAX_LABEL);
      if (!itemLabel) continue;
      items.push({
        label: itemLabel,
        note: text(item?.note, MAX_NOTE),
        tone: tone(item?.tone),
        /**
         * An action id, which turns the row into something pressable.
         *
         * A list is not always only a list: an inventory is the case that made
         * this necessary, where "wearing the sword" is a thing to do to a row
         * rather than a move to pick off a bar. Optional, so a journal stays a
         * journal — an entry that could be clicked and did nothing would be
         * worse than one that plainly cannot.
         */
        action: text(item?.action, MAX_ID),
      });
    }
    scene.groups.push({
      label,
      items,
      // The plugin's words for an empty list, not ours: only it knows whether
      // the right sentence is "no items" or "the journal is blank".
      empty: text(entry?.empty, MAX_NOTE),
    });
  }

  /**
   * A picture with pressable places on it.
   *
   * The image is scenery and nothing else: the markers, the roads and the
   * labels are drawn by the app from this data, over the top. That is not
   * tidiness — a game's map can differ from run to run (this one shuffles which
   * places connect), and a picture cannot know that. Drawn from data, the roads
   * are always the roads that exist, the labels are legible, and a marker is
   * where the game says it is rather than where a painter happened to put it.
   */
  if (raw.board && typeof raw.board === 'object') {
    const points = [];
    for (const entry of list(raw.board.points, MAX_POINTS)) {
      const id = text(entry?.id, MAX_ID);
      const label = text(entry?.label, MAX_LABEL);
      if (!id || !label) continue;
      points.push({
        id,
        label,
        note: text(entry?.note, MAX_NOTE),
        // Percentages of the board, so the same numbers work at any size and
        // nothing has to know how big the picture is.
        x: Math.max(0, Math.min(100, number(entry?.x, 50))),
        y: Math.max(0, Math.min(100, number(entry?.y, 50))),
        tone: tone(entry?.tone),
        /**
         * You are here.
         *
         * Its own flag rather than a fourth tone word: "where the piece stands"
         * is true of any board and is not a shade of good or bad, and the tone
         * vocabulary is deliberately three words that mean how something is
         * going.
         */
        here: entry?.here === true,
        action: text(entry?.action, MAX_ID),
      });
    }

    const known = new Set(points.map((point) => point.id));
    const links = [];
    for (const entry of list(raw.board.links, MAX_LINKS)) {
      const from = text(entry?.from, MAX_ID);
      const to = text(entry?.to, MAX_ID);
      // A road to nowhere is a line drawn off the edge of the board.
      if (from && to && from !== to && known.has(from) && known.has(to)) links.push({ from, to, tone: tone(entry?.tone) });
    }

    scene.board = { image: safeFile(raw.board.image), points, links };
  }

  /**
   * A chooser: equal cards, each with a picture over a name over a paragraph.
   *
   * The sheet could hold the same information as a list of rows, and that is
   * exactly why this exists separately — picking who you are at the start of a
   * run is not the same act as reading your inventory, and a choice that
   * matters reads better as a handful of things side by side than as lines down
   * a column. Cards are equal by construction: the grid gives every one the
   * same width, so a long description cannot make its card look like the
   * recommended answer.
   */
  if (raw.cards && typeof raw.cards === 'object') {
    const items = [];
    for (const entry of list(raw.cards.items, MAX_CARDS)) {
      const label = text(entry?.label, MAX_LABEL);
      if (!label) continue;
      items.push({
        label,
        // Longer than a list row's note: this is the paragraph somebody reads
        // before choosing, not a line of detail beside a name.
        note: text(entry?.note, MAX_HINT),
        image: safeFile(entry?.image),
        tone: tone(entry?.tone),
        action: text(entry?.action, MAX_ID),
      });
    }
    if (items.length) scene.cards = { label: text(raw.cards.label, MAX_TITLE), items };
  }

  /**
   * One line for the player to fill in.
   *
   * Added because a game asked a question the panel could not hold. A hero's
   * name used to be typed into the composer, on the argument that the composer
   * is a text field already and a second one would be a second place to look.
   * That argument was wrong in one particular way, and the wrongness was
   * reported as a bug: a name typed at the composer is a message, a message
   * goes to the model first, and a small model asked to pass a word through
   * sometimes answers it instead. The question is the game's, so the field to
   * answer it belongs to the game.
   *
   * Deliberately one line and nothing more. It is not a form: no second field,
   * no validation vocabulary, no types. A game that needs a form should be
   * asking something simpler.
   */
  if (raw.entry && typeof raw.entry === 'object') {
    const action = text(raw.entry.action, MAX_ID);
    // Without an id there is nowhere for the answer to go, which would be a
    // field that swallows what the player types.
    if (action) {
      scene.entry = {
        action,
        label: text(raw.entry.label, MAX_LABEL),
        hint: text(raw.entry.hint, MAX_HINT),
        placeholder: text(raw.entry.placeholder, MAX_LABEL),
        /** What the field starts out holding, so a question can be re-asked. */
        value: text(raw.entry.value, MAX_ENTRY),
        submit: text(raw.entry.submit, MAX_LABEL) || 'OK',
      };
    }
  }

  for (const entry of list(raw.actions, MAX_ACTIONS)) {
    const id = text(entry?.id, MAX_ID);
    const label = text(entry?.label, MAX_LABEL);
    // A button with no id has nothing to send back and a button with no label
    // has nothing to say. Either way it would be a control that cannot work.
    if (!id || !label) continue;
    scene.actions.push({
      id,
      label,
      hint: text(entry?.hint, MAX_HINT),
      tone: tone(entry?.tone),
      key: scene.actions.length < HOTKEYS.length ? HOTKEYS[scene.actions.length] : '',
    });
  }

  return scene;
}

export class Scene extends EventEmitter {
  /** The document on screen, or null when no game is running. */
  #scene = null;
  /** `{pluginId, pluginName, act}` — whoever is driving. */
  #presenter = null;
  /**
   * The conversation a turn is running in, while one is.
   *
   * Set from `ipc.mjs`, which is the only place that sees both a turn starting
   * and this object. The service itself has no idea what a conversation is and
   * should not learn: it draws a panel.
   */
  #turnChat = '';
  /**
   * The conversation this scene was last painted in.
   *
   * A game is played in a conversation, and the panel belongs there with it.
   * Without this the strip was drawn over every chat in the app — including a
   * brand new one with an empty transcript, where a character sheet and a row
   * of moves are an offer to play a game that is not there.
   */
  #chatId = '';

  status() {
    return {
      active: Boolean(this.#scene),
      pluginId: this.#presenter?.pluginId ?? '',
      pluginName: this.#presenter?.pluginName ?? '',
      /** Empty means "no conversation has claimed this", which draws nothing. */
      chatId: this.#chatId,
      scene: this.#scene
        ? {
            ...this.#scene,
            /**
             * Buttons are dropped when nobody is left to answer them.
             *
             * The same rule the audio bar follows: a transport that went away
             * takes its buttons with it, because a control that is drawn and
             * cannot work is worse than one that is absent. A scene switched off
             * mid-game still shows what the hero looked like — that is a
             * readable, honest end state — but it stops offering moves.
             */
            actions: this.#presenter ? this.#scene.actions : [],
            board: this.#board(),
            cards: this.#cards(),
          }
        : null,
    };
  }

  /**
   * The game acted in this turn, so the panel belongs to this conversation.
   *
   * `show()` claims a scene, which covers every game that repaints when it
   * acts. A scene painted *outside* a turn — from a timer, or at activation —
   * belongs to nobody, and before this nothing could ever claim it afterwards:
   * it stayed drawn nowhere until the plugin happened to repaint. Having acted
   * here is the evidence that closes that.
   *
   * Deliberately not "claim it for whichever conversation runs next". That is
   * the harm the rule above exists to prevent — a hero on screen for somebody
   * who opened the app to ask about the weather — so this is accepted only for
   * the plugin actually driving the panel, only inside a turn, and only when
   * there is something drawn. A plugin that draws nothing until it is played
   * still shows nothing, and no amount of claiming can invent a scene the app
   * was never given.
   */
  claimTurn(pluginId) {
    if (!this.#scene || !this.#turnChat) return;
    if (this.#presenter?.pluginId !== String(pluginId ?? '')) return;
    if (this.#chatId === this.#turnChat) return;
    this.#chatId = this.#turnChat;
    this.#announce();
  }

  /**
   * Is a game driving this session?
   *
   * Asked by the prompt, and deliberately broader than "is the panel up". The
   * first version gated on a scene being shown in this conversation, which
   * reads as the tighter and more careful answer and is wrong for the one
   * moment that matters: a run *starts* with nothing on screen. So at the exact
   * turn the model had to call the game's action, the prompt was still coaching
   * it on how to ask the user to pick something — and it duly wrote "press one
   * of the class cards on screen" without dealing any, because nothing had run.
   *
   * A registered presenter is a plugin that owns the panel and the moves for
   * this session, however little is drawn yet. While one exists the app has no
   * business offering a second way to ask a question. The cost is that a game
   * switched on takes the reply's own buttons out of every conversation, which
   * is the right trade: the game is the thing that breaks, and switching the
   * plugin off is one click on the row that turned it on.
   */
  hasPresenter() {
    return Boolean(this.#presenter);
  }

  /**
   * The board, with its picture turned into something the page can load.
   *
   * Built here and never in the renderer, for the reason the audio bar records:
   * the scheme and its encoding belong to the process that takes them apart
   * again, and a second encoder is a second thing to get wrong about a filename.
   * The file lives in the plugin's data directory, which updates do not wipe —
   * a map the user generated must not vanish on a version bump.
   */
  #board() {
    const board = this.#scene?.board;
    if (!board) return null;
    const id = this.#presenter?.pluginId ?? '';
    return { ...board, src: board.image && id ? pluginDataUrl(id, board.image) : '' };
  }

  /** The chooser, with each card's picture turned into something loadable. */
  #cards() {
    const cards = this.#scene?.cards;
    if (!cards) return null;
    const id = this.#presenter?.pluginId ?? '';
    return {
      ...cards,
      items: cards.items.map((item) => ({ ...item, src: item.image && id ? pluginDataUrl(id, item.image) : '' })),
    };
  }

  #announce() {
    this.emit('state', this.status());
  }

  /**
   * A plugin taking charge of the panel.
   *
   * One at a time, and the newcomer wins, for the reason `setTransport` gives:
   * showing a scene is a claim to be the thing being played, and leaving the
   * previous game's buttons on screen would offer moves in a world that is no
   * longer on screen.
   */
  present({ pluginId, pluginName = '', act }) {
    if (typeof act !== 'function') throw new Error('a game needs an act() function');
    this.#presenter = { pluginId: String(pluginId ?? ''), pluginName: String(pluginName ?? ''), act };
    this.#announce();
  }

  /**
   * Which conversation a turn is running in, or '' between turns.
   *
   * Told rather than asked, because the answer lives in the agent and this file
   * must stay free of everything but the panel.
   */
  setTurn(chatId) {
    this.#turnChat = String(chatId ?? '');
  }

  /**
   * Put a scene on screen, replacing whatever was there.
   *
   * A scene painted during a turn belongs to that turn's conversation. One
   * painted outside a turn — at activation, off a timer — keeps whichever
   * conversation claimed it last, and claims none if there has not been one:
   * nothing outside a turn knows which chat a game is being played in, and
   * guessing "the one that happens to be open" would put a hero on screen for
   * somebody who opened the app to ask about something else.
   *
   * The cost is that a run reopened after a restart shows no panel until the
   * first move, which is a smaller wrong answer than a panel over every
   * conversation in the app.
   */
  show(scene) {
    const next = normaliseScene(scene);
    if (!next) return this.status();
    this.#scene = next;
    if (this.#turnChat) this.#chatId = this.#turnChat;
    this.#announce();
    return this.status();
  }

  /** No game running, panel gone. */
  clear() {
    this.#scene = null;
    this.#chatId = '';
    this.#announce();
    return this.status();
  }

  /**
   * Called by the host when the plugin driving this is switched off.
   *
   * Every service may implement it; the host does not know what any particular
   * one is holding.
   */
  releasePlugin(pluginId) {
    if (this.#presenter?.pluginId !== pluginId) return;
    this.#presenter = null;
    this.clear();
  }

  /**
   * The player pressed one of the buttons.
   *
   * Answered by the plugin, which may do two different things and often does
   * both: redraw the panel by calling `show`, and hand back the words this
   * button stands for. Those words are returned rather than sent from here —
   * see `submit` below.
   *
   * Refused unless the id belongs to an action currently on offer. A click
   * carries an id the renderer read off a button, and a button can outlive the
   * scene that drew it: a stale one firing a move in a world three turns further
   * on is exactly the class of bug that is impossible to reproduce and easy to
   * prevent.
   */
  /** Every id currently pressable: the moves, and any list row that is one. */
  #offered() {
    const ids = new Set((this.#scene?.actions ?? []).map((action) => action.id));
    for (const group of this.#scene?.groups ?? []) {
      for (const item of group.items) if (item.action) ids.add(item.action);
    }
    for (const point of this.#scene?.board?.points ?? []) if (point.action) ids.add(point.action);
    for (const card of this.#scene?.cards?.items ?? []) if (card.action) ids.add(card.action);
    if (this.#scene?.entry?.action) ids.add(this.#scene.entry.action);
    return ids;
  }

  /**
   * @param actionId which control was used
   * @param value what was typed into the field, when the control is the field
   */
  async act(actionId, value = '') {
    const presenter = this.#presenter;
    if (!presenter) throw new Error('no game is running');

    const id = text(actionId, MAX_ID);
    if (!this.#offered().has(id)) {
      throw new Error('that action is no longer on offer');
    }

    // Cut to a line and a length here, so a plugin is handed a name and never
    // a paragraph however the field is driven.
    const answer = (await presenter.act(id, text(value, MAX_ENTRY))) ?? {};
    return {
      /** A line for the status bar: what happened, if nothing else says. */
      status: text(answer.status, MAX_STATUS),
      /**
       * The words to send as if the player had typed them, or ''.
       *
       * Handed back to the caller rather than sent from here, and the reason is
       * structural: a turn belongs to a conversation, and the main process does
       * not have a current one — the renderer does. Routing a move through the
       * window that knows which chat is open also means it goes down the same
       * path as typed text, so the busy check, the transcript entry and the
       * hand-back on failure are the ones that already work, rather than a
       * second implementation of each.
       *
       * It is also the only thing standing between a game and a loop. A move is
       * sent because a person pressed a key; nothing here can start a turn on
       * its own.
       */
      submit: text(answer.submit, MAX_SUBMIT),
      /**
       * Ask for the sheet to be opened.
       *
       * The dialog is the app's, so a plugin has no other way to say "look in
       * the bag" — and an inventory button that only wrote a line in the status
       * bar would be a control that describes the thing it should have shown.
       */
      sheet: answer.sheet === true,
      /**
       * Ask for the board to be opened, as `sheet` asks for the lists.
       *
       * Two flags rather than one `open: 'sheet'|'board'` because `sheet`
       * already shipped, and a plugin written against it must keep working.
       */
      board: answer.board === true,
      /** Ask for the chooser, as `sheet` and `board` ask for theirs. */
      cards: answer.cards === true,
      /** Ask for the field, which is how a game gets a name typed into it. */
      entry: answer.entry === true,
    };
  }
}

export const scene = new Scene();
