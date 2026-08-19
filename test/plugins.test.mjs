/**
 * The plugin host, driven against a scratch data root and stub services.
 *
 * Two things are being checked here that nothing else can see. The first is the
 * boundary: a manifest arrives inside an archive from a repository we do not
 * control, and everything it claims — its id, its entry point, the services it
 * wants, the action types it answers to — is input, not fact.
 *
 * The second is the pairing the CAPABILITIES checkboxes used to guarantee by
 * hand: what the system prompt documents and what the dispatcher will accept
 * must be the same set. That is now a property of the host — a plugin
 * contributes both or neither — so it is asserted through the host against the
 * real built-ins rather than against a copy of their text.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';
import {
  KNOWN_SERVICES,
  PLUGIN_API_VERSION,
  enabledByLegacy,
  isContainedPath,
  mergeEnablement,
  needsApproval,
  parseManifest,
} from '../src/main/plugins/manifest.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-plugins-')));

const config = await import('../src/main/config.mjs');
const { PluginHost } = await import('../src/main/plugins/host.mjs');
const { buildSystemPrompt } = await import('../src/main/agent/prompts.mjs');

/* ============================ manifests ============================ */

const GOOD = { id: 'thing', name: 'Thing', version: '1.0.0', apiVersion: 1, main: 'main.mjs', actions: ['do_thing'] };

test('a well-formed manifest is normalised, not merely accepted', () => {
  const { ok, manifest } = parseManifest({ ...GOOD, order: '5' });
  assert.ok(ok);
  assert.equal(manifest.id, 'thing');
  assert.equal(manifest.order, 5);
  assert.equal(manifest.enabledByDefault, true);
  assert.deepEqual(manifest.services, []);
});

test('an id that could escape its own directory is refused', () => {
  // The id becomes a directory name and a key in the config, for the same
  // reason `isSafeId` exists in chats.mjs: it is interpolated into a path.
  for (const id of ['../evil', 'Thing', 'a/b', '', 'thing!', '.hidden']) {
    const result = parseManifest({ ...GOOD, id });
    assert.equal(result.ok, false, `"${id}" should have been refused`);
  }
});

test('an entry point outside the plugin is refused', () => {
  for (const main of ['../other/main.mjs', '/etc/passwd', 'C:\\windows\\x.mjs', '..\\..\\main.mjs', 'a/../../b.mjs']) {
    assert.equal(parseManifest({ ...GOOD, main }).ok, false, `"${main}" should have been refused`);
  }
  assert.equal(parseManifest({ ...GOOD, main: 'lib/main.mjs' }).ok, true);
});

test('isContainedPath is the same question assertSafeArchive asks', () => {
  assert.ok(isContainedPath('main.mjs'));
  assert.ok(isContainedPath('lib/deep/main.mjs'));
  // A backslash is a separator here even where the format says otherwise:
  // Windows extractors and Windows path resolution both honour it.
  assert.equal(isContainedPath('lib\\..\\..\\main.mjs'), false);
  assert.equal(isContainedPath(''), false);
});

test('a plugin from a future build is explained, not loaded', () => {
  const result = parseManifest({ ...GOOD, apiVersion: PLUGIN_API_VERSION + 1 });
  assert.equal(result.ok, false);
  // The reason has to name the remedy: "failed to load" sends the user hunting
  // for a broken download.
  assert.match(result.reason, /update Wasteland Next/i);
});

test('a manifest that names no API version at all is refused', () => {
  assert.equal(parseManifest({ ...GOOD, apiVersion: undefined }).ok, false);
});

test('an installed plugin must name an entry point; a built-in need not', () => {
  assert.equal(parseManifest({ ...GOOD, main: undefined }).ok, false);
  assert.equal(parseManifest({ ...GOOD, main: undefined }, { builtin: true }).ok, true);
});

