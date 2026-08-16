/**
 * Boot the real window offscreen and assert the UI populated itself.
 *
 * `npm test` covers the pure logic; nothing there would catch a renderer that
 * throws on boot, a preload that failed to expose its bridge, or an IPC channel
 * that was renamed on one side only. This does, without a human watching.
 *
 * Run with `npm run smoke`.
 */
import { app, BrowserWindow } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { setDataRoot, pluginStateDir, pluginsDir } from '../src/main/paths.mjs';
import { registerSchemes } from '../src/main/plugins/protocol.mjs';
import { registerIpc, serveAssets } from '../src/main/ipc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// A scratch data root, so a smoke run never touches real chats or settings.
setDataRoot(mkdtempSync(join(tmpdir(), 'wl-smoke-')));

// At module scope, exactly as in `main.mjs`: after the app is ready the scheme
// table is fixed, and a theme served over an unregistered scheme is refused by
// the page's CSP without ever reaching the handler.
registerSchemes();

/**
 * A GUI Electron process on Windows has no attached console, so stdout goes
 * nowhere when this is piped. The transcript is written to a file the caller
 * prints instead.
 */
const reportPath = process.env['SMOKE_REPORT'] ?? join(tmpdir(), 'wasteland-smoke.txt');
const report = [];
const failures = [];

function say(line) {
  report.push(line);
  console.log(line);
}

function check(label, ok, detail = '') {
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function finish() {
  say(failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`);
  try {
    writeFileSync(reportPath, `${report.join('\n')}\n`, 'utf8');
  } catch {
    /* the exit code still carries the verdict */
  }
  app.exit(failures.length === 0 ? 0 : 1);
}

// A hung renderer must fail the run, not hang the caller forever.
const watchdog = setTimeout(() => {
  check('completed within 45s', false, 'timed out');
  finish();
}, 45_000);

/**
 * Shapes the layout has to survive.
 *
 * The point of the aspect-ratio rules is that a 4:3 panel and an ultrawide want
 * different column counts at similar widths, so both ends of that range are
 * exercised rather than just "small" and "large".
 */
const SHAPES = [
  { name: '1024×768 (4:3)', width: 1024, height: 768, activity: false },
  { name: '1280×960 (4:3)', width: 1280, height: 960, activity: false },
  { name: '1200×960 (5:4)', width: 1200, height: 960, activity: false },
  { name: '1600×900 (16:9)', width: 1600, height: 900, activity: true },
  { name: '1920×960 (2:1)', width: 1920, height: 960, activity: true },
  { name: '2560×900 (21:9)', width: 2560, height: 900, activity: true },
  { name: '900×700 (narrow)', width: 900, height: 700, activity: false },
];

async function checkLayouts(window) {
  say('');
  say('Layout across screen shapes');

  // Windows refuses a content height taller than the work area, silently
  // keeping the previous size. Shapes that cannot fit are reported as skipped
  // rather than measured against a viewport that never changed.
  const { screen } = await import('electron');
  const workArea = screen.getPrimaryDisplay().workAreaSize;

  for (const shape of SHAPES) {
    if (shape.height > workArea.height - 60) {
      say(`  skip ${shape.name} — taller than this display's work area (${workArea.height}px)`);
      continue;
    }

    // A hidden window applies a resize on its own schedule, so the viewport is
    // polled rather than assumed after a fixed sleep.
    window.setContentSize(shape.width, shape.height);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const width = await window.webContents.executeJavaScript('window.innerWidth');
      if (Math.abs(width - shape.width) <= 4) break;
      if (attempt === 9) window.setContentSize(shape.width, shape.height);
    }

    const layout = await window.webContents.executeJavaScript(`(() => {
      const root = document.documentElement;
      const chat = document.querySelector('.panel-chat').getBoundingClientRect();
      const activity = document.getElementById('panel-activity');
      const log = document.getElementById('chat-log').getBoundingClientRect();
      return {
        viewport: window.innerWidth + '×' + window.innerHeight,
        innerWidth: window.innerWidth,
        overflow: root.scrollWidth - root.clientWidth,
        chatWidth: Math.round(chat.width),
        logHeight: Math.round(log.height),
        activityShown: getComputedStyle(activity).display !== 'none',
        columns: getComputedStyle(document.getElementById('workspace')).gridTemplateColumns.split(' ').length,
      };
    })()`);

    const problems = [];
    if (layout.overflow > 1) problems.push(`h-overflow ${layout.overflow}px`);
    if (layout.chatWidth < 320) problems.push(`chat only ${layout.chatWidth}px`);
    if (layout.logHeight < 200) problems.push(`log only ${layout.logHeight}px`);
    if (layout.activityShown !== shape.activity) {
      problems.push(`activity column ${layout.activityShown ? 'shown' : 'hidden'}, expected the opposite`);
    }

    // The requested size is only a request: a hidden window, a smaller display
    // or DPI scaling can all land somewhere else, and a layout check against a
    // viewport that never changed proves nothing.
    if (Math.abs(layout.innerWidth - shape.width) > 4) {
      problems.push(`viewport ${layout.viewport}, asked for ${shape.width}×${shape.height}`);
    }

    check(
      `${shape.name} — ${layout.columns} col, chat ${layout.chatWidth}px, log ${layout.logHeight}px`,
      problems.length === 0,
      problems.join('; '),
    );
  }
}

/**
 * Drive the chat controls the way a user does.
 *
 * NEW CHAT resetting the conversation is the kind of thing that looks obviously
 * correct in the source and still regresses, because it spans a click handler,
 * a module-scoped variable and the id the main process is handed on the next
 * send. Only clicking it proves anything.
 */
