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

const MAX_TITLE = 80;
const MAX_LABEL = 48;
const MAX_VALUE = 32;
const MAX_NOTE = 120;
const MAX_HINT = 200;
const MAX_ID = 64;
/** A line for the status bar, and the words a button puts in the composer. */
const MAX_STATUS = 200;
const MAX_SUBMIT = 400;

const MAX_METERS = 8;
const MAX_FIELDS = 10;
const MAX_TAGS = 10;
const MAX_GROUPS = 6;
const MAX_ITEMS = 60;
/**
 * Buttons on the action row.
 *
 * Twelve is already more than fits on a narrow window, and the row wraps rather
 * than scrolling sideways — an action scrolled out of sight is one the player
 * cannot see to press, which is the same complaint the attachment chips answer.
 */
const MAX_ACTIONS = 12;

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

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
      if (itemLabel) items.push({ label: itemLabel, note: text(item?.note, MAX_NOTE), tone: tone(item?.tone) });
    }
    scene.groups.push({
      label,
      items,
      // The plugin's words for an empty list, not ours: only it knows whether
      // the right sentence is "no items" or "the journal is blank".
      empty: text(entry?.empty, MAX_NOTE),
    });
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
          }
        : null,
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
  async act(actionId) {
    const presenter = this.#presenter;
    if (!presenter) throw new Error('no game is running');

    const id = text(actionId, MAX_ID);
    if (!this.#scene?.actions.some((action) => action.id === id)) {
      throw new Error('that action is no longer on offer');
    }

    const answer = (await presenter.act(id)) ?? {};
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
    };
  }
}

export const scene = new Scene();