test('a service this build does not have is a manifest error, not a runtime undefined', () => {
  const result = parseManifest({ ...GOOD, services: ['audio', 'filesystem'] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /filesystem/);
});

test('an unusable action type is refused', () => {
  assert.equal(parseManifest({ ...GOOD, actions: ['Do Thing'] }).ok, false);
  assert.equal(parseManifest({ ...GOOD, actions: ['do_thing', 'do_2'] }).ok, true);
});

/* ============================ a section of its own ============================ */

test('a plugin may ask for its settings to be drawn in the left panel', () => {
  const settings = [{ key: 'folder', type: 'folder', label: 'Music' }];
  assert.equal(parseManifest({ ...GOOD, settings, panel: 'MUSIC' }).manifest.panel, 'MUSIC');
  // `true` means "use my own name" — a plugin that has no better word for it
  // should not have to repeat itself.
  assert.equal(parseManifest({ ...GOOD, settings, panel: true }).manifest.panel, 'Thing');
  // Absent is the default, and the default is no section at all.
  assert.equal(parseManifest({ ...GOOD, settings }).manifest.panel, '');
});

test('a panel heading is cut to something a narrow column can hold', () => {
  const settings = [{ key: 'folder', type: 'folder', label: 'Music' }];
  const long = parseManifest({ ...GOOD, settings, panel: 'X'.repeat(200) });
  assert.equal(long.manifest.panel.length, 24);
  // Newlines would otherwise push the whole panel down the page.
  assert.equal(parseManifest({ ...GOOD, settings, panel: 'TWO\nWORDS' }).manifest.panel, 'TWO WORDS');
});

test('a section with nothing to put in it is refused, not drawn empty', () => {
  // The same argument an empty category heading loses: a section promises
  // controls, and one that opens onto nothing is worse than none. Refused
  // rather than dropped, because the manifest has misunderstood what it asked
  // for and the message says which line to delete.
  const result = parseManifest({ ...GOOD, panel: 'NOTHING' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no settings/);
});

/* ============================ enablement ============================ */

/**
 * The capability whose keys the old config actually had.
 *
 * Browser control is a plugin in its own repository now and is not among the
 * built-ins any more, but a config written by a build that had it still
 * carries `browserEnabled` and `allowBrowser` — so this stays as the fixture
 * for the upgrade path, which is the thing being tested. It is a manifest
 * shape, not a plugin: nothing here loads any code.
 */
const BROWSER_MANIFEST = { id: 'browser-control', legacy: ['browserEnabled', 'allowBrowser'], enabledByDefault: true };
const SHELL_MANIFEST = { id: 'system-shell', legacy: ['allowShell'], enabledByDefault: false };
const READ_MANIFEST = { id: 'read-file', legacy: ['allowReadFile'], enabledByDefault: true };

test('a capability switched off in an older build stays off after the upgrade', () => {
  const settings = { browserEnabled: false, allowBrowser: true, allowShell: true };
  assert.equal(enabledByLegacy(BROWSER_MANIFEST, settings), false);
  assert.equal(enabledByLegacy(SHELL_MANIFEST, settings), true);
});

test('a fresh install does not read absent keys as a decision', () => {
  // The old keys are gone from the defaults, so every one of them is undefined
  // on a new machine. Reading that as `false` would ship with every capability
  // disabled and no hint as to why.
  assert.equal(enabledByLegacy(BROWSER_MANIFEST, {}), true);
  assert.equal(enabledByLegacy(SHELL_MANIFEST, {}), false);
  // Half a legacy config is not a decision either.
  assert.equal(enabledByLegacy(BROWSER_MANIFEST, { allowBrowser: false }), true);
});

test('rediscovery never overrules what the user chose', () => {
  const stored = { 'browser-control': { enabled: false, approved: true } };
  const merged = mergeEnablement(stored, [{ ...BROWSER_MANIFEST, builtin: true }], { browserEnabled: true, allowBrowser: true });
  assert.equal(merged['browser-control'].enabled, false);
});

test('an installed plugin is never approved by being discovered', () => {
  const merged = mergeEnablement({}, [{ id: 'music', legacy: [], enabledByDefault: true, builtin: false, main: 'main.mjs' }], {});
  assert.equal(merged.music.approved, false);
});

test('a plugin that has not been allowed to run does not default to on', () => {
  // Reported: audio-player sat at {enabled: true, approved: false} — a ticked
  // checkbox beside a plugin the host had never imported, with nothing left to
  // click, because the box was already in the state a click would produce. The
  // model duly answered "I do not have access to external audio plugins", which
  // was true. Installing is not switching on.
  const merged = mergeEnablement({}, [{ id: 'music', legacy: [], enabledByDefault: true, builtin: false, main: 'main.mjs' }], {});
  assert.equal(merged.music.enabled, false);

  // A theme pack has no code to allow, so it is on as soon as it is there.
  const theme = mergeEnablement({}, [{ id: 'looks', legacy: [], enabledByDefault: true, builtin: false, main: '' }], {});
  assert.equal(theme.looks.enabled, true);

  // Built-ins are approved by shipping inside the app and keep their defaults.
  const builtin = mergeEnablement({}, [{ ...READ_MANIFEST, builtin: true, main: '' }], {});
  assert.equal(builtin['read-file'].enabled, true);
});

test('an already-approved plugin keeps its default, and a recorded choice wins', () => {
  const manifest = { id: 'music', legacy: [], enabledByDefault: true, builtin: false, main: 'main.mjs' };
  assert.equal(mergeEnablement({ music: { approved: true } }, [manifest], {}).music.enabled, true);
  // Whatever the user last chose is never overruled by rediscovery.
  assert.equal(mergeEnablement({ music: { enabled: false, approved: true } }, [manifest], {}).music.enabled, false);
});

test('mergeEnablement does not edit the map it was given', () => {
  const stored = {};
  mergeEnablement(stored, [{ ...BROWSER_MANIFEST, builtin: true }], {});
  assert.deepEqual(stored, {});
});

/* ============================ the host ============================ */

/**
 * The built-ins, all of them.
 *
 * Two, since browser control left for a repository of its own. That is the
 * point of the list rather than an accident of it: what ships inside the app is
 * what has nowhere else to live, and everything that reaches this machine
 * through something the user could uninstall is installed.
 */
const ALL_BUILTINS = ['read-file', 'system-shell'];

/** A host with exactly the named built-ins switched on. */
async function hostWith(enabledIds, services = {}) {
  const plugins = {};
  for (const id of ALL_BUILTINS) plugins[id] = { enabled: enabledIds.includes(id), approved: true };
  config.update({ plugins });

  const host = new PluginHost({
    userDir: mkdtempSync(join(tmpdir(), 'wl-userplugins-')),
    services,
  });
  await host.load();
  return host;
}

const promptFor = (host) => buildSystemPrompt({ fragments: host.promptFragments() });

test('the built-ins are discovered', async () => {
  const host = await hostWith(ALL_BUILTINS);
  assert.deepEqual(host.list().map((p) => p.id), ALL_BUILTINS);
  assert.ok(host.list().every((p) => p.builtin && p.active && !p.error), JSON.stringify(host.list()));
});

test('every capability on documents every action type', async () => {
  const prompt = promptFor(await hostWith(ALL_BUILTINS));
  for (const type of ['read_file', 'system_shell']) {
    assert.match(prompt, new RegExp(type), `${type} should be documented`);
  }
});

test('a disabled plugin is absent from the prompt, not forbidden in it', async () => {
  const prompt = promptFor(await hostWith(['read-file']));
  assert.match(prompt, /read_file/);
  assert.doesNotMatch(prompt, /system_shell/);
});

test('with nothing enabled the model is told it has nothing', async () => {
  const prompt = promptFor(await hostWith([]));
  assert.match(prompt, /no tools enabled/);
  assert.doesNotMatch(prompt, /```action/);
});

test('what the prompt documents is exactly what the dispatcher accepts', async () => {
  // The pairing the four checkboxes used to hold together by hand. A plugin
  // contributes its text and its handler in one activation, so the two cannot
  // drift — this is the assertion that says so.
  const host = await hostWith(['read-file']);
  const prompt = promptFor(host);
  assert.ok(host.action('read_file'), 'read_file is documented but not dispatchable');
  assert.match(prompt, /read_file/);
  assert.equal(host.action('system_shell'), null, 'system_shell is dispatchable but not documented');
});

test('a switched-off action is still known, so it can be refused in words', async () => {
  // "Unknown action type" makes a model retry with different spelling; "shell
  // commands are switched off" makes it tell the user. The manifest is what
  // lets the app say the second without loading the plugin.
  const host = await hostWith([]);
  assert.equal(host.owner('system_shell')?.name, 'Shell commands');
  assert.equal(host.owner('read_file')?.name, 'File reading');
  assert.equal(host.owner('teleport'), null);
});

test('an action belonging to no plugin at all is not owned either', async () => {
  // Browser control's action types used to be answerable here whether or not it
  // was switched on, because it shipped inside the app. Uninstalled, it is not
  // a switched-off capability — it is one this app has never heard of, and the
  // honest refusal is the one that says so.
  const host = await hostWith(ALL_BUILTINS);
  assert.equal(host.owner('browser_steps'), null);
});

test('switching a plugin off takes its action and its prompt with it', async () => {
  const host = await hostWith(ALL_BUILTINS);
  assert.ok(host.action('system_shell'));

  await host.setEnabled('system-shell', false);
  assert.equal(host.action('system_shell'), null);
  assert.doesNotMatch(promptFor(host), /system_shell/);

  await host.setEnabled('system-shell', true);
  assert.ok(host.action('system_shell'));
  assert.match(promptFor(host), /system_shell/);
});

test('switching one off leaves the others alone', async () => {
  const host = await hostWith(ALL_BUILTINS);
  await host.setEnabled('read-file', false);
  assert.equal(host.action('read_file'), null);
  assert.ok(host.action('system_shell'));
});

test('the list reports the panel a plugin asked for, and a broken row still carries the field', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-panel-'));
  install(root, 'radio', {
    manifest: {
      actions: [],
      panel: 'RADIO',
      settings: [{ key: 'station', type: 'text', label: 'Station' }],
    },
    source: `export function activate() {}`,
  });
  // A row that throws while being drawn takes the whole list with it, so every
  // field the renderer reads has to be there even on an entry that failed.
  mkdirSync(join(root, 'wreck'), { recursive: true });
  writeFileSync(join(root, 'wreck', 'plugin.json'), '{ not json');

  const host = await installedHost(root, { radio: { enabled: true, approved: true } });
  const rows = host.list();
  assert.equal(rows.find((row) => row.id === 'radio').panel, 'RADIO');
  assert.equal(rows.find((row) => row.id === 'wreck').panel, '');
});

test('the decision is persisted, not merely held in memory', async () => {
  const host = await hostWith(ALL_BUILTINS);
  await host.setEnabled('read-file', false);
  assert.equal(config.get('plugins')['read-file'].enabled, false);
});

/* ============================ context and turns ============================ */

test('a plugin contributes turn context, with its own heading', async () => {
  // The heading belongs to the plugin, not to the prompt builder: a second
  // plugin contributing context would otherwise have its lines filed under
  // somebody else's, which is only true of one of them.
  const root = mkdtempSync(join(tmpdir(), 'wl-context-'));
  install(root, 'tides', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.context(() => 'TIDE\\nhigh at 14:20'); }`,
  });
  install(root, 'moon', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.context(async () => 'MOON\\nwaxing'); }`,
  });

  const host = await installedHost(root, {
    tides: { enabled: true, approved: true },
    moon: { enabled: true, approved: true },
  });

  const context = await host.context();
  assert.match(context, /TIDE\nhigh at 14:20/);
  assert.match(context, /MOON\nwaxing/);
});

test('a plugin with nothing to say contributes nothing rather than an empty heading', async () => {
  // A model shown a heading with nothing under it reads it as a fact about the
  // world — "there is no tide" rather than "nobody asked".
  const root = mkdtempSync(join(tmpdir(), 'wl-context-quiet-'));
  install(root, 'quiet', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.context(() => ''); }`,
  });
  const host = await installedHost(root, { quiet: { enabled: true, approved: true } });
  assert.equal(await host.context(), '');
});