async function checkChatControls(window) {
  say('');
  say('Chat controls');

  // Pick the seeded conversation from the picker above the transcript.
  const before = await window.webContents.executeJavaScript(`(() => {
    const pick = document.querySelector('#chat-menu .chat-row .chat-pick');
    if (!pick) return false;
    pick.click();
    return true;
  })()`);
  assertOk(before);
  await new Promise((r) => setTimeout(r, 400));

  const loaded = await window.webContents.executeJavaScript(`(() => ({
    turns: document.querySelectorAll('#chat-log .turn').length,
    current: document.querySelector('#chat-menu .chat-row.current') !== null,
    label: document.getElementById('chat-current-label').textContent,
    deletable: !document.getElementById('btn-delete-chat').disabled,
    ctx: document.getElementById('ctx-label').textContent,
  }))()`);
  check(`seeded chat renders — ${loaded.turns} turn(s)`, loaded.turns === 3);
  check(`the picker shows the open conversation — ${loaded.label}`, loaded.current, JSON.stringify(loaded));
  check('an open conversation can be deleted', loaded.deletable);

  // Push a real context reading in first: checking that the meter reads 0%
  // after NEW CHAT proves nothing if it was never anything else.
  window.webContents.send('event', { event: 'ctx', used: 5100, max: 8192, percent: 62.2 });
  await new Promise((r) => setTimeout(r, 200));
  const busy = await window.webContents.executeJavaScript(`document.getElementById('ctx-label').textContent`);
  check(`context meter shows usage — ${busy}`, /5100/.test(busy));

  await window.webContents.executeJavaScript(`document.getElementById('btn-new-chat').click()`);
  await new Promise((r) => setTimeout(r, 400));

  const fresh = await window.webContents.executeJavaScript(`(() => ({
    turns: document.querySelectorAll('#chat-log .turn').length,
    cards: document.querySelectorAll('#chat-log .action-card').length,
    label: document.getElementById('chat-current-label').textContent,
    current: document.querySelector('#chat-menu .chat-row.current') !== null,
    rows: document.querySelectorAll('#chat-menu .chat-row').length,
    deletable: !document.getElementById('btn-delete-chat').disabled,
    ctx: document.getElementById('ctx-label').textContent,
    input: document.getElementById('input').value,
  }))()`);
  check('NEW CHAT empties the transcript', fresh.turns === 0 && fresh.cards === 0, `${fresh.turns} turn(s)`);
  check(`NEW CHAT selects the placeholder — ${fresh.label}`, /new conversation/.test(fresh.label) && !fresh.current);
  // The seeded chat is still there to go back to; only the selection moved.
  check(`the earlier conversation is still listed — ${fresh.rows} entries`, fresh.rows >= 1);
  check('there is nothing to delete on a blank conversation', !fresh.deletable);
  check('NEW CHAT clears the composer', fresh.input === '', JSON.stringify(fresh.input));

  // A fresh chat still costs the system prompt, so the assertion is that the
  // number was recomputed and is small — not that it is literally zero.
  const used = Number(/CTX: (\d+)/.exec(fresh.ctx)?.[1] ?? -1);
  check(`NEW CHAT recomputes the context meter — ${fresh.ctx}`, used >= 0 && used < 2000);

  // The menu itself. `hidden` is checked through the computed style, because
  // any author-level `display` outranks the attribute and the two can disagree
  // — which is exactly how the drop veil shipped visible from boot.
  const menu = await window.webContents.executeJavaScript(`(() => {
    const node = document.getElementById('chat-menu');
    const shut = getComputedStyle(node).display;
    document.getElementById('chat-current').click();
    return { shut, open: getComputedStyle(node).display };
  })()`);
  check('the chat menu starts closed', menu.shut === 'none', JSON.stringify(menu));
  check('clicking the picker opens it', menu.open !== 'none', JSON.stringify(menu));

  // Deleting from the list, without opening the conversation first — the thing
  // a native <select> could not offer. The transcript is blank here (NEW CHAT
  // above), so it must still be blank afterwards: deleting some other chat must
  // not disturb the one on screen.
  const dropped = await window.webContents.executeJavaScript(`(async () => {
    const rows = document.querySelectorAll('#chat-menu .chat-row');
    const before = rows.length;
    const name = rows[0].querySelector('.chat-title').textContent;
    rows[0].querySelector('.chat-drop').click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      before,
      after: document.querySelectorAll('#chat-menu .chat-row').length,
      name,
      names: [...document.querySelectorAll('#chat-menu .chat-title')].map((n) => n.textContent),
      turns: document.querySelectorAll('#chat-log .turn').length,
      stillOpen: getComputedStyle(document.getElementById('chat-menu')).display !== 'none',
    };
  })()`);
  check(`a conversation is deleted from the list — ${dropped.name}`, dropped.after === dropped.before - 1, JSON.stringify(dropped));
  check('the deleted one is gone from the list', !dropped.names.includes(dropped.name), JSON.stringify(dropped.names));
  check('deleting another conversation leaves the open one alone', dropped.turns === 0, `${dropped.turns} turn(s)`);
  check('the menu stays open, so several can go in one visit', dropped.stillOpen);

  await window.webContents.executeJavaScript(`document.body.click()`);
  await new Promise((r) => setTimeout(r, 150));
  const shut = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('chat-menu')).display`,
  );
  check('clicking away closes the menu', shut === 'none', shut);

  await checkComposerKeys(window);
}

/**
 * Enter sends, Shift+Enter does not.
 *
 * There is no model loaded here, so the send fails — but it fails *after* the
 * composer has been cleared and the user's turn drawn, which is exactly the
 * part being checked.
 */
async function checkComposerKeys(window) {
  const key = (shift) => `(() => {
    const input = document.getElementById('input');
    input.value = 'hello there';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: ${shift}, bubbles: true, cancelable: true }));
    return null;
  })()`;

  await window.webContents.executeJavaScript(key(true));
  await new Promise((r) => setTimeout(r, 300));
  const afterShift = await window.webContents.executeJavaScript(`(() => ({
    value: document.getElementById('input').value,
    turns: document.querySelectorAll('#chat-log .turn.user').length,
  }))()`);
  check('Shift+Enter does not send', afterShift.value === 'hello there' && afterShift.turns === 0);

  // No model is loaded, so this send fails. That is the interesting case: the
  // failure happens before the turn is recorded, so the words must come back
  // and the optimistic turn must be withdrawn.
  await window.webContents.executeJavaScript(key(false));
  await new Promise((r) => setTimeout(r, 900));
  const afterEnter = await window.webContents.executeJavaScript(`(() => ({
    value: document.getElementById('input').value,
    turns: document.querySelectorAll('#chat-log .turn.user').length,
    cursors: document.querySelectorAll('#chat-log .cursor').length,
    sendLabel: document.getElementById('btn-send').textContent,
  }))()`);
  check('Enter sends', afterEnter.turns >= 0 && afterEnter.sendLabel === '▶', JSON.stringify(afterEnter));
  check(
    'a failed send returns the text to the composer',
    afterEnter.value === 'hello there' && afterEnter.turns === 0,
    JSON.stringify(afterEnter),
  );
  check('a failed send leaves no blinking cursor behind', afterEnter.cursors === 0, `${afterEnter.cursors} cursor(s)`);
}

/**
 * Attaching a file or a folder.
 *
 * Driven through the IPC the buttons use rather than through the file dialog,
 * which cannot be opened offscreen. What this catches is the half that is
 * invisible from the unit tests: the chips reaching the DOM, the detach button
 * being wired to the right id, and an attachment rendering folded in the
 * transcript instead of unrolling a whole project into it.
 */
async function checkAttachments(window) {
  say('');
  say('Attachments');

  // Asserted on the computed style, not on the `hidden` attribute. The first
  // version of this check read the attribute, found it set, and passed — while
  // the veil sat over the transcript from boot, because `hidden` is only the UA
  // rule `[hidden] { display: none }` and the author-level `display: flex`
  // outranked it. What the attribute says and what the user sees are different
  // questions, and only the second one is worth a check.
  const veil = await window.webContents.executeJavaScript(`(() => {
    const node = document.getElementById('drop-veil');
    return { attribute: node.hidden, display: getComputedStyle(node).display };
  })()`);
  check('the drop veil starts hidden', veil.display === 'none', JSON.stringify(veil));

  // The repository itself is the folder under test — it is certainly there, and
  // it is the case the feature was asked for.
  const added = await window.webContents.executeJavaScript(
    `window.wasteland.attach.add([${JSON.stringify(process.cwd())}]).then((r) => r.items.length)`,
  );
  check('a folder attaches', added === 1, `${added} item(s)`);

  await new Promise((r) => setTimeout(r, 200));
  const chips = await window.webContents.executeJavaScript(`(() => ({
    count: document.querySelectorAll('#attach-chips .chip').length,
    name: document.querySelector('#attach-chips .chip-name')?.textContent ?? '',
    kind: document.querySelector('#attach-chips .chip-kind')?.textContent ?? '',
    title: document.querySelector('#attach-chips .chip')?.title ?? '',
    clearShown: !document.getElementById('btn-attach-clear').hidden,
  }))()`);
  check('the chip reaches the composer row', chips.count === 1, JSON.stringify(chips));
  // Named by parent/name, not by basename: half the folders worth attaching are
  // called `src`, and two of those would be one label written twice.
  check(`the chip names the folder and its parent — ${chips.name}`, chips.name.includes('/'), chips.name);
  check(`a folder is labelled as one — ${chips.kind}`, chips.kind === 'DIR');
  check('the full path is on hover', chips.title.includes(process.cwd().split('\\').pop()), chips.title);
  check('CLEAR appears once something is attached', chips.clearShown === true);

  // Removing one must remove exactly one. A detach button wired to the wrong id
  // — or to the clear-all — is invisible until the moment it costs somebody the
  // attachment they meant to keep.
  const detached = await window.webContents.executeJavaScript(`(async () => {
    await window.wasteland.attach.add([${JSON.stringify(join(process.cwd(), 'package.json'))}]);
    await new Promise((r) => setTimeout(r, 150));
    const before = document.querySelectorAll('#attach-chips .chip').length;
    document.querySelector('#attach-chips .chip button').click();
    await new Promise((r) => setTimeout(r, 250));
    const chip = document.querySelector('#attach-chips .chip .chip-name');
    return { before, after: document.querySelectorAll('#attach-chips .chip').length, left: chip?.textContent ?? '' };
  })()`);
  check('two attachments coexist', detached.before === 2, JSON.stringify(detached));
  check('detaching one leaves the other', detached.after === 1, JSON.stringify(detached));
  check(`the one left is the one not detached — ${detached.left}`, detached.left.includes('package.json'));

  const skipped = await window.webContents.executeJavaScript(
    `window.wasteland.attach.add(['${'/definitely/not/here'}']).then((r) => r.errors.length)`,
  );
  check('an unreachable path is reported, not thrown away', skipped === 1, `${skipped} error(s)`);

  const cleared = await window.webContents.executeJavaScript(
    `window.wasteland.attach.clear().then(() => new Promise((r) => setTimeout(
       () => r(document.querySelectorAll('#attach-chips .chip').length), 150)))`,
  );
  check('clearing empties the row', cleared === 0, `${cleared} chip(s) left`);

  // Folded, because a dropped project renders to thousands of lines and a
  // transcript with the reply somewhere below all of them is unusable.
  const folded = await window.webContents.executeJavaScript(`(() => {
    const log = document.getElementById('chat-log');
    log.replaceChildren();
    const node = document.createElement('div');
    node.className = 'turn tool attachment';
    log.append(node);
    return document.querySelectorAll('#chat-log .turn.attachment').length;
  })()`);
  check('an attachment turn has its own shape in the transcript', folded === 1);

  /**
   * Sending a message does not detach anything.
   *
   * The chip used to vanish the moment a question was asked, which read as the
   * app having thrown the folder away — so the user attached it again to ask a
   * second question about the same project. Driven through the real event
   * channel rather than by calling a renderer function, because what is under
   * test is exactly the handler that used to blank the row.
   */
  await window.webContents.executeJavaScript(`window.wasteland.attach.add([${JSON.stringify(process.cwd())}])`);
  await new Promise((r) => setTimeout(r, 200));

  const pendingMark = await window.webContents.executeJavaScript(
    `document.querySelector('#attach-chips .chip-state')?.textContent ?? ''`,
  );
  check('an attachment not yet sent is marked as still to go — +', pendingMark === '+', pendingMark);

  const items = await window.webContents.executeJavaScript(`window.wasteland.attach.list()`);
  window.webContents.send('event', {
    event: 'attach:consumed',
    items: items.map((item) => ({ ...item, includedIn: [''] })),
  });
  await new Promise((r) => setTimeout(r, 200));

  const afterSend = await window.webContents.executeJavaScript(`(() => ({
    count: document.querySelectorAll('#attach-chips .chip').length,
    mark: document.querySelector('#attach-chips .chip-state')?.textContent ?? '',
    title: document.querySelector('#attach-chips .chip')?.title ?? '',
  }))()`);
  check('the chip survives the message it went with', afterSend.count === 1, JSON.stringify(afterSend));
  check('and says the conversation now holds it — ✓', afterSend.mark === '✓', JSON.stringify(afterSend));
  check('the tooltip says so too', afterSend.title.includes('Already in this conversation'), afterSend.title);

  await window.webContents.executeJavaScript(`window.wasteland.attach.clear()`);
}

/**
 * A message with no question in front of it.
 *
 * Driven over the real `event` channel, which is the only way in: a reminder
 * coming due is a main-process timer talking to a window that never asked for
 * anything. What is being checked is that it lands somewhere the user will see
 * it and that it lands exactly once — the same notice arrives twice by design,
 * through the boot snapshot and again on the stream.
 */
async function checkNotices(window) {
  say('');
  say('Notices');

  await window.webContents.executeJavaScript(`document.getElementById('chat-log').replaceChildren()`);

  const notice = { id: 'smoke-notice-1', title: 'Watch the series', body: 'Due at 18:45', pluginId: 'reminders', at: Date.now() };
  window.webContents.send('event', { event: 'notice', notice });
  await new Promise((r) => setTimeout(r, 200));

  const drawn = await window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#chat-log .notice');
    return {
      count: document.querySelectorAll('#chat-log .notice').length,
      title: card?.querySelector('.notice-title')?.textContent ?? '',
      body: card?.querySelector('.notice-body')?.textContent ?? '',
      display: card ? getComputedStyle(card).display : 'none',
      logged: document.getElementById('activity-log').textContent.includes('Watch the series'),
    };
  })()`);
  check('a notice reaches the transcript', drawn.count === 1, JSON.stringify(drawn));
  check(`the notice says what it is for — ${drawn.title}`, drawn.title === 'Watch the series');
  check('and when it was due', drawn.body.includes('18:45'), drawn.body);
  // Asserted on the computed style rather than on the element existing: a card
  // in the DOM that nothing draws is the failure this app has already shipped
  // once, with the drop veil.
  check('the notice is actually on screen', drawn.display !== 'none', drawn.display);
  check('and it reaches the activity log', drawn.logged === true);

  // The same notice arrives twice by design — once in the boot snapshot, once
  // on the stream — and drawing a reminder twice is worse than the race that
  // makes it arrive twice.
  window.webContents.send('event', { event: 'notice', notice });
  await new Promise((r) => setTimeout(r, 150));
  const again = await window.webContents.executeJavaScript(
    `document.querySelectorAll('#chat-log .notice').length`,
  );
  check('the same notice is not drawn twice', again === 1, `${again} card(s)`);

  await window.webContents.executeJavaScript(`document.getElementById('chat-log').replaceChildren()`);
}

