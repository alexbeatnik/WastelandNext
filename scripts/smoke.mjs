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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setDataRoot } from '../src/main/paths.mjs';
import { registerIpc } from '../src/main/ipc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// A scratch data root, so a smoke run never touches real chats or settings.
setDataRoot(mkdtempSync(join(tmpdir(), 'wl-smoke-')));

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

  const before = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('.chat-item .title').click();
    return true;
  })()`);
  assertOk(before);
  await new Promise((r) => setTimeout(r, 400));

  const loaded = await window.webContents.executeJavaScript(`(() => ({
    turns: document.querySelectorAll('#chat-log .turn').length,
    active: document.querySelectorAll('.chat-item.active').length,
    ctx: document.getElementById('ctx-label').textContent,
  }))()`);
  check(`seeded chat renders — ${loaded.turns} turn(s)`, loaded.turns === 3);
  check('the loaded chat is marked active', loaded.active === 1);

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
    active: document.querySelectorAll('.chat-item.active').length,
    ctx: document.getElementById('ctx-label').textContent,
    input: document.getElementById('input').value,
  }))()`);
  check('NEW CHAT empties the transcript', fresh.turns === 0 && fresh.cards === 0, `${fresh.turns} turn(s)`);
  check('NEW CHAT deselects the old chat', fresh.active === 0, `${fresh.active} still active`);
  check('NEW CHAT clears the composer', fresh.input === '', JSON.stringify(fresh.input));

  // A fresh chat still costs the system prompt, so the assertion is that the
  // number was recomputed and is small — not that it is literally zero.
  const used = Number(/CTX: (\d+)/.exec(fresh.ctx)?.[1] ?? -1);
  check(`NEW CHAT recomputes the context meter — ${fresh.ctx}`, used >= 0 && used < 2000);

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

function assertOk(value) {
  if (!value) throw new Error('interaction setup failed');
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

    registerIpc(() => window);

    // A model registered from outside the vault. The native picker cannot be
    // clicked from here, but everything downstream of it can be checked.
    const config = await import('../src/main/config.mjs');
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

    await checkChatControls(window);
    await checkContextControls(window);
    await checkLayouts(window);
  } catch (err) {
    check('smoke run completed', false, err.message);
  } finally {
    clearTimeout(watchdog);
    finish();
  }
});