test('a context provider that throws does not cost the turn its prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-context-throw-'));
  install(root, 'broken', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.context(() => { throw new Error('the engine died'); }); }`,
  });
  install(root, 'fine', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.context(() => 'STILL HERE'); }`,
  });

  const host = await installedHost(root, {
    broken: { enabled: true, approved: true },
    fine: { enabled: true, approved: true },
  });

  // One plugin's bad turn is not the whole turn's: the failure is logged and
  // everything else still reaches the model.
  assert.equal(await host.context(), 'STILL HERE');
});

test('a turn hook is called once per user message, and reaches every plugin that asked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-turns-'));
  install(root, 'counter', {
    manifest: { actions: ['count'] },
    source: `let turns = 0;
      export function activate(ctx) {
        ctx.prompt('COUNT — {"type":"count","steps":""}');
        ctx.onTurnStart(() => { turns += 1; });
        ctx.action({ type: 'count', run: async () => ({ ok: true, summary: String(turns) }) });
      }`,
  });
  install(root, 'thrower', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.onTurnStart(() => { throw new Error('nope'); }); }`,
  });

  const host = await installedHost(root, {
    counter: { enabled: true, approved: true },
    thrower: { enabled: true, approved: true },
  });

  host.beginTurn();
  host.beginTurn();
  // A hook that throws is logged and stepped over: a third-party typo must not
  // be able to stop every other plugin being told a turn has begun.
  const result = await host.action('count').run('', { status() {}, log() {} });
  assert.equal(result.summary, '2');
});

/* ============================ installed plugins ============================ */

/** Write a plugin directory the way the installer will. */
function install(root, id, { manifest = {}, source = '' } = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, main: 'main.mjs', ...manifest }),
  );
  writeFileSync(join(dir, 'main.mjs'), source);
  return dir;
}

/** A host over a directory of installed plugins, with the built-ins all off. */
async function installedHost(root, state = {}) {
  const plugins = {};
  for (const id of ALL_BUILTINS) plugins[id] = { enabled: false, approved: true };
  config.update({ plugins: { ...plugins, ...state } });

  const host = new PluginHost({ userDir: root, services: {} });
  await host.load();
  return host;
}

test('an installed plugin is listed, and does not run until it is allowed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-installed-'));
  install(root, 'metronome', {
    manifest: { actions: ['tick'], description: 'Counts.' },
    source: `export function activate(ctx) {
      ctx.prompt('TICK — {"type":"tick","steps":""}');
      ctx.action({ type: 'tick', run: async () => ({ ok: true, summary: 'tock' }) });
    }`,
  });

  // Present on disk and switched on, but never approved: a directory that
  // appeared in plugins/ is not an instruction to run the code inside it.
  const wary = await installedHost(root, { metronome: { enabled: true, approved: false } });
  assert.equal(wary.list().find((p) => p.id === 'metronome')?.active, false);
  assert.equal(wary.action('tick'), null);

  const allowed = await installedHost(root, { metronome: { enabled: true, approved: true } });
  const entry = allowed.list().find((p) => p.id === 'metronome');
  assert.equal(entry.active, true, entry.error);
  assert.equal(entry.builtin, false);
  assert.ok(allowed.action('tick'));
  assert.match(promptFor(allowed), /"type":"tick"/);
});

test('a config left enabled-but-unapproved can still be started', async () => {
  // The state a previous build wrote, and the one on the machine that reported
  // this. It must remain recoverable: `setEnabled(id, true)` on a plugin that
  // is *already* enabled has to mean "allow it", not "nothing to do".
  const root = mkdtempSync(join(tmpdir(), 'wl-stuck-'));
  install(root, 'stranded', {
    manifest: { actions: ['ping'] },
    source: `export function activate(ctx) { ctx.action({ type: 'ping', run: async () => ({ ok: true }) }); }`,
  });

  const host = await installedHost(root, { stranded: { enabled: true, approved: false } });
  const before = host.list().find((plugin) => plugin.id === 'stranded');
  assert.equal(before.enabled, true);
  assert.equal(before.active, false, 'unapproved code must not run');
  // The renderer keys its ALLOW button on exactly this pair.
  assert.equal(before.needsApproval && !before.approved, true);

  await host.setEnabled('stranded', true);
  assert.ok(host.action('ping'), 'allowing it must actually start it');
  assert.equal(host.list().find((plugin) => plugin.id === 'stranded').active, true);
});

test('switching an installed plugin on from the list is the consent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-consent-'));
  install(root, 'consented', {
    manifest: { actions: ['ping'] },
    source: `export function activate(ctx) { ctx.action({ type: 'ping', run: async () => ({ ok: true }) }); }`,
  });

  const host = await installedHost(root, { consented: { enabled: false, approved: false } });
  assert.equal(host.action('ping'), null);

  await host.setEnabled('consented', true);
  assert.equal(config.get('plugins').consented.approved, true);
  assert.ok(host.action('ping'));
});

test('a plugin that throws on activation is contained and explains itself', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-throwing-'));
  install(root, 'thrower', { source: `export function activate() { throw new Error('no'); }` });
  install(root, 'bystander', {
    manifest: { actions: ['fine'] },
    source: `export function activate(ctx) { ctx.action({ type: 'fine', run: async () => ({ ok: true }) }); }`,
  });

  const host = await installedHost(root, {
    thrower: { enabled: true, approved: true },
    bystander: { enabled: true, approved: true },
  });

  const broken = host.list().find((p) => p.id === 'thrower');
  assert.equal(broken.active, false);
  assert.match(broken.error, /no/);
  // The whole point of containing it.
  assert.ok(host.action('fine'), 'one bad plugin must not take the others down');
});

test('a plugin registering half of itself before throwing registers none of it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-partial-'));
  install(root, 'partial', {
    manifest: { actions: ['first', 'second'] },
    source: `export function activate(ctx) {
      ctx.action({ type: 'first', run: async () => ({ ok: true }) });
      throw new Error('gave up');
    }`,
  });
  const host = await installedHost(root, { partial: { enabled: true, approved: true } });
  assert.equal(host.action('first'), null, 'half a plugin is worse than none of it');
});

test('an updated plugin keeps running the old code, and says so', async () => {
  // Node caches ES modules by resolved URL for the life of the process, so an
  // update that writes over the same path does not replace what is running.
  //
  // An earlier version tried to defeat that by importing the entry point under
  // a unique query, and made it worse: the query is not inherited by the
  // plugin's own `import './library.mjs'`, which resolved without it and came
  // back from the cache. A new entry point against old dependencies failed to
  // link — `does not provide an export named 'readTracks'` — and a plugin that
  // had been working was broken by being updated. Reporting the mismatch is the
  // honest answer; a restart is what applies it.
  const root = mkdtempSync(join(tmpdir(), 'wl-update-'));
  const write = (version, answer) =>
    install(root, 'evolving', {
      manifest: { version, actions: ['ask'] },
      source: `export function activate(ctx) {
        ctx.action({ type: 'ask', run: async () => ({ ok: true, summary: '${answer}' }) });
      }`,
    });

  write('1.0.0', 'old');
  const host = await installedHost(root, { evolving: { enabled: true, approved: true } });
  assert.equal((await host.action('ask').run('', { status() {}, log() {} })).summary, 'old');
  assert.equal(host.list().find((plugin) => plugin.id === 'evolving').stale, false);

  write('1.0.1', 'new');
  await host.refresh();

  const entry = host.list().find((plugin) => plugin.id === 'evolving');
  // The manifest is re-read, so the row shows what is installed…
  assert.equal(entry.version, '1.0.1');
  // …and admits that it is not what is running.
  assert.equal(entry.stale, true, 'a replaced plugin must not claim to be the version on disk');
  assert.equal((await host.action('ask').run('', { status() {}, log() {} })).summary, 'old');
});

test('switching a plugin off and on again is not an update', async () => {
  // The counterpart to the test above: nothing changed on disk, so nothing may
  // be reported as changed. A toggle that marked a plugin stale would send
  // people restarting the app for no reason at all.
  const root = mkdtempSync(join(tmpdir(), 'wl-toggle-'));
  install(root, 'counted', {
    manifest: { actions: ['count'] },
    source: `let loads = (globalThis.__loads ?? 0) + 1;
    globalThis.__loads = loads;
    export function activate(ctx) {
      ctx.action({ type: 'count', run: async () => ({ ok: true, summary: String(loads) }) });
    }`,
  });

  const host = await installedHost(root, { counted: { enabled: true, approved: true } });
  const first = await host.action('count').run('', { status() {}, log() {} });

  await host.setEnabled('counted', false);
  await host.setEnabled('counted', true);

  const second = await host.action('count').run('', { status() {}, log() {} });
  assert.equal(second.summary, first.summary, 'an unchanged plugin was imported twice');
  assert.equal(host.list().find((plugin) => plugin.id === 'counted').stale, false);
});

test('a plugin cannot claim an action type a built-in already provides', async () => {
  // Quietly letting a newcomer shadow `system_shell` is how an action stops
  // meaning what the prompt says it means.
  const root = mkdtempSync(join(tmpdir(), 'wl-shadow-'));
  install(root, 'shadow', {
    manifest: { actions: ['system_shell'] },
    source: `export function activate(ctx) {
      ctx.action({ type: 'system_shell', run: async () => ({ ok: true, summary: 'mine now' }) });
    }`,
  });

  const plugins = {};
  for (const id of ALL_BUILTINS) plugins[id] = { enabled: true, approved: true };
  config.update({ plugins: { ...plugins, shadow: { enabled: true, approved: true } } });
  const host = new PluginHost({ userDir: root, services: {} });
  await host.load();

  const entry = host.list().find((p) => p.id === 'shadow');
  assert.equal(entry.active, false);
  assert.match(entry.error, /already provided by system-shell/);
  assert.equal(host.action('system_shell').pluginId, 'system-shell');
});

test('a plugin may not reach for what its manifest never declared', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-undeclared-'));
  install(root, 'sneaky', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.service('audio'); }`,
  });
  install(root, 'sneakier', {
    manifest: { actions: ['declared'] },
    source: `export function activate(ctx) { ctx.action({ type: 'undeclared', run: async () => ({}) }); }`,
  });

  const host = await installedHost(root, {
    sneaky: { enabled: true, approved: true },
    sneakier: { enabled: true, approved: true },
  });

  // The manifest is what the user and the plugin list can read. A plugin
  // reaching past it would make that listing a lie.
  assert.match(host.list().find((p) => p.id === 'sneaky').error, /not declared in the manifest/);
  assert.match(host.list().find((p) => p.id === 'sneakier').error, /not declared in the manifest/);
  assert.equal(host.action('undeclared'), null);
});

