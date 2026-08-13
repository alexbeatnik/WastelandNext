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
import { extractActions, splitNarration, stripActionBlocks } from './actions.mjs';

/** How many times one user message may bounce back through the model. */
const MAX_FOLLOW_UPS = 3;
/** Above this share of the context window, compact before the next send. */
const COMPACT_THRESHOLD = 0.75;
/** Shell commands are killed rather than left hanging the pipeline. */
const SHELL_TIMEOUT_MS = 120_000;

export class Agent extends EventEmitter {
  #server;
  #browser;
  #lookupBrowser;
  #abort = null;
  #busy = false;
  #pendingShell = new Map();

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
      if (message.role === 'assistant') messages.push({ role: 'assistant', content: message.content });
      else if (message.role === 'tool') messages.push({ role: 'user', content: message.content });
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

    try {
      let chat = chats.read(chatId) ?? chats.create(chats.titleFromPrompt(prompt));
      chat = chats.append(chat.id, { role: 'user', content: prompt });
      // Captured before the turn runs: afterwards the chat holds a reply too,
      // and the model only gets to name a conversation once.
      const isFirstTurn = chat.messages.length === 1;
      this.#say('turn:start', { chatId: chat.id, title: chat.title });

      await this.#maybeCompact(chat.id);
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
    const chat = chats.read(chatId);
    const pageContext = this.#browser.open ? pageMapContext(await this.#browser.pageMap()) : '';
    const messages = this.#buildMessages(chat, pageContext);

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
        : `[BROWSER] All ${outcomes.length} step(s) succeeded.`,
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

  /** Ask the model to name a chat once it has something to name it from. */
  async #retitle(chatId) {
    const chat = chats.read(chatId);
    if (!chat || chat.messages.length < 2) return;
    try {
      const { text } = await this.#complete(
        [
          { role: 'system', content: titlePrompt() },
          ...chat.messages.slice(0, 2).map((m) => ({ role: 'user', content: m.content })),
        ],
        { silent: true },
      );
      const updated = chats.rename(chatId, text);
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
  async #maybeCompact(chatId, { force = false } = {}) {
    const chat = chats.read(chatId);
    if (!chat) return false;

    const messages = this.#buildMessages(chat, '');
    const usage = this.#contextUsage(messages);
    const keep = 4; // the last two exchanges
    if (!force && (usage.percent < COMPACT_THRESHOLD * 100 || chat.messages.length <= keep + 2)) return false;
    if (chat.messages.length <= keep + 1) return false;

    this.#status('Compacting…');
    const older = chat.messages.slice(0, -keep);
    const tail = chat.messages.slice(-keep);

    try {
      const { text } = await this.#complete(
        [
          { role: 'system', content: COMPACT_PROMPT },
          { role: 'user', content: older.map((m) => `${m.role}: ${m.content}`).join('\n\n') },
        ],
        { silent: true },
      );
      const summary = text.trim();
      if (!summary) return false;

      const compacted = chats.read(chatId);
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
    return this.#maybeCompact(chatId, { force: true });
  }
}
