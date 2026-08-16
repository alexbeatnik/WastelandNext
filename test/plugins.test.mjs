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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { pageMapContext } from '../src/plugins/browser-control.mjs';

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
  const result = parseManifest({ ...GOOD, services: ['browser', 'filesystem'] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /filesystem/);
});

test('an unusable action type is refused', () => {
  assert.equal(parseManifest({ ...GOOD, actions: ['Do Thing'] }).ok, false);
  assert.equal(parseManifest({ ...GOOD, actions: ['do_thing', 'do_2'] }).ok, true);
});

/* ============================ enablement ============================ */

const BROWSER_MANIFEST = { id: 'browser-control', legacy: ['browserEnabled', 'allowBrowser'], enabledByDefault: true };
const SHELL_MANIFEST = { id: 'system-shell', legacy: ['allowShell'], enabledByDefault: false };

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
  const builtin = mergeEnablement({}, [{ ...BROWSER_MANIFEST, builtin: true, main: '' }], {});
  assert.equal(builtin['browser-control'].enabled, true);
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

/** A browser that answers without a Chrome anywhere near it. */
function stubBrowser({ open = false, map = null } = {}) {
  return {
    open,
    steps: [],
    closed: 0,
    async runSteps(dsl) {
      this.steps.push(dsl);
      return dsl.split('\n').map((step) => ({ ok: true, step, url: 'https://a.test' }));
    },
    async pageMap() {
      return map;
    },
    async readText() {
      return 'the answer is 42';
    },
    async close() {
      this.closed += 1;
    },
  };
}

const ALL_BUILTINS = ['browser-control', 'web-lookup', 'read-file', 'system-shell'];

/** A host with exactly the named built-ins switched on. */
async function hostWith(enabledIds, services = {}) {
  const plugins = {};
  for (const id of ALL_BUILTINS) plugins[id] = { enabled: enabledIds.includes(id), approved: true };
  config.update({ plugins });

  const host = new PluginHost({
    userDir: mkdtempSync(join(tmpdir(), 'wl-userplugins-')),
    services: { browser: stubBrowser(), lookupBrowser: stubBrowser(), ...services },
  });
  await host.load();
  return host;
}

const promptFor = (host) => buildSystemPrompt({ fragments: host.promptFragments() });

test('the four built-ins are discovered', async () => {
  const host = await hostWith(ALL_BUILTINS);
  assert.deepEqual(host.list().map((p) => p.id), ALL_BUILTINS);
  assert.ok(host.list().every((p) => p.builtin && p.active && !p.error), JSON.stringify(host.list()));
});

test('every capability on documents every action type', async () => {
  const prompt = promptFor(await hostWith(ALL_BUILTINS));
  for (const type of ['browser_steps', 'browser_close', 'web_lookup', 'read_file', 'system_shell']) {
    assert.match(prompt, new RegExp(type), `${type} should be documented`);
  }
});

test('a disabled plugin is absent from the prompt, not forbidden in it', async () => {
  const prompt = promptFor(await hostWith(['browser-control']));
  assert.match(prompt, /browser_steps/);
  assert.doesNotMatch(prompt, /system_shell/);
  assert.doesNotMatch(prompt, /read_file/);
  assert.doesNotMatch(prompt, /web_lookup/);
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
  const host = await hostWith(['browser-control', 'read-file']);
  const prompt = promptFor(host);
  for (const type of ['browser_steps', 'browser_close', 'read_file']) {
    assert.ok(host.action(type), `${type} is documented but not dispatchable`);
    assert.match(prompt, new RegExp(type));
  }
  for (const type of ['web_lookup', 'system_shell']) {
    assert.equal(host.action(type), null, `${type} is dispatchable but not documented`);
  }
});

test('a switched-off action is still known, so it can be refused in words', async () => {
  // "Unknown action type" makes a model retry with different spelling; "browser
  // control is switched off" makes it tell the user. The manifest is what lets
  // the app say the second without loading the plugin.
  const host = await hostWith([]);
  assert.equal(host.owner('browser_steps')?.name, 'Browser control');
  assert.equal(host.owner('system_shell')?.name, 'Shell commands');
  assert.equal(host.owner('teleport'), null);
});