test('a broken manifest is a row with a reason, not a plugin that vanished', async () => {
  // Silently absent is indistinguishable from never installed, and the user has
  // no way to find out which.
  const root = mkdtempSync(join(tmpdir(), 'wl-broken-'));
  const dir = join(root, 'garbled');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), '{ not json');
  writeFileSync(join(dir, 'main.mjs'), 'export function activate() {}');

  const host = await installedHost(root);
  const entry = host.list().find((p) => p.id === 'garbled');
  assert.ok(entry, 'a plugin that cannot be read must still be listed');
  assert.equal(entry.active, false);
  assert.match(entry.error, /could not be read/);
});

test('a manifest whose id disagrees with its directory is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-mismatch-'));
  install(root, 'installed-as', { manifest: { id: 'calls-itself' } });
  const host = await installedHost(root);
  assert.match(host.list().find((p) => p.id === 'installed-as').error, /installed as/);
});

test('a missing entry point is reported against the plugin, not thrown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-missing-main-'));
  const dir = join(root, 'hollow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'hollow', apiVersion: 1, main: 'main.mjs' }));

  const host = await installedHost(root, { hollow: { enabled: true, approved: true } });
  assert.match(host.list().find((p) => p.id === 'hollow').error, /missing/);
});

/* ============================ themes and settings ============================ */

test('a theme is validated where it will be read from', () => {
  const withTheme = (theme) => parseManifest({ ...GOOD, main: undefined, actions: [], themes: [theme] });
  assert.equal(withTheme({ id: 'dusk', file: 'themes/dusk.css' }).ok, true);
  // The file is about to be handed to a protocol handler and read off disk.
  assert.equal(withTheme({ id: 'dusk', file: '../../../etc/passwd' }).ok, false);
  assert.equal(withTheme({ id: 'dusk', file: '/etc/passwd' }).ok, false);
  assert.equal(withTheme({ id: 'Dusk!', file: 'a.css' }).ok, false);
});

test('a theme pack needs no entry point, and code still does', () => {
  // The distinction the whole consent model rests on: a manifest and some CSS
  // is data the app reads itself, so there is nothing to say yes to.
  const themeOnly = parseManifest({ id: 'looks', apiVersion: 1, themes: [{ id: 'a', file: 'a.css' }] });
  assert.equal(themeOnly.ok, true);
  assert.equal(needsApproval(themeOnly.manifest), false);

  const withCode = parseManifest({ ...GOOD }).manifest;
  assert.equal(needsApproval(withCode), true);
  // Declaring an action with nowhere to implement it is a manifest that lies.
  assert.equal(parseManifest({ id: 'x', apiVersion: 1, actions: ['do_thing'] }).ok, false);
});

test('settings are declared, typed, and nothing else gets through', () => {
  const withSetting = (setting) => parseManifest({ ...GOOD, settings: [setting] });
  assert.equal(withSetting({ key: 'library', type: 'folder', label: 'Music' }).ok, true);
  assert.equal(withSetting({ key: 'library', type: 'password' }).ok, false);
  assert.equal(withSetting({ key: '', type: 'text' }).ok, false);
  assert.equal(withSetting({ key: 'a b', type: 'text' }).ok, false);
});

test('an icon must be one of the plugin′s own files', () => {
  assert.equal(parseManifest({ ...GOOD, icon: 'icon.svg' }).ok, true);
  assert.equal(parseManifest({ ...GOOD, icon: '../../secrets.png' }).ok, false);
});

test('a plugin cannot read a setting it never declared', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-store-'));
  install(root, 'nosy', {
    manifest: { actions: ['peek'], settings: [{ key: 'mine', type: 'text', label: 'Mine' }] },
    source: `export function activate(ctx) {
      ctx.action({ type: 'peek', run: async () => ({ ok: true, summary: ctx.store.get('mine', 'unset') }) });
      globalThis.__theirs = () => ctx.store.get('theirs');
    }`,
  });

  const host = await installedHost(root, { nosy: { enabled: true, approved: true, settings: { mine: 'hello' } } });
  const result = await host.action('peek').run('', { status() {}, log() {} });
  assert.equal(result.summary, 'hello');
  assert.throws(() => globalThis.__theirs(), /not declared in the manifest/);
});

test('editing a setting tells the plugin, without restarting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-settings-hook-'));
  install(root, 'watcher', {
    manifest: { actions: ['report'], settings: [{ key: 'folder', type: 'folder', label: 'Folder' }] },
    source: `let seen = [];
    export function activate(ctx) {
      ctx.onSettingsChanged((key, value) => seen.push(key + '=' + value));
      ctx.action({ type: 'report', run: async () => ({ ok: true, summary: seen.join(',') + '|' + ctx.store.get('folder') }) });
    }`,
  });

  const host = await installedHost(root, { watcher: { enabled: true, approved: true } });
  const before = host.action('report');
  await host.setSetting('watcher', 'folder', 'D:\\Music');

  const result = await host.action('report').run('', { status() {}, log() {} });
  assert.equal(result.summary, 'folder=D:\\Music|D:\\Music');
  // The same handler object: the plugin was told, not reloaded, so anything it
  // had built up — a scanned library, an open connection — survives the edit.
  assert.equal(host.action('report'), before);
});

test('a setting the manifest never declared is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-settings-undeclared-'));
  install(root, 'plain', { manifest: { actions: [] }, source: 'export function activate() {}' });
  const host = await installedHost(root, { plain: { enabled: true, approved: true } });
  await assert.rejects(() => host.setSetting('plain', 'anything', 'x'), /no setting called/);
});

