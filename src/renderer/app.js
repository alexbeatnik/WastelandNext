/**
 * The chat view.
 *
 * No framework and no local model of the pipeline: the main process owns every
 * piece of state that matters and announces changes on one event stream, so a
 * reload of this window can never leave the two disagreeing about whether a
 * turn is running.
 */
import { describePlacement, formatDuration, formatSize, splitThinking, stripActionBlocks } from '../shared/render.mjs';
import { describeUpdate, isBusy, isReady } from '../shared/updates.mjs';
import { parseMarkdown } from '../shared/markdown.mjs';
import { formatTime } from '../shared/media.mjs';

const api = window.wasteland;
const $ = (id) => document.getElementById(id);

const state = {
  settings: {},
  chatId: '',
  streaming: false,
  streamRaw: '',
  streamEl: null,
  pendingShell: null,
  turnStarted: false,
  autoContext: null,
  autoGpu: null,
  llmReady: false,
  update: { state: 'idle' },
  /** What is installed, what the registry offers, and what is on the bar. */
  plugins: [],
  store: { plugins: [], error: '', fetched: false },
  themes: [],
  audio: { source: null },
};

/* ============================ small helpers ============================ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function status(text) {
  $('status-line').textContent = text;
}

function activity(text, kind = '') {
  const log = $('activity-log');
  log.append(el('div', `line ${kind}`.trim(), text));
  while (log.childElementCount > 300) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

/** Save a settings patch and keep the local copy in step. */
async function saveSetting(patch) {
  state.settings = await api.config.set(patch);
}

/** Text inputs save on idle rather than on every keystroke. */
function bindText(id, key, transform = (v) => v) {
  const input = $(id);
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveSetting({ [key]: transform(input.value) }), 400);
  });
}

function bindCheck(id, key) {
  $(id).addEventListener('change', (event) => saveSetting({ [key]: event.target.checked }));
}

function bindRange(id, key, labelId, format = (v) => v) {
  const input = $(id);
  input.addEventListener('input', () => {
    $(labelId).textContent = format(input.value);
  });
  input.addEventListener('change', () => saveSetting({ [key]: Number(input.value) }));
}

/* ============================ chat rendering ============================ */

function addTurn(kind, text) {
  const node = el('div', `turn ${kind}`, text);
  $('chat-log').append(node);
  return node;
}

/** One inline span as a DOM node. */
function inlineNode(span) {
  if (span.type === 'code') return el('code', '', span.text);
  if (span.type === 'bold') return el('strong', '', span.text);
  if (span.type === 'italic') return el('em', '', span.text);
  if (span.type === 'link') {
    const link = el('a', '', span.text);
    link.href = span.href;
    // `target` sends it through the window-open handler, which hands it to the
    // real browser. Without it the chat window itself would navigate away.
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    return link;
  }
  return document.createTextNode(span.text);
}

/**
 * Draw a reply as markdown.
 *
 * Built node by node rather than through `innerHTML`: the text comes from a
 * model, and a reply that happens to contain markup must be shown, not run.
 */
function addMarkdownTurn(kind, text) {
  const node = el('div', `turn ${kind} md`);

  for (const block of parseMarkdown(text)) {
    if (block.type === 'code') {
      const pre = el('pre', 'code-block');
      pre.append(el('code', '', block.text));
      node.append(pre);
      continue;
    }

    if (block.type === 'list') {
      const list = el(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const li = el('li');
        for (const span of item) li.append(inlineNode(span));
        list.append(li);
      }
      node.append(list);
      continue;
    }

    const tag =
      block.type === 'heading' ? `h${Math.min(4, block.level + 2)}` : block.type === 'quote' ? 'blockquote' : 'p';
    const element = el(tag);
    for (const span of block.inline) element.append(inlineNode(span));
    node.append(element);
  }

  $('chat-log').append(node);
  return node;
}

/**
 * An attached file or folder in the transcript: one line, expandable.
 *
 * Drawn folded because it is the one message type whose size is chosen by the
 * user rather than the model — a dropped project renders to thousands of lines,
 * and a transcript where the reply is somewhere below all of them is unusable.
 * The full text is still there, one click away, because what was sent to the
 * model is exactly what the user should be able to check.
 */
function addAttachmentTurn(content) {
  const headline = content.split('\n', 1)[0].replace(/^\[ATTACHED (FILE|FOLDER)\]\s*/, '');
  const node = el('div', 'turn tool attachment');
  const head = el('button', 'attachment-head', `▸ ${headline}`);
  const body = el('pre', 'attachment-body', content);
  body.hidden = true;
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.textContent = `${body.hidden ? '▸' : '▾'} ${headline}`;
  });
  node.append(head, body);
  $('chat-log').append(node);
  return node;
}

/** Draw one stored message, splitting reasoning out and hiding action fences. */
function renderMessage(message) {
  if (message.role === 'user') return void addTurn('user', message.content);
  if (message.role === 'tool') {
    if (message.content.startsWith('[ATTACHED ')) return void addAttachmentTurn(message.content);
    return void addTurn('tool', message.content);
  }

  const segments = splitThinking(message.content);
  // With thinking switched off, the reasoning is hidden — but only when there
  // is an answer to show instead. A model that ignores the setting and thinks
  // without concluding would otherwise leave a blank turn, which tells the user
  // nothing and looks like a failure.
  const hasAnswer = segments.some((s) => s.kind === 'text' && stripActionBlocks(s.content));
  const hideThinking = !state.settings.thinking && hasAnswer;

  for (const segment of segments) {
    if (segment.kind === 'think') {
      if (!hideThinking) addTurn('think', segment.content);
    } else {
      const prose = stripActionBlocks(segment.content);
      if (prose) addMarkdownTurn('assistant', prose);
    }
  }
}

function scrollChat() {
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
}

/**
 * Which load is the current one.
 *
 * `chats.read` is a round trip, and a second pick started while the first is
 * still out can finish first — leaving the older transcript drawn over the
 * conversation the picker says is open. Every await below checks it is still
 * the load that was asked for and drops out if it is not.
 */
let chatLoadSeq = 0;

async function loadChat(id) {
  // A turn writes into whichever chat the main process is running; switching
  // out from under it would draw the reply into a conversation it does not
  // belong to, and the finishing `send()` would then set the id back.
  if (state.streaming) {
    status('A turn is running — stop it before switching conversations.');
    return;
  }

  const seq = (chatLoadSeq += 1);
  state.chatId = id ?? '';
  $('chat-log').replaceChildren();
  if (state.chatId) {
    const chat = await api.chats.read(state.chatId);
    if (seq !== chatLoadSeq) return;
    for (const message of chat?.messages ?? []) renderMessage(message);
  }
  scrollChat();

  // The meter is otherwise only written mid-turn, so it would keep showing the
  // previous conversation's usage — which reads as NEW CHAT not having cleared
  // anything.
  try {
    const usage = await api.agent.context(state.chatId);
    if (seq !== chatLoadSeq) return;
    paintCtx(usage);
  } catch {
    /* a meter that is briefly stale is not worth failing the load over */
  }

  await refreshChats();
}

function setChatMenu(open) {
  $('chat-menu').hidden = !open;
  $('chat-current').setAttribute('aria-expanded', String(open));
}

/**
 * Draw the picker: the open conversation on the button, all of them in the menu.
 *
 * Each row carries its own delete, so a conversation can be thrown away without
 * being opened first. That matters more than it sounds: the only other way to
 * delete one was to switch to it, which means loading a transcript, recomputing
 * the meter and making it the current chat — all to get rid of it.
 */