test('lookup is reached for before a refusal, and none of it survives without lookup', async () => {
  // The reported session: "what is today's date" answered with "I have no
  // access to real-time information", two messages after the same model used
  // the lookup action for the weather.
  const on = promptFor(await hostWith(['web-lookup']));
  assert.match(on, /BEFORE saying you do not know/i);
  assert.match(on, /today's date/i);
  assert.match(on, /no access to real-time information/i);
  assert.match(on, /do not fill the gap from\s+memory/i);

  const off = promptFor(await hostWith(['browser-control', 'read-file', 'system-shell']));
  assert.doesNotMatch(off, /BEFORE saying you do not know/i);
  assert.doesNotMatch(off, /no access to real-time information/i);
});

test('the browser section keeps its hard-won paragraphs', async () => {
  const prompt = promptFor(await hostWith(['browser-control']));
  // The two-turn search flow: "never use positional targets" with no recipe for
  // an unknown title left the model stuck between guessing and refusing.
  assert.match(prompt, /TWO turns/);
  assert.match(prompt, /search_query=/);
  assert.match(prompt, /CLICK the 'Exact Title As Listed'/);
  // A resolved step is not a reached goal — this is what let one model loop
  // five times on a sort that never applied.
  assert.match(prompt, /does NOT mean the page did what you wanted/i);
  assert.match(prompt, /check CURRENT PAGE/i);
  // And a route out of a stuck interaction.
  assert.match(prompt, /do not send the same steps again/i);
  assert.match(prompt, /query parameters/i);
  assert.match(prompt, /will be refused/i);
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
  await host.setEnabled('browser-control', false);
  assert.equal(host.action('browser_steps'), null);
  assert.ok(host.action('read_file'));
  assert.ok(host.action('web_lookup'));
});

test('the decision is persisted, not merely held in memory', async () => {
  const host = await hostWith(ALL_BUILTINS);
  await host.setEnabled('read-file', false);
  assert.equal(config.get('plugins')['read-file'].enabled, false);
});

/* ============================ context and turns ============================ */

test('a plugin contributes turn context, with its own heading', async () => {
  const browser = stubBrowser({
    open: true,
    map: { url: 'https://a.test', groups: [{ name: 'Main', elements: [{ label: 'Sign in' }], truncated: 0 }] },
  });
  const host = await hostWith(['browser-control'], { browser });

  const context = await host.context();
  assert.match(context, /CURRENT PAGE/);
  assert.match(context, /'Sign in'/);
});

test('a closed browser contributes nothing rather than an empty heading', async () => {
  const host = await hostWith(['browser-control'], { browser: stubBrowser({ open: false }) });
  assert.equal(await host.context(), '');
});

test('a context provider that throws does not cost the turn its prompt', async () => {
  const browser = stubBrowser({ open: true });
  browser.pageMap = async () => {
    throw new Error('the engine died');
  };
  const host = await hostWith(['browser-control'], { browser });
  assert.equal(await host.context(), '');
});

test('the repeat guard is rearmed once per turn, not once per batch', async () => {
  const browser = stubBrowser({ open: true });
  const host = await hostWith(['browser-control'], { browser });
  const turn = { signal: undefined, status() {}, log() {}, confirm: async () => true };
  const steps = 'CLICK the \'Buy\' button';

  host.beginTurn();
  const first = await host.action('browser_steps').run(steps, turn);
  assert.equal(first.ok, true);

  // The same batch again inside one turn cannot produce a different result.
  const repeat = await host.action('browser_steps').run(steps, turn);
  assert.equal(repeat.ok, false);
  // A bare refusal tends to produce the same batch again, apologetically, so
  // the guard names a way forward rather than just saying no.
  assert.match(repeat.feedback, /already ran exactly these steps/i);
  assert.match(repeat.feedback, /Try a different route/i);

  // A new turn is a new question, and the user may well have asked for it again.
  host.beginTurn();
  const later = await host.action('browser_steps').run(steps, turn);
  assert.equal(later.ok, true);
});

test('a lookup closes its own browser and never touches the visible one', async () => {
  const visible = stubBrowser({ open: true });
  const lookupBrowser = stubBrowser();
  const host = await hostWith(['web-lookup'], { browser: visible, lookupBrowser });

  const result = await host.action('web_lookup').run('current weather', { status() {}, log() {} });
  assert.equal(result.ok, true);
  assert.match(result.feedback, /42/);
  assert.equal(lookupBrowser.closed, 1, 'the headless browser must not be left holding memory');
  assert.equal(visible.steps.length, 0, 'a lookup must never disturb the page the user is looking at');
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

  const host = new PluginHost({ userDir: root, services: { browser: stubBrowser(), lookupBrowser: stubBrowser() } });
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
  const host = new PluginHost({ userDir: root, services: { browser: stubBrowser(), lookupBrowser: stubBrowser() } });
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
    source: `export function activate(ctx) { ctx.service('browser'); }`,
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
 * The real `audio-player`, from the plugins repository beside this one.
 *
 * Skipped when that checkout is absent, because it is a separate repository and
 * a missing sibling is not a failure of this one. When it is there, this is the
 * only test that exercises the actual deliverable end to end: the manifest the
 * registry will publish, the code the installer will unpack, and the app's own
 * host and audio service — the three halves that are each fine on their own and
 * only fail where they meet.
 */
const pluginsCheckout = join(process.cwd(), '..', 'wasteland-plugins', 'plugins');
const havePlugins = existsSync(join(pluginsCheckout, 'audio-player', 'plugin.json'));

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

test('the published plugins load into the real host', { skip: !havePlugins }, async () => {
  const audio = stubAudio();
  config.update({
    plugins: {
      'audio-player': { enabled: true, approved: true },
      'phosphor-themes': { enabled: true, approved: false },
    },
  });
  const host = new PluginHost({ userDir: pluginsCheckout, services: { audio } });
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
});

test('the player finds music, queues it and drives the bar', { skip: !havePlugins }, async () => {
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
  const host = new PluginHost({ userDir: pluginsCheckout, services: { audio } });
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

test('near-matches are offered rather than guessed between', { skip: !havePlugins }, async () => {
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
  const host = new PluginHost({ userDir: pluginsCheckout, services: { audio } });
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

test('a playlist is gathered without asking which one', { skip: !havePlugins }, async () => {
  // The other half of the same request: asking which of forty tracks was meant
  // is the wrong question when somebody asked for all forty.
  const library = mkdtempSync(join(tmpdir(), 'wl-playlist-'));
  mkdirSync(join(library, 'Pearl Jam', 'Ten'), { recursive: true });
  for (const name of ['01 Once.mp3', '02 Even Flow.mp3', '03 Alive.mp3', '04 Black.mp3']) {
    writeFileSync(join(library, 'Pearl Jam', 'Ten', name), 'x');
  }

  const audio = stubAudio();
  config.update({ plugins: { 'audio-player': { enabled: true, approved: true, settings: { library } } } });
  const host = new PluginHost({ userDir: pluginsCheckout, services: { audio } });
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

test('the player says so rather than throwing when no folder is set', { skip: !havePlugins }, async () => {
  const audio = stubAudio();
  config.update({ plugins: { 'audio-player': { enabled: true, approved: true, settings: {} } } });
  const host = new PluginHost({ userDir: pluginsCheckout, services: { audio } });
  await host.load();

  // The agent turns a throw into feedback too, but a message naming the remedy
  // is worth more than a stack trace's first line.
  await assert.rejects(
    () => host.action('play_music').run('anything', { status() {}, log() {} }),
    /no music folder is set/,
  );
});

/* ============================ page map ============================ */

test('pageMapContext flattens a map into quoted labels', () => {
  const context = pageMapContext({
    url: 'https://a.test',
    groups: [
      { name: 'Main', elements: [{ label: 'Sign in' }, { label: 'Register' }], truncated: 0 },
      { name: 'Nav', elements: [{ label: 'Home' }], truncated: 3 },
    ],
  });
  assert.match(context, /URL: https:\/\/a\.test/);
  assert.match(context, /Main: 'Sign in', 'Register'/);
  assert.match(context, /Nav: 'Home' \(\+3 more\)/);
});

test('pageMapContext is empty when there is nothing to describe', () => {
  assert.equal(pageMapContext(null), '');
  assert.equal(pageMapContext({ url: 'https://a.test', groups: [] }), '');
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
  const host = new PluginHost({ userDir: pluginsCheckout, stateDir, services: { notify } });
  await host.load();
  return host;
}

const haveReminders = existsSync(join(pluginsCheckout, 'reminders', 'plugin.json'));

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

const haveVoice = existsSync(join(pluginsCheckout, 'voice-input', 'plugin.json'));

test('voice input drives the button and tells the model nothing', { skip: !haveVoice }, async () => {
  const mic = stubMic();
  // Built-ins off, so what is left in the prompt is this plugin's or nothing.
  const plugins = { 'voice-input': { enabled: true, approved: true, settings: {} } };
  for (const id of ALL_BUILTINS) plugins[id] = { enabled: false, approved: true };
  config.update({ plugins });

  const host = new PluginHost({ userDir: pluginsCheckout, services: { mic } });
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