/**
 * The AUTO context toggle.
 *
 * The slider must be inert while AUTO is on: one that still looks editable but
 * is ignored at load time is a lie about who decides the value.
 */
async function checkContextControls(window) {
  say('');
  say('Context control');

  const read = () =>
    window.webContents.executeJavaScript(`(() => ({
      auto: document.getElementById('set-auto-ctx').checked,
      disabled: document.getElementById('set-nctx').disabled,
      shown: document.getElementById('val-nctx').textContent,
      explain: document.getElementById('ctx-explain').textContent,
      gpuAuto: document.getElementById('set-auto-gpu').checked,
      gpuDisabled: document.getElementById('set-ngl').disabled,
      gpuShown: document.getElementById('val-ngl').textContent,
    }))()`);

  const on = await read();
  check(`AUTO is on by default — shows "${on.shown}"`, on.auto === true);
  check('the slider is inert while AUTO decides', on.disabled === true);
  check(`AUTO explains itself — "${on.explain}"`, on.explain.length > 0);
  check(
    `GPU layers are AUTO too — shows "${on.gpuShown}"`,
    on.gpuAuto === true && on.gpuDisabled === true && on.gpuShown === 'auto',
  );

  await window.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('set-auto-ctx');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const off = await read();
  check('turning AUTO off hands the slider back', off.disabled === false);
  check(`the manual value is shown — "${off.shown}"`, /^\d+$/.test(off.shown));

  // Restore, so the shape checks that follow see the default state.
  await window.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('set-auto-ctx');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * The plugin list.
 *
 * The unit tests drive the host directly and never see the half that is only
 * visible from here: the rows reaching the DOM, a checkbox bound to the right
 * id, and — the one that matters — a toggle whose effect comes back from the
 * main process rather than from the click. A row that painted itself optimistically
 * would pass every assertion below except the last one.
 */
async function checkPlugins(window) {
  say('');
  say('Plugins');

  // Read first, before anything in this run has touched the section. The
  // registry points at a closed port, and a boot that cannot reach it must be
  // silent: the update badges are worth a background fetch, an error about a
  // list nobody asked to see is not. Pressing REFRESH is asking, and that
  // failure is said out loud further down.
  const quiet = await window.webContents.executeJavaScript(`document.getElementById('store-status').textContent`);
  check(`an unreachable registry is quiet at boot — "${quiet}"`, quiet === '', quiet);

  const read = () =>
    window.webContents.executeJavaScript(`(() => ({
      rows: [...document.querySelectorAll('#plugin-list .plugin-item')].map((row) => ({
        name: row.querySelector('.plugin-name').textContent,
        checked: row.querySelector('input[type=checkbox]').checked,
        off: row.classList.contains('off'),
        adds: row.querySelector('.plugin-adds')?.textContent ?? '',
        note: row.querySelector('.plugin-note')?.textContent ?? '',
      })),
      status: document.getElementById('plugin-status').textContent,
    }))()`);

  const start = await read();
  // Four built-ins, the theme pack, and the code plugin awaiting approval.
  check(`every plugin is listed — ${start.rows.length}`, start.rows.length === 6, JSON.stringify(start.rows.map((r) => r.name)));
  check(`the section says how many are running — ${start.status}`, /^4 of 6 active$/.test(start.status), start.status);

  const browser = start.rows.find((row) => row.name === 'Browser control');
  const shell = start.rows.find((row) => row.name === 'Shell commands');
  check('browser control is on by default', browser?.checked === true && browser?.off === false, JSON.stringify(browser));
  // The one capability that has always been off until asked for.
  check('shell is off by default, and looks it', shell?.checked === false && shell?.off === true, JSON.stringify(shell));
  check(`a row names the actions it adds — ${browser?.adds}`, /browser_steps/.test(browser?.adds ?? ''), browser?.adds);
  check('a working plugin has nothing to explain', browser?.note === '', browser?.note);

  // A theme pack is manifest and CSS: there is no code to run, so there is
  // nothing to approve, and it must be active on the strength of being enabled.
  const theme = start.rows.find((row) => row.name === 'Smoke theme');
  check('an installed theme pack is active without being approved', theme?.checked === true && theme?.off === false, JSON.stringify(theme));
  check('and it says which theme it adds', /theme: Green/.test(theme?.adds ?? ''), theme?.adds);
  // Languages were missing from this line entirely, so a language pack's row
  // gave its name, its version and no hint whatever that it contributed a
  // language — installed, working, and indistinguishable from a plugin that
  // does nothing.
  check('and which language', /language: Smokish/.test(theme?.adds ?? ''), theme?.adds);
  // A pack does nothing by being installed: it appears in a picker, and the
  // picker is in a collapsed section further down. Reported as "the language
  // plugin is installed and there is no language choice anywhere".
  check(`and where to go to use it — "${theme?.note}"`, /pick it in INTERFACE/.test(theme?.note ?? ''), theme?.note);

  // Switch one off through the checkbox, exactly as a user would.
  await window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('#plugin-list .plugin-item')]
      .find((r) => r.querySelector('.plugin-name').textContent === 'File reading');
    const box = row.querySelector('input[type=checkbox]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const off = await read();
  const readFile = off.rows.find((row) => row.name === 'File reading');
  check('switching a plugin off is reflected in its row', readFile?.checked === false && readFile?.off === true, JSON.stringify(readFile));
  // Asserted against the number, not merely against "it changed": the first
  // version of this check passed because the handler blanked the status line it
  // had just written, and an empty string is different from anything.
  check(`and in the count — ${off.status}`, /^3 of 6 active$/.test(off.status), `${start.status} → ${off.status}`);

  // The state must survive a round trip through the main process, not merely
  // live in the checkbox that was clicked.
  const persisted = await window.webContents.executeJavaScript(
    `window.wasteland.plugins.list().then((list) => list.find((p) => p.id === 'read-file'))`,
  );
  check('the main process agrees it is off', persisted.enabled === false && persisted.active === false, JSON.stringify(persisted));

  // Put it back, so the rest of the run sees the defaults.
  await window.webContents.executeJavaScript(`window.wasteland.plugins.setEnabled('read-file', true)`);
  await new Promise((r) => setTimeout(r, 400));
  const back = await window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('#plugin-list .plugin-item')]
      .find((r) => r.querySelector('.plugin-name').textContent === 'File reading');
    return { checked: row.querySelector('input[type=checkbox]').checked, off: row.classList.contains('off') };
  })()`);
  // Painted from the event, not from a click — nothing was clicked this time.
  check('an enable from elsewhere repaints the row', back.checked === true && back.off === false, JSON.stringify(back));

  // Before `checkApproval`, which is what approves the code plugin: this checks
  // the state it is in *before* that, which is the state a real machine was
  // found in twice.
  await checkStoreApproval(window);
  await checkApproval(window);
  await checkChoices(window);

  await window.webContents.executeJavaScript(`document.getElementById('btn-store-refresh').click()`);
  await new Promise((r) => setTimeout(r, 1500));
  const asked = await window.webContents.executeJavaScript(`(() => ({
    status: document.getElementById('store-status').textContent,
    rows: document.querySelectorAll('#store-list .plugin-item').length,
  }))()`);
  check(`asking for it out loud reports the failure — "${asked.status}"`, /registry/i.test(asked.status), JSON.stringify(asked));
  check('and lists nothing rather than something stale', asked.rows === 0, `${asked.rows} row(s)`);

  await checkRegistries(window);
}

/**
 * A registry that actually answers, on loopback.
 *
 * Every other registry check in this run points at a closed port, because what
 * they are checking is the failure. This one exists because the *success* path
 * has its own failure mode, and it is the one that has now caught two people
 * out: a plugin installs, its row says "installed (1.0.0)", and nothing runs —
 * because installing is not switching on and the control that does it was in a
 * different section entirely.
 */
function startRegistry(entries) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ schema: 1, updated: '2026-08-15', plugins: entries }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * What the registry row says about something installed that is not running.
 *
 * Run before the code plugin has been approved, which is the state a machine
 * was found in twice: enabled false, approved false, and a row that mentioned
 * neither.
 */
async function checkStoreApproval(window) {
  const { server, port } = await startRegistry([
    {
      id: 'smoke-code',
      name: 'Smoke code',
      version: '1.0.0',
      description: 'Registers one action, for the smoke test.',
      author: 'the smoke runner',
      apiVersion: 4,
      kind: 'code',
      url: 'https://example.test/smoke-code-1.0.0.zip',
      sha256: 'a'.repeat(64),
      size: 1024,
    },
  ]);

  try {
    await window.webContents.executeJavaScript(
      `window.wasteland.plugins.addRegistry('http://127.0.0.1:${port}/index.json')`,
    );
    await window.webContents.executeJavaScript(`document.getElementById('btn-store-refresh').click()`);
    await new Promise((r) => setTimeout(r, 1500));

    const row = await window.webContents.executeJavaScript(`(() => {
      const item = [...document.querySelectorAll('#store-list .plugin-item')]
        .find((node) => node.querySelector('.plugin-name')?.textContent === 'Smoke code');
      if (!item) return null;
      return {
        note: item.querySelector('.plugin-note')?.textContent ?? '',
        buttons: [...item.querySelectorAll('.plugin-buttons button')].map((b) => b.textContent),
        source: item.querySelector('.plugin-adds')?.textContent ?? '',
      };
    })()`);

    check('a reachable registry lists what it published', Boolean(row), 'no row for the published plugin');
    if (row) {
      check(`the row says it came from elsewhere — ${row.source}`, /from 127\.0\.0\.1/.test(row.source), row.source);
      // The two halves of the failure that was reported: the row claimed to be
      // installed and said nothing about needing permission, and there was no
      // control here to give it.
      check(`an installed plugin that is not running says so — "${row.note}"`, /needs your permission/.test(row.note), row.note);
      check('and the control that starts it is on that row', row.buttons.some((text) => text.includes('ALLOW AND RUN')), JSON.stringify(row.buttons));
    }

    await window.webContents.executeJavaScript(
      `window.wasteland.plugins.removeRegistry('http://127.0.0.1:${port}/index.json')`,
    );
    await window.webContents.executeJavaScript(`window.wasteland.plugins.available().catch(() => {})`);
  } finally {
    server.close();
  }
}

/**
 * Where the plugin list is fetched from.
 *
 * Every URL here is loopback on a closed port, so each one fails in
 * milliseconds rather than waiting out the fetch timeout — the run has a
 * watchdog, and a check that spends twenty seconds proving a name does not
 * resolve is a check that eventually kills the suite.
 */
async function checkRegistries(window) {
  say('');
  say('Registries');

  const read = () =>
    window.webContents.executeJavaScript(`(() => ({
      rows: [...document.querySelectorAll('#registry-list .registry-item')].map((row) => ({
        name: row.querySelector('.registry-name').textContent,
        removable: Boolean(row.querySelector('button')),
        failed: row.classList.contains('failed'),
      })),
      status: document.getElementById('store-status').textContent,
    }))()`);

  const start = await read();
  check(`the registry being asked is on screen — ${start.rows.length}`, start.rows.length === 1, JSON.stringify(start.rows));
  // The app's own has no remove button: a list with nothing in it and no way
  // back to the default is a plugin section repairable only by editing
  // config.json.
  check('the app’s own registry cannot be removed', start.rows[0]?.removable === false, JSON.stringify(start.rows[0]));
  check('a registry that did not answer says so on its own row', start.rows[0]?.failed === true, JSON.stringify(start.rows[0]));

  // Refused before it is stored: an index over plain http is a list of URLs and
  // checksums that anything on the path can rewrite.
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('registry-url').value = 'http://plugins.example/index.json';
    document.getElementById('btn-registry-add').click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const refused = await read();
  check('a registry that is not over https is refused', refused.rows.length === 1, JSON.stringify(refused.rows));
  check(`and the reason is where the user is looking — "${refused.status}"`, /https/.test(refused.status), refused.status);

  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('registry-url').value = 'http://127.0.0.1:1/index.json';
    document.getElementById('btn-registry-add').click();
  })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const added = await read();
  check(`a second registry is added and asked — ${added.rows.length}`, added.rows.length === 2, JSON.stringify(added.rows));
  check('and it is the one that can be removed', added.rows[1]?.removable === true, JSON.stringify(added.rows[1]));
  const cleared = await window.webContents.executeJavaScript(
    `document.getElementById('registry-url').value`,
  );
  check('the box is emptied once it has been taken', cleared === '', cleared);

  // Removing is a click on the row, not a settings edit.
  await window.webContents.executeJavaScript(
    `document.querySelectorAll('#registry-list .registry-item')[1].querySelector('button').click()`,
  );
  await new Promise((r) => setTimeout(r, 1500));
  const removed = await read();
  check('removing one leaves the app’s own behind', removed.rows.length === 1, JSON.stringify(removed.rows));

  const fromFile = await window.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('btn-store-file');
    return { there: Boolean(button), shown: button ? getComputedStyle(button).display !== 'none' : false };
  })()`);
  check('installing from an archive on disk is offered', fromFile.there && fromFile.shown, JSON.stringify(fromFile));
}