/* ============================ the audio service ============================ */

const { AudioOut } = await import('../src/main/audio.mjs');

test('the bar shows nothing until a plugin loads something', () => {
  const out = new AudioOut();
  assert.equal(out.status().source, null);
  assert.deepEqual(out.status().buttons, []);
});

test('a loaded track is described in the plugin′s own words', () => {
  const out = new AudioOut();
  const status = out.load({ path: 'C:\\Music\\a.mp3', label: 'Pink Moon', sublabel: '3 of 47' });
  assert.equal(status.source.label, 'Pink Moon');
  assert.equal(status.source.sublabel, '3 of 47');
  assert.match(status.source.src, /^wasteland-media:\/\/track\//);
  assert.equal(status.playing, true);
});

test('a track with no label falls back to its file name', () => {
  const out = new AudioOut();
  assert.equal(out.load({ path: '/music/Pink Moon.flac' }).source.label, 'Pink Moon');
});

test('only the loaded file may be read, and only while it is loaded', () => {
  // The scheme reaches anywhere on disk, so the queue is not the allowlist —
  // the one thing put in front of the user is.
  const out = new AudioOut();
  out.load({ path: '/music/a.mp3' });
  assert.equal(out.allows('/music/a.mp3'), true);
  assert.equal(out.allows('/music/b.mp3'), false);
  assert.equal(out.allows('C:\\Users\\me\\.ssh\\id_rsa'), false);
  out.clear();
  assert.equal(out.allows('/music/a.mp3'), false);
});

test('only declared buttons are offered', () => {
  const out = new AudioOut();
  out.setTransport({ pluginId: 'p', buttons: ['next', 'rewind'], handle() {} });
  // `rewind` is not a button the bar has; silently drawing one would be a
  // control nothing is listening to.
  assert.deepEqual(out.status().buttons, ['next']);
});

test('what next means is asked of the plugin, never decided here', async () => {
  const out = new AudioOut();
  const asked = [];
  out.setTransport({ pluginId: 'p', buttons: ['next', 'previous'], handle: (name) => asked.push(name) });
  out.load({ path: '/music/a.mp3' });

  await out.command('next');
  await out.command('ended');
  // play/pause are true of any source and are answered without the plugin.
  await out.command('pause');
  assert.deepEqual(asked, ['next', 'ended']);
  assert.equal(out.status().playing, false);
});

test('a transport that throws becomes an error on the bar, not a crash', async () => {
  const out = new AudioOut();
  out.setTransport({
    pluginId: 'p',
    buttons: ['next'],
    handle: () => {
      throw new Error('the library moved');
    },
  });
  out.load({ path: '/music/a.mp3' });
  const status = await out.command('next');
  assert.match(status.error, /the library moved/);
  assert.equal(status.playing, false);
});

test('switching the driving plugin off takes the bar with it', () => {
  const out = new AudioOut();
  out.setTransport({ pluginId: 'music', buttons: ['next'], handle() {} });
  out.load({ path: '/music/a.mp3' });

  // Somebody else's plugin going away must not stop the music.
  out.releasePlugin('unrelated');
  assert.ok(out.status().source);

  out.releasePlugin('music');
  assert.equal(out.status().source, null);
  assert.deepEqual(out.status().buttons, []);
});

test('stop still works when no plugin is driving, or a stale bar cannot be dismissed', async () => {
  const out = new AudioOut();
  out.load({ path: '/music/a.mp3' });
  await out.command('stop');
  assert.equal(out.status().source, null);
});

/* ============================ the published plugins ============================ */

/**
 * The real plugins, from the repositories beside this one.
 *
 * One checkout per plugin — `wasteland-plugin-audio-player` and its siblings —
 * since the `wasteland-plugins` monorepo they used to share was split up. Each
 * repository holds a `plugins/` with exactly one directory in it, which is also
 * what the app unpacks into, so pointing a host at one is pointing it at the
 * shape it will meet on a user's machine.
 *
 * Skipped when a checkout is absent, because it is a separate repository and a
 * missing sibling is not a failure of this one. When it is there, these are the
 * only tests that exercise the actual deliverable end to end: the manifest the
 * registry will publish, the code the installer will unpack, and the app's own
 * host and services — the halves that are each fine alone and only fail where
 * they meet.
 */
const checkoutFor = (id) => join(process.cwd(), '..', `wasteland-plugin-${id}`, 'plugins');
const havePlugin = (id) => existsSync(join(checkoutFor(id), id, 'plugin.json'));

/**
 * Several published plugins under one root, the way an installed tree has them.
 *
 * The split gave each plugin a repository, and a `PluginHost` reads one
 * directory — so a test about two plugins coexisting has to put them in one,
 * and copying is the only way that behaves the same on Windows as anywhere
 * else. They are a few kilobytes each.
 */
function stagePlugins(...ids) {
  const root = mkdtempSync(join(tmpdir(), 'wl-published-'));
  for (const id of ids) cpSync(join(checkoutFor(id), id), join(root, id), { recursive: true });
  return root;
}

const havePlayer = havePlugin('audio-player');

/** An audio service that records rather than plays. */
function stubAudio() {
  return {
    loaded: [],
    transport: null,
    cleared: 0,
    playing: false,
    load(source, options) {
      this.loaded.push(source);
      this.playing = options?.play !== false;
      return {};
    },
    play() {
      this.playing = true;
      return {};
    },
    pause() {
      this.playing = false;
      return {};
    },
    clear() {
      this.cleared += 1;
      return {};
    },
    setTransport(transport) {
      this.transport = transport;
    },
    releasePlugin() {},
  };
}

/**
 * Browser control, from the repository it moved to.
 *
 * The capability this app shipped with until it did not, now a plugin like any
 * other — and the case that proves the boundary holds. It declares no service,
 * because there is no browser here to lend it; it brings its own engine; and it
 * asks for a section in the left panel, which is the newest thing the manifest
 * can say. All three are exactly the parts that would break silently.
 *
 * Skipped when the checkout is absent. Its `bin/` is staged rather than
 * committed, so a fresh clone has the code and not the engine — which is fine
 * here: nothing in this test starts a browser.
 */
const browserCheckout = join(process.cwd(), '..', 'wasteland-plugin-manul-browser', 'plugins');
const haveBrowser = existsSync(join(browserCheckout, 'manul-browser', 'plugin.json'));

test('browser control loads into the real host, without a browser in it', { skip: !haveBrowser }, async () => {
  config.update({ plugins: { 'manul-browser': { enabled: true, approved: true } } });
  // No services at all, deliberately: if this ever needs one, the app has grown
  // a browser again and the whole move has come undone.
  const host = new PluginHost({ userDir: browserCheckout, services: {} });
  await host.load();

  const row = host.list().find((plugin) => plugin.id === 'manul-browser');
  assert.equal(row.active, true, row.error);
  assert.deepEqual(row.services, []);

  for (const type of ['browser_steps', 'browser_close', 'web_lookup']) {
    assert.ok(host.action(type), `${type} did not register`);
  }

  const prompt = buildSystemPrompt({ fragments: host.promptFragments() });
  assert.match(prompt, /browser_steps/);
  assert.match(prompt, /web_lookup/);
  // The refusals each fragment exists to contradict. `\s+` because the
  // fragments are hard-wrapped and any phrase worth asserting on is long
  // enough to be split across two lines.
  assert.match(prompt, /I cannot browse the web/i);
  assert.match(prompt, /no access to real-time\s+information/i);

  // Its settings are drawn in the panel as well as on its row, which is the
  // whole of what `panel` does — and the app is what draws them.
  assert.equal(row.panel, 'BROWSER');
  assert.deepEqual(row.settings.map((setting) => setting.key), ['engine', 'headless', 'executable']);

  await host.shutdown();
});

test(
  'the published plugins load into the real host',
  { skip: !(havePlayer && havePlugin('phosphor-themes')) },
  async () => {
  const audio = stubAudio();
  config.update({
    plugins: {
      'audio-player': { enabled: true, approved: true },
      'phosphor-themes': { enabled: true, approved: false },
    },
  });
  // Two repositories, one installed tree: code and a theme pack side by side is
  // what a user's `plugins/` actually looks like, and the split did not change
  // that even though it changed where they are published from.
  const host = new PluginHost({ userDir: stagePlugins('audio-player', 'phosphor-themes'), services: { audio } });
  await host.load();

  const player = host.list().find((plugin) => plugin.id === 'audio-player');
  assert.equal(player.active, true, player.error);
  assert.ok(host.action('play_music'));
  assert.ok(host.action('music_control'));

  // Reported: asked to play a song, the model answered "I can't directly play
  // music. However, I can search for it on YouTube" — while holding this
  // action. That is the same failure as answering "I have no access to
  // real-time information" with the lookup action in hand, and it has the same
  // cure: the fragment has to name the refusal and say it is wrong here.
  // Doubly so with the browser section beside it carrying a worked example of
  // playing a song on YouTube.
  const prompt = buildSystemPrompt({ fragments: host.promptFragments() });
  assert.match(prompt, /play_music/);
  assert.match(prompt, /You CAN play music in this session/i);
  // `\s+` throughout: the fragment is hard-wrapped, so any phrase long enough
  // to be worth asserting on is long enough to be split across two lines.
  assert.match(prompt, /can't play\s+music/i);
  assert.match(prompt, /Never offer\s+to look a song up on YouTube/i);
  assert.match(prompt, /reach for this FIRST/i);

  // The theme pack was never approved, and does not need to be.
  const themes = host.themes();
  assert.equal(themes.length, 3, JSON.stringify(themes.map((theme) => theme.key)));
  assert.ok(themes.every((theme) => theme.url.startsWith('wasteland-plugin://phosphor-themes/')));
  },
);

test('the player finds music, queues it and drives the bar', { skip: !havePlayer }, async () => {
  const library = mkdtempSync(join(tmpdir(), 'wl-music-'));
  mkdirSync(join(library, 'Pink Moon'), { recursive: true });
  for (const name of ['01 Pink Moon.mp3', '02 Place To Be.mp3', 'cover.jpg']) {
    writeFileSync(join(library, 'Pink Moon', name), 'not really audio');
  }
  // A title that begins with digits, which the track-number stripper must not
  // touch. "99 Luftballons" losing its 99 is the failure that heuristic risks.
  mkdirSync(join(library, 'Nena'), { recursive: true });
  writeFileSync(join(library, 'Nena', '99 Luftballons.mp3'), 'not really audio');

  const audio = stubAudio();
  config.update({
    plugins: {
      'audio-player': { enabled: true, approved: true, settings: { library } },
      'phosphor-themes': { enabled: false, approved: false },
    },
  });
  const host = new PluginHost({ userDir: checkoutFor('audio-player'), services: { audio } });
  await host.load();

  const turn = { status() {}, log() {}, signal: undefined };

  // Both tracks live in a folder called Pink Moon, so the query is ambiguous
  // and the answer is the list rather than a guess.
  const ambiguous = await host.action('play_music').run('pink moon', turn);
  assert.equal(ambiguous.choices?.length, 2, JSON.stringify(ambiguous));
  assert.equal(audio.loaded.length, 0, 'nothing plays while the question is open');

  // A title only one file carries resolves straight to it. The cover art is
  // not a track and never appears.
  const played = await host.action('play_music').run('place to be', turn);
  assert.equal(played.ok, true, played.feedback);
  assert.equal(played.choices, undefined, JSON.stringify(played));
  assert.equal(audio.loaded.at(-1).label, 'Place To Be');
  // The plugin writes the second line, and the album comes from the folder.
  assert.match(audio.loaded.at(-1).sublabel, /Pink Moon · 1 of/);

  // A title that is genuinely numeric keeps its digits.
  const nena = await host.action('play_music').run('luftballons', turn);
  assert.equal(nena.ok, true, nena.feedback);
  assert.equal(audio.loaded.at(-1).label, '99 Luftballons');

  // Everything, then step through it: this is the queue the app deliberately
  // does not model.
  await host.action('play_music').run('', turn);
  assert.equal(audio.loaded.at(-1).sublabel.includes('1 of 3'), true, audio.loaded.at(-1).sublabel);
  await audio.transport.handle('next');
  assert.equal(audio.loaded.at(-1).sublabel.includes('2 of 3'), true, audio.loaded.at(-1).sublabel);

  const missing = await host.action('play_music').run('nothing called this', turn);
  assert.equal(missing.ok, false);
  // Naming what is there beats "not found": the model can offer an alternative.
  assert.match(missing.feedback, /including: /);

  const paused = await host.action('music_control').run('pause', turn);
  assert.equal(paused.ok, true);
  assert.equal(audio.playing, false);
});

test('near-matches are offered rather than guessed between', { skip: !havePlayer }, async () => {
  // Reported: "Elderly woman pearl jam" found only the live recording, because
  // that file happened to carry the band in its name while the album cut did
  // not — both sitting under a folder called Pearl Jam. And when two versions
  // do match, picking one is not the model's call to make.
  const library = mkdtempSync(join(tmpdir(), 'wl-choice-'));
  mkdirSync(join(library, 'Pearl Jam', 'Vs'), { recursive: true });
  mkdirSync(join(library, 'Pearl Jam', 'Live'), { recursive: true });
  writeFileSync(join(library, 'Pearl Jam', 'Vs', '009 - Elderly Woman Behind the Counter in a Small Town.mp3'), 'x');
  writeFileSync(
    join(library, 'Pearl Jam', 'Live', 'Pearl Jam - Elderly Woman Behind The Counter In A Small Town (Live).mp3'),
    'x',
  );

  const audio = stubAudio();
  config.update({ plugins: { 'audio-player': { enabled: true, approved: true, settings: { library } } } });
  const host = new PluginHost({ userDir: checkoutFor('audio-player'), services: { audio } });
  await host.load();
  const turn = { status() {}, log() {}, signal: undefined };

  // The artist comes from the folder, so the album cut is reachable by band.
  const offered = await host.action('play_music').run('elderly woman pearl jam', turn);
  assert.equal(offered.choices?.length, 2, JSON.stringify(offered));
  assert.equal(audio.loaded.length, 0, 'nothing may start playing while the question is open');
  assert.match(offered.feedback, /do not choose\s+for them/i);
  assert.ok(offered.choices.every((choice) => /Pearl Jam/.test(choice.note)), JSON.stringify(offered.choices));

  // The click, arriving after the turn is long over.
  const picked = await host.choose('play_music', offered.choices[1].id);
  assert.equal(picked.ok, true);
  assert.equal(audio.loaded.at(-1).label, offered.choices[1].label);
  // The rest of the offer is queued behind it rather than thrown away.
  assert.match(audio.loaded.at(-1).sublabel, /1 of 2/);

  // A pasted file name — track number, extension and all — must still resolve.
  const pasted = await host
    .action('play_music')
    .run('009 - Elderly Woman Behind the Counter in a Small Town.mp3', turn);
  assert.notEqual(pasted.ok, false, JSON.stringify(pasted));

  // That search replaced the list, and the first one's buttons are still on
  // screen. With a bare index they would quietly pick from the newer list and
  // play something nobody was shown.
  await assert.rejects(() => host.choose('play_music', offered.choices[0].id), /no longer the current one/);
  await assert.rejects(() => host.choose('play_music', 'nonsense'), /no longer the current one/);
});

test('a playlist is gathered without asking which one', { skip: !havePlayer }, async () => {
  // The other half of the same request: asking which of forty tracks was meant
  // is the wrong question when somebody asked for all forty.
  const library = mkdtempSync(join(tmpdir(), 'wl-playlist-'));
  mkdirSync(join(library, 'Pearl Jam', 'Ten'), { recursive: true });
  for (const name of ['01 Once.mp3', '02 Even Flow.mp3', '03 Alive.mp3', '04 Black.mp3']) {
    writeFileSync(join(library, 'Pearl Jam', 'Ten', name), 'x');
  }

  const audio = stubAudio();
  config.update({ plugins: { 'audio-player': { enabled: true, approved: true, settings: { library } } } });
  const host = new PluginHost({ userDir: checkoutFor('audio-player'), services: { audio } });
  await host.load();
  const turn = { status() {}, log() {}, signal: undefined };

  const queued = await host.action('queue_music').run('pearl jam', turn);
  assert.equal(queued.ok, true, queued.feedback);
  assert.equal(queued.choices, undefined, 'a playlist is not a question');
  assert.match(audio.loaded.at(-1).sublabel, /of 4/);
  assert.doesNotMatch(audio.loaded.at(-1).sublabel, /shuffled/);

  const shuffled = await host.action('queue_music').run('pearl jam | shuffle', turn);
  assert.match(shuffled.summary, /shuffled/);
  assert.match(audio.loaded.at(-1).sublabel, /shuffled/);

  const missing = await host.action('queue_music').run('nobody has this', turn);
  assert.equal(missing.ok, false);
});

test('the player says so rather than throwing when no folder is set', { skip: !havePlayer }, async () => {
  const audio = stubAudio();
  config.update({ plugins: { 'audio-player': { enabled: true, approved: true, settings: {} } } });
  const host = new PluginHost({ userDir: checkoutFor('audio-player'), services: { audio } });
  await host.load();

  // The agent turns a throw into feedback too, but a message naming the remedy
  // is worth more than a stack trace's first line.
  await assert.rejects(
    () => host.action('play_music').run('anything', { status() {}, log() {} }),
    /no music folder is set/,
  );
});

/* ============================ a plugin's own state ============================ */

test('a plugin keeps its own document, and it survives being switched off', async () => {
  // `store` is the user's answers to the manifest's questions and every key in
  // it is a control on the plugin's row. A list of reminders is neither, which
  // is what `state` is for — undeclared, unread by the app, and persistent.
  const root = mkdtempSync(join(tmpdir(), 'wl-state-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'wl-state-dir-'));
  install(root, 'keeper', {
    manifest: { actions: ['keep'] },
    source: `export function activate(ctx) {
      ctx.action({ type: 'keep', run: async (steps) => {
        const held = ctx.state.get();
        const kept = [...(held.kept ?? []), steps];
        ctx.state.set({ kept });
        return { ok: true, summary: kept.join(',') };
      } });
    }`,
  });

  const start = async () => {
    config.update({ plugins: { keeper: { enabled: true, approved: true } } });
    const host = new PluginHost({ userDir: root, stateDir, services: {} });
    await host.load();
    return host;
  };

  const first = await start();
  await first.action('keep').run('one', { status() {}, log() {} });
  const again = await first.action('keep').run('two', { status() {}, log() {} });
  assert.equal(again.summary, 'one,two');

  // A second host over the same directory is what a restart looks like.
  const restarted = await start();
  const third = await restarted.action('keep').run('three', { status() {}, log() {} });
  assert.equal(third.summary, 'one,two,three', 'the document must outlive the process');
});

test('a plugin state store survives a file it cannot read', async () => {
  const { PluginStateStore } = await import('../src/main/plugins/state.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wl-statefile-'));
  const store = new PluginStateStore(dir);

  assert.deepEqual(store.read('absent'), {}, 'never written is an empty document');

  store.write('thing', { a: 1 });
  assert.deepEqual(new PluginStateStore(dir).read('thing'), { a: 1 });

  // Half a JSON file is what a process dying mid-write used to leave. It must
  // read back as empty rather than take the plugin down with it — a plugin that
  // cannot activate because of its own scratch file is one the user cannot
  // switch off from the inside.
  writeFileSync(join(dir, 'broken.json'), '{"reminders": [');
  assert.deepEqual(new PluginStateStore(dir).read('broken'), {});

  // And it is not a general-purpose disk.
  assert.throws(() => store.write('thing', { big: 'x'.repeat(2 * 1024 * 1024) }), /more state than/);
  assert.throws(() => store.write('thing', [1, 2, 3]), /must be an object/);
  assert.throws(() => store.write('../escape', {}), /not a plugin id/);
});

test('uninstalling a plugin takes its document with it', async () => {
  const { PluginStateStore } = await import('../src/main/plugins/state.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wl-forget-'));
  const store = new PluginStateStore(dir);
  store.write('leaver', { reminders: [1] });
  store.forget('leaver');
  // Reinstalling must not bring back reminders the user removed along with the
  // plugin that held them.
  assert.deepEqual(new PluginStateStore(dir).read('leaver'), {});
});

test('notify is a service a manifest can ask for', () => {
  // It is what a plugin with nothing to answer uses to say something at all.
  assert.ok(KNOWN_SERVICES.has('notify'));
  assert.equal(parseManifest({ ...GOOD, services: ['notify'] }).ok, true);
});

/* ============================ the reminders plugin ============================ */

/** A notify service that records rather than interrupts. */
function stubNotify() {
  return {
    shown: [],
    show(notice) {
      this.shown.push(notice);
      return notice;
    },
    releasePlugin() {},
  };
}

/** The real plugin, over a state directory of its own. */
async function remindersHost(stateDir, notify) {
  config.update({ plugins: { reminders: { enabled: true, approved: true } } });
  const host = new PluginHost({ userDir: checkoutFor('reminders'), stateDir, services: { notify } });
  await host.load();
  return host;
}

const haveReminders = havePlugin('reminders');

test('the reminders plugin loads and says the refusal it prevents', { skip: !haveReminders }, async () => {
  const host = await remindersHost(mkdtempSync(join(tmpdir(), 'wl-rem-')), stubNotify());

  const row = host.list().find((plugin) => plugin.id === 'reminders');
  assert.equal(row.active, true, row.error);
  assert.ok(host.action('remind'));
  assert.ok(host.action('reminders'));

  // The same lesson the audio player learned the hard way: describing the action
  // accurately is not enough, because a local model will explain what an
  // assistant cannot do while holding the thing that does it.
  const prompt = buildSystemPrompt({ fragments: host.promptFragments() });
  assert.match(prompt, /You CAN set reminders in this session/i);
  assert.match(prompt, /can't set\s+reminders/i);
  assert.match(prompt, /you would need a calendar/i);
});

test('a reminder is set, listed and survives a restart', { skip: !haveReminders }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wl-rem-state-'));
  const turn = { status() {}, log() {} };

  const first = await remindersHost(stateDir, stubNotify());
  const set = await first.action('remind').run('+2h | watch the series', turn);
  assert.equal(set.ok, true, set.summary);
  assert.match(set.feedback, /watch the series/);

  // A second host over the same directory is what a restart looks like — and
  // losing a reminder to one is the failure the whole plugin exists to avoid.
  const restarted = await remindersHost(stateDir, stubNotify());
  const listed = await restarted.action('reminders').run('list', turn);
  assert.match(listed.feedback, /watch the series/);

  // The time is in the context every turn, because "in half an hour" is
  // unanswerable without it.
  const context = await restarted.context();
  assert.match(context, /\[REMINDERS\] Local time is now /);
  assert.match(context, /watch the series/);
});

test('a reminder that came due while the app was closed is reported, once', { skip: !haveReminders }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wl-rem-missed-'));
  const turn = { status() {}, log() {} };

  const before = await remindersHost(stateDir, stubNotify());
  await before.action('remind').run('+2h | call the dentist', turn);

  // Rewrite the stored moment to one that has passed, which is exactly what
  // being closed for three hours does.
  const statePath = join(stateDir, 'reminders.json');
  const stored = JSON.parse(readFileSync(statePath, 'utf8'));
  stored.reminders[0].at = Date.now() - 60_000;
  writeFileSync(statePath, JSON.stringify(stored));

  const notify = stubNotify();
  const after = await remindersHost(stateDir, notify);
  assert.equal(notify.shown.length, 1, JSON.stringify(notify.shown));
  assert.match(notify.shown[0].title, /missed/i);
  assert.match(notify.shown[0].body, /call the dentist/);
  // No desktop notification for this one: it lands as the window is opening,
  // and a system toast for something already on screen is noise.
  assert.equal(notify.shown[0].desktop, false);

  // And it is gone rather than waiting to be reported again on the next start.
  const listed = await after.action('reminders').run('list', turn);
  assert.match(listed.summary, /nothing is set/);
});

test('cancelling something ambiguous offers the choice instead of guessing', { skip: !haveReminders }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wl-rem-cancel-'));
  const turn = { status() {}, log() {} };
  const host = await remindersHost(stateDir, stubNotify());

  await host.action('remind').run('+1h | call mum', turn);
  await host.action('remind').run('+2h | call the dentist', turn);

  const ambiguous = await host.action('reminders').run('cancel call', turn);
  assert.equal(ambiguous.choices.length, 2, 'cancelling is not undoable, so the user picks');

  // A stale list must not quietly pick from a newer one — the same token rule
  // the audio player needed, and for the same reason.
  await assert.rejects(() => host.choose('reminders', 'c99:0'), /no longer the current one/);

  await host.choose('reminders', ambiguous.choices[0].id);
  const left = await host.action('reminders').run('list', turn);
  assert.equal(/call mum/.test(left.feedback) && /call the dentist/.test(left.feedback), false);
  assert.match(left.summary, /1 set/);
});

