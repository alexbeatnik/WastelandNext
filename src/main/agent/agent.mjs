/**
 * The turn pipeline.
 *
 * One user message in; a streamed reply, zero or more dispatched actions, and
 * however many follow-up turns those actions earned, out. Everything the UI
 * shows is an event emitted from here, so the renderer holds no pipeline state
 * of its own and a reload cannot desynchronise it.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as chats from '../chats.mjs';
import * as config from '../config.mjs';
import { estimateTokens, streamChat } from '../llm/client.mjs';
import { COMPACT_PROMPT, buildSystemPrompt, titlePrompt } from './prompts.mjs';
import { extractActions, splitNarration, splitThinking, stripActionBlocks, stripThinking } from './actions.mjs';
import { Attachments } from './attach.mjs';

/** How many times one user message may bounce back through the model. */
const MAX_FOLLOW_UPS = 3;
/** Above this share of the context window, compact before the next send. */
const COMPACT_THRESHOLD = 0.75;
/** Messages kept verbatim when compacting — the last two exchanges. */
const KEEP_MESSAGES = 4;
/**
 * Tokens held back for the answer.
 *
 * The window is prompt *and* reply; measuring only the prompt against it says a
 * conversation is fine right up to the point where there is no room left to say
 * anything. A prompt at 4594 of 4608 leaves fourteen tokens for the reply, and
 * the model duly emitted a few words and stopped mid-sentence — which reads as
 * the app cutting it off. A quarter of a small window, capped, is enough for a
 * couple of paragraphs plus an action block.
 */
const REPLY_RESERVE = 1536;
/** Marks where `fitToWindow` cut a message that could not be dropped whole. */
const TRIM_NOTE = '\n\n[… trimmed to fit the context window …]\n\n';

/** How much of the window the prompt may occupy, leaving room to answer. */
export function promptBudget(max, reserve = REPLY_RESERVE) {
  if (!(max > 0)) return 0;
  // A window smaller than the reserve is not worth failing over; half of it is
  // a poor prompt budget but a working one.
  return max > reserve * 2 ? max - reserve : Math.floor(max / 2);
}

/**
 * Is it time to compress the conversation?
 *
 * Separated out because it is a policy decision rather than plumbing, and
 * because the interesting cases — a long single message, a conversation too
 * short to compress, a window reported by the endpoint rather than configured
 * — are worth testing without a model attached.
 *
 * Measured against the prompt budget, not the whole window: the share that
 * matters is of the room the prompt is actually allowed, and the difference is
 * the whole bug on a small context.
 *
 * A conversation with nothing older than the kept tail cannot be compacted: the
 * summary would replace the very messages it summarised, and the prompt would
 * not shrink.
 */
export function shouldCompact(
  usage,
  messageCount,
  { threshold = COMPACT_THRESHOLD, keep = KEEP_MESSAGES, reserve = REPLY_RESERVE } = {},
) {
  if (!usage?.max) return false;
  if (messageCount <= keep + 2) return false;
  return usage.used / promptBudget(usage.max, reserve) >= threshold;
}

/** Keep the head and tail of an oversized message, losing the middle. */
function shrinkToFit(content, budget) {
  const source = String(content ?? '');
  let keep = source.length;
  let out = source;
  // Shrunk geometrically rather than converted from tokens back to characters:
  // the estimate is script-dependent, so there is no single ratio to invert.
  while (keep > 400 && estimateTokens(out) > budget) {
    keep = Math.floor(keep * 0.7);
    const half = Math.floor(keep / 2);
    out = `${source.slice(0, half)}${TRIM_NOTE}${source.slice(source.length - half)}`;
  }
  return out;
}

/**
 * The last line of defence: a prompt that cannot exceed the window.
 *
 * Compaction is the graceful answer and usually the only one needed, but it
 * cannot always succeed — it keeps the last `KEEP_MESSAGES` verbatim, and a
 * single pasted README in that tail can fill a small window on its own. When it
 * does, nothing downstream noticed: the turn was sent anyway, llama.cpp dropped
 * whatever did not fit, and the model answered a conversation whose beginning
 * had silently vanished.
 *
 * The system prompt and the newest message always survive — the first is the
 * protocol the reply has to obey, the second is the thing being answered.
 * Anything else goes oldest-first, and a newest message too big even alone is
 * cut from the middle, keeping its opening and its closing question.
 */
