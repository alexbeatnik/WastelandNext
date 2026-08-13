/**
 * Reading actions out of a model's reply.
 *
 * The model narrates in prose and asks for work in fenced ```action blocks
 * holding one JSON object. Everything in this file is pure text handling, so it
 * is all directly testable — which matters, because small models are creative
 * about JSON and this is where that creativity gets absorbed.
 */

import { ACTION_RE } from '../../shared/render.mjs';

export { splitThinking, stripActionBlocks, stripThinking } from '../../shared/render.mjs';

/**
 * Slice out the first balanced `{...}`, respecting strings and escapes.
 *
 * The model often writes a sentence after the closing brace, still inside the
 * fence. A strict parse rejects the whole thing and the action is silently
 * lost, which reads to the user as the model having given up.
 */
export function firstJsonObject(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
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
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Patch the one truncation small models reliably produce: the inner DSL string
 * is closed with an apostrophe and the outer `"}` never arrives.
 *
 * Only applied after a clean parse has already failed, so payloads that were
 * invalid for a real reason are not quietly "fixed" into something else.
 */
export function repairTruncatedJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text.startsWith('{')) return null;

  const candidates = [];
  if (text.endsWith('}')) candidates.push(text.slice(0, -1) + '"}');
  candidates.push(`${text}"}`, `${text}}`, `${text}"`);
  return candidates;
}

/** Parse one fence body into `{type, steps}`, or null if it is beyond saving. */
export function parseActionPayload(raw) {
  const attempt = (text) => {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && typeof value.type === 'string') {
        return { type: value.type.trim(), steps: typeof value.steps === 'string' ? value.steps : '' };
      }
    } catch {
      /* next candidate */
    }
    return null;
  };

  const sliced = firstJsonObject(raw);
  if (sliced) {
    const parsed = attempt(sliced);
    if (parsed) return parsed;
  }

  for (const candidate of repairTruncatedJson(raw) ?? []) {
    const parsed = attempt(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/** Every well-formed action in a reply, in the order the model emitted them. */
export function extractActions(text) {
  const actions = [];
  for (const match of String(text ?? '').matchAll(ACTION_RE)) {
    const payload = parseActionPayload(match[1]);
    if (payload && payload.type) actions.push(payload);
  }
  return actions;
}

/**
 * Split a reply into the prose before the first action and after the last one.
 *
 * Text sandwiched between two actions is dropped on purpose: the user already
 * read the intent and will get the summary, and repeating the middle is noise.
 */
export function splitNarration(text) {
  const source = String(text ?? '');
  const matches = [...source.matchAll(ACTION_RE)];
  if (matches.length === 0) return { pre: source.trim(), post: '' };

  const first = matches[0];
  const last = matches[matches.length - 1];
  return {
    pre: source.slice(0, first.index).trim(),
    post: source.slice(last.index + last[0].length).trim(),
  };
}