function paintChatPicker(chats) {
  const open = chats.find((chat) => chat.id === state.chatId);
  $('chat-current-label').textContent = open ? open.title || 'Untitled' : '— new conversation —';

  const menu = $('chat-menu');
  menu.replaceChildren();

  if (chats.length === 0) {
    menu.append(el('div', 'chat-empty muted', 'No conversations yet.'));
    return;
  }

  for (const chat of chats) {
    const row = el('div', `chat-row${chat.id === state.chatId ? ' current' : ''}`);

    const pick = el('button', 'chat-pick');
    pick.title = `${chat.turns} turn(s) · ${chat.updated ?? ''}`;
    pick.append(el('span', 'chat-title', chat.title || 'Untitled'));
    pick.append(el('span', 'muted', `${chat.turns}`));
    pick.addEventListener('click', async () => {
      setChatMenu(false);
      await loadChat(chat.id);
    });

    const drop = el('button', 'chat-drop danger', '×');
    drop.title = `Delete "${chat.title || 'Untitled'}"`;
    drop.addEventListener('click', async () => {
      // A turn appends to the file as it goes; deleting it underneath one is a
      // half-written conversation, and a chat the reply is still being written
      // into is not one anybody means to throw away mid-sentence.
      if (state.streaming) return status('A turn is running — stop it before deleting a conversation.');
      await api.chats.remove(chat.id);
      // Deleting the conversation on screen has to clear the transcript with
      // it; deleting any other must leave the view exactly where it was. The
      // menu stays open either way, so several can go in one visit.
      if (chat.id === state.chatId) await loadChat('');
      else await refreshChats();
      setChatMenu(true);
    });

    row.append(pick, drop);
    menu.append(row);
  }
}

/**
 * Fill the conversation picker.
 *
 * A chat is only created once something has been said in it, so a fresh one has
 * no id yet — hence the placeholder label. Without it the picker would show the
 * previous conversation's name while the user typed into a new one.
 */
async function refreshChats() {
  paintChatPicker(await api.chats.list());
  $('btn-delete-chat').disabled = !state.chatId;
}

/* ============================ vault + hub ============================ */

/**
 * Interrupted downloads, offered back rather than left as litter.
 *
 * A half-finished `.part` is kept on purpose: it is what makes resuming
 * possible. Without this list it would be invisible, and the only way out of a
 * failed transfer would be to start it again from zero.
 */
async function refreshPartials() {
  const list = $('partial-list');
  list.replaceChildren();

  const partials = await api.models.partials().catch(() => []);
  for (const partial of partials) {
    const row = el('div', 'vault-item missing');
    row.append(el('span', 'name', `${partial.name} · ${formatSize(partial.received)} so far`));

    const resume = el('button', '', '[ RESUME ]');
    resume.addEventListener('click', async () => {
      const input = $('custom-model').value.trim();
      if (!input) {
        $('download-status').textContent = 'Paste the model id or URL above, then resume.';
        return;
      }
      resume.disabled = true;
      try {
        await api.models.download(input);
      } catch (err) {
        $('download-status').textContent = err.message;
      } finally {
        resume.disabled = false;
        await Promise.all([refreshVault(), refreshPartials()]);
      }
    });

    const discard = el('button', 'ghost danger', '×');
    discard.title = 'Discard this partial download';
    discard.addEventListener('click', async () => {
      await api.models.discardPartial(partial.name);
      await refreshPartials();
    });

    row.append(resume, discard);
    list.append(row);
  }
}

/** `GPU`, `GPU 15/52` or `CPU`, from the plan the launcher would use. */
function placementLabel(plan) {
  if (!plan || plan.where === 'unknown') return '';
  if (plan.where === 'gpu') return 'GPU';
  if (plan.where === 'cpu') return 'CPU';
  return `GPU ${plan.layers}/${plan.blocks}`;
}