/**
 * Markdown in an assistant reply is drawn as structure, not printed literally.
 *
 * The reply is pushed through the real `reply:end` event, so this exercises the
 * same path a model's answer takes.
 */
async function checkMarkdown(window) {
  say('');
  say('Markdown rendering');

  const reply = [
    '## Heading',
    '',
    'Some **bold** and `inline code` and a [link](https://example.com).',
    '',
    '- first item',
    '- second item',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    'And markup that must not run: <img src=x onerror=alert(1)>',
  ].join('\n');

  window.webContents.send('event', { event: 'reply:end', text: reply, rendered: reply, aborted: false });
  await new Promise((r) => setTimeout(r, 400));

  const drawn = await window.webContents.executeJavaScript(`(() => {
    const turn = document.querySelector('#chat-log .turn.assistant.md');
    if (!turn) return null;
    return {
      heading: turn.querySelectorAll('h3, h4').length,
      bold: turn.querySelectorAll('strong').length,
      code: turn.querySelectorAll('code').length,
      pre: turn.querySelectorAll('pre.code-block').length,
      listItems: turn.querySelectorAll('li').length,
      links: [...turn.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      images: turn.querySelectorAll('img').length,
      text: turn.textContent,
    };
  })()`);

  check('an assistant reply is drawn as markdown', Boolean(drawn), 'no markdown turn found');
  if (!drawn) return;

  check(`a heading became an element — ${drawn.heading}`, drawn.heading === 1);
  check('emphasis became <strong>', drawn.bold === 1);
  check(`code spans and blocks rendered — ${drawn.code} code, ${drawn.pre} block`, drawn.code >= 2 && drawn.pre === 1);
  check(`the list became items — ${drawn.listItems}`, drawn.listItems === 2);
  check(`the link points where it said — ${drawn.links.join(',')}`, drawn.links[0] === 'https://example.com');
  // The point of building nodes instead of assigning innerHTML.
  check('markup in the reply is shown, not executed', drawn.images === 0 && drawn.text.includes('<img src=x'));
  check('the raw asterisks are gone', !drawn.text.includes('**bold**'), drawn.text.slice(0, 60));
}

