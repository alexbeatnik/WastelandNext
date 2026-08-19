/**
 * Reading actions out of a model's reply.
 *
 * The model narrates in prose and asks for work in fenced ```action blocks
 * holding one JSON object. Everything in this file is pure text handling, so it
 * is all directly testable — which matters, because small models are creative
 * about JSON and this is where that creativity gets absorbed.
 */

import { ACTION_RE, BARE_ACTION_RE, firstJsonObject } from '../../shared/render.mjs';

// `firstJsonObject` moved to `shared/` when the renderer came to need it for
// the choices fence; it is re-exported here because this is where the action
// parser's own tests reach for it, and because it is the same job either way.
export { firstJsonObject, parseChoices, splitThinking, stripBlocks, stripThinking } from '../../shared/render.mjs';

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

/**
 * Every well-formed action in a reply, in the order the model emitted them.
 *
 * `known` answers "is this a type some plugin declares", and is what makes the
 * unfenced fallback below safe enough to have. Without it every reply that
 * quoted an action object would run one.
 */
export function extractActions(text, { known = null } = {}) {
  const source = String(text ?? '');
  const actions = [];
  for (const match of source.matchAll(ACTION_RE)) {
    const payload = parseActionPayload(match[1]);
    if (payload && payload.type) actions.push(payload);
  }
  if (actions.length > 0) return actions;

  /**
   * The fence was left off entirely.
   *
   * Reported as a playlist that never played: the model emitted
   * {"type":"queue_music","steps":"pearl jam"} alone on a line, nothing matched
   * it, and the JSON was printed at the user instead of being run.
   *
   * Only when the reply has no fenced action at all, and only for a type a
   * plugin actually declares. Both narrow the same risk — a reply that is
   * *discussing* an action rather than asking for one — which the fenced path
   * already carries and this must not widen much. A declared type that is
   * switched off is still accepted: the dispatcher answers "that is switched
   * off", which is the sentence the model can act on.
   */
  for (const match of source.matchAll(BARE_ACTION_RE)) {
    const payload = parseActionPayload(match[0]);
    if (!payload?.type) continue;
    if (known && !known(payload.type)) continue;
    actions.push(payload);
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

