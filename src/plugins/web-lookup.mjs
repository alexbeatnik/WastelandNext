/**
 * Silent web lookup, as a plugin.
 *
 * Its own headless browser is the whole point of the action — a lookup must not
 * disturb the page the user is looking at — so it asks for `lookupBrowser` and
 * never touches the visible session.
 */

export const manifest = {
  id: 'web-lookup',
  name: 'Web lookup',
  version: '1.0.0',
  apiVersion: 1,
  description: 'A background search for a fact the model does not know, in a browser the user never sees.',
  actions: ['web_lookup'],
  services: ['lookupBrowser'],
  order: 20,
  legacy: ['browserEnabled', 'allowWebLookup'],
};

/**
 * "Look it up before saying you do not know" lives here rather than in the base
 * rules on purpose. A model told to look things up with no lookup to hand
 * reaches for it anyway, and the refusal reads to the user as a bug.
 */
const PROMPT = `
LOOKUP — {"type":"web_lookup","steps":"<search query>"}

A silent background search for a fact you do not know and the user only wants
TOLD (weather, an exchange rate, a score, a fresh headline). It does not disturb
the page the user is looking at. Use this instead of browser_steps whenever the
answer is words rather than something to look at.

Look it up BEFORE saying you do not know. Anything that moves with time —
today's date, the weather, a price, a score, a release version, who currently
holds a position, what happened recently — is not something you know; it is
something you look up. "I have no access to real-time information" is wrong in
this session: you do, it is this action, and it costs one turn.

Ask the user which site to use only when the answer genuinely depends on the
site. For an ordinary fact, search first and report what you found.

Then answer from the result and nothing else. If it does not actually contain
the answer, say so and say what it did contain — do not fill the gap from
memory, and do not present a remembered figure as a looked-up one.`;

async function lookup(browser, query, turn) {
  turn.status('Looking up…');
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  try {
    await browser.runSteps(`NAVIGATE to ${url}\nWAIT 2`, { signal: turn.signal });
    const text = (await browser.readText('body', 4000)) ?? '';
    const trimmed = text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);

    if (!trimmed) {
      return {
        ok: false,
        summary: `${query} — nothing readable`,
        feedback: `[LOOKUP] "${query}" returned nothing readable. Say so; do not invent an answer.`,
      };
    }
    return {
      ok: true,
      summary: `${query} — ${trimmed.length} chars`,
      feedback: `[LOOKUP] Search results for "${query}":\n${trimmed}\n\nAnswer the user's question from this in one or two sentences. If the answer is not here, say so.`,
    };
  } catch (err) {
    return { ok: false, summary: err.message, feedback: `[LOOKUP FAILED] ${err.message}. Tell the user you could not check.` };
  } finally {
    // A lookup is a one-shot: holding the headless Chrome open costs a few
    // hundred megabytes until the app quits, for nothing. Reopening on the next
    // lookup is a second or two.
    await browser.close().catch(() => {});
  }
}

export function activate(ctx) {
  const browser = ctx.service('lookupBrowser');
  ctx.prompt(PROMPT);
  ctx.action({ type: 'web_lookup', run: (query, turn) => lookup(browser, query, turn) });
}
