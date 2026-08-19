/**
 * Text shaping shared by the main process and the chat view.
 *
 * Both ends need the same answer to "what part of this reply is prose?" — the
 * main process to decide what to feed back, the renderer to decide what to
 * draw. One definition, imported twice, so the two can never drift.
 */

/** The action fence. The closer is optional so a truncated stream still parses. */
export const ACTION_RE = /```action\s*\r?\n([\s\S]*?)(?:\r?\n```|$)/g;

/** The choices fence — what the model offers the user. Same shape, same reason. */
export const CHOICES_RE = /```choices\s*\r?\n([\s\S]*?)(?:\r?\n```|$)/g;

/**
 * An action object written without its fence, alone on a line.
 *
 * Small models drop the fence and emit the JSON by itself — a report of a
 * playlist that never played came back as the literal text
 * {"type":"queue_music","steps":"pearl jam"} printed at the user, because
 * nothing matched it and nothing ran. It is the next step in the series
 * `parseActionPayload` already walks: the JSON arrives creative, and this is
 * where that creativity gets absorbed.
 *
 * Deliberately one line, anchored to both ends of it. A multi-line scan would
 * start swallowing JSON a reply is *discussing*, and the whole reason this is
 * safe is that a line holding nothing but an action object is not prose. The
 * caller checks it parses before believing any of that.
 */
export const BARE_ACTION_RE = /^[ \t]*\{[ \t]*"type"[ \t]*:[^\n]*\}[ \t]*$/gm;

/** Does this line hold an action object, rather than merely look like one? */
export function isBareAction(line) {
  try {
    const value = JSON.parse(String(line ?? '').trim());
    return Boolean(value && typeof value === 'object' && typeof value.type === 'string' && value.type.trim());
  } catch {
    return false;
  }
}

/**
 * The reply as the chat view should render it: prose only.
 *
 * The raw text — fences and all — is what gets persisted, because the model
 * needs to see its own actions on the next turn. This is purely a view.
 *
 * Both fences go, and for the same reason: a block the app turns into something
 * — work to run, buttons to press — has already been read by the time this is
 * called, and leaving its JSON in the prose shows the user the wiring.
 */