function assertOk(value) {
  if (!value) throw new Error('interaction setup failed');
}

/** A playable 8 kHz mono PCM WAV of `samples` bytes of silence. */
function silentWav(samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk length
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(8000, 28); // byte rate
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples, 40);
  // 8-bit PCM is unsigned, so silence is 128 rather than 0.
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

/**
 * Allowing a plugin that brings code.
 *
 * This is the path that failed on a real machine: the plugin was installed, its
 * settings were filled in, its checkbox looked ticked — and the host had never
 * imported a line of it, because nothing had approved it. The model then said,
 * accurately, that it had no audio plugin. Every part of that is invisible from
 * the unit tests, which can see the state but not what the row shows about it.
 */
async function checkApproval(window) {
  const read = () =>
    window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('#plugin-list .plugin-item')]
        .find((r) => r.querySelector('.plugin-name').textContent === 'Smoke code');
      if (!row) return null;
      const button = [...row.querySelectorAll('.plugin-buttons button')]
        .find((b) => b.textContent.includes('ALLOW'));
      return {
        checked: row.querySelector('input[type=checkbox]').checked,
        boxDisabled: row.querySelector('input[type=checkbox]').disabled,
        off: row.classList.contains('off'),
        note: row.querySelector('.plugin-note')?.textContent ?? '',
        allow: Boolean(button),
      };
    })()`);

  const before = await read();
  check('a plugin bringing code is listed', Boolean(before), 'no row for it');
  if (!before) return;

  check('it is not running before it is allowed', before.checked === false && before.off === true, JSON.stringify(before));
  // The checkbox cannot start it, so it must not look as though it could.
  check('and its checkbox does not pretend to be the control', before.boxDisabled === true, JSON.stringify(before));
  check(`the row says what allowing it means — "${before.note}"`, /runs code from outside the app/.test(before.note), before.note);
  check('there is a control that can actually start it', before.allow === true, JSON.stringify(before));

  await window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('#plugin-list .plugin-item')]
      .find((r) => r.querySelector('.plugin-name').textContent === 'Smoke code');
    [...row.querySelectorAll('.plugin-buttons button')].find((b) => b.textContent.includes('ALLOW')).click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const after = await read();
  check('allowing it starts it', after.checked === true && after.off === false, JSON.stringify(after));
  check('and the checkbox becomes the control from then on', after.boxDisabled === false, JSON.stringify(after));
  check('with nothing left to explain', after.note === '' && after.allow === false, JSON.stringify(after));

  // The point of all of it: the model is now told the action exists.
  const known = await window.webContents.executeJavaScript(
    `window.wasteland.plugins.list().then((list) => list.find((p) => p.id === 'smoke-code')?.active === true)`,
  );
  check('the main process agrees it is running', known === true);

  // It wrote to its own document during activation, which is the only proof
  // from out here that `ctx.state` reached it at all — a service or a store
  // that threw would have failed the row above with a reason, but a store that
  // silently wrote nowhere would not.
  const statePath = join(pluginStateDir(), 'smoke-code.json');
  const kept = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  check('a plugin keeps a document of its own, outside its directory', Number(kept?.starts) >= 1, JSON.stringify(kept));

  // The picker is drawn from the manifest, so it exists before a line of the
  // plugin's code has run — and a `select` that rendered as a text box would
  // pass every assertion about the value while being unusable.
  const picker = await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('#plugin-list .plugin-item[data-plugin="smoke-code"]');
    const select = row?.querySelector('.plugin-setting select');
    return {
      there: Boolean(select),
      options: select ? [...select.options].map((o) => o.value) : [],
      chosen: select?.value ?? null,
    };
  })()`);
  check('a picker setting is drawn as one', picker.there === true, JSON.stringify(picker));
  // The blank leads, because an unset value reading as the first option would
  // claim a decision nobody made.
  check(`the choices come from the manifest — ${picker.options.join(',')}`, picker.options.join(',') === ',small,large', JSON.stringify(picker));

  const stored = await window.webContents.executeJavaScript(`(async () => {
    const list = await window.wasteland.plugins.setSetting('smoke-code', 'size', 'large');
    let refused = '';
    try { await window.wasteland.plugins.setSetting('smoke-code', 'size', 'enormous'); }
    catch (err) { refused = err.message; }
    return { value: list.find((p) => p.id === 'smoke-code').settings[0].value, refused };
  })()`);
  check('choosing one stores it', stored.value === 'large', JSON.stringify(stored));
  check('and a value it never offered is refused', /not one of the choices/.test(stored.refused), stored.refused);
}

/**
 * Dictation, without a microphone.
 *
 * Nothing here records anything — an offscreen window has no device and no
 * permission — but everything on either side of the recording is real: the
 * button appears because a plugin registered a transcriber, the bytes cross IPC,
 * the plugin answers, and the words land in the composer. That is the seam worth
 * checking; whisper.cpp is the plugin's business and is tested there.
 */
