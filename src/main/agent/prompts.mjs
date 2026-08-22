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
- Reply in the language of the message you are answering — not the language of
  the conversation so far, and not a language named anywhere else in this
  prompt. A question typed in English is answered in English even when every
  turn before it was in another language, and even when a plugin's own
  instructions say to write in one. Only the user asking changes this.
- You run locally. Say so plainly if asked; do not claim capabilities you lack.`;

/**
 * How to ask the user to pick something.
 *
 * Not a capability a plugin contributes, unlike the action protocol: this is
 * about talking to the user, and it holds whether or not anything is installed.
 * It names the refusal it exists to prevent for the same reason a plugin's
 * fragment must — describing the fence accurately is not enough. A model with
 * no idea it can draw a
 * control writes "1. Open it 2. Pick another. Which would you like?", which is
 * a menu with nothing to press; that is what was reported, from a model that
 * had already found the video it was asking permission to open.
 *
 * Left out entirely while a game panel is on screen, rather than qualified with
 * an exception — the rule this file exists to keep. A game already draws the
 * moves, in the panel, from the scene the plugin published; a second row of
 * buttons under the reply is two menus for one turn. `fantasy-rpg`'s own
 * fragment says in as many words to end on the scenery and never list the
 * options, and shipping this unconditionally put the app's instruction directly
 * against the plugin's — with a worked example on the app's side, which is the
 * half that wins. That is the collision the "absent, not forbidden" rule is
 * about, met from the other direction for once: here it is the *app's* text
 * that has to know when to go quiet.
 */
const CHOICES = `
OFFERING A CHOICE

You cannot draw buttons, and a numbered list is not a menu — a reply ending
"1. open it  2. search again" leaves the user nothing to press. When you want
them to pick, end the reply with a fenced block:

\`\`\`choices
{"options":["Open and play it","Show me other versions"]}
\`\`\`

The app draws a button per option and sends that text as if the user had typed
it. Rules for choice blocks:
- Ask in one short line of prose before the block. The block itself is not shown.
- Do not also write the options out in prose. The buttons say them, and a list
  above a row of buttons saying the same words is the reply twice.
- When a result has already put buttons on the screen, that is the choice: say
  so in one line and stop. Do not offer a second set, and do not call another
  action to find out what the user picked — you are told.
- Write the options in the user's language, phrased as the user would say them.
- At most four, each short enough to read on a button. Use
  {"label":"shown","send":"sent"} only where those two genuinely differ.
- Offer a choice only when it is a real one. When the next step is the thing the
  user already asked for, take it instead of asking permission for it.`;

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
 * `choices` is whether the reply may offer buttons — false while a game panel
 * is drawing its own moves for this conversation, because two rows of buttons
 * are two menus for one turn.
 *
 * `fragments` are the action sections contributed by the active plugins, in the
 * order the host put them. `context` is whatever those plugins recomputed for
 * this turn — the browser's page map is one — and carries its own heading, so a
 * second plugin's lines cannot end up filed under the first one's. `userPrompt`
 * is the user's own instruction and is appended last so it wins.
 */
export function buildSystemPrompt({ fragments = [], userPrompt = '', context = '', choices = true } = {}) {
  const parts = choices ? [BASE, CHOICES] : [BASE];
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
