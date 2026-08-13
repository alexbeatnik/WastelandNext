/**
 * End-to-end check for the YouTube ad watcher, against a real browser.
 *
 * A real ad cannot be summoned on demand, so the button is served from a local
 * page that mimics the player markup. Everything else is the real path: the
 * engine, a real Chrome, the same selector, the same detect-then-click.
 *
 * The host predicate is pointed at the local server for the run — that seam
 * exists on `BrowserBridge` for exactly this.
 *
 * Run with `npm run adskip:live`.
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-adskip-live-')));

const config = await import('../src/main/config.mjs');
config.update({ browserMode: 'launch', browserHeadless: true, skipYouTubeAds: true });

const { BrowserBridge } = await import('../src/main/browser/manul-browser.mjs');

/**
 * A page with the player's skip button, which records its own click so the
 * result can be read back with the same `readText` the watcher uses.
 */
const PAGE = `<!doctype html>
<meta charset="utf-8"><title>fake player</title>
<style>body{font:16px sans-serif;padding:40px}
button{padding:12px 20px;font-size:16px}
#result{margin-top:30px;font-size:20px}</style>
<h1>Pretend YouTube</h1>
<button class="ytp-ad-skip-button-modern" id="skip">SKIP AD</button>
<div id="result">not clicked</div>

<!-- A control the watcher must never touch. Reading a selector falls back to
     the whole body when it matches nothing, so a watcher that trusted that
     reading would click the first short thing it found. This proves it does
     not. -->
<button id="bystander">Subscribe</button>
<div id="bystander-result">untouched</div>

<script>
  document.getElementById('skip').addEventListener('click', () => {
    document.getElementById('result').textContent = 'clicked';
    document.getElementById('skip').remove();
  });
  document.getElementById('bystander').addEventListener('click', () => {
    document.getElementById('bystander-result').textContent = 'CLICKED BY MISTAKE';
  });
</script>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// Only this origin counts as "an ad host" for the run; everything else must be
// left alone, which the second case checks.
const browser = new BrowserBridge({ isAdHost: (url) => String(url).startsWith(origin) });
browser.on('log', (line) => console.log('   log:', line.slice(0, 100)));

try {
  console.log('Ad watcher, live\n');

  await browser.runSteps(`NAVIGATE to ${origin}/\nWAIT 1`);
  const before = await browser.readText('#result', 40);
  check('the page starts unclicked', before.trim() === 'not clicked', before);

  // The watcher polls every 2.5s; give it two windows.
  await new Promise((r) => setTimeout(r, 6000));

  const after = await browser.readText('#result', 40);
  check('the watcher clicked the skip button', after.trim() === 'clicked', after);

  // With the button gone the selector matches nothing, and the watcher keeps
  // polling. Two more windows: if it mistook the body text for a button it
  // would have clicked the bystander by now.
  await new Promise((r) => setTimeout(r, 6000));
  const bystander = await browser.readText('#bystander-result', 40);
  check('nothing else was clicked once the button was gone', bystander.trim() === 'untouched', bystander);

} finally {
  await browser.close();
}

// A page that is not an ad host must be left entirely alone. Run only after the
// first browser has fully closed: manul reuses one Chrome per profile, so two
// bridges at once would both be looking at the same page — an earlier version
// of this check "failed" for exactly that reason, with nothing wrong in the
// watcher.
const other = new BrowserBridge({ isAdHost: () => false });
try {
  await other.runSteps(`NAVIGATE to ${origin}/\nWAIT 1`);
  await new Promise((r) => setTimeout(r, 7000));
  const untouched = await other.readText('#result', 40);
  check('a page that is not an ad host is left alone', untouched.trim() === 'not clicked', untouched);
} finally {
  await other.close();
  server.close();
}

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
process.exit(failures.length === 0 ? 0 : 1);
