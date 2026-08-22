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
import { scene } from '../src/main/scene.mjs';
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

/**
 * A check this screen cannot answer, said out loud rather than passed.
 *
 * A hosted runner's display is 1024×768, which several of these need more room
 * than — and a check quietly relaxed until it fits is worse than one that
 * plainly did not run, because the relaxed one goes on reporting ok while the
 * thing it was written for is unproven.
 */
function skip(label, reason) {
  say(`  skip ${label} — ${reason}`);
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

/**
 * A hung renderer must fail the run, not hang the caller forever.
 *
 * Generous on purpose. This is a deadline for a renderer that has stopped
 * answering, not a performance budget for the suite: the run takes about
 * three-quarters of a minute on the machine it was written on, and a hosted
 * runner is slower. Set close to the real duration it stops being a watchdog
 * and becomes a coin flip — which is what 45s had quietly become, failing on
 * the 312th check of 312 while nothing was wrong.
 *
 * If this ever needs raising again, look first at what is sleeping. A check
 * that waits a fixed interval for something it could poll for is where the time
 * goes; `waitFor` is the way to stop paying it.
 */
const watchdog = setTimeout(() => {
  check('completed within 90s', false, 'timed out');
  finish();
}, 90_000);

/**
 * Wait until an expression in the renderer is true, instead of sleeping.
 *
 * The same reasoning as the layout checks polling `window.innerWidth` rather
 * than sleeping after a resize: a fixed interval is either longer than it needs
 * to be on every run, or too short on the one run that mattered. Returns
 * whether the condition arrived, so a caller can assert on it rather than
 * discover it three checks later.
 */
async function waitFor(window, expression, { timeoutMs = 4000, every = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = Boolean(await window.webContents.executeJavaScript(`Boolean(${expression})`));
    } catch {
      /* mid-navigation or mid-repaint; try again */
    }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

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
      skip(shape.name, `taller than this display's work area (${workArea.height}px)`);
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
 * The prompt box, measured rather than read.
 *
 * Both halves of this were on screen while the source read perfectly. A column
 * of buttons beside a two-line field hangs below it, which is geometry and not
 * anything the DOM can be asked about; and a status line resting on a word is a
 * row of the transcript's height spent saying nothing, which is a computed
 * `display`. Neither is visible to a check that reads text content.
 */
async function checkComposer(window) {
  say('');
  say('Composer');

  const shape = await window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const field = document.querySelector('.composer-field').getBoundingClientRect();
    const buttons = document.querySelector('.composer-buttons').getBoundingClientRect();
    return {
      resting: input.getBoundingClientRect().height,
      gap: Math.abs(field.bottom - buttons.bottom),
      overhang: buttons.height - field.height,
      grip: getComputedStyle(input).resize,
    };
  })()`);
  check(
    `the buttons sit on the bottom edge of the field — ${shape.gap.toFixed(1)}px apart`,
    shape.gap <= 1.5,
    JSON.stringify(shape),
  );
  // The other half of straight: a stack tall enough to outgrow the box it sits
  // beside pushes the whole row open around it, which is what the column of
  // three did to a two-line field.
  check(
    'and do not make the row taller than it — ' + shape.overhang.toFixed(1) + 'px',
    shape.overhang <= 0,
    JSON.stringify(shape),
  );

  // A dragged height and a computed one are two owners for one number, and the
  // dragged one loses on the next keystroke.
  check('and the box carries no resize grip to fight the computed height', shape.grip === 'none', shape.grip);

  // The eight lines are built here and interpolated as JSON. A newline written
  // as an escape inside a string that is itself inside a template literal is one
  // backslash away from a SyntaxError thrown in the renderer instead.
  const eight = JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => 'line ' + n).join('\n'));
  const grown = await window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('input');
    input.value = ${eight};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const field = document.querySelector('.composer-field').getBoundingClientRect();
    const buttons = document.querySelector('.composer-buttons').getBoundingClientRect();
    const height = input.getBoundingClientRect().height;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { height, gap: Math.abs(field.bottom - buttons.bottom), shrunk: input.getBoundingClientRect().height };
  })()`);
  check(
    `eight lines make the box taller — ${shape.resting.toFixed(0)} → ${grown.height.toFixed(0)}px`,
    grown.height > shape.resting + 20,
    JSON.stringify(grown),
  );
  check('the buttons stay on its edge as it grows', grown.gap <= 1.5, JSON.stringify(grown));
  // The other half of the same rule: a cleared box still five lines tall is the
  // same bug from the other side.
  check(
    `emptying it puts the box back — ${grown.shrunk.toFixed(0)}px`,
    Math.abs(grown.shrunk - shape.resting) <= 1,
    JSON.stringify(grown),
  );

  // The status line, driven the way the agent drives it.
  const read = `(() => {
    const node = document.getElementById('status-line');
    return {
      text: node.textContent,
      display: getComputedStyle(node).display,
      composerTop: document.getElementById('composer').getBoundingClientRect().top,
    };
  })()`;

  window.webContents.send('event', { event: 'status', text: 'Thinking…' });
  await new Promise((r) => setTimeout(r, 200));
  const shown = await window.webContents.executeJavaScript(read);
  check(
    `something to say puts the line on screen — "${shown.text}"`,
    shown.text === 'Thinking…' && shown.display !== 'none',
    JSON.stringify(shown),
  );

  // Exactly what the agent emits in its `finally`. Idle is drawn as nothing.
  window.webContents.send('event', { event: 'status', text: '' });
  await new Promise((r) => setTimeout(r, 200));
  const idle = await window.webContents.executeJavaScript(read);
  check('and a finished turn takes it away again', idle.text === '' && idle.display === 'none', JSON.stringify(idle));
  // Why it sits above the composer rather than below: the height comes out of
  // the transcript, which can spare it, and never out from under the box the
  // user is typing in.
  check(
    `the composer does not move when it comes and goes — ${idle.composerTop.toFixed(0)}px`,
    Math.abs(shown.composerTop - idle.composerTop) <= 1,
    JSON.stringify({ shown: shown.composerTop, idle: idle.composerTop }),
  );
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
      // The headings, and what sits under each. Read as the DOM order the user
      // actually sees rather than from the grouping function — the question is
      // whether the list is drawn in sections, not whether an array can be
      // split into some.
      sections: [...document.querySelectorAll('#plugin-list > *')].reduce((acc, node) => {
        if (node.classList.contains('plugin-section')) {
          acc.push({ label: node.querySelector('.plugin-section-label').textContent, count: 0 });
        } else if (acc.length) {
          acc[acc.length - 1].count += 1;
        }
        return acc;
      }, []),
      status: document.getElementById('plugin-status').textContent,
    }))()`);

  const start = await read();

  /**
   * Grouped, and every heading has something under it.
   *
   * The list outgrew one column: four capabilities, a theme pack and whatever
   * else is installed read as five lists printed on top of each other. An empty
   * heading is the failure worth checking for — it is a promise of plugins that
   * are not there, and on the narrow layout it costs a line to say nothing.
   */
  check(
    `the list is drawn in sections — ${start.sections.map((s) => `${s.label} ${s.count}`).join(', ')}`,
    start.sections.length >= 2,
    JSON.stringify(start.sections),
  );
  check(
    'no heading is drawn over an empty section',
    start.sections.every((section) => section.count > 0),
    JSON.stringify(start.sections),
  );
  check(
    'every row sits under a heading',
    start.sections.reduce((sum, section) => sum + section.count, 0) === start.rows.length,
    JSON.stringify({ sections: start.sections, rows: start.rows.length }),
  );
  // Capabilities are what the section is mostly for, so they come first.
  check(
    `capabilities come first — ${start.sections[0]?.label}`,
    start.sections[0]?.label === 'CAPABILITIES',
    JSON.stringify(start.sections[0]),
  );
  // Two built-ins, the theme pack, and the code plugin awaiting approval.
  check(`every plugin is listed — ${start.rows.length}`, start.rows.length === 4, JSON.stringify(start.rows.map((r) => r.name)));
  check(`the section says how many are running — ${start.status}`, /^2 of 4 active$/.test(start.status), start.status);

  const reader = start.rows.find((row) => row.name === 'File reading');
  const shell = start.rows.find((row) => row.name === 'Shell commands');
  check('file reading is on by default', reader?.checked === true && reader?.off === false, JSON.stringify(reader));
  // The one capability that has always been off until asked for.
  check('shell is off by default, and looks it', shell?.checked === false && shell?.off === true, JSON.stringify(shell));
  check(`a row names the actions it adds — ${reader?.adds}`, /read_file/.test(reader?.adds ?? ''), reader?.adds);
  check('a working plugin has nothing to explain', reader?.note === '', reader?.note);

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
  check(`and in the count — ${off.status}`, /^1 of 4 active$/.test(off.status), `${start.status} → ${off.status}`);

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

  await checkAutoUpdate(window);
  await checkRestart(window);
  await checkUpdateBadge(window);

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
 * Keeping a plugin current, without being asked each time.
 *
 * The box is drawn from the list the main process answers with, so the two
 * halves that can drift are whether it is offered at all — a built-in has no
 * registry entry that could replace it, and a box promising updates that can
 * never arrive is worse than none — and whether ticking it actually reaches
 * config. The second is read back through the API rather than off the DOM: a
 * row that painted itself optimistically would pass everything else here.
 */
async function checkAutoUpdate(window) {
  say('');
  say('Plugin auto-update');

  const read = () =>
    window.webContents.executeJavaScript(`(() => {
      const box = (id) => {
        const row = document.querySelector('#plugin-list .plugin-item[data-plugin="' + id + '"]');
        const control = row?.querySelector('.plugin-auto input[type=checkbox]');
        return control
          ? { there: true, checked: control.checked, shown: getComputedStyle(control).display !== 'none' }
          : { there: false, checked: false, shown: false };
      };
      const builtin = [...document.querySelectorAll('#plugin-list .plugin-item')]
        .find((row) => (row.querySelector('.plugin-meta')?.textContent ?? '').includes('BUILT-IN'));
      return {
        installed: box('smoke-code'),
        theme: box('smoke-theme'),
        builtin: Boolean(builtin?.querySelector('.plugin-auto')),
      };
    })()`);

  const start = await read();
  check('an installed plugin is offered auto-update', start.installed.there && start.installed.shown, JSON.stringify(start.installed));
  check('so is a theme pack, which updates the same way', start.theme.there, JSON.stringify(start.theme));
  // Off unless somebody ticks it: an update is code arriving from outside the
  // app, and the approval on the row was given for the version that was there.
  check('and it is off until it is asked for', start.installed.checked === false, JSON.stringify(start.installed));
  check('a built-in is not offered a box that cannot work', start.builtin === false, String(start.builtin));

  await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('#plugin-list .plugin-item[data-plugin="smoke-code"]');
    const box = row.querySelector('.plugin-auto input[type=checkbox]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('#plugin-list .plugin-item[data-plugin="smoke-code"] .plugin-auto input').checked`);

  // From the main process, not from the box that was just clicked.
  const stored = await window.webContents.executeJavaScript(
    `window.wasteland.plugins.list().then((list) => list.find((p) => p.id === 'smoke-code'))`,
  );
  check('ticking it is recorded where the decision lives', stored.autoUpdate === true, JSON.stringify(stored.autoUpdate));
  // And it changed nothing else: this is a separate decision from approval and
  // from the switch, and a control that quietly moves either is the bug.
  check('and it approves nothing and switches nothing on', stored.approved === true && stored.enabled === true, JSON.stringify(stored));

  const repainted = await read();
  check('the row comes back showing it', repainted.installed.checked === true, JSON.stringify(repainted.installed));

  await window.webContents.executeJavaScript(`window.wasteland.plugins.setAutoUpdate('smoke-code', false)`);
  await waitFor(window, `!document.querySelector('#plugin-list .plugin-item[data-plugin="smoke-code"] .plugin-auto input').checked`);
}