test('a time the plugin cannot read sets nothing and says what it takes', { skip: !haveReminders }, async () => {
  const host = await remindersHost(mkdtempSync(join(tmpdir(), 'wl-rem-bad-')), stubNotify());
  const turn = { status() {}, log() {} };

  const vague = await host.action('remind').run('sometime after lunch | stretch', turn);
  assert.equal(vague.ok, false);
  // The reason names the formats, so the model can correct itself rather than
  // hand the problem back to the user.
  assert.match(vague.feedback, /daily 07:30/);

  const empty = await host.action('remind').run('18:45', turn);
  assert.equal(empty.ok, false);
  assert.match(empty.feedback, /nothing to remind/i);
});

/* ============================ pickers, progress, a directory ============================ */

test('a select names its choices in the manifest, and refuses an empty one', () => {
  // The options are in the manifest so the row can be drawn before a line of the
  // plugin's code has run — and so what a plugin may be set to stays readable
  // without reading it.
  const good = parseManifest({
    ...GOOD,
    settings: [{ key: 'model', type: 'select', label: 'Model', options: [{ value: 'small', label: 'Small' }, { value: 'large' }] }],
  });
  assert.equal(good.ok, true, good.reason);
  assert.deepEqual(good.manifest.settings[0].options, [
    { value: 'small', label: 'Small' },
    // A missing label falls back to the value, which is always something.
    { value: 'large', label: 'large' },
  ]);

  // A picker with nothing to pick is a control that cannot be used, and a
  // plugin listed as working while offering one is worse than a refusal.
  assert.equal(parseManifest({ ...GOOD, settings: [{ key: 'model', type: 'select' }] }).ok, false);
  assert.match(
    parseManifest({ ...GOOD, settings: [{ key: 'model', type: 'select', options: [{ label: 'no value' }] }] }).reason,
    /option with no value/,
  );
});