export function fitToWindow(messages, budget) {
  const list = Array.isArray(messages) ? messages : [];
  if (!(budget > 0) || list.length === 0) return { messages: list, dropped: 0, trimmed: false };

  const system = list[0]?.role === 'system' ? list[0] : null;
  const rest = system ? list.slice(1) : list.slice();
  const cost = (message) => estimateTokens(message?.content);
  let total = (system ? cost(system) : 0) + rest.reduce((sum, message) => sum + cost(message), 0);

  let dropped = 0;
  while (total > budget && rest.length > 1) {
    total -= cost(rest.shift());
    dropped += 1;
  }

  let trimmed = false;
  if (total > budget && rest.length === 1) {
    const room = budget - (system ? cost(system) : 0);
    const shrunk = shrinkToFit(rest[0].content, room);
    if (shrunk !== rest[0].content) {
      rest[0] = { ...rest[0], content: shrunk };
      trimmed = true;
    }
  }

  return { messages: system ? [system, ...rest] : rest, dropped, trimmed };
}

export class Agent extends EventEmitter {
  #server;
  /** The plugin host. Every action the model may emit comes from it. */
  #plugins;
  #abort = null;
  #busy = false;
  /**
   * Approval questions waiting on the user, by id.
   *
   * Owned by the agent rather than by the plugin that asked, so a plugin cannot
   * arrange to run something without the dialog by simply not calling anything
   * — and so Stop can answer every outstanding question at once.
   */
  #pendingApprovals = new Map();
  /** Files and folders the user attached, waiting for the next message. */
  attachments = new Attachments();

  constructor({ server, plugins }) {
    super();
    this.#server = server;
    this.#plugins = plugins;
  }

  get busy() {
    return this.#busy;
  }

  /** Cancel whatever is in flight. The partial reply is kept. */
  stop() {
    this.#abort?.abort();
  }

