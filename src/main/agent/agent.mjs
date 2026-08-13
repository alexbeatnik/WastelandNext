/**
 * The turn pipeline.
 *
 * One user message in; a streamed reply, zero or more dispatched actions, and
 * however many follow-up turns those actions earned, out. Everything the UI
 * shows is an event emitted from here, so the renderer holds no pipeline state
 * of its own and a reload cannot desynchronise it.
 */
import { exec } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as chats from '../chats.mjs';
import * as config from '../config.mjs';
import { estimateTokens, streamChat } from '../llm/client.mjs';
import { readForModel } from './readfile.mjs';
import { COMPACT_PROMPT, buildSystemPrompt, pageMapContext, titlePrompt } from './prompts.mjs';
import { extractActions, splitNarration, splitThinking, stripActionBlocks, stripThinking } from './actions.mjs';
import { BatchGuard } from './batch-guard.mjs';

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
/** Shell commands are killed rather than left hanging the pipeline. */
const SHELL_TIMEOUT_MS = 120_000;
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
  #browser;
  #lookupBrowser;
  #abort = null;
  #busy = false;
  #pendingShell = new Map();
  /** Refuses a browser batch identical to one already run this turn. */
  #batchGuard = new BatchGuard();

  constructor({ server, browser, lookupBrowser }) {
    super();
    this.#server = server;
    this.#browser = browser;
    this.#lookupBrowser = lookupBrowser;
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

  /** The capability set as the left panel currently has it. */
  #capabilities() {
    const settings = config.load();
    return {
      browser: Boolean(settings.allowBrowser && settings.browserEnabled),
      webLookup: Boolean(settings.allowWebLookup && settings.browserEnabled),
      readFile: Boolean(settings.allowReadFile),
      shell: Boolean(settings.allowShell),
    };
  }

  /**
   * Turn stored history into API messages.
   *
   * `tool` messages are ours, not the protocol's: they carry action results and
   * go over the wire as user turns, because a mid-conversation system message
   * is handled inconsistently across local models.
   */
  #buildMessages(chat, pageContext) {
    const settings = config.load();
    const system = buildSystemPrompt({
      capabilities: this.#capabilities(),
      userPrompt: settings.systemPrompt,
      pageContext,
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
    // What the endpoint reported beats what we configured: with an external
    // endpoint the two have nothing to do with each other.
    const max = this.#server.contextSize || Number(config.get('nCtx')) || 8192;
    return { used, max, percent: Math.min(100, (used / max) * 100) };
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

    this.#busy = true;
    this.#abort = new AbortController();
    this.#batchGuard.beginTurn();

    try {
      let chat = chats.read(chatId) ?? chats.create(chats.titleFromPrompt(prompt));
      chat = chats.append(chat.id, { role: 'user', content: prompt });
      // Captured before the turn runs: afterwards the chat holds a reply too,
      // and the model only gets to name a conversation once.
      const isFirstTurn = chat.messages.length === 1;
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
    const pageContext = this.#browser.open ? pageMapContext(await this.#browser.pageMap()) : '';

    // Checked here rather than only at the start of `send`, because a browsing
    // turn grows its own history: every batch appends a page map, and three
    // follow-ups can carry a conversation past the window without a single new
    // message from the user.
    await this.#maybeCompact(chatId, { pageContext });

    const chat = chats.read(chatId);
    const built = this.#buildMessages(chat, pageContext);

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
      const result = await this.#dispatch(chatId, action);
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

  async #dispatch(chatId, action) {
    const capabilities = this.#capabilities();
    this.#say('action:start', { type: action.type, steps: action.steps });

    switch (action.type) {
      case 'browser_steps':
        if (!capabilities.browser) return this.#refuse('browser control is switched off');
        return this.#doBrowserSteps(action.steps);
      case 'browser_close':
        await this.#browser.close();
        this.#say('action:result', { type: action.type, ok: true, summary: 'browser closed' });
        return null;
      case 'web_lookup':
        if (!capabilities.webLookup) return this.#refuse('web lookup is switched off');
        return this.#doWebLookup(action.steps);
      case 'read_file':
        if (!capabilities.readFile) return this.#refuse('file reading is switched off');
        return this.#doReadFile(action.steps);
      case 'system_shell':
        if (!capabilities.shell) return this.#refuse('shell access is switched off');
        return this.#doShell(action.steps);
      default:
        this.#say('log', { text: `unknown action type: ${action.type}` });
        return null;
    }
  }

  #refuse(reason) {
    this.#say('action:result', { type: 'refused', ok: false, summary: reason });
    return { feedback: `[ACTION REFUSED] ${reason}. Tell the user, and do not retry it.` };
  }

  async #doBrowserSteps(steps) {
    // A batch identical to one already run this turn cannot produce a different
    // result, and a model that cannot tell "the click resolved" from "the page
    // changed" will send it again — five times, in the session this guard was
    // written for. The decision lives in `batch-guard.mjs`.
    const refusal = this.#batchGuard.check(steps);
    if (refusal) {
      this.#say('action:result', { type: 'browser_steps', ok: false, summary: 'identical batch already run' });
      return { feedback: refusal };
    }

    this.#status('Browser…');
    let outcomes;
    try {
      outcomes = await this.#browser.runSteps(steps, { signal: this.#abort?.signal });
    } catch (err) {
      this.#say('action:result', { type: 'browser_steps', ok: false, summary: err.message });
      return { feedback: `[BROWSER FAILED] ${err.message}` };
    }

    const failed = outcomes.find((o) => !o.ok);
    const summary = failed
      ? `failed at: ${failed.step} — ${failed.error || failed.reason || 'no match'}`
      : `${outcomes.length} step(s) ok`;
    this.#say('action:result', { type: 'browser_steps', ok: !failed, summary, outcomes });

    const map = await this.#browser.pageMap();
    const context = pageMapContext(map);
    const lines = [
      failed
        ? `[BROWSER] Step failed: ${failed.step}\nReason: ${failed.error || failed.reason || 'no element matched'}`
        : // Deliberately not "succeeded": the engine reports that it resolved a
          // target and acted on it, which is not the same as the page having
          // done what was wanted. Told the stronger thing, a model stops
          // checking and repeats itself.
          `[BROWSER] All ${outcomes.length} step(s) resolved and were acted on. That does NOT prove the page did ` +
          'what you intended — check CURRENT PAGE below before saying it worked.',
    ];
    if (context) {
      lines.push(
        '',
        'What is on the page now — use these exact labels if you act again:',
        context,
      );
    }
    lines.push('', 'Tell the user what happened in one or two sentences. Emit another action only if the goal is not met yet.');
    return { feedback: lines.join('\n') };
  }

  /**
   * A lookup runs in its own headless browser, not the user's visible one.
   *
   * The point of this action is that it does not disturb what the user is
   * looking at, so it cannot share their tab.
   */
  async #doWebLookup(query) {
    this.#status('Looking up…');
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    try {
      await this.#lookupBrowser.runSteps(`NAVIGATE to ${url}\nWAIT 2`, { signal: this.#abort?.signal });
      const text = (await this.#lookupBrowser.readText('body', 4000)) ?? '';
      const trimmed = text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
      this.#say('action:result', {
        type: 'web_lookup',
        ok: Boolean(trimmed),
        summary: `${query} — ${trimmed.length} chars`,
      });
      if (!trimmed) return { feedback: `[LOOKUP] "${query}" returned nothing readable. Say so; do not invent an answer.` };
      return {
        feedback: `[LOOKUP] Search results for "${query}":\n${trimmed}\n\nAnswer the user's question from this in one or two sentences. If the answer is not here, say so.`,
      };
    } catch (err) {
      this.#say('action:result', { type: 'web_lookup', ok: false, summary: err.message });
      return { feedback: `[LOOKUP FAILED] ${err.message}. Tell the user you could not check.` };
    } finally {
      // A lookup is a one-shot: hold the headless Chrome open and it costs a
      // few hundred megabytes until the app quits, for nothing. Reopening on
      // the next lookup is a second or two.
      await this.#lookupBrowser.close().catch(() => {});
    }
  }

  async #doReadFile(path) {
    this.#status('Reading…');
    const result = await readForModel(path);
    this.#say('action:result', {
      type: 'read_file',
      ok: result.ok,
      summary: result.ok ? `${result.path} (${result.size} bytes)` : `${path}: ${result.reason}`,
    });
    if (!result.ok) return { feedback: `[READ FAILED] ${path}: ${result.reason}` };
    return {
      feedback: `[FILE] ${result.path}\n\n${result.content}\n\n[END FILE] Answer the user's question about this file concisely.`,
    };
  }

  /** Shell runs only after the user clicks approve in the renderer. */
  async #doShell(command) {
    const id = randomUUID();
    this.#status('Waiting for approval…');
    this.#say('shell:request', { id, command });

    const approved = await new Promise((resolve) => {
      this.#pendingShell.set(id, resolve);
      this.#abort?.signal.addEventListener('abort', () => resolve(false), { once: true });
    });
    this.#pendingShell.delete(id);

    // The dialog can be answered by the user OR resolved out from under them by
    // Stop. Announcing the resolution means the renderer dismisses it either
    // way, instead of leaving a dead dialog whose buttons do nothing.
    this.#say('shell:resolved', { id, approved });

    if (!approved) {
      this.#say('action:result', { type: 'system_shell', ok: false, summary: 'declined' });
      return { feedback: `[SHELL DECLINED] The user did not approve \`${command}\`. Do not retry it.` };
    }

    this.#status('Running…');
    const output = await new Promise((resolve) => {
      exec(command, { timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, text: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err ? err.message : '(no output)') });
      });
    });

    this.#say('action:result', { type: 'system_shell', ok: output.ok, summary: output.text.slice(0, 200) });
    return {
      feedback: `[SHELL] \`${command}\` ${output.ok ? 'succeeded' : 'failed'}:\n${output.text.slice(0, 4000)}\n\nSummarise this for the user in one or two sentences.`,
    };
  }

  /** Called from IPC when the user answers the approval dialog. */
  answerShell(id, approved) {
    const resolve = this.#pendingShell.get(id);
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
  async #maybeCompact(chatId, { force = false, pageContext = '' } = {}) {
    const chat = chats.read(chatId);
    if (!chat) return false;

    // The page context counts. It is part of every prompt and, on a busy site,
    // it is the largest part — estimating without it is what let a browsing
    // turn sail past the threshold without ever triggering.
    const messages = this.#buildMessages(chat, pageContext);
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