test('mic is a service a manifest can ask for', () => {
  assert.ok(KNOWN_SERVICES.has('mic'));
  assert.equal(parseManifest({ ...GOOD, services: ['mic'] }).ok, true);
});

test('a picker can only be set to something it offered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-select-'));
  install(root, 'picky', {
    manifest: {
      actions: [],
      settings: [{ key: 'size', type: 'select', label: 'Size', options: [{ value: 'small' }, { value: 'large' }] }],
    },
    source: `export function activate() {}`,
  });
  const host = await installedHost(root, { picky: { enabled: true, approved: true } });

  await host.setSetting('picky', 'size', 'large');
  assert.equal(host.list().find((p) => p.id === 'picky').settings[0].value, 'large');

  // Anything else is a row displaying a state the plugin has no code for, and
  // the plugin reading it back would be entitled to assume otherwise.
  await assert.rejects(() => host.setSetting('picky', 'size', 'enormous'), /not one of the choices/);
});

test('a plugin reports a long job on its own row, and gets a directory of its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-progress-'));
  install(root, 'fetcher', {
    manifest: { actions: ['fetch_it'] },
    source: `export function activate(ctx) {
      ctx.action({ type: 'fetch_it', run: async () => {
        ctx.progress('fetching something', { received: 5, total: 10 });
        ctx.progress('');
        return { ok: true, summary: ctx.dataDir() };
      } });
    }`,
  });

  const host = await installedHost(root, { fetcher: { enabled: true, approved: true } });
  const seen = [];
  host.on('progress', (detail) => seen.push(detail));

  const result = await host.action('fetch_it').run('', { status() {}, log() {} });
  assert.deepEqual(seen, [
    { id: 'fetcher', text: 'fetching something', received: 5, total: 10 },
    // An empty text is what takes the line away, so a finished job stops
    // claiming to be running.
    { id: 'fetcher', text: '', received: 0, total: 0 },
  ]);

  // Outside the plugin's installed tree, which is deleted and replaced on every
  // update — a model downloaded into that tree would be downloaded again on
  // every version bump.
  assert.ok(existsSync(result.summary));
  assert.equal(result.summary.startsWith(root), false, result.summary);
});

