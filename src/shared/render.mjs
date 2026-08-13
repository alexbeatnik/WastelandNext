/**
 * Text shaping shared by the main process and the chat view.
 *
 * Both ends need the same answer to "what part of this reply is prose?" — the
 * main process to decide what to feed back, the renderer to decide what to
 * draw. One definition, imported twice, so the two can never drift.
 */

/** The action fence. The closer is optional so a truncated stream still parses. */
export const ACTION_RE = /```action\s*\r?\n([\s\S]*?)(?:\r?\n```|$)/g;

/**
 * The reply as the chat view should render it: prose only.
 *
 * The raw text — fences and all — is what gets persisted, because the model
 * needs to see its own actions on the next turn. This is purely a view.
 */
export function stripActionBlocks(text) {
  return String(text ?? '')
    .replace(ACTION_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
