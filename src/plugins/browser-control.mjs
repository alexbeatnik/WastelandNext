/**
 * Browser control, as a plugin.
 *
 * The engine, the Chrome process and the manual OPEN/CLOSE buttons stay in the
 * app: they are infrastructure the user drives directly. What lives here is the
 * *model's* access to them — the action types, the prompt that documents them,
 * the page map fed back each turn, and the guard that refuses a repeated batch.
 * Switching this plugin off leaves the browser working and takes the model's
 * hands off it, which is exactly the distinction the CAPABILITIES checkbox used
 * to draw.
 */
import { BatchGuard } from '../main/agent/batch-guard.mjs';

export const manifest = {
  id: 'browser-control',
  name: 'Browser control',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Lets the model drive your Chrome — open pages, click, fill forms, play a video.',
  actions: ['browser_steps', 'browser_close'],
  services: ['browser'],
  order: 10,
  // The two checkboxes this plugin replaced. Both had to be on for the action
  // to be offered, so both are read.
  legacy: ['browserEnabled', 'allowBrowser'],
};

const PROMPT = `
BROWSER — {"type":"browser_steps","steps":"..."}

Drives the user's visible Chrome. Use it when the user should SEE the result:
open a page, play a video, fill a form, click through a site.

"steps" is manul-browser DSL, one command per line, targets in single quotes:
  NAVIGATE to https://example.com
  CLICK the 'Sign in' button
  FILL 'Search' field with 'ambient music'
  TYPE 'hello' into 'Message'
  SELECT 'Ukraine' from the 'Country' dropdown
  PRESS Enter
  SCROLL DOWN
  WAIT 3
  WAIT FOR the 'Results' element
  EXTRACT the 'Price' into {price}
  VERIFY the 'Welcome' text is visible

Targets must be text a person can actually read on the page. Never write
positional or abstract targets like 'first result', 'the top video', 'перше
відео' — the engine resolves labels, not positions.

When you do not know a title yet, this takes TWO turns. Search on the first, and
stop there; you will be shown what is on the page, and you click an exact title
on the second. Do not guess a title, and do not try to do both in one block.

For "find and play X on YouTube", the first turn is exactly this:

\`\`\`action
{"type":"browser_steps","steps":"NAVIGATE to https://www.youtube.com/results?search_query=X\\nWAIT 3"}
\`\`\`

Then say you are looking at the results, and stop. On the next turn the page's
real titles are in CURRENT PAGE, and you click one of them verbatim:

\`\`\`action
{"type":"browser_steps","steps":"CLICK the 'Exact Title As Listed' link"}
\`\`\`

A step reporting success means the engine found a target and acted on it. It
does NOT mean the page did what you wanted. Always check CURRENT PAGE
afterwards, and describe what you actually see rather than what you expected.

If the page did not end up where you wanted, do not send the same steps again —
the result will be the same. Change route instead:
- pick a different label from CURRENT PAGE;
- or NAVIGATE to a URL that already encodes the outcome. Sorting and filtering
  on shops and catalogues are usually query parameters, which is far more
  reliable than driving a custom dropdown. Example:
  NAVIGATE to https://example.com/search?q=mower&sort=price_asc
- if neither works, say plainly what you could not do. Two failed attempts is
  enough; a third identical one will be refused.

{"type":"browser_close","steps":""} closes the controlled browser.`;

/**
 * Fed back after a browser batch so the model retargets from real labels.
 *
 * The heading travels with the text rather than being added by the prompt
 * builder: a second plugin contributing context would otherwise have its own
 * lines filed under CURRENT PAGE, which is only true of this one.
 */
export function pageMapContext(map) {
  if (!map || !map.groups?.length) return '';
  const lines = [`URL: ${map.url}`];
  for (const group of map.groups) {
    const labels = group.elements.map((el) => `'${el.label}'`).join(', ');
    if (labels) lines.push(`${group.name}: ${labels}${group.truncated ? ` (+${group.truncated} more)` : ''}`);
  }
  return lines.join('\n');
}

/** One batch of DSL steps against the visible browser. */
async function runSteps(browser, guard, steps, turn) {
  // A batch identical to one already run this turn cannot produce a different
  // result, and a model that cannot tell "the click resolved" from "the page
  // changed" will send it again — five times, in the session this guard was
  // written for. The decision lives in `batch-guard.mjs`.
  const refusal = guard.check(steps);
  if (refusal) return { ok: false, summary: 'identical batch already run', feedback: refusal };

  turn.status('Browser…');
  let outcomes;
  try {
    outcomes = await browser.runSteps(steps, { signal: turn.signal });
  } catch (err) {
    return { ok: false, summary: err.message, feedback: `[BROWSER FAILED] ${err.message}` };
  }

  const failed = outcomes.find((o) => !o.ok);
  const summary = failed
    ? `failed at: ${failed.step} — ${failed.error || failed.reason || 'no match'}`
    : `${outcomes.length} step(s) ok`;

  const context = pageMapContext(await browser.pageMap());
  const lines = [
    failed
      ? `[BROWSER] Step failed: ${failed.step}\nReason: ${failed.error || failed.reason || 'no element matched'}`
      : // Deliberately not "succeeded": the engine reports that it resolved a
        // target and acted on it, which is not the same as the page having done
        // what was wanted. Told the stronger thing, a model stops checking and
        // repeats itself.
        `[BROWSER] All ${outcomes.length} step(s) resolved and were acted on. That does NOT prove the page did ` +
        'what you intended — check CURRENT PAGE below before saying it worked.',
  ];
  if (context) {
    lines.push('', 'What is on the page now — use these exact labels if you act again:', context);
  }
  lines.push('', 'Tell the user what happened in one or two sentences. Emit another action only if the goal is not met yet.');

  return { ok: !failed, summary, outcomes, feedback: lines.join('\n') };
}

export function activate(ctx) {
  const browser = ctx.service('browser');
  const guard = new BatchGuard();

  ctx.prompt(PROMPT);
  ctx.onTurnStart(() => guard.beginTurn());
  ctx.context(async () => {
    if (!browser.open) return '';
    const map = pageMapContext(await browser.pageMap());
    return map ? `CURRENT PAGE\n${map}` : '';
  });

  ctx.action({ type: 'browser_steps', run: (steps, turn) => runSteps(browser, guard, steps, turn) });
  ctx.action({
    type: 'browser_close',
    run: async () => {
      await browser.close();
      return { ok: true, summary: 'browser closed' };
    },
  });
}