/**
 * The count of updates waiting, on the GET PLUGINS heading.
 *
 * The UPDATE buttons have been on the rows all along; what was missing was any
 * reason to go and look, because the section is closed and the boot fetch is
 * silent. So the number is asserted while the section is *shut* — a badge only
 * visible once the list is open answers a question nobody had by then.
 *
 * The other half is that it goes down again. A plugin set to AUTO-UPDATE needs
 * no attention, so it must not be counted, or the badge becomes a number that
 * cannot be cleared by doing everything it is asking for.
 */
async function checkUpdateBadge(window) {
  say('');
  say('Updates waiting');

  const { server, port } = await startRegistry([
    {
      id: 'smoke-code',
      name: 'Smoke code',
      version: '2.0.0',
      description: 'A newer build than the one installed.',
      apiVersion: 4,
      kind: 'code',
      url: 'https://example.test/smoke-code-2.0.0.zip',
      sha256: 'b'.repeat(64),
      size: 1024,
    },
  ]);

  const read = () =>
    window.webContents.executeJavaScript(`(() => {
      const badge = document.getElementById('store-badge');
      return {
        there: Boolean(badge),
        text: badge ? badge.textContent : '',
        display: badge ? getComputedStyle(badge).display : 'missing',
        title: badge ? badge.title : '',
        sectionOpen: document.getElementById('section-store').open,
      };
    })()`);

  try {
    const quiet = await read();
    check('the badge exists', quiet.there, 'no #store-badge');
    // Nothing published is newer than what is installed, so there is nothing to
    // say. A badge that is always there is a number nobody reads.
    check(`nothing waiting means no number — ${quiet.display}`, quiet.display === 'none', JSON.stringify(quiet));

    await window.webContents.executeJavaScript(
      `window.wasteland.plugins.addRegistry('http://127.0.0.1:${port}/index.json')`,
    );
    await window.webContents.executeJavaScript(`document.getElementById('btn-store-refresh').click()`);
    await waitFor(window, `document.getElementById('store-badge').textContent === '1'`);

    const waiting = await read();
    check(`one update published shows a 1 — "${waiting.text}"`, waiting.text === '1', JSON.stringify(waiting));
    // The point of putting it on the heading: it has to be readable without
    // opening the section, because the section being shut is the problem.
    check('and it is readable with the section shut', waiting.display !== 'none' && waiting.sectionOpen === false, JSON.stringify(waiting));
    check(`a bare number says what of — "${waiting.title}"`, /Smoke code/.test(waiting.title), waiting.title);

    // Set to look after itself, so it is no longer asking for anything.
    await window.webContents.executeJavaScript(`window.wasteland.plugins.setAutoUpdate('smoke-code', true)`);
    await waitFor(window, `document.getElementById('store-badge').hidden`);
    const handled = await read();
    check(`a plugin that updates itself is not counted — ${handled.display}`, handled.display === 'none', JSON.stringify(handled));

    await window.webContents.executeJavaScript(`window.wasteland.plugins.setAutoUpdate('smoke-code', false)`);
    await waitFor(window, `!document.getElementById('store-badge').hidden`);
    const back = await read();
    check(`unticking it puts the number back — "${back.text}"`, back.text === '1', JSON.stringify(back));

    await window.webContents.executeJavaScript(
      `window.wasteland.plugins.removeRegistry('http://127.0.0.1:${port}/index.json')`,
    );
    await window.webContents.executeJavaScript(`document.getElementById('btn-store-refresh').click()`);
    await waitFor(window, `document.getElementById('store-badge').hidden`);
    const gone = await read();
    check(`and it clears when nothing publishes one — ${gone.display}`, gone.display === 'none', JSON.stringify(gone));
  } finally {
    server.close();
  }
}

/**
 * The one control that finishes a plugin update.
 *
 * Node caches modules by URL for the life of the process, so an updated plugin
 * goes on running the code it was first imported with — and the row saying so
 * was not enough, because the row lives in a collapsed section inside a panel a
 * narrow window closes entirely. The button is asserted on its *computed*
 * display rather than on `hidden`: `.topbar .restart` gives it a `display`, and
 * any author-level `display` outranks the UA rule behind the attribute, which
 * is exactly how the drop veil shipped visible.
 *
 * Driven over the real event channel, because `stale` is a fact only a process
 * that has imported a plugin twice can produce.
 */