async function checkDictation(window) {
  say('');
  say('Dictation');

  // The reported status comes along so a mismatch names both halves: the button
  // once said "Dictate" while the main process reported the right label the
  // whole time, and only having both told us which side was wrong.
  const button = await window.webContents.executeJavaScript(`(async () => {
    const node = document.getElementById('btn-mic');
    return {
      display: getComputedStyle(node).display,
      glyph: node.textContent,
      title: node.title,
      reported: await window.wasteland.mic.status(),
    };
  })()`);
  // Asserted on the computed style, never on the attribute: `hidden` is only
  // the UA rule, and this button carries an author-level `display` that outranks
  // it — the drop veil shipped visible for exactly this reason.
  check('the microphone is offered once a plugin can hear', button.display !== 'none', JSON.stringify(button));
  check(`and it says whose ears they are — ${button.title}`, /Smoke ears/.test(button.title), JSON.stringify(button));

  // A WAV that is not a recording of anything: the stub answers regardless, and
  // what is under test is that the bytes reach it and the words come back.
  const heard = await window.webContents.executeJavaScript(`(async () => {
    const bytes = new Uint8Array(1024);
    const text = await window.wasteland.mic.transcribe(bytes.buffer);
    const input = document.getElementById('input');
    input.value = '';
    return { text };
  })()`);
  check(`a recording comes back as words — "${heard.text}"`, heard.text === 'open the browser', JSON.stringify(heard));

  // Switching the plugin off has to take the button with it, or the control
  // outlives the only thing that could answer it.
  await window.webContents.executeJavaScript(`window.wasteland.plugins.setEnabled('smoke-code', false)`);
  await new Promise((r) => setTimeout(r, 500));
  const gone = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('btn-mic')).display`,
  );
  check('switching the plugin off takes the button away', gone === 'none', gone);

  await window.webContents.executeJavaScript(`window.wasteland.plugins.setEnabled('smoke-code', true)`);
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Options an action put in the transcript, and a click on one.
 *
 * The event is synthetic — there is no model here to emit an action — but
 * everything after it is real: the renderer draws the buttons, the click goes
 * out over IPC, and the plugin's own `choose` answers it. What this catches is
 * a list that renders and does nothing, which looks identical to one that works
 * until somebody presses it.
 */
async function checkChoices(window) {
  window.webContents.send('event', {
    event: 'action:result',
    type: 'smoke_ping',
    ok: true,
    summary: '2 possible matches',
    choices: [
      { id: 'first', label: 'First option', note: 'an artist · an album' },
      { id: 'second', label: 'Second option', note: 'another one' },
    ],
  });
  await new Promise((r) => setTimeout(r, 300));

  const drawn = await window.webContents.executeJavaScript(`(() => {
    const box = [...document.querySelectorAll('#chat-log .action-card .choices')].pop();
    if (!box) return null;
    return {
      count: box.querySelectorAll('button.choice').length,
      labels: [...box.querySelectorAll('.choice-label')].map((n) => n.textContent),
      notes: [...box.querySelectorAll('.choice-note')].map((n) => n.textContent),
      chosen: box.querySelectorAll('button.choice.chosen').length,
    };
  })()`);
  check('choices are drawn as buttons under the result', drawn?.count === 2, JSON.stringify(drawn));
  check(`each one carries its own second line — ${drawn?.notes.join(' | ')}`, drawn?.notes.length === 2);
  check('none is marked as taken before anything is pressed', drawn?.chosen === 0);

  // The second one is what the fixture's `choose` accepts; the first is not.
  const taken = await window.webContents.executeJavaScript(`(async () => {
    const box = [...document.querySelectorAll('#chat-log .action-card .choices')].pop();
    [...box.querySelectorAll('button.choice')][1].click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      chosen: [...box.querySelectorAll('button.choice')].map((b) => b.classList.contains('chosen')),
      status: document.getElementById('status-line').textContent,
    };
  })()`);
  check('pressing one marks it, and only it', JSON.stringify(taken.chosen) === '[false,true]', JSON.stringify(taken));

  const refused = await window.webContents.executeJavaScript(`(async () => {
    const box = [...document.querySelectorAll('#chat-log .action-card .choices')].pop();
    [...box.querySelectorAll('button.choice')][0].click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      status: document.getElementById('status-line').textContent,
      chosen: [...box.querySelectorAll('button.choice')].map((b) => b.classList.contains('chosen')),
      enabled: [...box.querySelectorAll('button.choice')].every((b) => !b.disabled),
    };
  })()`);
  // A plugin that refuses a choice must say so rather than leave a dead button.
  check(`a refused choice is reported — "${refused.status}"`, /no longer the current one/.test(refused.status), refused.status);
  check('and the mark stays where it was', JSON.stringify(refused.chosen) === '[false,true]', JSON.stringify(refused));
  check('with every option still clickable', refused.enabled === true);
}

/**
 * A theme, end to end.
 *
 * Every part of this is invisible to the unit tests: whether the scheme was
 * registered in time, whether the CSP lets a stylesheet through it, whether the
 * handler finds the file inside the plugin, and whether the picker points the
 * `<link>` at the right place. The assertion is on a colour actually changing,
 * because everything short of that can be true while the screen is unchanged.
 */
async function checkThemes(window) {
  say('');
  say('Themes');

  const offered = await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('set-theme');
    return {
      options: [...select.options].map((option) => option.value),
      labels: [...select.options].map((option) => option.textContent),
      value: select.value,
    };
  })()`);
  check(
    `the picker lists the installed theme — ${offered.labels.join(' | ')}`,
    offered.options.includes('smoke-theme/green'),
    JSON.stringify(offered),
  );
  check('and starts on the built-in look', offered.value === '', offered.value);

  const before = await window.webContents.executeJavaScript(`getComputedStyle(document.body).color`);

  await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('set-theme');
    select.value = 'smoke-theme/green';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  // The stylesheet is fetched over the custom scheme, so this is a real load.
  await new Promise((r) => setTimeout(r, 800));

  const applied = await window.webContents.executeJavaScript(`(() => ({
    href: document.getElementById('theme-css').getAttribute('href') ?? '',
    color: getComputedStyle(document.body).color,
    sheets: [...document.styleSheets].length,
  }))()`);
  check(`the link points at the plugin scheme — ${applied.href}`, applied.href.startsWith('wasteland-plugin://smoke-theme/'), applied.href);
  check(
    `the theme actually repaints the window — ${before} → ${applied.color}`,
    applied.color === 'rgb(51, 255, 51)',
    `expected rgb(51, 255, 51), got ${applied.color}`,
  );

  // Back to amber, so the layout checks below see the shipped palette.
  await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('set-theme');
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const restored = await window.webContents.executeJavaScript(`(() => ({
    href: document.getElementById('theme-css').getAttribute('href'),
    color: getComputedStyle(document.body).color,
  }))()`);
  check('choosing the built-in look takes the stylesheet away again', restored.href === null && restored.color !== 'rgb(51, 255, 51)', JSON.stringify(restored));
}

/**
 * The language picker.
 *
 * It had none of this, and a theme picker sitting beside it that had all of it —
 * which is how a language pack came to be installed, enabled, correct on the
 * main-process side and completely absent from the screen, with nothing failing
 * anywhere. The dictionary is fetched over the plugin scheme like a stylesheet,
 * so `connect-src` is in this too; the assertion is on text actually changing,
 * because everything short of that can be true while the window is unchanged.
 */