  #say(event, payload) {
    this.emit('event', { event, ...payload });
  }

  #status(text) {
    this.#say('status', { text });
  }

  /**
   * Turn stored history into API messages.
   *
   * `tool` messages are ours, not the protocol's: they carry action results and
   * go over the wire as user turns, because a mid-conversation system message
   * is handled inconsistently across local models.
   */
  #buildMessages(chat, context) {
    const settings = config.load();
    const system = buildSystemPrompt({
      fragments: this.#plugins.promptFragments(),
      userPrompt: settings.systemPrompt,
      context,
    });

    const messages = [{ role: 'system', content: system }];
    for (const message of chat.messages) {
      if (message.role === 'assistant') {
        // Stored raw, sent without the reasoning — see `stripThinking`. A reply
        // that was *only* thinking would otherwise leave an empty assistant
        // turn, and two user messages running together is exactly the shape
        // `#retitle` already avoids.
        const prose = stripThinking(message.content);
        messages.push({ role: 'assistant', content: prose || '(that reply was cut off before an answer)' });
      } else if (message.role === 'tool') messages.push({ role: 'user', content: message.content });
      else messages.push({ role: 'user', content: message.content });
    }
    return messages;
  }

  #contextUsage(messages) {
    const used = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const max = this.#window();
    return { used, max, percent: Math.min(100, (used / max) * 100) };
  }

  /**
   * The context window in force.
   *
   * What the endpoint reported beats what we configured: with an external
   * endpoint the two have nothing to do with each other.
   */
  #window() {
    return this.#server.contextSize || Number(config.get('nCtx')) || 8192;
  }

  /** One streamed completion, with tokens relayed to the UI as they land. */
  async #complete(messages, { silent = false } = {}) {
    const settings = config.load();
    const baseUrl = this.#server.baseUrl;
    if (!baseUrl) throw new Error('no model loaded — pick one from the vault');

    const { text, aborted } = await streamChat({
      baseUrl,
      messages,
      temperature: Number(settings.temperature),
      signal: this.#abort?.signal,
      onToken: silent ? undefined : (delta) => this.#say('token', { delta }),
      // With thinking off, reasoning is not streamed: watching it scroll past
      // and then vanish when the reply is rendered reads as a glitch.
      streamReasoning: Boolean(settings.thinking),
    });
    return { text, aborted };
  }

  /**
   * Run a full turn for `prompt` against `chatId`.
   *
   * Returns the (possibly new) chat id, because the first message of a session
   * is what creates the chat.
   */
  async send(chatId, prompt) {
    if (this.#busy) throw new Error('a turn is already running');
    // Checked before anything is written: having no endpoint is knowable up
    // front, and failing after the message is persisted would leave an orphan
    // user turn in the history with no reply — and no way to hand the words
    // back to the composer.
    if (!this.#server.usable) throw new Error('no model loaded — pick one from the vault');

    // Plugins are discovered and activated asynchronously at boot. Waiting here
    // costs nothing after the first turn and removes the one race that would
    // matter: a first message sent fast enough to be answered by a model that
    // had not yet been told which actions exist.
    await this.#plugins.ready;

    this.#busy = true;
    this.#abort = new AbortController();
    this.#plugins.beginTurn();

    try {
      let chat = chats.read(chatId) ?? chats.create(chats.titleFromPrompt(prompt));

      // Attachments go in ahead of the message they came with, as an ordinary
      // transcript entry: they are then compacted, budgeted and dropped by
      // exactly the machinery that handles everything else, instead of being a
      // second kind of context with its own rules. Half the prompt budget is
      // theirs — the other half has to hold the conversation they are for.
      const attached = this.attachments.take(Math.floor(promptBudget(this.#window()) / 2));
      if (attached) {
        chat = chats.append(chat.id, { role: 'tool', content: attached });
        this.#say('attach:consumed', {});
      }

      chat = chats.append(chat.id, { role: 'user', content: prompt });
      // Captured before the turn runs: afterwards the chat holds a reply too,
      // and the model only gets to name a conversation once. Counted in *user*
      // messages rather than all of them, because an attachment goes in first
      // and a chat opened by dropping a folder would otherwise never be named.
      const isFirstTurn = chat.messages.filter((message) => message.role === 'user').length === 1;
      this.#say('turn:start', { chatId: chat.id, title: chat.title });

      await this.#runTurn(chat.id, 0);

      if (isFirstTurn) await this.#retitle(chat.id);
      return chat.id;
    } finally {
      this.#busy = false;
      this.#abort = null;
      this.#say('turn:end', {});
      this.#status('Ready');
    }
  }

  /** One model round: stream, persist, dispatch, recurse if an action fed back. */
  async #runTurn(chatId, depth) {
    // Recomputed every round, from every active plugin. The browser's page map
    // is the one that moves most, and it is why this is not hoisted out of the
    // follow-up loop.
    const context = await this.#plugins.context();

    // Checked here rather than only at the start of `send`, because a browsing
    // turn grows its own history: every batch appends a page map, and three
    // follow-ups can carry a conversation past the window without a single new
    // message from the user.
    await this.#maybeCompact(chatId, { context });

    const chat = chats.read(chatId);
    const built = this.#buildMessages(chat, context);

    // Compaction is the graceful shrink and normally the only one that runs.
    // This is what happens when it could not shrink enough — without it the
    // oversized prompt went out anyway and llama.cpp decided what to lose.
    const window = this.#contextUsage(built).max;
    const { messages, dropped, trimmed } = fitToWindow(built, promptBudget(window));
    if (dropped || trimmed) {
      const what = [dropped ? `dropped ${dropped} older message(s)` : '', trimmed ? 'trimmed the newest' : '']
        .filter(Boolean)
        .join(' and ');
      this.#say('log', { text: `context full — ${what} to leave room for a reply` });
    }

    // Reported from what is actually being sent, so a full meter means a full
    // prompt rather than one that was quietly cut on the way out.
    this.#say('ctx', this.#contextUsage(messages));
    this.#status('Thinking…');
    this.#say('reply:start', {});

    // `reply:start` puts a live, cursor-blinking element on screen, so every
    // path out of here owes a `reply:end` — including the failing one. Without
    // it a dead endpoint leaves a blinking cursor in the transcript forever.
    let text;
    let aborted;
    try {
      ({ text, aborted } = await this.#complete(messages));
    } catch (err) {
      this.#say('reply:end', { text: '', rendered: '', aborted: false, error: err.message });
      throw err;
    }

    chats.append(chatId, { role: 'assistant', content: text });
    this.#say('reply:end', { text, rendered: stripActionBlocks(text), aborted });

    if (aborted) return;

    const actions = extractActions(text);
    if (actions.length === 0) return;

    const { post } = splitNarration(text);
    let fedBack = false;
    for (const action of actions) {
      if (this.#abort?.signal.aborted) return;
      const result = await this.#dispatch(action);
      if (result?.feedback) {
        chats.append(chatId, { role: 'tool', content: result.feedback });
        fedBack = true;
      }
    }

    // A result the model has not seen yet is only useful if it gets another
    // turn to react to it. Bounded, or a stubborn model loops forever.
    if (fedBack && depth < MAX_FOLLOW_UPS) await this.#runTurn(chatId, depth + 1);
    else if (fedBack) this.#say('log', { text: `follow-up limit (${MAX_FOLLOW_UPS}) reached` });
    else if (post) this.#say('log', { text: post });
  }

  /**
   * Hand one action to the plugin that provides it.
   *
   * Nothing a plugin does may end a turn. A handler that throws produces
   * feedback the model can act on, exactly as a handler that returns a failure
   * does — the alternative is a third-party plugin able to kill the pipeline
   * with a typo, leaving the transcript with a live cursor and no reply.
   */
  async #dispatch(action) {
    this.#say('action:start', { type: action.type, steps: action.steps });

    const handler = this.#plugins.action(action.type);
    if (!handler) {
      // Known but not running is a different answer from never heard of, and
      // the model can only act on the first one. The manifest is what lets a
      // switched-off plugin still be named without loading it.
      const owner = this.#plugins.owner(action.type);
      if (owner) return this.#refuse(`${owner.name} is switched off`);
      this.#say('log', { text: `unknown action type: ${action.type}` });
      return null;
    }

    let result;
    try {
      result = await handler.run(action.steps, this.#turnContext());
    } catch (err) {
      this.#say('action:result', { type: action.type, ok: false, summary: err.message });
      return { feedback: `[ACTION FAILED] ${action.type}: ${err.message}. Tell the user; do not retry it.` };
    }

    const { ok = true, summary = '', feedback = '', ...detail } = result ?? {};
    this.#say('action:result', { type: action.type, ok, summary, ...detail });
    return feedback ? { feedback } : null;
  }

  /**
   * What a plugin's handler is given for the duration of one action.
   *
   * Deliberately small: the signal so a handler can be stopped, the two ways of
   * saying what is happening, and the approval question. Anything wider — the
   * chat, the config, the window — would make a plugin able to do things the
   * plugin list does not describe.
   */
  #turnContext() {
    return {
      signal: this.#abort?.signal,
      status: (text) => this.#status(text),
      log: (text) => this.#say('log', { text }),
      confirm: (request) => this.#confirm(request),
    };
  }

  #refuse(reason) {
    this.#say('action:result', { type: 'refused', ok: false, summary: reason });
    return { feedback: `[ACTION REFUSED] ${reason}. Tell the user, and do not retry it.` };
  }

  /**
   * Ask the user to approve something, and wait.
   *
   * Resolvable from two directions — the user answering, or Stop resolving it
   * out from under them — so the resolution is announced either way. Without
   * that the renderer would be left holding a dead dialog whose buttons do
   * nothing.
   */
  async #confirm({ kind = 'shell', command = '' } = {}) {
    const id = randomUUID();
    this.#status('Waiting for approval…');
    this.#say('shell:request', { id, kind, command });

    const approved = await new Promise((resolve) => {
      this.#pendingApprovals.set(id, resolve);
      this.#abort?.signal.addEventListener('abort', () => resolve(false), { once: true });
    });
    this.#pendingApprovals.delete(id);
    this.#say('shell:resolved', { id, approved });
    return approved;
  }

  /** Called from IPC when the user answers the approval dialog. */
  answerShell(id, approved) {
    const resolve = this.#pendingApprovals.get(id);
    if (!resolve) return false;
    resolve(Boolean(approved));
    return true;
  }

  /**
   * Ask the model to name a chat once it has something to name it from.
   *
   * The exchange is handed over as one user message rather than replayed as a
   * conversation. Replaying it invited the model to *continue* the chat instead
   * of naming it, and mapping the assistant's reply to `user` produced two
   * consecutive user turns, which some templates render as a single run-on.
   */
  async #retitle(chatId) {
    const chat = chats.read(chatId);
    if (!chat || chat.messages.length < 2) return;

    const transcript = chat.messages
      // Attachments are skipped: naming a chat from a directory listing gives
      // "src, main, agent" for a conversation that was about something else.
      .filter((message) => message.role !== 'tool')
      .slice(0, 2)
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${stripActionBlocks(m.content).slice(0, 600)}`)
      .join('\n\n');

    try {
      const { text } = await this.#complete(
        [
          { role: 'system', content: titlePrompt() },
          { role: 'user', content: `${transcript}\n\nTitle:` },
        ],
        { silent: true },
      );
      // A thinking model answers with its reasoning attached; the title is the
      // prose, not the deliberation.
      const prose = splitThinking(text)
        .filter((segment) => segment.kind === 'text')
        .map((segment) => segment.content)
        .join(' ');
      const updated = chats.rename(chatId, prose || text);
      if (updated) this.#say('chat:renamed', { chatId, title: updated.title });
    } catch {
      /* the prompt-derived title is already good enough */
    }
  }

  /**
   * Compress everything older than the last two turns into a summary note.
   *
   * The summary replaces the messages it covers, so the prefix stays roughly
   * constant however long the conversation runs.
   */
  async #maybeCompact(chatId, { force = false, context = '' } = {}) {
    const chat = chats.read(chatId);
    if (!chat) return false;

    // The plugin context counts. It is part of every prompt and, on a busy
    // site, the page map is the largest part of it — estimating without it is
    // what let a browsing turn sail past the threshold without ever triggering.
    const messages = this.#buildMessages(chat, context);
    const usage = this.#contextUsage(messages);
    if (!force && !shouldCompact(usage, chat.messages.length)) return false;
    if (chat.messages.length <= KEEP_MESSAGES + 1) return false;

    const keep = KEEP_MESSAGES;

    this.#status('Compacting…');
    const older = chat.messages.slice(0, -keep);
    const tail = chat.messages.slice(-keep);

    try {
      // The thing being summarised is, by definition, most of a full window —
      // so the summarisation prompt is the one most likely to overflow, and a
      // summary made from a prompt llama.cpp truncated is worse than none: it
      // is confidently wrong about what the conversation was.
      const { messages: ask } = fitToWindow(
        [
          { role: 'system', content: COMPACT_PROMPT },
          { role: 'user', content: older.map((m) => `${m.role}: ${stripThinking(m.content) || m.content}`).join('\n\n') },
        ],
        promptBudget(usage.max),
      );
      const { text } = await this.#complete(ask, { silent: true });
      const summary = text.trim();
      if (!summary) return false;

      const compacted = chats.read(chatId);
      if (!compacted) return false;
      compacted.messages = [
        { role: 'tool', content: `[SUMMARY OF EARLIER CONVERSATION]\n${summary}`, ts: new Date().toISOString() },
        ...tail,
      ];
      chats.overwrite(compacted);
      this.#say('chat:compacted', { chatId, kept: tail.length, summarised: older.length });
      return true;
    } catch (err) {
      this.#say('log', { text: `compact failed: ${err.message}` });
      return false;
    }
  }

  /**
   * Context usage for a chat, without running a turn.
   *
   * The meter is otherwise only updated mid-turn, which leaves it showing the
   * previous conversation's number after switching chats — and after NEW CHAT
   * that reads as "the context was not cleared".
   *
   * An unknown or empty id is the new-chat case: the system prompt alone.
   */
  contextFor(chatId) {
    const chat = chats.read(chatId) ?? { messages: [] };
    return this.#contextUsage(this.#buildMessages(chat, ''));
  }

  /**
   * Manual COMPACT button.
   *
   * Refused while a turn is running: compaction rewrites the whole message
   * list, and a turn appending to the same file at the same moment would lose
   * messages or leave the chat half-written.
   */
  async compact(chatId) {
    if (this.#busy) throw new Error('a turn is running — stop it first');
    this.#busy = true;
    try {
      return await this.#maybeCompact(chatId, { force: true });
    } finally {
      this.#busy = false;
    }
  }
}