async function checkRestart(window) {
  say('');
  say('Restart');

  const read = () =>
    window.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('btn-restart');
      const rowButtons = [...document.querySelectorAll('#plugin-list .plugin-item[data-plugin="smoke-code"] .plugin-buttons button')];
      return {
        there: Boolean(button),
        display: button ? getComputedStyle(button).display : 'missing',
        title: button ? button.title : '',
        onRow: rowButtons.some((node) => node.textContent.includes('RESTART')),
      };
    })()`);

  const quiet = await read();
  check('the restart button exists', quiet.there, 'no #btn-restart');
  // Nothing is stale, so nothing is offered. A permanently visible RESTART is a
  // control that means nothing by the second time it is read.
  check(`nothing to finish means nothing on screen — ${quiet.display}`, quiet.display === 'none', quiet.display);
  check('and no restart button on the row either', quiet.onRow === false, String(quiet.onRow));

  const list = await window.webContents.executeJavaScript(`window.wasteland.plugins.list()`);
  const stale = list.map((plugin) => (plugin.id === 'smoke-code' ? { ...plugin, stale: true } : plugin));
  window.webContents.send('event', { event: 'plugins:changed', plugins: stale, themes: [], locales: [] });
  await waitFor(window, `getComputedStyle(document.getElementById('btn-restart')).display !== 'none'`);

  const showing = await read();
  check(`a plugin newer on disk puts RESTART in the topbar — ${showing.display}`, showing.display !== 'none', showing.display);
  // Named, or "restart to finish an update" is a request the user cannot check.
  check(`and the button says what it is for — "${showing.title}"`, /Smoke code/.test(showing.title), showing.title);
  check('the row that explains it carries one too', showing.onRow === true, String(showing.onRow));

  // Put the real list back: a synthetic one left in place would make every
  // later check read a plugin state the main process does not have. Done
  // through a real call, because what repaints from the truth is the `changed`
  // event the host emits on its way out of one.
  await window.webContents.executeJavaScript(`window.wasteland.plugins.setAutoUpdate('smoke-code', false)`);
  await waitFor(window, `getComputedStyle(document.getElementById('btn-restart')).display === 'none'`);
  const restored = await read();
  check(`and it goes away again — ${restored.display}`, restored.display === 'none', restored.display);
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

  /**
   * Folded away until it is asked for.
   *
   * Nine times out of ten this is a list of the app's own indexes, and it grows
   * a row with every plugin that ships — left open it pushed the thing the
   * section is actually for, the plugins, off the bottom of the panel. Asserted
   * on whether the rows have a box rather than on the attribute: a `<details>`
   * marked closed whose contents are still drawn is the same class of failure
   * as `hidden` losing to an author `display`.
   */
  const folded = await window.webContents.executeJavaScript(`(() => {
    const section = document.getElementById('section-registries');
    return {
      there: Boolean(section),
      tag: section ? section.tagName : '',
      open: section ? section.open : true,
      summary: section?.querySelector('summary')?.textContent?.trim() ?? '',
      // Measured, not read off the attribute. A details element marked closed
      // whose contents are still laid out is the same class of failure as the
      // hidden attribute losing to an author-level display, and only the height
      // can tell them apart: a closed one is its summary and nothing else.
      // (No backticks in here — this whole string is a template literal, and a
      // backtick inside one ends it. That has taken the entire run down before.)
      height: section ? section.getBoundingClientRect().height : 0,
      summaryHeight: section?.querySelector('summary')?.getBoundingClientRect().height ?? 0,
    };
  })()`);
  check('the registries fold away into a section of their own', folded.there && folded.tag === 'DETAILS', JSON.stringify(folded));
  check(`and it says what is inside it — "${folded.summary}"`, /REGISTRIES/i.test(folded.summary), folded.summary);
  check('closed to begin with, so the plugins are what the section shows', folded.open === false, String(folded.open));
  check(
    `and closed means it takes only its heading — ${Math.round(folded.height)}px`,
    folded.summaryHeight > 0 && folded.height <= folded.summaryHeight + 2,
    JSON.stringify({ height: folded.height, summary: folded.summaryHeight }),
  );

  const opened = await window.webContents.executeJavaScript(`(() => {
    document.getElementById('section-registries').open = true;
    const section = document.getElementById('section-registries');
    const row = document.querySelector('#registry-list .registry-item');
    return { height: section.getBoundingClientRect().height, row: row ? row.getBoundingClientRect().height : 0 };
  })()`);
  check(
    `opening it brings the rows back — ${Math.round(opened.height)}px`,
    opened.height > folded.height + 10 && opened.row > 0,
    JSON.stringify(opened),
  );

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

/**
 * The options a reply offers, as buttons.
 *
 * None of this is visible to the unit tests, which can only say that the fence
 * parses. What is checked here is what was actually reported: a model found the
 * video, wrote a numbered list of what to do next, and left the user with
 * nothing to press. So: that buttons appear, that they are *enabled* — an offer
 * is drawn on `reply:end`, while the turn is still running, so every one of
 * them is born disabled and something has to hand them back — that the JSON
 * never reaches the screen, and that a superseded offer stops being pressable.
 */
async function checkReplyChoices(window) {
  say('');
  say('Choices offered by a reply');

  const reply = [
    'Found **Pearl Jam — Black (Official Audio)**, 5:46. What next?',
    '',
    '```choices',
    '{"options":[{"label":"Open and play it","send":"open the video and play it","note":"5:46"},"Show other versions"]}',
    '```',
  ].join('\n');

  window.webContents.send('event', { event: 'reply:end', text: reply, rendered: reply, aborted: false });
  await new Promise((r) => setTimeout(r, 400));

  const drawn = await window.webContents.executeJavaScript(`(() => {
    const box = [...document.querySelectorAll('#chat-log .choices.offer')].pop();
    const turn = [...document.querySelectorAll('#chat-log .turn.assistant.md')].pop();
    if (!box) return null;
    const buttons = [...box.querySelectorAll('button.choice')];
    return {
      count: buttons.length,
      labels: buttons.map((b) => b.querySelector('.choice-label').textContent),
      notes: [...box.querySelectorAll('.choice-note')].map((n) => n.textContent),
      titles: buttons.map((b) => b.title),
      enabled: buttons.every((b) => !b.disabled),
      spent: box.classList.contains('spent'),
      display: getComputedStyle(box).display,
      prose: turn ? turn.textContent : '',
    };
  })()`);

  check('a reply that offers options draws buttons', drawn?.count === 2, JSON.stringify(drawn));
  if (!drawn) return;

  check(
    `labelled as the model wrote them — ${drawn.labels.join(' | ')}`,
    drawn.labels[0] === 'Open and play it' && drawn.labels[1] === 'Show other versions',
  );
  check(`a second line survives — ${drawn.notes.join(' | ')}`, drawn.notes.length === 1 && drawn.notes[0] === '5:46');
  // A hint that repeats the button is noise; one hiding different words is a trap.
  check(
    'the tooltip appears only where the words sent differ',
    drawn.titles[0] === 'open the video and play it' && drawn.titles[1] === '',
  );
  // The bug this check exists for: the offer lands while the turn is still
  // running, so every button is created disabled and stays that way unless
  // `setStreaming` hands them back afterwards.
  check('and they are pressable once the turn has finished', drawn.enabled === true);
  check('the row is not born spent', drawn.spent === false);
  check(`the row is actually on screen — display: ${drawn.display}`, drawn.display !== 'none');
  // The fence is wiring. Left in, it renders as a code block full of JSON.
  check('the block itself is not shown to the user', !drawn.prose.includes('"options"'), drawn.prose.slice(0, 80));
  check('but the prose around it is', drawn.prose.includes('Pearl Jam'), drawn.prose.slice(0, 80));

  /**
   * Pressing one, with no model loaded.
   *
   * The failure is the point, exactly as it is for a game move: it proves the
   * words went out by the path a typed message takes. What is specific here is
   * the way back — a turn that never started did not answer the offer, so the
   * buttons have to come back rather than sitting dead for a message that does
   * not exist.
   */
  const before = await window.webContents.executeJavaScript(
    `document.querySelectorAll('#chat-log .turn.user').length`,
  );
  const pressed = await window.webContents.executeJavaScript(`(async () => {
    const box = [...document.querySelectorAll('#chat-log .choices.offer')].pop();
    box.querySelectorAll('button.choice')[0].click();
    await new Promise((r) => setTimeout(r, 600));
    return {
      status: document.getElementById('status-line').textContent,
      turns: document.querySelectorAll('#chat-log .turn.user').length,
      composer: document.getElementById('input').value,
      spent: box.classList.contains('spent'),
      enabled: [...box.querySelectorAll('button.choice')].every((b) => !b.disabled),
    };
  })()`);
  check(
    `a pressed option goes out as an ordinary message — "${pressed.status}"`,
    /model/i.test(pressed.status),
    pressed.status,
  );
  check('a turn that never started leaves nothing in the transcript', pressed.turns === before, `${before} → ${pressed.turns}`);
  // The words came from a button, so there is nowhere to hand them back to.
  check("and does not put the model's words in the composer", pressed.composer === '', pressed.composer);
  check('an offer nothing answered is handed back', pressed.spent === false && pressed.enabled === true, JSON.stringify(pressed));

  /**
   * A superseded offer stops being pressable.
   *
   * A turn with follow-ups emits a reply — and so an offer — per model call.
   * Two live rows of buttons are two answers to a question that has one, and
   * the older row is asking about a world several steps back.
   */
  const second = ['Opened it. Anything else?', '', '```choices', '{"options":["Play the next one"]}', '```'].join('\n');
  window.webContents.send('event', { event: 'reply:end', text: second, rendered: second, aborted: false });
  await new Promise((r) => setTimeout(r, 400));

  const rows = await window.webContents.executeJavaScript(`(() => {
    return [...document.querySelectorAll('#chat-log .choices.offer')].map((box) => ({
      spent: box.classList.contains('spent'),
      enabled: [...box.querySelectorAll('button.choice')].every((b) => !b.disabled),
      labels: [...box.querySelectorAll('.choice-label')].map((n) => n.textContent),
    }));
  })()`);
  const stale = rows.at(-2);
  const fresh = rows.at(-1);
  check('a newer offer takes over', fresh?.labels.join() === 'Play the next one', JSON.stringify(fresh));
  check('and the one it replaced is spent', stale?.spent === true && stale?.enabled === false, JSON.stringify(stale));
  // Kept, not removed: the fence is stripped out of the prose, so this row is
  // the only remaining record of what was on offer.
  check(`the spent offer is still readable — ${stale?.labels.join(' | ')}`, stale?.labels.length === 2);
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

  await checkPluginPanel(window);
}