async function checkLanguages(window) {
  say('');
  say('Languages');

  const offered = await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('set-locale');
    return {
      options: [...select.options].map((option) => option.value),
      labels: [...select.options].map((option) => option.textContent),
      value: select.value,
    };
  })()`);
  check(
    `the picker lists the installed language — ${offered.labels.join(' | ')}`,
    offered.options.includes('smoke-theme/xx'),
    JSON.stringify(offered),
  );
  check('and starts on the English it ships in', offered.value === '', offered.value);

  const before = await window.webContents.executeJavaScript(
    `document.querySelector('.activity-head').textContent`,
  );

  await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('set-locale');
    select.value = 'smoke-theme/xx';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  // A real fetch over wasteland-plugin://, so this is not instant.
  await new Promise((r) => setTimeout(r, 800));

  const applied = await window.webContents.executeJavaScript(`(() => ({
    heading: document.querySelector('.activity-head').textContent,
    send: document.getElementById('btn-send').title,
  }))()`);
  check(`the interface is actually translated — ${before} → ${applied.heading}`, applied.heading === 'SMOKE-LOG', JSON.stringify(applied));
  // A `title` is text a user reads too, and it is captured separately from the
  // text nodes — one working while the other does not is entirely possible.
  check(`an attribute is translated as well — ${applied.send}`, applied.send === 'SMOKE-SEND', applied.send);

  // Back to English, so everything below reads the shipped strings.
  await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('set-locale');
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const restored = await window.webContents.executeJavaScript(
    `document.querySelector('.activity-head').textContent`,
  );
  check('choosing English puts the original text back', restored === before, `${before} → ${restored}`);
}

/**
 * The player bar, driven the way a plugin drives it.
 *
 * The audio service is poked directly from the main process here because that
 * is exactly what a plugin does — there is no renderer API for loading a track,
 * on purpose. What this proves is the half a plugin cannot: that the bar
 * appears, that the media scheme serves a real file to a real `<audio>`, and
 * that a transport with no next button does not draw one.
 */
async function checkPlayer(window, wavPath) {
  say('');
  say('Audio player');

  const { audio } = await import('../src/main/audio.mjs');

  const hiddenAtBoot = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('player')).display`,
  );
  // Asserted through the computed style, never the attribute: `.player { display: flex }`
  // outranks the UA rule behind `hidden`, which is how the drop veil once shipped visible.
  check('the bar is absent until something is loaded', hiddenAtBoot === 'none', hiddenAtBoot);

  let advanced = 0;
  audio.setTransport({
    pluginId: 'smoke',
    buttons: ['next', 'stop'],
    handle: (command) => {
      if (command === 'next' || command === 'ended') advanced += 1;
    },
  });
  audio.load({ path: wavPath, label: 'Silence', sublabel: '1 of 1' }, { play: false });
  await new Promise((r) => setTimeout(r, 1200));

  const shown = await window.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('player');
    return {
      display: getComputedStyle(bar).display,
      title: document.getElementById('player-title').textContent,
      sub: document.getElementById('player-sub').textContent,
      duration: document.getElementById('player-duration').textContent,
      toggle: document.getElementById('player-toggle').textContent,
      next: getComputedStyle(document.getElementById('player-next')).display,
      previous: getComputedStyle(document.getElementById('player-previous')).display,
    };
  })()`);

  check(`the bar appears with the track named — ${shown.title}`, shown.display !== 'none' && shown.title === 'Silence', JSON.stringify(shown));
  check(`the plugin's own second line is shown — ${shown.sub}`, shown.sub === '1 of 1');
  // The duration can only come from the element having actually loaded the
  // file, which means the media scheme served it: this is the end-to-end bit.
  check(`the media scheme delivered a playable file — ${shown.duration}`, /^0:0[01]$/.test(shown.duration), shown.duration);
  check('a paused track shows a play button', shown.toggle === '▶');
  // The transport declared next and stop but not previous.
  check('declared buttons are shown', shown.next !== 'none', shown.next);
  check('undeclared ones are not', shown.previous === 'none', shown.previous);

  await window.webContents.executeJavaScript(`document.getElementById('player-next').click()`);
  await new Promise((r) => setTimeout(r, 300));
  check('the next button reaches the plugin that registered it', advanced === 1, `${advanced} advance(s)`);

  // Switching the driving plugin off must take the bar with it, or a bar left
  // behind offers buttons nothing is listening to.
  audio.releasePlugin('smoke');
  await new Promise((r) => setTimeout(r, 300));
  const gone = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('player')).display`,
  );
  check('releasing the transport clears the bar', gone === 'none', gone);
}

app.on('window-all-closed', () => {});

// `app.whenReady()` is awaited in a callback rather than at module top level:
// Electron holds the ready event until the ESM entry has finished evaluating,
// so a top-level await on it deadlocks.
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload: join(repoRoot, 'src', 'preload', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const errors = [];
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) errors.push(message);
    });

    // A theme pack, installed the way the registry installer would leave one.
    // It is the only way to exercise the whole path a theme takes: manifest →
    // host → picker → custom scheme → CSP → a colour actually changing.
    const themeDir = join(pluginsDir(), 'smoke-theme');
    mkdirSync(join(themeDir, 'themes'), { recursive: true });
    writeFileSync(
      join(themeDir, 'plugin.json'),
      JSON.stringify({
        id: 'smoke-theme',
        name: 'Smoke theme',
        version: '1.0.0',
        apiVersion: 3,
        description: 'Two colours, for the smoke test.',
        themes: [{ id: 'green', name: 'Green', file: 'themes/green.css' }],
        // A language too, so both halves of "data a pack contributes" are
        // exercised. They were not, and a language pack shipped that was
        // installed, enabled and correct on the main-process side while being
        // entirely absent from the screen.
        locales: [{ id: 'xx', name: 'Smokish', file: 'locales/xx.json' }],
      }),
    );
    writeFileSync(join(themeDir, 'themes', 'green.css'), ':root { --amber: #33ff33; }\n');
    mkdirSync(join(themeDir, 'locales'), { recursive: true });
    // Two entries, deliberately of different kinds: a text node and a `title`
    // attribute are captured separately, and one working while the other does
    // not is entirely possible.
    writeFileSync(
      join(themeDir, 'locales', 'xx.json'),
      JSON.stringify({ ACTIVITY: 'SMOKE-LOG', Send: 'SMOKE-SEND' }),
    );

    // A plugin that brings code, and therefore has to be allowed before it runs.
    // Installed but never approved is the state a real machine was found in:
    // enabled true, approved false, a ticked checkbox beside a plugin the host
    // had never imported, and no control left to correct it.
    const codeDir = join(pluginsDir(), 'smoke-code');
    mkdirSync(codeDir, { recursive: true });
    writeFileSync(
      join(codeDir, 'plugin.json'),
      JSON.stringify({
        id: 'smoke-code',
        name: 'Smoke code',
        version: '1.0.0',
        apiVersion: 4,
        description: 'Registers one action, for the smoke test.',
        main: 'main.mjs',
        actions: ['smoke_ping'],
        // Asked for, so the whole chain is exercised from a manifest: declared
        // here, handed over by name, and used to put something on screen.
        services: ['notify', 'mic'],
        settings: [
          { key: 'size', type: 'select', label: 'Size', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] },
        ],
      }),
    );
    writeFileSync(
      join(codeDir, 'main.mjs'),
      `export function activate(ctx) {
         const notify = ctx.service('notify');
         // Dictation, with no microphone anywhere near it: the app captures and
         // encodes, a plugin turns the bytes into words, and this one has the
         // words ready. It is the seam that is being checked, not whisper.
         ctx.service('mic').setTranscriber({
           pluginId: ctx.id,
           label: 'Smoke ears',
           ready: true,
           transcribe: async () => 'open the browser',
         });
         // A plugin's own document: undeclared, unread by the app, and the only
         // place a count like this can live across a restart. Touched during
         // activation so that a store which cannot be written fails the row
         // rather than waiting for somebody to run the action.
         ctx.state.set({ starts: (ctx.state.get().starts ?? 0) + 1 });
         ctx.prompt('PING — {"type":"smoke_ping","steps":""}');
         ctx.action({
           type: 'smoke_ping',
           run: async () => {
             notify.show({ title: 'Smoke ping', body: 'the plugin said so', desktop: false });
             return { ok: true, summary: 'pong' };
           },
           // Answers a click that arrives long after the turn has ended, and
           // refuses one from a list it no longer considers current.
           choose: async (id) => {
             if (id !== 'second') throw new Error('that list is no longer the current one');
             return { ok: true, summary: id };
           },
         });
       }\n`,
    );

    // One second of silence, so the media scheme has something real to serve.
    // A missing file would exercise the error path instead, which is not the
    // question — whether Range-capable delivery works at all is.
    const wavPath = join(mkdtempSync(join(tmpdir(), 'wl-smoke-audio-')), 'silence.wav');
    writeFileSync(wavPath, silentWav(8000));

    serveAssets();
    registerIpc(() => window);


    // A model registered from outside the vault. The native picker cannot be
    // clicked from here, but everything downstream of it can be checked.
    const config = await import('../src/main/config.mjs');
    // The registry is asked for at boot, which would make this run depend on
    // the network and on what is published there. Pointed at a closed port
    // instead: it fails immediately and deterministically, which is also the
    // case worth checking — a machine with no network must still boot quietly.
    config.update({ pluginRegistry: 'https://127.0.0.1:1/index.json' });

    const externalModel = join(mkdtempSync(join(tmpdir(), 'wl-smoke-away-')), 'elsewhere-Q4_K_M.gguf');
    const magic = Buffer.alloc(4096);
    magic.write('GGUF', 0, 'ascii');
    writeFileSync(externalModel, magic);
    config.update({ externalModels: [externalModel] });

    // Seeded before the window loads so the boot render already lists it.
    const chats = await import('../src/main/chats.mjs');
    const seeded = chats.create('Seeded conversation');
    chats.append(seeded.id, { role: 'user', content: 'what is on this page?' });
    chats.append(seeded.id, { role: 'assistant', content: 'A sign-in form.' });
    chats.append(seeded.id, { role: 'tool', content: '[BROWSER] All 2 step(s) succeeded.' });

    await window.loadFile(join(repoRoot, 'src', 'renderer', 'index.html'));

    // boot() is async — give its IPC round-trips a moment to land.
    await new Promise((r) => setTimeout(r, 2000));

    const probe = await window.webContents.executeJavaScript(`(() => ({
      bridge: typeof window.wasteland === 'object',
      results: document.querySelectorAll('#search-results .repo-item').length,
      vault: document.getElementById('vault-list').textContent.trim().length,
      sections: document.querySelectorAll('.section').length,
      status: document.getElementById('status-line').textContent,
      engine: document.getElementById('stat-engine').textContent,
      model: document.getElementById('stat-model').textContent,
      ctx: document.getElementById('ctx-label').textContent,
      composer: Boolean(document.getElementById('input')),
      search: Boolean(document.getElementById('model-search') && document.getElementById('btn-search')),
      openFile: Boolean(document.getElementById('btn-add-file')),
      clearSearch: Boolean(document.getElementById('btn-clear-search')),
      // The thinking toggle belongs beside the composer, not buried in a panel.
      thinkingByComposer: Boolean(document.querySelector('.ctx-row #set-thinking')),
      computeHidden: document.getElementById('stat-compute').hidden,
      externalRow: (() => {
        const row = [...document.querySelectorAll('#vault-list .vault-item')].find((r) =>
          r.querySelector('.name')?.textContent.includes('elsewhere-Q4_K_M.gguf'),
        );
        if (!row) return null;
        return {
          label: row.querySelector('.name').textContent,
          title: row.querySelector('.name').title,
          drop: row.querySelector('button.danger')?.textContent,
          dropTitle: row.querySelector('button.danger')?.title,
        };
      })(),
      leftWidth: document.getElementById('panel-left').getBoundingClientRect().width,
      chatWidth: document.querySelector('.panel-chat').getBoundingClientRect().width,
    }))()`);

    say('Renderer smoke test');
    check('preload bridge is exposed', probe.bridge);
    // Nothing has been searched for yet, so an empty result list is correct.
    check('search results start empty', probe.results === 0, `${probe.results} entries`);
    check('vault section rendered', probe.vault > 0);
    check('all left-panel sections present', probe.sections === 8, `${probe.sections} sections`);
    check('composer present', probe.composer);
    check('model search controls present', probe.search);
    check('the open-a-file control is present', probe.openFile);
    check('search results can be cleared', probe.clearSearch);
    check('the thinking toggle sits beside the composer', probe.thinkingByComposer);
    check('the run-location badge is hidden until a model loads', probe.computeHidden === true);
    check(
      `an external model is listed — ${probe.externalRow?.label ?? 'not listed'}`,
      Boolean(probe.externalRow) && probe.externalRow.label.includes('↗'),
    );
    check(
      'its remove button says the file will be left alone',
      probe.externalRow?.drop === '⊘' && /left alone/.test(probe.externalRow?.dropTitle ?? ''),
      JSON.stringify(probe.externalRow),
    );

    // The About box. Visibility through the computed style, never the `hidden`
    // attribute — see the note in the Testing section of the README.
    const about = await window.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('about-modal');
      const shut = getComputedStyle(box).display;
      document.getElementById('btn-about').click();
      return {
        shut,
        open: getComputedStyle(box).display,
        version: document.getElementById('about-version').textContent,
        links: [...box.querySelectorAll('a')].map((a) => ({ href: a.href, target: a.target })),
      };
    })()`);
    check('the About box starts closed', about.shut === 'none', JSON.stringify(about.shut));
    check('[ ABOUT ] opens it', about.open !== 'none', JSON.stringify(about.open));
    // Compared against the manifest, not merely against a version-shaped
    // string: the first version of this check passed while the box displayed
    // Electron's 34.5.8, because `app.getVersion()` falls back to it when it
    // cannot find the app manifest — which is exactly what this runner does.
    const expected = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).version;
    check(
      `it names this build — ${about.version}`,
      about.version.includes(expected),
      `expected ${expected} in "${about.version}"`,
    );
    // Every link must go out through the window-open handler. One without
    // `target` navigates this window to GitHub and there is no way back.
    check(
      `all ${about.links.length} links open externally`,
      about.links.length >= 4 && about.links.every((a) => a.target === '_blank' && /^https:/.test(a.href)),
      JSON.stringify(about.links.filter((a) => a.target !== '_blank')),
    );

    // Updates. This runner is not a packaged build, so the honest state is
    // "unsupported" — and the button must be gone rather than offering a check
    // whose only possible outcome is a failure.
    const dev = await window.webContents.executeJavaScript(`(() => ({
      text: document.getElementById('update-status').textContent,
      button: document.getElementById('btn-update').hidden,
    }))()`);
    check(`an unpackaged build says so — ${dev.text}`, /by hand/.test(dev.text), dev.text);
    check('and offers no update button', dev.button === true);

    // The status arrives on the app's single `event` channel like everything
    // else; a second channel for one feature is what that design avoids.
    window.webContents.send('event', { event: 'update:status', state: 'downloading', version: '9.9.9', percent: 42 });
    await new Promise((r) => setTimeout(r, 150));
    const busy = await window.webContents.executeJavaScript(`(() => ({
      text: document.getElementById('update-status').textContent,
      button: document.getElementById('btn-update').hidden,
    }))()`);
    check(`a download in flight is shown — ${busy.text}`, /9\.9\.9/.test(busy.text) && /42%/.test(busy.text), busy.text);
    check('with the button out of the way while it runs', busy.button === true);

    window.webContents.send('event', { event: 'update:status', state: 'ready', version: '9.9.9' });
    await new Promise((r) => setTimeout(r, 150));
    const ready = await window.webContents.executeJavaScript(`(() => ({
      text: document.getElementById('update-status').textContent,
      label: document.getElementById('btn-update').textContent,
      hidden: document.getElementById('btn-update').hidden,
    }))()`);
    check(`a downloaded build offers a restart — ${ready.label}`, ready.label.includes('RESTART') && !ready.hidden, JSON.stringify(ready));
    check('and says which version is waiting', /9\.9\.9/.test(ready.text), ready.text);

    const closed = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('btn-about-close').click();
      return getComputedStyle(document.getElementById('about-modal')).display;
    })()`);
    check('[ CLOSE ] shuts it again', closed === 'none', closed);

    // Download progress, driven by synthetic events rather than a real
    // transfer: the arithmetic is unit-tested, and what cannot be tested there
    // is that the renderer puts the numbers on screen at all.
    window.webContents.send('event', { event: 'download:start', filename: 'model.gguf' });
    window.webContents.send('event', {
      event: 'download:progress',
      filename: 'model.gguf',
      received: 1024 * 1024 * 1024,
      total: 4 * 1024 * 1024 * 1024,
      percent: 25,
      // Under 10, so `formatSize` keeps a decimal — the reading a slow link
      // needs. Above 10 it rounds, and "13 MB/s" is as much as anyone wants.
      bytesPerSecond: 5.5 * 1024 * 1024,
      etaSeconds: 240,
    });
    await new Promise((r) => setTimeout(r, 200));
    const progress = await window.webContents.executeJavaScript(
      `document.getElementById('download-status').textContent`,
    );
    check(`download progress shows the speed — ${progress}`, /5\.5 MB\/s/.test(progress));
    check('download progress shows the time left', /4m 0s left/.test(progress), progress);

    // A transfer that has not been measured yet must not claim 0 B/s or "0s
    // left": both read as a stall when the download is merely starting.
    window.webContents.send('event', {
      event: 'download:progress',
      filename: 'model.gguf',
      received: 1024,
      total: 4 * 1024 * 1024 * 1024,
      percent: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
    });
    await new Promise((r) => setTimeout(r, 200));
    const starting = await window.webContents.executeJavaScript(
      `document.getElementById('download-status').textContent`,
    );
    check('an unmeasured download claims no speed at all', !/\/s/.test(starting), starting);
    check('and no time left', !/left/.test(starting), starting);
    window.webContents.send('event', { event: 'download:done', name: 'model.gguf' });
    await new Promise((r) => setTimeout(r, 200));

    // Deliberately offline: an empty query must not reach the network, so this
    // exercises the wiring without making the smoke run need a connection.
    await window.webContents.executeJavaScript(`(() => {
      document.getElementById('model-search').value = '';
      document.getElementById('btn-search').click();
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const searched = await window.webContents.executeJavaScript(`(() => ({
      status: document.getElementById('search-status').textContent,
      results: document.getElementById('search-results').childElementCount,
      enabled: !document.getElementById('btn-search').disabled,
    }))()`);
    check('an empty search is a quiet no-op', searched.results === 0 && searched.enabled, JSON.stringify(searched));
    check('boot reached Ready', probe.status === 'Ready', probe.status);
    check('context meter initialised', /^CTX: \d+ \/ \d+/.test(probe.ctx), probe.ctx);
    // The status text is in the label, not just the detail: both values pass
    // the check, and which one appeared is the interesting part.
    check(`engine status resolved — ${probe.engine}`, /ENGINE: (MANUL-BROWSER|MISSING)$/.test(probe.engine));
    check(`model status resolved — ${probe.model}`, /MODEL:/.test(probe.model));
    check('both columns have width', probe.leftWidth > 100 && probe.chatWidth > 300, `${probe.leftWidth}/${probe.chatWidth}`);
    check('no renderer errors', errors.length === 0, errors.join(' | '));

    await checkMarkdown(window);
    await checkPlugins(window);
    await checkThemes(window);
    await checkLanguages(window);
    await checkPlayer(window, wavPath);
    await checkChatControls(window);
    await checkAttachments(window);
    await checkNotices(window);
    await checkDictation(window);
    await checkContextControls(window);
    await checkLayouts(window);
  } catch (err) {
    check('smoke run completed', false, err.message);
  } finally {
    clearTimeout(watchdog);
    finish();
  }
});