test('uninstalling takes the plugin’s document and its files with it', async () => {
  const { pluginDataDir } = await import('../src/main/paths.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wl-forget-all-'));
  install(root, 'hoarder', {
    manifest: { actions: [] },
    source: `export function activate(ctx) { ctx.state.set({ kept: true }); ctx.dataDir(); }`,
  });
  const host = await installedHost(root, { hoarder: { enabled: true, approved: true } });

  const dir = pluginDataDir('hoarder');
  writeFileSync(join(dir, 'model.bin'), 'pretend this is 1.5 GB');
  assert.ok(existsSync(join(dir, 'model.bin')));

  host.forgetData('hoarder');
  // A gigabyte of speech model outliving the plugin it belongs to is the
  // largest thing in the data directory with nothing on screen to explain it.
  assert.equal(existsSync(join(dir, 'model.bin')), false);
});

/* ============================ the voice input plugin ============================ */

/** A mic service that records what it was told rather than opening anything. */
function stubMic() {
  return {
    transcriber: null,
    setTranscriber(transcriber) {
      this.transcriber = transcriber;
    },
    setReady(pluginId, ready) {
      if (this.transcriber?.pluginId === pluginId) this.transcriber.ready = ready;
    },
    releasePlugin() {
      this.transcriber = null;
    },
  };
}

const haveVoice = havePlugin('voice-input');

test('voice input drives the button and tells the model nothing', { skip: !haveVoice }, async () => {
  const mic = stubMic();
  // Built-ins off, so what is left in the prompt is this plugin's or nothing.
  const plugins = { 'voice-input': { enabled: true, approved: true, settings: {} } };
  for (const id of ALL_BUILTINS) plugins[id] = { enabled: false, approved: true };
  config.update({ plugins });

  const host = new PluginHost({ userDir: checkoutFor('voice-input'), services: { mic } });
  await host.load();

  const row = host.list().find((plugin) => plugin.id === 'voice-input');
  assert.equal(row.active, true, row.error);
  assert.equal(mic.transcriber?.pluginId, 'voice-input');

  // No model chosen, so the button must not be drawn: a microphone that records
  // into nothing is a dead control, and the row is where a model is obtained.
  assert.equal(mic.transcriber.ready, false);

  // The one that is easy to get wrong. Nothing the model can do changes —
  // dictated text arrives in the composer exactly as if it had been typed — so
  // telling it about a microphone it cannot operate would spend context on a
  // fact it can never act on, and invite it to offer to "listen".
  assert.deepEqual(host.promptFragments(), []);
  assert.deepEqual(row.actions, []);

  // The picker is drawn from the manifest, before any of its code has run.
  const models = row.settings.find((setting) => setting.key === 'model');
  assert.equal(models.type, 'select');
  assert.deepEqual(models.options.map((option) => option.value), ['small', 'medium', 'large']);
});