async function refreshVault() {
  const [models, llm] = await Promise.all([api.models.list(), api.llm.status()]);
  const list = $('vault-list');
  list.replaceChildren();
  refreshPartials();

  if (models.length === 0) {
    list.append(el('div', 'muted', 'No models yet — search above, or [ OPEN FILE… ] to use one you already have.'));
    return;
  }

  for (const model of models) {
    // An external model is loaded by absolute path; a vault one by bare name.
    const key = model.external ? model.path : model.name;
    const loaded = llm.model === key && llm.state === 'ready';

    const row = el('div', `vault-item${loaded ? ' loaded' : ''}${model.missing ? ' missing' : ''}`);
    const where = placementLabel(model.plan);
    const label = model.missing
      ? `${model.name} · missing`
      : [model.name, formatSize(model.size), where, model.external ? '↗' : null].filter(Boolean).join(' · ');
    const name = el('span', 'name', label);
    name.title = [
      model.external ? `${model.path}\n(outside the vault)` : model.path,
      model.plan ? `\n${model.plan.reason}` : null,
      model.plan ? `context ${model.plan.context}${model.plan.modelMax ? ` of ${model.plan.modelMax}` : ''}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const load = el('button', '', loaded ? '[ UNLOAD ]' : '[ LOAD ]');
    load.disabled = model.missing;
    load.addEventListener('click', async () => {
      load.disabled = true;
      try {
        if (loaded) {
          await api.llm.unload();
        } else {
          status(`Loading ${model.name}…`);
          await api.llm.load(key);
        }
      } catch (err) {
        status(err.message);
      } finally {
        load.disabled = false;
        await refreshVault();
      }
    });

    // Two different actions behind one glyph would be a trap: a file we
    // downloaded is ours to delete, one the user pointed us at is not.
    const drop = el('button', 'ghost danger', model.external ? '⊘' : '×');
    drop.title = model.external ? 'Remove from the list (the file is left alone)' : 'Delete this file from disk';
    drop.addEventListener('click', async () => {
      if (model.external) await api.models.forget(model.path);
      else await api.models.remove(model.name);
      await refreshVault();
    });

    row.append(name, load, drop);
    list.append(row);
  }
}

/**
 * Whether inference can start at all, and the button to fix it if not.
 *
 * A remote endpoint makes the local binary irrelevant, so the row says so
 * rather than nagging about a download that would change nothing.
 */
async function refreshTool() {
  const label = $('tool-state');
  const button = $('btn-fetch-llama');

  if (state.settings.externalEndpoint) {
    label.textContent = 'not needed (remote endpoint)';
    button.disabled = true;
    return;
  }

  try {
    const tool = await api.llm.toolStatus();
    label.textContent = tool.found ? `found (${tool.source})` : 'missing';
    button.disabled = tool.found;
    button.textContent = tool.found ? '[ INSTALLED ]' : '[ DOWNLOAD LLAMA-SERVER ]';
    $('btn-fetch-llama').title = tool.path || '';
  } catch (err) {
    label.textContent = err.message;
    button.disabled = false;
  }
}

/* ============================ search ============================ */

/** `241649` reads as `242k` in a sidebar row. */
function compactCount(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
  return String(value);
}

/**
 * Expand a search hit into its quantisations.
 *
 * The file list is fetched on demand rather than up front: one request per
 * result would be twenty requests for a search nobody has committed to yet.
 */
async function showRepoFiles(repoId, host) {
  host.replaceChildren(el('div', 'muted', 'Reading files…'));
  let files;
  try {
    files = await api.models.files(repoId);
  } catch (err) {
    host.replaceChildren(el('div', 'muted', err.message));
    return;
  }

  const usable = files.filter((file) => !file.shard);
  host.replaceChildren();

  if (usable.length === 0) {
    host.append(
      el(
        'div',
        'muted',
        files.length > 0
          ? `${files.length} file(s), all multi-part shards — not downloadable as one file.`
          : 'No .gguf files in this repository.',
      ),
    );
    return;
  }

  for (const file of usable) {
    const row = el('div', `file-item${file.placement === 'cpu' ? ' wont-fit' : ''}`);
    // Estimated from size — the header that would give an exact answer is
    // inside the file we have not downloaded yet.
    const fit = { gpu: '~GPU', partial: '~part GPU', cpu: '~CPU' }[file.placement] ?? '';
    const label = el('span', 'name', [file.quant || file.name, formatSize(file.size), fit].filter(Boolean).join(' · '));
    label.title = `${file.name}${fit ? `\n${fit} — estimated from file size against your VRAM` : ''}`;

    const get = el('button', '', '[ GET ]');
    get.addEventListener('click', async () => {
      get.disabled = true;
      $('download-status').textContent = `Starting ${file.name}…`;
      try {
        await api.models.download(file.url);
      } catch (err) {
        $('download-status').textContent = err.message;
      } finally {
        get.disabled = false;
      }
    });

    row.append(label, get);
    host.append(row);
  }
}

async function runSearch() {
  const query = $('model-search').value.trim();
  const results = $('search-results');
  if (!query) {
    results.replaceChildren();
    $('search-status').textContent = '';
    return;
  }

  $('btn-search').disabled = true;
  $('search-status').textContent = 'Searching…';
  results.replaceChildren();

  try {
    const hits = await api.models.search(query);
    $('search-status').textContent = hits.length === 0 ? 'Nothing found.' : `${hits.length} repositories`;

    for (const hit of hits) {
      const item = el('div', 'repo-item');
      const head = el('div', 'search-head');
      head.append(
        el('span', 'repo', hit.id),
        el('span', 'note', `↓ ${compactCount(hit.downloads)} · ♥ ${hit.likes}${hit.gated ? ' · gated' : ''}`),
      );

      const files = el('div', 'file-list');
      let opened = false;
      head.addEventListener('click', () => {
        opened = !opened;
        if (opened) showRepoFiles(hit.id, files);
        else files.replaceChildren();
      });

      item.append(head, files);
      results.append(item);
    }
  } catch (err) {
    $('search-status').textContent = err.message;
  } finally {
    $('btn-search').disabled = false;
  }
}

/* ============================ status bar ============================ */

function paintLlm(llm) {
  const label = $('stat-model');
  if (state.settings.externalEndpoint) {
    label.textContent = `MODEL: REMOTE (${state.settings.externalEndpoint})`;
    label.className = 'stat ok';
    return;
  }
  const text =
    { ready: `MODEL: ${llm.model}`, starting: `MODEL: LOADING ${llm.detail}`, error: `MODEL: ${llm.detail}` }[llm.state] ??
    'MODEL: NONE';
  label.textContent = text.toUpperCase();
  label.className = `stat ${llm.state === 'ready' ? 'ok' : llm.state === 'error' ? 'warn' : ''}`;
}

/**
 * Where the loaded model is actually running — the question a size cannot answer.
 *
 * Read from what llama.cpp printed, never from the plan that was sent to it.
 * The two differ exactly where it matters: with no NVIDIA card to measure, the
 * planner asks for full offload — right for an AMD or Intel card under Vulkan,
 * which `nvidia-smi` cannot see — and a machine with no GPU at all took the
 * same branch, so the badge read `RUN: GPU` for a model running wholly on the
 * processor. `RUN: ?` is the honest reading when llama.cpp said nothing we
 * recognise; a request is not an outcome, and the badge is about the outcome.
 *
 * The wording is `describePlacement`'s, not this file's. It used to be written
 * out again here, and the copy went stale the moment the reader learned that
 * every layer being on the card does not mean every byte is.
 */
function paintCompute(llm) {
  state.llmReady = llm?.state === 'ready';
  const label = $('stat-compute');

  if (llm?.state !== 'ready') {
    label.hidden = true;
    return;
  }

  const real = llm.placement;
  const auto = llm.autoGpu;
  const asked = !auto
    ? ''
    : auto.layers === 999
      ? 'asked for every layer on the GPU'
      : `asked for ${auto.layers} layer(s) on the GPU`;

  const text = describePlacement(real);

  // The evidence goes in the tooltip rather than the badge: if the reading is
  // ever wrong, the line it was read from is what makes that visible instead of
  // it being another confident number.
  const title = real
    ? [real.evidence, real.devices.length ? real.devices.join(', ') : '', asked].filter(Boolean).join(' · ')
    : ['llama-server did not say where the weights went', asked].filter(Boolean).join(' · ');

  label.hidden = false;
  label.textContent = text;
  label.title = title;
  label.className = `stat ${!real ? '' : real.where === 'cpu' ? 'warn' : 'ok'}`.trim();
}

function paintBrowser(browser) {
  const label = $('stat-browser');
  label.textContent = browser.open ? `BROWSER: ${(browser.mode || 'open').toUpperCase()}` : 'BROWSER: IDLE';
  label.className = `stat ${browser.open ? 'ok' : ''}`;

  const engine = $('stat-engine');
  engine.textContent = browser.engine ? 'ENGINE: MANUL-BROWSER' : 'ENGINE: MISSING';
  engine.className = `stat ${browser.engine ? '' : 'warn'}`;
}

/* ============================ plugins ============================ */

/** A plugin's icon, or a glyph standing in for one that has none. */
function pluginIcon(plugin) {
  if (plugin.icon) {
    const image = document.createElement('img');
    image.className = 'plugin-icon';
    image.src = plugin.icon;
    image.alt = '';
    // A broken icon must not leave a torn image in the row.
    image.addEventListener('error', () => image.replaceWith(el('span', 'plugin-icon glyph', '▪')));
    return image;
  }
  return el('span', 'plugin-icon glyph', plugin.themes?.length ? '◐' : '▪');
}

/** The controls a plugin declared for its own settings. */
function settingControls(plugin) {
  const box = el('div', 'plugin-settings');

  for (const setting of plugin.settings ?? []) {
    const row = el('div', 'plugin-setting');
    row.append(el('span', 'plugin-setting-label', setting.label));

    if (setting.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(setting.value);
      input.addEventListener('change', () => saveSetting$(plugin.id, setting.key, input.checked));
      row.append(input);
    } else if (setting.type === 'folder') {
      const value = el('span', 'plugin-setting-value', setting.value || 'not set');
      value.title = setting.value || '';
      const pick = el('button', 'ghost', '[ CHOOSE… ]');
      pick.addEventListener('click', async () => {
        pick.disabled = true;
        try {
          const result = await api.plugins.pickFolder(plugin.id, setting.key);
          if (!result.canceled) paintPlugins(result.plugins);
        } catch (err) {
          $('plugin-status').textContent = err.message;
        } finally {
          pick.disabled = false;
        }
      });
      row.append(value, pick);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = setting.value ?? '';
      input.placeholder = setting.placeholder ?? '';
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => saveSetting$(plugin.id, setting.key, input.value), 500);
      });
      row.append(input);
    }
    box.append(row);
  }
  return box;
}

async function saveSetting$(id, key, value) {
  try {
    paintPlugins(await api.plugins.setSetting(id, key, value));
  } catch (err) {
    $('plugin-status').textContent = err.message;
  }
}

/**
 * The installed plugin list.
 *
 * Painted entirely from what the main process reports, including the checkbox:
 * "switched on" and "actually running" are different facts — a plugin can be
 * enabled and still be sitting there with a reason it could not load — and a
 * row that reads its own state from the click would show the first while
 * meaning the second.
 */
function paintPlugins(list = []) {
  state.plugins = list;
  const host = $('plugin-list');
  host.replaceChildren();

  for (const plugin of list) {
    const row = el('div', 'plugin-item');
    row.classList.toggle('off', !plugin.active);
    row.classList.toggle('failed', Boolean(plugin.error));

    const label = el('label', 'check');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = plugin.enabled;
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        // `paintPlugins` rewrites the status line with the new count, which is
        // also how the previous error message goes away. Clearing it here as
        // well — as the first version did — wipes the count it just wrote.
        paintPlugins(await api.plugins.setEnabled(plugin.id, box.checked));
      } catch (err) {
        // Put the box back where it was: the setting did not change, and a
        // checkbox showing a state the main process never accepted is a lie.
        box.checked = !box.checked;
        $('plugin-status').textContent = err.message;
      } finally {
        box.disabled = false;
      }
    });

    label.append(box, pluginIcon(plugin), el('span', 'plugin-name', plugin.name));
    row.append(label, el('span', 'plugin-meta', `${plugin.version} · ${plugin.builtin ? 'BUILT-IN' : 'INSTALLED'}`));
    if (plugin.description) row.append(el('div', 'plugin-desc muted', plugin.description));

    const adds = [...(plugin.actions ?? []), ...(plugin.themes ?? []).map((theme) => `theme: ${theme.name}`)];
    if (adds.length) row.append(el('div', 'plugin-adds muted', adds.join('  ')));
    if (plugin.settings?.length) row.append(settingControls(plugin));

    const note = plugin.error
      ? plugin.error
      : plugin.enabled && !plugin.active
        ? 'switched on, but not running'
        : plugin.needsApproval && !plugin.approved
          ? 'runs code from outside the app — switching it on allows that'
          : '';
    if (note) row.append(el('div', 'plugin-note', note));

    // An update is offered rather than applied: it is the same code path as a
    // fresh install, and installing something the user did not ask for is what
    // the approval step exists to prevent.
    const published = state.store.plugins.find((entry) => entry.id === plugin.id);
    const buttons = el('div', 'plugin-buttons');
    if (published && published.compatible && isNewerVersion(published.version, plugin.version)) {
      const update = el('button', '', `[ UPDATE → ${published.version} ]`);
      update.addEventListener('click', () => installPlugin(published, update));
      buttons.append(update);
    }
    if (!plugin.builtin) {
      const remove = el('button', 'ghost danger', '[ REMOVE ]');
      remove.title = 'Delete this plugin from disk';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          paintPlugins(await api.plugins.uninstall(plugin.id));
          paintStore();
        } catch (err) {
          $('plugin-status').textContent = err.message;
          remove.disabled = false;
        }
      });
      buttons.append(remove);
    }
    if (buttons.childElementCount) row.append(buttons);

    host.append(row);
  }

  const active = list.filter((plugin) => plugin.active).length;
  $('plugin-status').textContent = list.length ? `${active} of ${list.length} active` : 'No plugins found.';
}

/**
 * Is the published version worth offering over the installed one?
 *
 * The renderer's own copy of the comparison in `registry.mjs`, and it is the
 * same three lines for the same reason: `1.10.0` is newer than `1.9.0`, which a
 * string comparison gets backwards — and an update button that never appears
 * looks exactly like a registry that never publishes.
 */
function isNewerVersion(published, installed) {
  const parts = (value) =>
    String(value ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(published);
  const b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function refreshPlugins() {
  try {
    paintPlugins(await api.plugins.list());
  } catch (err) {
    $('plugin-status').textContent = err.message;
  }
}

/* ============================ the registry ============================ */

async function installPlugin(entry, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '[ … ]';
  try {
    const installed = await api.plugins.install(entry);
    activity(`plugin installed: ${installed.name} ${installed.version}`);
    await Promise.all([refreshPlugins(), refreshThemes()]);
    paintStore();
  } catch (err) {
    $('store-status').textContent = err.message;
    activity(`plugin install failed: ${err.message}`, 'bad');
    button.disabled = false;
    button.textContent = label;
  }
}

/** The registry, drawn against what is already installed. */
function paintStore() {
  const host = $('store-list');
  host.replaceChildren();

  for (const entry of state.store.plugins) {
    const installed = state.plugins.find((plugin) => plugin.id === entry.id);
    const row = el('div', 'plugin-item');
    if (!entry.compatible) row.classList.add('off');

    const head = el('div', 'plugin-head');
    head.append(pluginIcon(entry), el('span', 'plugin-name', entry.name));
    row.append(head, el('span', 'plugin-meta', `${entry.version} · ${entry.kind === 'theme' ? 'THEME' : 'PLUGIN'}`));
    if (entry.description) row.append(el('div', 'plugin-desc muted', entry.description));
    if (entry.author) row.append(el('div', 'plugin-adds muted', `by ${entry.author}`));

    const buttons = el('div', 'plugin-buttons');
    if (!entry.compatible) {
      row.append(el('div', 'plugin-note', `needs plugin API ${entry.apiVersion} — update Wasteland Next`));
    } else if (!installed) {
      const install = el('button', '', '[ INSTALL ]');
      install.addEventListener('click', () => installPlugin(entry, install));
      buttons.append(install);
    } else if (isNewerVersion(entry.version, installed.version)) {
      const update = el('button', '', `[ UPDATE → ${entry.version} ]`);
      update.addEventListener('click', () => installPlugin(entry, update));
      buttons.append(update);
    } else {
      row.append(el('div', 'plugin-note', `installed (${installed.version})`));
    }
    if (buttons.childElementCount) row.append(buttons);

    host.append(row);
  }

  if (state.store.error) $('store-status').textContent = state.store.error;
  else if (state.store.plugins.length) $('store-status').textContent = `${state.store.plugins.length} available`;
  else if (state.store.fetched) $('store-status').textContent = 'The registry lists nothing yet.';
}

/**
 * Ask the registry what it has.
 *
 * `quiet` is the boot call: a machine with no network must not open with an
 * error about a plugin list nobody asked to see. The update badges on installed
 * rows come from this, which is why it runs at boot at all rather than waiting
 * for the section to be opened.
 */
async function refreshStore({ quiet = false } = {}) {
  if (!quiet) $('store-status').textContent = 'Asking the registry…';
  try {
    const index = await api.plugins.available();
    state.store = { plugins: index.plugins ?? [], error: '', fetched: true };
  } catch (err) {
    state.store = { plugins: [], error: quiet ? '' : err.message, fetched: true };
    if (quiet) return;
  }
  paintStore();
  // The installed rows carry the update button, so they are repainted too.
  paintPlugins(state.plugins);
}

/* ============================ themes ============================ */

function paintThemes(themes = []) {
  state.themes = themes;
  const select = $('set-theme');
  const current = state.settings.theme ?? '';

  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Amber — built in';
  select.append(none);

  for (const theme of themes) {
    const option = document.createElement('option');
    option.value = theme.key;
    option.textContent = `${theme.name} — ${theme.pluginName}`;
    select.append(option);
  }

  // A theme whose plugin has been removed or switched off is no longer on
  // offer; saying so beats silently selecting something else.
  if (current && !themes.some((theme) => theme.key === current)) {
    const missing = document.createElement('option');
    missing.value = current;
    missing.textContent = `${current} — unavailable`;
    select.append(missing);
  }
  select.value = current;
  applyTheme(current);
}

/**
 * Point the theme stylesheet at the chosen plugin's CSS.
 *
 * A `<link>` is used rather than an injected `<style>` because the CSP has no
 * `'unsafe-inline'` and will not get one: a stylesheet arriving over the plugin
 * scheme is served by our own handler out of one directory, whereas inline
 * styles would be open to anything that can put text on the page.
 */
function applyTheme(key) {
  const link = $('theme-css');
  const theme = state.themes.find((item) => item.key === key);
  if (theme) link.setAttribute('href', theme.url);
  else link.removeAttribute('href');
}

async function refreshThemes() {
  try {
    paintThemes(await api.plugins.themes());
  } catch {
    /* the built-in look is always there to fall back to */
  }
}

/* ============================ the player ============================ */

/**
 * The audio element the app owns.
 *
 * Created here rather than in the markup because nothing else touches it, and
 * because `preload = 'metadata'` matters: the bar wants a duration as soon as a
 * track is cued, without pulling the whole file down to get one.
 */
const sound = new Audio();
sound.preload = 'metadata';

let seeking = false;

function paintPlayer(status = { source: null }) {
  state.audio = status;
  const bar = $('player');
  bar.hidden = !status.source;

  for (const name of ['previous', 'next', 'stop']) {
    $(`player-${name}`).hidden = !(status.buttons ?? []).includes(name);
  }

  $('player-toggle').textContent = status.playing ? '⏸' : '▶';
  $('player-toggle').title = status.playing ? 'Pause' : 'Play';
  $('player-title').textContent = status.source?.label ?? '';
  $('player-title').title = status.source?.path ?? '';
  $('player-sub').textContent = status.error || status.source?.sublabel || '';
  $('player-sub').classList.toggle('bad', Boolean(status.error));
  $('player-volume').value = String(Math.round((status.volume ?? 1) * 100));

  if (!status.source) {
    sound.removeAttribute('src');
    sound.load();
    return;
  }

  // Only when it actually changed: reassigning the same src restarts the track,
  // which turns a pause into a rewind.
  if (sound.getAttribute('src') !== status.source.src) {
    sound.setAttribute('src', status.source.src);
    sound.load();
  }

  // Hearing is logarithmic, so a linear slider would cram all the useful
  // volume into its top quarter. Squaring it is what A-Player settled on.
  sound.volume = (status.volume ?? 1) ** 2;

  if (status.playing) {
    // A play() rejection is ordinary here — a file that will not decode, or a
    // src replaced mid-load — and it is reported rather than thrown away.
    sound.play().catch((err) => api.audio.failed(err.message).then(paintPlayer).catch(() => {}));
  } else {
    sound.pause();
  }
}

function paintPlayhead() {
  const duration = Number.isFinite(sound.duration) ? sound.duration : 0;
  $('player-position').textContent = formatTime(sound.currentTime);
  $('player-duration').textContent = duration ? formatTime(duration) : '—:—';
  if (!seeking) $('player-seek').value = String(duration ? Math.round((sound.currentTime / duration) * 1000) : 0);
}

function wirePlayer() {
  sound.addEventListener('timeupdate', paintPlayhead);
  sound.addEventListener('loadedmetadata', paintPlayhead);
  sound.addEventListener('durationchange', paintPlayhead);
  // What the main process cannot know: only the element sees the file run out.
  sound.addEventListener('ended', () => api.audio.ended().then(paintPlayer).catch(() => {}));
  sound.addEventListener('error', () => {
    if (sound.getAttribute('src')) api.audio.failed('this file could not be played').then(paintPlayer).catch(() => {});
  });

  const command = (name) => api.audio.command(name).then(paintPlayer).catch((err) => status(err.message));
  $('player-toggle').addEventListener('click', () => command('toggle'));
  $('player-previous').addEventListener('click', () => command('previous'));
  $('player-next').addEventListener('click', () => command('next'));
  $('player-stop').addEventListener('click', () => command('stop'));

  const seek = $('player-seek');
  // Held while the user drags, or the timeupdate that arrives mid-gesture drags
  // the thumb back under their finger.
  seek.addEventListener('pointerdown', () => {
    seeking = true;
  });
  const commitSeek = () => {
    seeking = false;
    if (Number.isFinite(sound.duration)) sound.currentTime = (Number(seek.value) / 1000) * sound.duration;
  };
  seek.addEventListener('change', commitSeek);
  seek.addEventListener('pointerup', commitSeek);

  $('player-volume').addEventListener('input', (event) => {
    // Applied straight to the element so the slider is audible while dragging;
    // the main process is told on change, since that is what gets persisted.
    sound.volume = (Number(event.target.value) / 100) ** 2;
  });
  $('player-volume').addEventListener('change', (event) => {
    api.audio.volume(Number(event.target.value) / 100).then(paintPlayer).catch(() => {});
  });
}

function paintCtx({ used = 0, max = 0, percent = 0 } = {}) {
  const safePercent = Number.isFinite(percent) ? percent : 0;
  $('ctx-label').textContent = `CTX: ${used} / ${max} (${Math.round(safePercent)}%)`;
  const meter = $('ctx-meter');
  meter.className = `meter ctx${safePercent > 90 ? ' hot' : safePercent > 75 ? ' warn' : ''}`;
  meter.firstElementChild.style.width = `${Math.min(100, Math.max(0, safePercent))}%`;
}

/* ============================ updates ============================ */

/** The update line in the About box. Wording lives in `shared/updates.mjs`. */
function paintUpdate(status = { state: 'idle' }) {
  $('update-status').textContent = describeUpdate(status);
  $('about-update').className = `about-update${isReady(status) ? ' ready' : ''}${
    status.state === 'error' ? ' bad' : ''
  }`;

  const button = $('btn-update');
  // Hidden while something is in flight, and for a build that cannot update
  // itself at all — a button whose only outcome is a failure is worse than none.
  button.hidden = isBusy(status) || status.state === 'unsupported';
  button.textContent = isReady(status) ? '[ RESTART ]' : '[ CHECK ]';
  button.title = isReady(status) ? 'Restart and install the update' : 'Check for a newer version';
}

/* ============================ attachments ============================ */

/**
 * The last two segments of a path.
 *
 * A bare basename is not an answer to "what did I attach": half the folders
 * worth attaching are called `src`, `test` or `docs`, and two of them side by
 * side would be one label written twice. The parent is what tells them apart,
 * and it is short enough to sit in a chip.
 */
function shortPath(path) {
  const parts = String(path).split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/** The chips above the composer: what will go with the next message. */
function paintAttachments(items = []) {
  const chips = $('attach-chips');
  chips.replaceChildren();

  for (const item of items) {
    const chip = el('div', 'chip');
    // The whole path stays on hover. The chip says which one, the tooltip says
    // exactly where — a chip wide enough for the second would fit one item.
    chip.title = `${item.path}\n${item.files} file(s), ${formatSize(item.bytes)}`;

    chip.append(el('span', 'chip-kind', item.kind === 'dir' ? 'DIR' : 'FILE'));
    chip.append(el('span', 'chip-name', shortPath(item.path)));
    chip.append(
      el('span', 'muted', item.kind === 'dir' ? `${item.files} files · ${formatSize(item.bytes)}` : formatSize(item.bytes)),
    );

    const detach = el('button', '', '×');
    detach.title = `Detach ${item.path}`;
    detach.addEventListener('click', async () => paintAttachments(await api.attach.remove(item.id)));
    chip.append(detach);
    chips.append(chip);
  }

  $('btn-attach-clear').hidden = items.length === 0;
  $('btn-attach-clear').title = `Detach all ${items.length}`;
}

/**
 * Run an attach command and report what came of it.
 *
 * Failures are per-path, not per-batch: dropping six folders of which one is
 * unreadable attaches five and names the sixth. Throwing the lot away and
 * reporting only the first problem is not what the gesture asked for.
 */
async function attachVia(run) {
  try {
    const result = await run();
    const items = result.items ?? result;
    paintAttachments(items);
    for (const error of result.errors ?? []) activity(`not attached — ${error}`, 'bad');

    if (result.canceled) status('Ready');
    else if (result.errors?.length) status(`Not attached: ${result.errors[0]}`);
    else status(items.length === 1 ? '1 attachment ready.' : `${items.length} attachments ready.`);
  } catch (err) {
    status(err.message);
    activity(err.message, 'bad');
  }
}

/**
 * Dropping files or folders anywhere on the window.
 *
 * `dragover` must be cancelled or `drop` never fires at all: Chromium's default
 * is to navigate to what was dropped, which in this window means the app is
 * replaced by a file viewer with no way back.
 */
function wireDrop() {
  const veil = $('drop-veil');
  let idle = null;

  // A drag carrying selected text also fires these events, and veiling the
  // transcript for one would be a lie about what is going to happen.
  const holdsFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const hide = () => {
    clearTimeout(idle);
    idle = null;
    veil.hidden = true;
  };

  /**
   * Kept up by the drag itself rather than by counting enters against leaves.
   *
   * `dragover` repeats every few hundred milliseconds for as long as something
   * is over the window, so re-arming a short timer on each one means the veil
   * takes itself down the moment the events stop — whether the cursor left, the
   * drag was cancelled with Escape, or it was dropped on another window. The
   * counting version could not: `dragleave` is not guaranteed to balance
   * `dragenter` at the window edge, and one missed leave left the veil up over
   * the transcript for the rest of the session.
   */
  const show = () => {
    veil.hidden = false;
    clearTimeout(idle);
    idle = setTimeout(hide, 300);
  };

  document.addEventListener('dragenter', (event) => {
    if (!holdsFiles(event)) return;
    event.preventDefault();
    show();
  });

  document.addEventListener('dragover', (event) => {
    if (!holdsFiles(event)) return;
    event.preventDefault();
    show();
  });

  // Belt and braces for the cases that do announce themselves.
  document.addEventListener('dragleave', (event) => {
    if (holdsFiles(event) && !event.relatedTarget) hide();
  });
  document.addEventListener('dragend', hide);
  window.addEventListener('blur', hide);

  document.addEventListener('drop', async (event) => {
    if (!holdsFiles(event)) return;
    event.preventDefault();
    hide();

    // `File.path` was Electron's own extension and is gone as of Electron 32;
    // the path now comes from `webUtils` in the preload. Reading `.path` here
    // would yield undefined for every drop and look like the app ignoring it.
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => api.attach.pathFor(file))
      .filter(Boolean);

    if (paths.length === 0) return void status('Nothing with a filesystem path in that drop.');
    await attachVia(() => api.attach.add(paths));
  });
}

/* ============================ settings → controls ============================ */

/**
 * The N_CTX row, which reads differently depending on who decides the value.
 *
 * On AUTO the slider is inert and the number shown is whatever the last load
 * actually resolved — a slider that looks editable but is ignored would be a
 * lie, and so would showing the stored value while the model runs another.
 */
function paintContextControls(auto) {
  const reload = state.llmReady ? ' · reload the model to apply a change' : '';
  const on = Boolean(state.settings.autoContext);
  $('set-auto-ctx').checked = on;
  $('set-nctx').disabled = on;

  if (!on) {
    $('val-nctx').textContent = state.settings.nCtx;
    $('ctx-explain').textContent = `Fixed — the model must support this size.${reload}`;
    return;
  }

  if (!auto) {
    $('val-nctx').textContent = 'auto';
    $('ctx-explain').textContent = `Chosen from the model header when one is loaded.${reload}`;
    return;
  }

  $('val-nctx').textContent = auto.context;
  $('ctx-explain').textContent =
    [
      auto.reason,
      auto.modelMax ? `model max ${auto.modelMax}` : null,
      auto.kvPerToken ? `KV ${(auto.kvPerToken / 1024).toFixed(1)} KB/token` : null,
    ]
      .filter(Boolean)
      .join(' · ') + reload;
}

/** The GPU-layers row, the same idea as the context one. */
function paintGpuControls(auto) {
  const reload = state.llmReady ? ' · reload the model to apply a change' : '';
  const on = Boolean(state.settings.autoGpuLayers);
  $('set-auto-gpu').checked = on;
  $('set-ngl').disabled = on;
  $('set-ngl').value = state.settings.ngl;

  if (!on) {
    $('val-ngl').textContent = state.settings.ngl;
    $('gpu-explain').textContent = `Fixed — 999 means every layer, which fails if they do not fit.${reload}`;
    return;
  }
  if (!auto) {
    $('val-ngl').textContent = 'auto';
    $('gpu-explain').textContent = `Fitted to the card when a model is loaded.${reload}`;
    return;
  }

  $('val-ngl').textContent = auto.layers === 999 ? 'all' : auto.layers;
  $('gpu-explain').textContent =
    auto.reason + (auto.vramBytes ? ` · ${(auto.vramBytes / 1024 ** 3).toFixed(1)} GB VRAM` : '') + reload;
}

function applySettings(settings) {
  state.settings = settings;

  // These two own their whole row — slider position, label and explanation —
  // so nothing may write `val-nctx` or `val-ngl` after them. An earlier version
  // did, and the label read `999` while AUTO was deciding.
  $('set-nctx').value = settings.nCtx;
  paintContextControls(state.autoContext);
  paintGpuControls(state.autoGpu);

  $('set-temp').value = settings.temperature;
  $('val-temp').textContent = Number(settings.temperature).toFixed(2);

  $('set-endpoint').value = settings.externalEndpoint;
  $('set-llama-path').value = settings.llamaServerPath;
  $('set-system-prompt').value = settings.systemPrompt;

  $('set-browser-headless').checked = settings.browserHeadless;
  $('set-chrome').value = settings.chromePath;

  // What the model may do is not painted from here any more: it belongs to the
  // plugin list, which the main process owns and reports whole.
  $('set-thinking').checked = settings.thinking;
  $('set-crt').checked = settings.crtEffects;

  document.body.classList.toggle('no-crt', !settings.crtEffects);
  $('workspace').classList.toggle('panel-hidden', !settings.leftPanelOpen);
}

/* ============================ sending ============================ */

function setStreaming(on) {
  state.streaming = on;
  const send = $('btn-send');
  send.textContent = on ? '■' : '▶';
  send.classList.toggle('stop', on);
  send.title = on ? 'Stop' : 'Send';
}

async function send() {
  if (state.streaming) {
    await api.agent.stop();
    return;
  }
  const input = $('input');
  const prompt = input.value.trim();
  if (!prompt) return;

  input.value = '';
  const userTurn = addTurn('user', prompt);
  scrollChat();
  setStreaming(true);
  // The agent emits `turn:start` only after the message is persisted. Before
  // that point a failure means nothing was recorded and the text is ours to
  // give back; after it, the message is in the history and handing it back
  // would duplicate it on the next send.
  state.turnStarted = false;

  try {
    // The id comes back on `turn:start`, not from here: the main process is
    // what decides which conversation the turn is in, and taking it from the
    // resolved promise means taking it minutes later — after a reply, and after
    // anything else has had a chance to move the view.
    await api.agent.send(state.chatId, prompt);
    await refreshChats();
  } catch (err) {
    status(err.message);
    activity(err.message, 'bad');
    if (!state.turnStarted) {
      if (!input.value) input.value = prompt;
      userTurn.remove();
    }
  } finally {
    setStreaming(false);
  }
}

/* ============================ event stream ============================ */

function handleEvent(payload) {
  const { event } = payload;

  switch (event) {
    case 'status':
      status(payload.text);
      break;

    case 'log':
      activity(payload.text);
      break;

    // Kept in `state` as well as painted: the button has to know whether it is
    // offering a check or a restart, and the box may be shut when this lands.
    case 'update:status':
      state.update = payload;
      paintUpdate(payload);
      break;

    case 'attach:changed':
      paintAttachments(payload.items ?? []);
      break;

    // The attachments went into the transcript, so the composer no longer owes
    // them: the main process says when, because it is what decided.
    case 'attach:consumed':
      paintAttachments([]);
      break;

    case 'turn:start':
      // From here on the user's message is persisted, so a later failure must
      // not put it back in the composer.
      state.turnStarted = true;
      // The first message of a session is what creates the chat, so this is
      // where a new conversation gets its id.
      if (payload.chatId) state.chatId = payload.chatId;
      break;

    case 'reply:start':
      state.streamRaw = '';
      state.streamEl = addTurn('assistant', '');
      state.streamEl.append(el('span', 'cursor'));
      scrollChat();
      break;

    case 'token': {
      state.streamRaw += payload.delta;
      if (state.streamEl) {
        // Mid-stream the fences are still being typed, so only reasoning is
        // split out here; action blocks are stripped once the reply lands.
        state.streamEl.textContent = state.streamRaw;
        state.streamEl.append(el('span', 'cursor'));
        scrollChat();
      }
      break;
    }

    case 'reply:end': {
      state.streamEl?.remove();
      state.streamEl = null;
      if (payload.error) {
        addTurn('assistant error', `✗ ${payload.error}`);
      } else {
        renderMessage({ role: 'assistant', content: payload.text });
      }
      if (payload.aborted) activity('stopped by user', 'bad');
      scrollChat();
      break;
    }

    case 'turn:end':
      // Backstop. `reply:end` normally clears the streaming element; this
      // catches any path that ended the turn without one, so a failure can
      // never leave a blinking cursor behind.
      state.streamEl?.remove();
      state.streamEl = null;
      break;

    case 'action:start': {
      const card = el('div', 'action-card');
      card.append(el('span', 'kind', `▶ ${payload.type}`));
      if (payload.steps) card.append(el('pre', '', payload.steps));
      $('chat-log').append(card);
      activity(`${payload.type}: ${(payload.steps || '').split('\n')[0] ?? ''}`);
      scrollChat();
      break;
    }

    case 'action:result': {
      const card = el('div', `action-card${payload.ok ? '' : ' failed'}`);
      card.append(el('span', 'kind', `${payload.ok ? '✓' : '✗'} ${payload.type}`));
      if (payload.summary) card.append(el('pre', '', payload.summary));
      $('chat-log').append(card);
      activity(`${payload.type} → ${payload.summary ?? ''}`, payload.ok ? 'ok' : 'bad');
      scrollChat();
      break;
    }

    case 'browser:step':
      activity(
        `${payload.outcome.ok ? '✓' : '✗'} ${payload.outcome.step}${
          payload.outcome.error ? ` — ${payload.outcome.error}` : ''
        }`,
        payload.outcome.ok ? 'ok' : 'bad',
      );
      break;

    case 'browser:state':
      paintBrowser(payload);
      break;

    case 'browser:log':
      activity(payload.line);
      break;

    case 'llm:state':
      paintLlm(payload);
      paintCompute(payload);
      // Only overwrite on an actual decision: an unload reports null, and
      // blanking the last explanation on unload loses useful information.
      if (payload.autoContext) state.autoContext = payload.autoContext;
      if (payload.autoGpu) state.autoGpu = payload.autoGpu;
      paintContextControls(state.autoContext);
      paintGpuControls(state.autoGpu);
      refreshVault();
      break;

    case 'llm:log':
      activity(payload.line);
      break;

    case 'tool:progress': {
      // The same event whether the download was asked for or triggered by a
      // model load that found nothing to spawn.
      if (payload.stage === 'start') {
        $('tool-status').textContent = 'Resolving release…';
        $('tool-meter').hidden = false;
        activity('fetching llama-server');
      } else if (payload.stage === 'status') {
        $('tool-status').textContent = payload.detail;
      } else if (payload.stage === 'progress') {
        $('tool-status').textContent = `${payload.percent.toFixed(1)}% (${formatSize(payload.received)}${
          payload.total ? ` / ${formatSize(payload.total)}` : ''
        })`;
        $('tool-meter').firstElementChild.style.width = `${payload.percent}%`;
      } else if (payload.stage === 'done') {
        $('tool-meter').hidden = true;
        $('tool-status').textContent = payload.error ? `Failed: ${payload.error}` : 'llama-server ready.';
        activity(payload.error ? `llama-server: ${payload.error}` : 'llama-server ready', payload.error ? 'bad' : 'ok');
        refreshTool();
      }
      break;
    }

    case 'ctx':
      paintCtx(payload);
      break;

    case 'chat:renamed':
      refreshChats();
      break;

    case 'chat:compacted':
      activity(`compacted ${payload.summarised} message(s)`, 'ok');
      loadChat(state.chatId);
      break;

    case 'plugins:changed':
      paintPlugins(payload.plugins ?? []);
      // Themes ride along: switching a theme pack off has to take its entry out
      // of the picker, and the two facts arrive from the same place.
      paintThemes(payload.themes ?? []);
      break;

    case 'plugins:progress':
      if (payload.stage === 'download' && payload.total) {
        $('store-status').textContent = `Downloading ${payload.id} — ${Math.round((payload.received / payload.total) * 100)}%`;
      } else if (payload.stage && payload.stage !== 'done') {
        $('store-status').textContent = `${payload.stage} ${payload.id}…`;
      }
      break;

    case 'audio:state':
      paintPlayer(payload);
      break;

    case 'config:changed':
      applySettings(payload.settings);
      // Setting a remote endpoint makes the local binary irrelevant, and
      // clearing one makes it required again.
      refreshTool();
      break;

    case 'shell:request':
      state.pendingShell = payload.id;
      $('shell-command').textContent = payload.command;
      $('shell-modal').hidden = false;
      break;

    case 'shell:resolved':
      // Someone else settled it — Stop, most likely. Take the dialog away
      // rather than leave buttons that would answer a request nobody awaits.
      if (state.pendingShell === payload.id) {
        state.pendingShell = null;
        $('shell-modal').hidden = true;
        if (!payload.approved) activity('shell command not run', 'bad');
      }
      break;

    case 'download:start':
      $('download-status').textContent = `Downloading ${payload.filename}…`;
      $('download-meter').hidden = false;
      $('btn-cancel-download').hidden = false;
      break;

    case 'download:progress': {
      // Speed and time left are each left out until they can be stated: a rate
      // of 0 B/s on the first chunk, or "0s left" before anything has been
      // measured, reads as a stalled download rather than a starting one.
      const parts = [
        `${payload.filename} — ${payload.percent.toFixed(1)}%`,
        `${formatSize(payload.received)}${payload.total ? ` / ${formatSize(payload.total)}` : ''}`,
      ];
      if (payload.bytesPerSecond) parts.push(`${formatSize(payload.bytesPerSecond)}/s`);
      if (payload.etaSeconds) parts.push(`${formatDuration(payload.etaSeconds)} left`);

      $('download-status').textContent = parts.join(' · ');
      $('download-meter').firstElementChild.style.width = `${payload.percent}%`;
      break;
    }

    case 'download:done':
      $('download-status').textContent = payload.cancelled
        ? 'Download cancelled.'
        : payload.error
          ? `Download failed: ${payload.error}`
          : `Downloaded ${payload.name}.`;
      $('download-meter').hidden = true;
      $('btn-cancel-download').hidden = true;
      refreshVault();
      break;

    default:
      break;
  }
}

/* ============================ wiring ============================ */

function wire() {
  $('btn-send').addEventListener('click', send);

  // Enter sends; Shift+Enter inserts a newline. `isComposing` guards IME input,
  // where Enter commits a candidate rather than ending the message — sending
  // there would cut a Ukrainian or CJK word in half.
  $('input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  });

  $('btn-expand').addEventListener('click', () => $('composer').classList.toggle('expanded'));

  // The links inside carry `target="_blank"`, which the main process turns into
  // `shell.openExternal` — this window must never navigate away from itself.
  const about = (open) => {
    $('about-modal').hidden = !open;
  };
  $('btn-about').addEventListener('click', () => about(true));

  $('btn-update').addEventListener('click', async () => {
    try {
      // One button, two jobs, because they are never both offered: RESTART only
      // appears once a build is downloaded and waiting.
      if (state.update?.state === 'ready') await api.updates.install();
      else paintUpdate(await api.updates.check());
    } catch (err) {
      paintUpdate({ state: 'error', message: err.message });
    }
  });
  $('btn-about-close').addEventListener('click', () => about(false));
  $('about-modal').addEventListener('click', (event) => {
    // Only the backdrop closes it; a click on the box itself must not, or
    // selecting the version text would dismiss the dialog.
    if (event.target === $('about-modal')) about(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') about(false);
  });

  $('btn-attach-file').addEventListener('click', () => attachVia(() => api.attach.pickFiles()));
  $('btn-attach-dir').addEventListener('click', () => attachVia(() => api.attach.pickFolder()));
  $('btn-attach-clear').addEventListener('click', async () => paintAttachments(await api.attach.clear()));
  wireDrop();

  $('toggle-panel').addEventListener('click', async () => {
    const open = !state.settings.leftPanelOpen;
    $('workspace').classList.toggle('panel-hidden', !open);
    await saveSetting({ leftPanelOpen: open });
  });

  $('btn-new-chat').addEventListener('click', () => loadChat(''));
  $('chat-current').addEventListener('click', (event) => {
    // Or the document handler below would close it again in the same click.
    event.stopPropagation();
    setChatMenu($('chat-menu').hidden);
  });

  // Clicks inside the menu are the menu's own business — picking closes it, and
  // deleting deliberately does not, so several can go in one visit.
  $('chat-menu').addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => setChatMenu(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setChatMenu(false);
  });

  $('btn-delete-chat').addEventListener('click', async () => {
    if (!state.chatId) return;
    if (state.streaming) return status('A turn is running — stop it before deleting a conversation.');
    await api.chats.remove(state.chatId);
    // Straight to a blank conversation: leaving the picker on a chat that no
    // longer exists would show a transcript with nothing behind it.
    await loadChat('');
  });

  $('btn-compact').addEventListener('click', async () => {
    if (!state.chatId) return status('Nothing to compact.');
    try {
      const done = await api.agent.compact(state.chatId);
      status(done ? 'Compacted.' : 'Too short to compact.');
      if (done) await loadChat(state.chatId);
    } catch (err) {
      status(err.message);
    }
  });

  $('btn-refresh-vault').addEventListener('click', refreshVault);

  $('btn-add-file').addEventListener('click', async () => {
    $('btn-add-file').disabled = true;
    try {
      const result = await api.models.addFile();
      if (result.canceled) $('vault-status').textContent = '';
      else if (result.added) $('vault-status').textContent = `Added ${result.path}`;
      else $('vault-status').textContent = `Not added — ${result.reason}.`;
      await refreshVault();
    } catch (err) {
      $('vault-status').textContent = err.message;
    } finally {
      $('btn-add-file').disabled = false;
    }
  });

  $('btn-search').addEventListener('click', runSearch);
  $('btn-clear-search').addEventListener('click', () => {
    $('model-search').value = '';
    $('search-results').replaceChildren();
    $('search-status').textContent = '';
  });
  $('model-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      runSearch();
    }
  });

  $('btn-fetch-llama').addEventListener('click', async () => {
    $('btn-fetch-llama').disabled = true;
    try {
      await api.llm.fetchTool();
    } catch (err) {
      $('tool-status').textContent = err.message;
      $('btn-fetch-llama').disabled = false;
    }
  });

  $('btn-download').addEventListener('click', async () => {
    const input = $('custom-model').value.trim();
    if (!input) return status('Search above, or paste a repo id or URL.');
    $('btn-download').disabled = true;
    try {
      $('download-status').textContent = 'Resolving…';
      await api.models.download(input);
    } catch (err) {
      $('download-status').textContent = err.message;
    } finally {
      $('btn-download').disabled = false;
    }
  });

  $('btn-cancel-download').addEventListener('click', () => api.models.cancelDownload());

  $('btn-browser-open').addEventListener('click', async () => {
    status('Opening browser…');
    try {
      paintBrowser(await api.browser.open());
      status('Browser ready.');
    } catch (err) {
      status(err.message);
      activity(err.message, 'bad');
    }
  });

  $('btn-browser-close').addEventListener('click', async () => paintBrowser(await api.browser.close()));

  $('btn-shell-approve').addEventListener('click', () => answerShell(true));
  $('btn-shell-reject').addEventListener('click', () => answerShell(false));

  bindRange('set-nctx', 'nCtx', 'val-nctx');
  bindCheck('set-auto-ctx', 'autoContext');
  bindCheck('set-auto-gpu', 'autoGpuLayers');
  bindCheck('set-thinking', 'thinking');
  bindRange('set-temp', 'temperature', 'val-temp', (v) => Number(v).toFixed(2));
  bindRange('set-ngl', 'ngl', 'val-ngl');

  bindText('set-endpoint', 'externalEndpoint');
  bindText('set-llama-path', 'llamaServerPath');
  bindText('set-system-prompt', 'systemPrompt');
  bindText('set-chrome', 'chromePath');

  bindCheck('set-browser-headless', 'browserHeadless');
  bindCheck('set-crt', 'crtEffects');

  $('btn-store-refresh').addEventListener('click', () => refreshStore());

  // Opening the section is asking what is available, so it asks. The boot fetch
  // is one moment in time and the answer it got can be minutes old by the time
  // anybody looks — which is exactly how a published update went unseen until
  // the app was restarted.
  $('section-store').addEventListener('toggle', (event) => {
    if (event.target.open) refreshStore();
  });

  $('set-theme').addEventListener('change', async (event) => {
    // Applied first, saved after: a stylesheet swap should feel instant, and
    // the write is a round trip.
    applyTheme(event.target.value);
    await saveSetting({ theme: event.target.value });
  });

  wirePlayer();

  $('set-crt').addEventListener('change', (event) => document.body.classList.toggle('no-crt', !event.target.checked));
}

async function answerShell(approved) {
  $('shell-modal').hidden = true;
  if (!state.pendingShell) return;
  await api.agent.answerShell(state.pendingShell, approved);
  state.pendingShell = null;
}

async function boot() {
  api.on(handleEvent);
  wire();

  const snapshot = await api.snapshot();
  $('about-version').textContent = `Version ${snapshot.version ?? '—'} · Apache 2.0`;
  state.update = snapshot.update ?? { state: 'idle' };
  paintUpdate(state.update);
  // Set before `applySettings`, which paints the context row from it.
  state.autoContext = snapshot.llm.autoContext ?? null;
  state.autoGpu = snapshot.llm.autoGpu ?? null;
  applySettings(snapshot.settings);
  paintLlm(snapshot.llm);
  paintCompute(snapshot.llm);
  paintBrowser({ ...snapshot.browser, engine: snapshot.engine });
  paintCtx({ used: 0, max: snapshot.settings.nCtx, percent: 0 });
  // A first paint from the snapshot, which may have been taken while discovery
  // was still running; `refreshPlugins` below waits for it to settle.
  paintPlugins(snapshot.plugins ?? []);
  // After `applySettings`, which is where the chosen theme comes from.
  paintThemes(snapshot.themes ?? []);
  paintPlayer(snapshot.audio ?? { source: null });

  // Attachments outlive a reload — they live in the main process — so the row
  // is painted from what is actually pending, not assumed empty.
  paintAttachments(await api.attach.list());

  await Promise.all([refreshVault(), refreshChats(), refreshTool(), refreshPlugins(), refreshThemes()]);

  if (!snapshot.engine) activity('manul-browser engine not built — run `npm run engine` for browser control.', 'bad');
  status('Ready');

  // Last, unawaited and quiet. It is what puts UPDATE on an installed row, so
  // it cannot wait for the section to be opened — but a machine with no network
  // must not open with an error about a list nobody asked to see.
  refreshStore({ quiet: true });
}

boot().catch((err) => {
  status(`Boot failed: ${err.message}`);
  activity(err.message, 'bad');
});