export function stripBlocks(text) {
  return String(text ?? '')
    .replace(ACTION_RE, '')
    .replace(CHOICES_RE, '')
    // Only when it really is one: a line of prose that merely starts with a
    // brace keeps its place, and the reply is not quietly edited to fix it.
    .replace(BARE_ACTION_RE, (line) => (isBareAction(line) ? '' : line))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Slice out the first balanced `{...}` — or `[...]` — respecting strings and
 * escapes.
 *
 * The model often writes a sentence after the closing brace, still inside the
 * fence. A strict parse rejects the whole thing and the action is silently
 * lost, which reads to the user as the model having given up.
 *
 * Here rather than beside the action parser because the renderer needs it too:
 * choices are read in the window that draws them, and a renderer importing out
 * of `main/agent/` to get at one function is the layering this file exists to
 * avoid.
 */
export function firstJsonObject(raw, opener = '{') {
  const closer = opener === '[' ? ']' : '}';
  const text = String(raw ?? '');
  const start = text.indexOf(opener);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * How many options are drawn, and how long one may be.
 *
 * A model that offers fourteen things has not offered a choice, it has written
 * a list with buttons on it — and a "button" two hundred characters wide is a
 * paragraph that should have stayed prose. Both limits drop the surplus rather
 * than truncating it: a label shortened for the layout would no longer say what
 * pressing it sends, which is the one thing a choice button has to be honest
 * about.
 *
 * Deliberately looser than what the prompt asks for (four): the cap is here to
 * stop a runaway, not to enforce the house style. A model that offers five has
 * not done anything the user needs protecting from.
 */
export const MAX_CHOICES = 6;
const MAX_LABEL = 200;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Parse a fence body that may have prose stuck to it, as an object or a bare array. */
function parseJsonish(raw) {
  const text = String(raw ?? '').trim();
  for (const candidate of [text, firstJsonObject(text, '['), firstJsonObject(text, '{')]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** The list out of whatever shape the model reached for. */
function choiceEntries(raw) {
  const value = parseJsonish(raw);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['options', 'choices', 'items']) if (Array.isArray(value[key])) return value[key];
  return [];
}

/**
 * One entry, however it was written.
 *
 * A bare string is the common case and means both halves at once — most
 * options are worded the same whether you read them or send them, and making a
 * small model repeat itself in two fields is one more thing for it to get
 * wrong. `send` is what actually goes, so an entry with no usable text for it
 * is dropped rather than guessed at.
 */
function normaliseChoice(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text && text.length <= MAX_LABEL ? { label: text, send: text } : null;
  }
  if (!entry || typeof entry !== 'object') return null;

  const label = firstString(entry.label, entry.text, entry.title, entry.send, entry.value);
  const send = firstString(entry.send, entry.value, entry.prompt, entry.message, entry.label, entry.text);
  if (!label || !send || label.length > MAX_LABEL) return null;

  const note = firstString(entry.note, entry.hint, entry.detail);
  return note && note.length <= MAX_LABEL ? { label, send, note } : { label, send };
}

/**
 * The options a reply offers, ready to draw. `[]` when it offers none.
 *
 * The *last* block wins. Choices belong at the end of a reply, and a model that
 * emitted two of them changed its mind in between; merging both would build a
 * row of buttons it never actually offered.
 *
 * Nothing here throws. A malformed block has to come out as "no choices" — the
 * reply is already on screen by then, and a parse error that took the prose
 * with it would lose the answer to punctuation.
 */
export function parseChoices(text) {
  const blocks = [...String(text ?? '').matchAll(CHOICES_RE)];
  if (blocks.length === 0) return [];

  const offered = [];
  const seen = new Set();

  for (const entry of choiceEntries(blocks[blocks.length - 1][1])) {
    const option = normaliseChoice(entry);
    if (!option) continue;
    // Two buttons that send the same words are one button drawn twice.
    const key = option.send.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    offered.push(option);
    if (offered.length === MAX_CHOICES) break;
  }
  return offered;
}

/**
 * Pull `<think>` reasoning out so the UI can dim it.
 *
 * Only a fence at the start of a line counts: models discuss `<think>` in prose
 * often enough that a naive match turns a normal answer into a thinking block.
 * An unclosed opener runs to the end — that is a reply that was cut off
 * mid-thought, and showing the tail as an answer would be a lie.
 */
export function splitThinking(text) {
  const source = String(text ?? '');
  const segments = [];
  const re = /(?:^|\n)[ \t]*<think>([\s\S]*?)(?:<\/think>|$)/g;
  let cursor = 0;

  for (const match of source.matchAll(re)) {
    const before = source.slice(cursor, match.index);
    if (before.trim()) segments.push({ kind: 'text', content: before.trim() });
    const thought = match[1].trim();
    if (thought) segments.push({ kind: 'think', content: thought });
    cursor = match.index + match[0].length;
  }

  const tail = source.slice(cursor);
  if (tail.trim()) segments.push({ kind: 'text', content: tail.trim() });
  return segments;
}

/**
 * The reply with its reasoning removed — what goes back to the model next turn.
 *
 * Thinking is persisted (it is part of the raw reply, and the view dims it), but
 * it must not be *resent*: a model re-reads its own deliberation as established
 * fact, and on a small window the deliberation is far larger than the answer. A
 * 4608-token session here was full after two turns, almost entirely of thinking
 * the model had already finished with. Every other provider drops prior
 * reasoning for the same reason.
 *
 * Action fences deliberately survive this — the model does need to see what it
 * did — and so do choices fences: when the user presses one, the words arrive
 * as an ordinary message, and a model that cannot see the offer it made reads
 * the answer to a question it has no record of asking. Only `<think>` goes.
 */
export function stripThinking(text) {
  return splitThinking(text)
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.content)
    .join('\n\n')
    .trim();
}

/**
 * A rough duration, for "time left" on a download.
 *
 * Coarse on purpose: the estimate behind it moves every time the connection
 * does, and a figure reading "3m 21s" then "3m 19s" invites a precision it does
 * not have. Seconds below a minute, minutes and seconds below an hour, hours
 * and minutes above.
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The compute badge, from a placement read out of llama.cpp's own output.
 *
 * Here rather than beside `PlacementReader` in `main/llm/offload.mjs` for the
 * reason everything else in this file is: the renderer draws this string and
 * the reader produces what it describes, and a second copy written out by hand
 * in `app.js` is how the two come to disagree about what a partial offload
 * looks like. Importing across the process boundary is not the alternative.
 */
export function describePlacement(placement) {
  if (!placement) return 'RUN: ?';
  if (placement.where === 'cpu') return 'RUN: CPU';
  if (placement.where === 'gpu') return 'RUN: GPU';
  // Layers first: when that is what was split, it is the more useful number and
  // the one the settings slider speaks in.
  if (placement.blocks && placement.layers < placement.blocks) {
    return `RUN: GPU ${placement.layers}/${placement.blocks} LAYERS + CPU`;
  }
  // Otherwise the split is in bytes — every layer is on the card and a good
  // share of the weights is not — and the layer count would read as a
  // contradiction. `43/43 LAYERS + CPU` states something true that no one can
  // act on.
  if (placement.gpuShare != null) return `RUN: GPU ${Math.round(placement.gpuShare * 100)}% WEIGHTS + CPU`;
  return 'RUN: GPU + CPU';
}

/** Human-readable byte size for the vault list. */
export function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
