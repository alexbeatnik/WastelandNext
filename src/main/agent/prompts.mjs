/**
 * The system prompt.
 *
 * Assembled from parts so a disabled capability is *absent* rather than
 * described-then-forbidden: a model told about a tool it may not use will reach
 * for it anyway, and the refusal reads to the user as a bug.
 *
 * The parts describing actions belong to the plugins that provide them, and
 * arrive here as `fragments`. Keeping the text beside the handler is what makes
 * "the prompt documents exactly what the dispatcher will accept" a property of
 * the design rather than something to remember: a plugin that is not active
 * contributes neither, and there is no list here to fall out of step.
 */

const BASE = `You are Wasteland, a local assistant running on the user's own machine.

Rules:
- Markdown is rendered, so use it where it earns its place: code fences for
  code, lists for lists, links, occasional emphasis. Do not decorate a one-line
  answer with headings. Never deliberate about formatting — just write.
- Be concise. Say the answer, not a preamble about how you will say it.
- Reply in the language the user wrote in.
- You run locally. Say so plainly if asked; do not claim capabilities you lack.`;

const ACTION_PROTOCOL = `
ACTIONS

When a request needs something done rather than said, emit a fenced action block:

\`\`\`action
{"type":"<type>","steps":"<payload>"}
\`\`\`

Rules for action blocks:
- Narrate your intent in one short sentence BEFORE the block, and summarise the
  outcome after it. The user reads both.
- The JSON must be one line, valid, and closed. Escape newlines inside "steps" as \\n.
- Emit an action only when it is actually needed. Facts you already know
  (a capital city, a definition, arithmetic) are answered directly, without tools.
- Never invent the result of an action. You are told what happened; wait for it.`;

const NO_TOOLS = `
You have no tools enabled in this session: answer from what you know, and say so
if a request would need the web or the filesystem.`;

/**
 * Build the system prompt for a turn.
 *
 * `fragments` are the action sections contributed by the active plugins, in the
 * order the host put them. `context` is whatever those plugins recomputed for
 * this turn — the browser's page map is one — and carries its own heading, so a
 * second plugin's lines cannot end up filed under the first one's. `userPrompt`
 * is the user's own instruction and is appended last so it wins.
 */
export function buildSystemPrompt({ fragments = [], userPrompt = '', context = '' } = {}) {
  const parts = [BASE];
  const enabled = fragments.map((fragment) => String(fragment ?? '').trim()).filter(Boolean);

  if (enabled.length > 0) parts.push(ACTION_PROTOCOL, ...enabled.map((fragment) => `\n${fragment}`));
  else parts.push(NO_TOOLS);

  if (context.trim()) parts.push(`\n${context.trim()}`);
  if (userPrompt.trim()) parts.push(`\nADDITIONAL INSTRUCTIONS\n${userPrompt.trim()}`);

  return parts.join('\n');
}

/** Asks the model to name a chat from its first exchange. */
export function titlePrompt(language = '') {
  return `Give this conversation a title of 3 to 5 words, at most 40 characters${
    language ? `, in ${language}` : ', in the language of the conversation'
  }. Reply with the title alone — no quotes, no punctuation at the end, no explanation.`;
}

/** Asks the model to compress the older half of a long conversation. */
export const COMPACT_PROMPT = `Summarise the conversation so far in 3 to 6 sentences, at most 600 characters.
Keep names, numbers, file paths, decisions made and questions still open.
Write in the language of the conversation. Reply with the summary alone.`;