/**
 * A plugin's own section in the left panel.
 *
 * Reported: a music folder and a browser choice were reachable only by opening
 * PLUGINS and reading a dozen rows to find which control was which — for
 * settings that get touched daily. A plugin can now ask for a section of its
 * own, and the app draws its declared settings there as well as on its row.
 *
 * Checked on screen rather than through the list, because everything
 * interesting about it is in the drawing: the section exists, it is a real
 * section rather than a hidden one, the control inside it works the same as
 * the one on the row, and switching the plugin off takes it away.
 */
async function checkPluginPanel(window) {
  say('A plugin section in the panel');

  const read = async () =>
    window.webContents.executeJavaScript(`(() => {
      const section = document.querySelector('#plugin-panels details[data-plugin-panel="smoke-code"]');
      const select = section?.querySelector('.plugin-setting select');
      return {
        there: Boolean(section),
        heading: section?.querySelector('summary')?.textContent ?? '',
        // The attribute and the pixels are different questions, and only the
        // second one is worth a check: an author-level display outranks the UA
        // rule behind [hidden], which is how the drop veil once shipped visible
        // with its attribute faithfully set the whole time.
        display: section ? getComputedStyle(section).display : 'none',
        control: Boolean(select),
        value: select?.value ?? '',
        // Where it sits. Above PLUGINS, because this is the daily control and
        // that is the occasional one.
        beforePlugins: section
          ? Boolean(
              section.compareDocumentPosition(document.getElementById('plugin-list')) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            )
          : false,
      };
    })()`);

  const shown = await read();
  check('the plugin has a section of its own', shown.there === true, JSON.stringify(shown));
  check(`and it is headed the way the manifest asked — ${shown.heading}`, shown.heading === 'SMOKE', shown.heading);
  check('and it is actually drawn', shown.display !== 'none', shown.display);
  check('its settings are in it', shown.control === true && shown.value === 'large', JSON.stringify(shown));
  check('and it sits above the plugin list', shown.beforePlugins === true, JSON.stringify(shown));

  // The same rule the audio transport and the game panel follow: a driver that
  // went away takes its controls with it. A section left behind would offer
  // settings for something that is not running.
  await window.webContents.executeJavaScript(`window.wasteland.plugins.setEnabled('smoke-code', false)`);
  await new Promise((r) => setTimeout(r, 400));
  const gone = await read();
  check('switching the plugin off takes its section away', gone.there === false, JSON.stringify(gone));

  await window.webContents.executeJavaScript(`window.wasteland.plugins.setEnabled('smoke-code', true)`);
  await new Promise((r) => setTimeout(r, 400));
  const back = await read();
  check('switching it back on brings it back', back.there === true, JSON.stringify(back));
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
 * A game on screen, driven through the real service.
 *
 * Not a synthetic event: `scene` here is the same singleton `ipc.mjs` handed to
 * the plugin host, so this exercises the whole chain a plugin would — show,
 * the `state` event, the IPC relay, the paint, the click, and the answer coming
 * back. What only this can catch is a panel that draws and does nothing, which
 * looks exactly like one that works.
 *
 * The keyboard half matters more than it looks. The composer is where this game
 * is played from, so a digit typed into a sentence must not make a move — and
 * that failure is invisible in the source, where the handler reads perfectly
 * well either way.
 */
async function checkScene(window) {
  say('');
  say('The game panel');

  /**
   * A game is played in a conversation, so one has to be open.
   *
   * The panel is drawn only in the chat the scene was painted in, and a scene
   * painted outside a turn belongs to nobody — so the seeded conversation is
   * opened first and the service is told a turn is running in it, which is what
   * `ipc.mjs` does off `turn:start` when there is a real one.
   */
  const chatId = await window.webContents.executeJavaScript(`(async () => {
    const list = await window.wasteland.chats.list();
    const pick = document.querySelector('#chat-menu .chat-row .chat-pick');
    if (!pick || !list.length) return '';
    pick.click();
    await new Promise((r) => setTimeout(r, 400));
    return list[0].id;
  })()`);
  check('a conversation to play in', Boolean(chatId), 'no seeded chat to open');
  scene.setTurn(chatId);

  const pressed = [];
  scene.present({
    pluginId: 'smoke-game',
    pluginName: 'Smoke game',
    act: (id) => {
      pressed.push(id);
      // One move that costs a turn and one that only redraws — the two kinds a
      // game has, and the whole reason `submit` is optional.
      if (id === 'look') return { submit: 'I look around' };
      if (id === 'item-sword') return { status: 'The sword is in your hand.' };
      // The only way a plugin can open the sheet: the dialog is the app's.
      if (id === 'peek') return { sheet: true };
      if (id === 'map') return { board: true };
      if (id === 'who') return { cards: true };
      if (id === 'go-forest') return { status: 'Walking to the forest.' };
      return { status: 'The bag is open.' };
    },
  });
  const SCENE = {
    title: 'Village of Mara — day 4',
    subtitle: 'the common room',
    meters: [
      { label: 'HP', value: 12, max: 20, tone: 'bad' },
      { label: 'MANA', value: 4, max: 4 },
      { label: 'GOLD', value: 14 },
    ],
    fields: [{ label: 'QUEST', value: 'find the hunters' }],
    tags: [{ label: 'BLEEDING', tone: 'bad' }],
    groups: [
      // One row the game gave something to do, one it did not. A journal entry
      // that could be clicked and did nothing would be worse than one that
      // plainly cannot be.
      { label: 'ITEMS', items: [{ label: 'Notched sword', note: 'a weapon', action: 'item-sword' }, { label: 'Herb' }] },
      { label: 'JOURNAL', items: [], empty: 'nothing written down yet' },
    ],
    actions: [
      { id: 'look', label: 'Look around', hint: 'costs a turn' },
      { id: 'bag', label: 'Inventory' },
      { id: 'peek', label: 'Open sheet' },
      { id: 'map', label: 'Map' },
      { id: 'who', label: 'Who' },
    ],
    cards: {
      label: 'Who are you',
      items: [
        { label: 'Ranger', note: 'a bow and a long memory for tracks', image: 'class-ranger.jpg', action: 'class-ranger' },
        { label: 'Warrior', note: 'heavy, and hard to put down', image: 'class-warrior.jpg', action: 'class-warrior' },
        { label: 'Nobody', note: 'no picture, and nothing to press' },
      ],
    },
    board: {
      points: [
        { id: 'village', label: 'Village', x: 50, y: 80, here: true },
        { id: 'forest', label: 'Forest', x: 60, y: 45, tone: 'good', action: 'go-forest' },
        { id: 'tower', label: 'Tower', x: 25, y: 15 },
      ],
      links: [{ from: 'village', to: 'forest', tone: 'good' }, { from: 'forest', to: 'tower' }],
    },
  };
  scene.show(SCENE);
  await new Promise((r) => setTimeout(r, 300));

  const drawn = await window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('scene');
    const row = document.getElementById('scene-actions');
    const hp = document.querySelector('#scene-meters .scene-meter .meter > i');
    return {
      // Asserted on the computed style, never on the attribute: what \`hidden\`
      // says and what the user sees are different questions, and only the
      // second one is worth a check.
      panel: getComputedStyle(panel).display,
      row: getComputedStyle(row).display,
      title: document.getElementById('scene-title').textContent,
      meters: [...document.querySelectorAll('#scene-meters .scene-meter-value')].map((n) => n.textContent),
      plain: document.querySelectorAll('#scene-meters .scene-meter.plain').length,
      hpWidth: hp ? hp.style.width : '',
      tags: [...document.querySelectorAll('#scene-facts .scene-tag')].map((n) => n.className),
      buttons: [...row.querySelectorAll('.scene-action')].map((b) => ({
        key: b.querySelector('.scene-key')?.textContent ?? '',
        label: b.querySelector('.scene-action-label').textContent,
      })),
      sheetButton: getComputedStyle(document.getElementById('btn-scene-sheet')).display,
      sheet: getComputedStyle(document.getElementById('sheet-modal')).display,
    };
  })()`);

  check(`the panel is on screen — "${drawn.title}"`, drawn.panel !== 'none', JSON.stringify(drawn.panel));
  check('and so is the row of moves', drawn.row !== 'none', drawn.row);
  check(`meters read as values — ${drawn.meters.join(' ')}`, JSON.stringify(drawn.meters) === '["12/20","4/4","14"]');
  check('a meter with no maximum is a number, not a bar', drawn.plain === 1, `${drawn.plain} plain`);
  check(`the bar is filled to the value — ${drawn.hpWidth}`, drawn.hpWidth === '60%');
  check('a tone reaches the class list', drawn.tags.join() === 'scene-tag bad', drawn.tags.join());
  check(
    `the app put digits on the moves — ${drawn.buttons.map((b) => `${b.key}:${b.label}`).join(' ')}`,
    JSON.stringify(drawn.buttons.map((b) => b.key)) === '["1","2","3","4","5"]',
    JSON.stringify(drawn.buttons),
  );
  check('the sheet is offered', drawn.sheetButton !== 'none', drawn.sheetButton);
  check('and is shut until it is asked for', drawn.sheet === 'none', drawn.sheet);

  // A move that only redraws the panel. No model is loaded in a smoke run, so
  // this is also the proof that such a move needs none.
  const local = await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#scene-actions .scene-action')][1].click();
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('status-line').textContent;
  })()`);
  check(`a move that needs no model runs without one — "${local}"`, /bag is open/i.test(local), local);
  check('and reached the plugin', pressed.at(-1) === 'bag', JSON.stringify(pressed));

  // The trap: the composer is where the game is played from, and every digit in
  // a typed sentence arrives at the same document-level handler.
  const typed = await window.webContents.executeJavaScript(`(async () => {
    const input = document.getElementById('input');
    input.focus();
    input.value = 'I say 1 thing';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const value = input.value;
    input.value = '';
    input.blur();
    return value;
  })()`);
  check('a digit typed into the composer is a digit, not a move', pressed.at(-1) === 'bag', JSON.stringify(pressed));
  check('and the message being written is left alone', typed === 'I say 1 thing', typed);

  // The hotkey itself, from the document, where a player's keystroke lands.
  // Counted rather than read off the last entry: pressing the same move twice
  // leaves the same id at the end either way, so only the delta says whether
  // the key did anything at all.
  const beforeKey = pressed.length;
  const hotkeyed = await window.webContents.executeJavaScript(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('status-line').textContent;
  })()`);
  check(
    `pressing 2 makes the move — "${hotkeyed}"`,
    pressed.length === beforeKey + 1 && pressed.at(-1) === 'bag',
    JSON.stringify(pressed),
  );

  // The sheet: 0 opens it, and the lists are the plugin's, empty ones included.
  const sheet = await window.webContents.executeJavaScript(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return {
      display: getComputedStyle(document.getElementById('sheet-modal')).display,
      groups: [...document.querySelectorAll('#sheet-body .sheet-group-label')].map((n) => n.textContent),
      items: [...document.querySelectorAll('#sheet-body .sheet-item-label')].map((n) => n.textContent),
      empty: [...document.querySelectorAll('#sheet-body .sheet-empty')].map((n) => n.textContent),
    };
  })()`);
  check('0 opens the sheet', sheet.display !== 'none', sheet.display);
  check(`with the game's own headings — ${sheet.groups.join(', ')}`, JSON.stringify(sheet.groups) === '["ITEMS","JOURNAL"]');
  check(`and its items — ${sheet.items.join(', ')}`, sheet.items.length === 2, JSON.stringify(sheet.items));
  check(
    `an empty list says so in the game's words — "${sheet.empty[0]}"`,
    sheet.empty[0] === 'nothing written down yet',
    JSON.stringify(sheet.empty),
  );

  /**
   * A list row that is also a control.
   *
   * An inventory is the case this exists for: putting the sword in your hand is
   * a thing to do to a row, not a move to pick off a bar. The row next to it has
   * no action and must stay a row — a journal entry that could be clicked and
   * did nothing would be worse than one that plainly cannot be.
   */
  const rows = await window.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#sheet-body .sheet-item')];
    return items.map((node) => ({ tag: node.tagName, pressable: node.classList.contains('pressable') }));
  })()`);
  check(
    'a row with something to do is a button, and one without is not',
    rows[0]?.tag === 'BUTTON' && rows[0]?.pressable === true && rows[1]?.tag === 'DIV',
    JSON.stringify(rows),
  );

  const beforeItem = pressed.length;
  const itemPress = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#sheet-body .sheet-item.pressable').click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      status: document.getElementById('status-line').textContent,
      sheet: getComputedStyle(document.getElementById('sheet-modal')).display,
    };
  })()`);
  check(
    `pressing a row reaches the game — "${itemPress.status}"`,
    pressed.length === beforeItem + 1 && pressed.at(-1) === 'item-sword',
    JSON.stringify(pressed),
  );
  check('and the sheet stays open to be read', itemPress.sheet !== 'none', itemPress.sheet);

  const shut = await window.webContents.executeJavaScript(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return getComputedStyle(document.getElementById('sheet-modal')).display;
  })()`);
  check('and Escape shuts it', shut === 'none', shut);

  /**
   * The board: a picture with pressable places drawn over it.
   *
   * No image in this fixture, on purpose — the markers and roads *are* the map,
   * and they have to be usable before any artwork exists. What this catches is
   * a marker drawn where the game did not put it, or one that cannot be pressed.
   */
  const map = await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#scene-actions .scene-action')][3].click();
    await new Promise((r) => setTimeout(r, 400));
    const points = [...document.querySelectorAll('#board .board-point')].map((node) => ({
      label: node.querySelector('.board-label').textContent,
      tag: node.tagName,
      here: node.classList.contains('here'),
      left: node.style.left,
      top: node.style.top,
    }));
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {
      open: getComputedStyle(document.getElementById('board-modal')).display,
      points,
      roads: document.querySelectorAll('#board .board-road').length,
      casings: document.querySelectorAll('#board .board-road-casing').length,
      // How wide a road actually is, in pixels. The first version set a stroke
      // width of 0.4 alongside a non-scaling stroke, which means device pixels,
      // so every road was drawn four tenths of a pixel wide and the map arrived
      // with none on it. Counting the elements said everything was fine.
      roadWidth: parseFloat(getComputedStyle(document.querySelector('#board .board-road')).strokeWidth),
      // A name on a busy drawing needs a plate under it, or it smears.
      labelPlate: getComputedStyle(document.querySelector('#board .board-label')).backgroundColor,
      // The dialog, against the two rules that could be sizing it. An ordinary
      // .modal-box asks for min(46rem, 92vw); .modal-box.board-box asks for
      // min(90rem, 96vw, 112vh). Which of them won is readable straight off the
      // width, and computing both here rather than naming a number survives a
      // change of font size and a screen this was not written on.
      boxWidth: Math.round(document.querySelector('.board-box').getBoundingClientRect().width),
      ordinary: Math.round(Math.min(46 * rem, 0.92 * window.innerWidth)),
      wanted: Math.round(Math.min(90 * rem, 0.96 * window.innerWidth, 1.12 * window.innerHeight)),
    };
  })()`);
  check('a move can open the board', map.open !== 'none', map.open);
  check(
    `every place is drawn where the game put it — ${map.points.map((p) => p.label).join(', ')}`,
    map.points.length === 3 && map.points[0].left === '50%' && map.points[0].top === '80%',
    JSON.stringify(map.points),
  );
  check('the one you are standing on is marked', map.points[0].here === true, JSON.stringify(map.points[0]));
  check(
    'only a place you can reach is a button',
    map.points[1].tag === 'BUTTON' && map.points[2].tag === 'DIV',
    JSON.stringify(map.points.map((p) => p.tag)),
  );
  check(`the roads are drawn too — ${map.roads}`, map.roads === 2);
  check('each one over a dark casing, so it survives a busy drawing', map.casings === map.roads, `${map.casings} casings`);
  check(`and wide enough to see — ${map.roadWidth}px`, map.roadWidth >= 1.5, String(map.roadWidth));
  check(
    `each name sits on a plate rather than on the picture — ${map.labelPlate}`,
    /rgba?\(0, 0, 0/.test(map.labelPlate),
    map.labelPlate,
  );
  /**
   * Sized by its own rule, and — where the screen allows it — wider than an
   * ordinary dialog. Two questions, because only one of them is always askable.
   *
   * The first version asked for more than 500px, which `.modal-box` clears on
   * its own, so it kept passing through a build where the rule meant to widen
   * the map was overridden by `.modal-box` further down the stylesheet and the
   * map sat at 46rem the whole time.
   *
   * The second compared it against a nominal 46rem, which is right on a screen
   * with room and wrong on one without. `112vh` is one of the terms the map's
   * own rule minimises over, so on a 768px display the map asks for 734px where
   * an ordinary dialog would have taken 736 — correctly sized, by the rule that
   * was supposed to win, and reported as a failure. A hosted runner is exactly
   * that screen, which is where it was found.
   *
   * So what is asserted is which rule is in force, against both rules computed
   * at whatever viewport this is running in. That the winner is also the wider
   * of the two is a second question, and a short screen cannot answer it.
   */
  if (Math.abs(map.wanted - map.ordinary) <= 1) {
    skip('the map is sized by its own rule', `both rules ask for ${map.wanted}px on this screen`);
  } else {
    check(
      `the map is sized by its own rule — ${map.boxWidth}px, where an ordinary dialog would take ${map.ordinary}`,
      Math.abs(map.boxWidth - map.wanted) <= 1,
      `${map.boxWidth} against the ${map.wanted} its rule asks for`,
    );
  }

  if (map.wanted > map.ordinary * 1.2) {
    check(
      `and the map gets the window — ${map.boxWidth}px against an ordinary ${map.ordinary}px`,
      map.boxWidth > map.ordinary * 1.2,
      `${map.boxWidth} vs ${map.ordinary}`,
    );
  } else {
    skip(
      'and the map gets the window',
      `this screen tops the map out at ${map.wanted}px, where an ordinary dialog takes ${map.ordinary}`,
    );
  }

  // Counted from here rather than from before the map was opened: opening it is
  // itself a press, and the delta is the only thing that says the click landed.
  const beforeWalk = pressed.length;
  const walked = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#board .board-point.pressable').click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      status: document.getElementById('status-line').textContent,
      open: getComputedStyle(document.getElementById('board-modal')).display,
    };
  })()`);
  check(`pressing a place walks there — "${walked.status}"`, pressed.length === beforeWalk + 1 && pressed.at(-1) === 'go-forest', JSON.stringify(pressed));
  // The fixture's `go-forest` answers with a status and no words to send, so the
  // map stays; the closing is checked where a move actually sends something.
  check('and the map is still there when nothing was sent', walked.open !== 'none', walked.open);

  /**
   * A move made from the map closes it.
   *
   * Pressing a place and then watching the reply arrive behind the still-open
   * map is the map refusing to get out of the way of the thing it was used for.
   * `look` is the fixture's move that sends words.
   */
  const closed = await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#scene-actions .scene-action')][3].click();
    await new Promise((r) => setTimeout(r, 300));
    const before = getComputedStyle(document.getElementById('board-modal')).display;
    [...document.querySelectorAll('#scene-actions .scene-action')][0].click();
    await new Promise((r) => setTimeout(r, 600));
    return { before, after: getComputedStyle(document.getElementById('board-modal')).display };
  })()`);
  check('a move that sends words shuts the map behind it', closed.before !== 'none' && closed.after === 'none', JSON.stringify(closed));

  /**
   * The chooser: equal cards, a picture over a name over a paragraph.
   *
   * Equal by construction is the part worth checking. The grid gives every card
   * the same width, so a longer description cannot quietly make one of them
   * look like the recommended answer.
   */
  const beforeCards = pressed.length;
  const chooser = await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#scene-actions .scene-action')][4].click();
    await new Promise((r) => setTimeout(r, 400));
    const cards = [...document.querySelectorAll('#cards .card')];
    return {
      open: getComputedStyle(document.getElementById('cards-modal')).display,
      title: document.getElementById('cards-title').textContent,
      tags: cards.map((c) => c.tagName),
      widths: cards.map((c) => Math.round(c.getBoundingClientRect().width)),
      art: cards.map((c) => Boolean(c.querySelector('.card-art'))),
      notes: cards.map((c) => (c.querySelector('.card-note')?.textContent ?? '').length),
    };
  })()`);
  check(`the chooser opens — "${chooser.title}"`, chooser.open !== 'none', chooser.open);
  check(`three cards drawn — ${chooser.tags.join(', ')}`, chooser.tags.length === 3, JSON.stringify(chooser.tags));
  check(
    'one with nothing to press is not a button',
    chooser.tags[0] === 'BUTTON' && chooser.tags[2] === 'DIV',
    JSON.stringify(chooser.tags),
  );
  check(`and every card is the same width — ${chooser.widths.join(', ')}`, new Set(chooser.widths).size === 1, JSON.stringify(chooser.widths));
  check('a picture where there is one, and none where there is not', chooser.art[0] && !chooser.art[2], JSON.stringify(chooser.art));

  const chose = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#cards .card').click();
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('status-line').textContent;
  })()`);
  check(`pressing one reaches the game — "${chose}"`, pressed.length === beforeCards + 2 && pressed.at(-1) === 'class-ranger', JSON.stringify(pressed));

  // Answering is what closes it: a scene without cards has nothing left to ask.
  scene.show({ title: 'Chosen', actions: [{ id: 'look', label: 'Look around' }] });
  await new Promise((r) => setTimeout(r, 300));
  const answered = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('cards-modal')).display`,
  );
  check('and a scene without cards closes it', answered === 'none', answered);
  // Put the game back: every check after this one reads the scene above.
  scene.show(SCENE);
  await new Promise((r) => setTimeout(r, 200));

  // A game asking for the sheet, which is the only way a plugin can open it.
  const asked = await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#scene-actions .scene-action')][2].click();
    await new Promise((r) => setTimeout(r, 400));
    return getComputedStyle(document.getElementById('sheet-modal')).display;
  })()`);
  check('a move can ask for the sheet to be opened', asked !== 'none', asked);
  await window.webContents.executeJavaScript(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  })()`);

  /**
   * A move that costs a turn, with no model loaded.
   *
   * The failure is the point: it proves the words reached the agent by the same
   * path a typed message takes, and that the turn it could not start left
   * nothing behind in the transcript.
   */
  const before = await window.webContents.executeJavaScript(
    `document.querySelectorAll('#chat-log .turn.user').length`,
  );
  const move = await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#scene-actions .scene-action')][0].click();
    await new Promise((r) => setTimeout(r, 600));
    return {
      status: document.getElementById('status-line').textContent,
      turns: document.querySelectorAll('#chat-log .turn.user').length,
      composer: document.getElementById('input').value,
    };
  })()`);
  check('a move that costs a turn reaches the plugin', pressed.at(-1) === 'look', JSON.stringify(pressed));
  check(`and goes out as an ordinary message — "${move.status}"`, /model/i.test(move.status), move.status);
  check('a turn that never started leaves nothing in the transcript', move.turns === before, `${before} → ${move.turns}`);
  check("and does not put the game's words in the composer", move.composer === '', move.composer);

  /**
   * A game must not eat the transcript.
   *
   * The strip and the action row both sit inside the chat column, so they come
   * out of the reading area — and the shortest shape the layout supports is
   * where that is paid for. Checked here rather than in `checkLayouts`, which
   * runs with no game on screen.
   */
  window.setContentSize(900, 700);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const width = await window.webContents.executeJavaScript('window.innerWidth');
    if (Math.abs(width - 900) <= 4) break;
  }
  const narrow = await window.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    return {
      log: Math.round(document.getElementById('chat-log').getBoundingClientRect().height),
      overflow: root.scrollWidth - root.clientWidth,
    };
  })()`);
  check(`the transcript survives a game on a 900×700 window — log ${narrow.log}px`, narrow.log >= 200, JSON.stringify(narrow));
  check('and the row of moves wraps rather than widening the page', narrow.overflow <= 1, `${narrow.overflow}px`);
  window.setContentSize(1280, 860);

  /**
   * A game does not follow you into another conversation.
   *
   * The reported bug: the strip and the moves were drawn over every chat in the
   * app, so opening a new conversation left a character sheet and a row of
   * moves above an empty transcript, offering a game that was not being played.
   * NEW CHAT is the shortest way to be somewhere else.
   */
  await window.webContents.executeJavaScript(`document.getElementById('btn-new-chat').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const elsewhere = await window.webContents.executeJavaScript(`(() => ({
    panel: getComputedStyle(document.getElementById('scene')).display,
    row: getComputedStyle(document.getElementById('scene-actions')).display,
    sheet: getComputedStyle(document.getElementById('sheet-modal')).display,
  }))()`);
  check(
    'a new conversation has no game in it',
    elsewhere.panel === 'none' && elsewhere.row === 'none',
    JSON.stringify(elsewhere),
  );

  // And the keyboard goes with it: a hidden panel that still answered a digit
  // would make a move in a conversation the game is not being played in.
  const beforeKeys = pressed.length;
  await window.webContents.executeJavaScript(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  })()`);
  const quiet = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('sheet-modal')).display`,
  );
  check('and its hotkeys are silent there', pressed.length === beforeKeys, JSON.stringify(pressed));
  check('including the one that opens the sheet', quiet === 'none', quiet);

  // Back where the game is, the panel is back with it.
  const back = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#chat-menu .chat-row .chat-pick').click();
    await new Promise((r) => setTimeout(r, 500));
    return getComputedStyle(document.getElementById('scene')).display;
  })()`);
  check('returning to the game brings the panel back', back !== 'none', back);

  // Switching the game off takes the panel with it — the same rule the audio
  // bar follows, and the reason `releasePlugin` exists on every service.
  scene.releasePlugin('smoke-game');
  await new Promise((r) => setTimeout(r, 300));
  const gone = await window.webContents.executeJavaScript(`(() => ({
    panel: getComputedStyle(document.getElementById('scene')).display,
    row: getComputedStyle(document.getElementById('scene-actions')).display,
  }))()`);
  check('switching the game off takes the panel away', gone.panel === 'none' && gone.row === 'none', JSON.stringify(gone));
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
/**
 * A chooser with no button to open it.
 *
 * The reported dead end, exactly: `fantasy-rpg` publishes its class chooser as
 * a scene carrying `cards` and no `actions`, because picking a class *is* the
 * turn. The dialog was only ever opened by an `act` answering `cards: true`, so
 * there was nothing on screen to reach it with — and the model spent the whole
 * session telling the player to press a card that had never been drawn. Every
 * assertion here is on what is actually displayed, because the cards existed in
 * the scene document the entire time the bug was on screen.
 */
async function checkChooser(window) {
  say('');
  say('A chooser that nothing opens');

  // The panel is drawn only in the conversation the scene was stamped with, so
  // one has to be open and the service told a turn is running in it.
  const chatId = await window.webContents.executeJavaScript(`(async () => {
    const list = await window.wasteland.chats.list();
    const pick = document.querySelector('#chat-menu .chat-row .chat-pick');
    if (!pick || !list.length) return '';
    pick.click();
    await new Promise((r) => setTimeout(r, 400));
    return list[0].id;
  })()`);
  check('a conversation to ask in', Boolean(chatId), 'no seeded chat to open');
  scene.setTurn(chatId);
  scene.present({ pluginId: 'smoke-game', pluginName: 'Smoke game', act: () => ({ status: 'picked' }) });
  scene.show({
    title: 'New run',
    subtitle: 'Choose who to play',
    // No `actions`. That is the whole case.
    cards: {
      label: 'Who are you',
      items: [
        { label: 'Warrior', note: 'strong', action: 'class-warrior' },
        { label: 'Mage', note: 'clever', action: 'class-mage' },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 400));

  const opened = await window.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('cards-modal');
    const button = document.getElementById('btn-scene-cards');
    return {
      display: getComputedStyle(modal).display,
      cards: modal.querySelectorAll('.card').length,
      labels: [...modal.querySelectorAll('.card')].map((c) => c.textContent),
      buttonShown: getComputedStyle(button).display !== 'none',
      actions: document.querySelectorAll('#scene-actions .scene-action').length,
    };
  })()`);

  check('a scene that asks a question offers no moves', opened.actions === 0, JSON.stringify(opened));
  // The bug: the dialog stayed shut and there was no way to open it.
  check(`the chooser opens itself — display: ${opened.display}`, opened.display !== 'none', JSON.stringify(opened));
  check(`with the cards the game published — ${opened.cards}`, opened.cards === 2);
  // And a way back, for a chooser the player dismissed.
  check('a button to reopen it is drawn', opened.buttonShown === true);

  const dismissed = await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-scene-cards').click();
    await new Promise((r) => setTimeout(r, 200));
    const shut = getComputedStyle(document.getElementById('cards-modal')).display;
    document.getElementById('btn-scene-cards').click();
    await new Promise((r) => setTimeout(r, 200));
    return { shut, reopened: getComputedStyle(document.getElementById('cards-modal')).display };
  })()`);
  check(`the button closes it — display: ${dismissed.shut}`, dismissed.shut === 'none', JSON.stringify(dismissed));
  check('and opens it again', dismissed.reopened !== 'none', JSON.stringify(dismissed));

  /**
   * A repaint is not a new question.
   *
   * A game redraws its panel every turn. A chooser that reopened on each one
   * could not be dismissed at all, which is a worse dead end than the one this
   * check exists for.
   */
  await window.webContents.executeJavaScript(`document.getElementById('btn-scene-cards').click()`);
  await new Promise((r) => setTimeout(r, 200));
  scene.show({
    title: 'New run',
    subtitle: 'Choose who to play — still',
    cards: {
      label: 'Who are you',
      items: [
        { label: 'Warrior', note: 'strong and rested', action: 'class-warrior' },
        { label: 'Mage', note: 'clever', action: 'class-mage' },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  const again = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('cards-modal')).display`,
  );
  check(`the same question redrawn stays dismissed — display: ${again}`, again === 'none', again);

  // A different question is a new one, and opens.
  scene.show({
    title: 'New run',
    subtitle: 'Name the hero',
    cards: { label: 'Pick a name', items: [{ label: 'Elsa', action: 'name-elsa' }] },
  });
  await new Promise((r) => setTimeout(r, 400));
  const fresh = await window.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById('cards-modal')).display`,
  );
  check(`a different question opens itself — display: ${fresh}`, fresh !== 'none', fresh);

  /**
   * Cards a scene keeps beside its moves are a reference, not a question.
   *
   * The rule the smoke run had to teach: throwing that open unasked put a
   * dialog over the panel that swallowed the next hotkey. A scene with moves
   * has given the player something else to do, so the chooser waits behind its
   * own button.
   */
  scene.show({
    title: 'Playing',
    actions: [{ id: 'look', label: 'Look around' }],
    cards: { label: 'Who is here', items: [{ label: 'Brann', action: 'who-brann' }] },
  });
  await new Promise((r) => setTimeout(r, 400));
  const beside = await window.webContents.executeJavaScript(`(() => ({
    modal: getComputedStyle(document.getElementById('cards-modal')).display,
    button: getComputedStyle(document.getElementById('btn-scene-cards')).display,
    moves: document.querySelectorAll('#scene-actions .scene-action').length,
  }))()`);
  check(`a chooser beside the moves stays shut — display: ${beside.modal}`, beside.modal === 'none', JSON.stringify(beside));
  check('but is still reachable from its button', beside.button !== 'none', JSON.stringify(beside));
  check(`and the moves are drawn — ${beside.moves}`, beside.moves === 1);

  // A scene with nothing to ask takes the chooser and its button away.
  scene.show({ title: 'Playing', actions: [{ id: 'look', label: 'Look around' }] });
  await new Promise((r) => setTimeout(r, 400));
  const gone = await window.webContents.executeJavaScript(`(() => ({
    modal: getComputedStyle(document.getElementById('cards-modal')).display,
    button: getComputedStyle(document.getElementById('btn-scene-cards')).display,
  }))()`);
  check(`a scene with no chooser closes it — display: ${gone.modal}`, gone.modal === 'none', JSON.stringify(gone));
  check('and takes the button with it', gone.button === 'none', JSON.stringify(gone));

  /**
   * A chooser painted before any turn, claimed by the turn the game acts in.
   *
   * A game can paint from a timer or at activation, outside every turn, and
   * such a scene belongs to nobody and is drawn nowhere. Claiming it when the
   * game next acts is what brings it back. This is the one part
   * `scene.test.mjs` cannot see: whether the window actually draws it when the
   * claim lands.
   */
  scene.clear();
  scene.setTurn('');
  scene.show({
    title: 'New run',
    subtitle: 'Choose who to play',
    cards: { label: 'Who are you', items: [{ label: 'Warrior', action: 'class-warrior' }] },
  });
  await new Promise((r) => setTimeout(r, 400));

  const unclaimed = await window.webContents.executeJavaScript(`(() => ({
    panel: getComputedStyle(document.getElementById('scene')).display,
    modal: getComputedStyle(document.getElementById('cards-modal')).display,
  }))()`);
  check(`a scene painted outside a turn is drawn nowhere — panel: ${unclaimed.panel}`,
    unclaimed.panel === 'none' && unclaimed.modal === 'none', JSON.stringify(unclaimed));

  scene.setTurn(chatId);
  scene.claimTurn('smoke-game');
  await new Promise((r) => setTimeout(r, 400));

  const claimed = await window.webContents.executeJavaScript(`(() => ({
    panel: getComputedStyle(document.getElementById('scene')).display,
    modal: getComputedStyle(document.getElementById('cards-modal')).display,
    cards: document.querySelectorAll('#cards-modal .card').length,
  }))()`);
  check(`the game acting claims the panel — panel: ${claimed.panel}`, claimed.panel !== 'none', JSON.stringify(claimed));
  check(`and the chooser it was holding opens — modal: ${claimed.modal}`, claimed.modal !== 'none', JSON.stringify(claimed));
  check(`with its cards — ${claimed.cards}`, claimed.cards === 1, JSON.stringify(claimed));

  scene.clear();
  await new Promise((r) => setTimeout(r, 200));
}

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
        // Its settings, drawn a second time as a section of the left panel.
        // The row is where a plugin is decided about; a section is where one is
        // used, and a setting somebody changes daily should not be behind a
        // list of a dozen rows.
        panel: 'SMOKE',
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
      // Direct children of the rail only. A section can hold sections of its
      // own now — GET PLUGINS folds its list of registries away into one — and
      // counting every section on the page turns "is the rail complete" into a
      // number that moves whenever anything inside a section is rearranged.
      sections: document.querySelectorAll('#panel-left > .section').length,
      status: document.getElementById('status-line').textContent,
      statusShown: getComputedStyle(document.getElementById('status-line')).display,
      browserChip: Boolean(document.getElementById('stat-browser')),
      sysChip: Boolean(document.getElementById('stat-sys')),
      engineChip: Boolean(document.getElementById('stat-engine')),
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
    check('all left-panel sections present', probe.sections === 7, `${probe.sections} sections`);
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
    // Read through the computed style, not the attribute: what `hidden` says
    // and what the user sees are different questions, and only the second is
    // worth a check. An idle app has nothing to report, and the line that used
    // to rest on "Ready" spent every idle moment saying so.
    check('boot says nothing, because nothing is happening', probe.status === '', probe.status);
    check('and the line is not on screen to say it', probe.statusShown === 'none', probe.statusShown);
    // SYS: ONLINE was written once, in the markup, and never again — a reading
    // that cannot report anything else is decoration wearing a status chip's
    // clothes.
    check('no SYS chip that could only ever say ONLINE', !probe.sysChip);
    check('context meter initialised', /^CTX: \d+ \/ \d+/.test(probe.ctx), probe.ctx);
    // The browser chips are gone with the browser: nothing in this app owns a
    // Chrome any more, and a status line for a capability that may not be
    // installed is one that reads as broken to everyone who never wanted it.
    check(
      'no status chip is left over from the browser',
      !probe.browserChip && !probe.engineChip,
      JSON.stringify({ browser: probe.browserChip, engine: probe.engineChip }),
    );
    check(`model status resolved — ${probe.model}`, /MODEL:/.test(probe.model));
    check('both columns have width', probe.leftWidth > 100 && probe.chatWidth > 300, `${probe.leftWidth}/${probe.chatWidth}`);
    check('no renderer errors', errors.length === 0, errors.join(' | '));

    await checkMarkdown(window);
    await checkReplyChoices(window);
    await checkPlugins(window);
    await checkThemes(window);
    await checkLanguages(window);
    await checkPlayer(window, wavPath);
    await checkScene(window);
    await checkChooser(window);
    await checkChatControls(window);
    await checkComposer(window);
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
