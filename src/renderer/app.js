/**
 * The chat view.
 *
 * No framework and no local model of the pipeline: the main process owns every
 * piece of state that matters and announces changes on one event stream, so a
 * reload of this window can never leave the two disagreeing about whether a
 * turn is running.
 */
import { formatSize, splitThinking, stripActionBlocks } from '../shared/render.mjs';
import { parseMarkdown } from '../shared/markdown.mjs';

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

async function loadChat(id) {
  state.chatId = id ?? '';
  $('chat-log').replaceChildren();
  if (state.chatId) {
    const chat = await api.chats.read(state.chatId);
    for (const message of chat?.messages ?? []) renderMessage(message);
  }
  scrollChat();

  // The meter is otherwise only written mid-turn, so it would keep showing the
  // previous conversation's usage — which reads as NEW CHAT not having cleared
  // anything.
  try {
    paintCtx(await api.agent.context(state.chatId));
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

/** Where the loaded model is actually running — the question a size cannot answer. */
function paintCompute(llm) {
  state.llmReady = llm?.state === 'ready';
  const label = $('stat-compute');
  const auto = llm?.autoGpu;

  if (llm?.state !== 'ready' || !auto) {
    label.hidden = true;
    return;
  }

  const text =
    auto.layers === 0
      ? 'RUN: CPU'
      : auto.layers === 999
        ? 'RUN: GPU'
        : `RUN: GPU ${auto.layers} LAYERS + CPU`;

  label.hidden = false;
  label.textContent = text;
  label.title = auto.reason + (auto.vramBytes ? ` · ${(auto.vramBytes / 1024 ** 3).toFixed(1)} GB VRAM` : '');
  label.className = `stat ${auto.layers === 0 ? 'warn' : 'ok'}`;
}

function paintBrowser(browser) {
  const label = $('stat-browser');
  label.textContent = browser.open ? `BROWSER: ${(browser.mode || 'open').toUpperCase()}` : 'BROWSER: IDLE';
  label.className = `stat ${browser.open ? 'ok' : ''}`;

  const engine = $('stat-engine');
  engine.textContent = browser.engine ? 'ENGINE: MANUL-BROWSER' : 'ENGINE: MISSING';
  engine.className = `stat ${browser.engine ? '' : 'warn'}`;
}

function paintCtx({ used = 0, max = 0, percent = 0 } = {}) {
  const safePercent = Number.isFinite(percent) ? percent : 0;
  $('ctx-label').textContent = `CTX: ${used} / ${max} (${Math.round(safePercent)}%)`;
  const meter = $('ctx-meter');
  meter.className = `meter ctx${safePercent > 90 ? ' hot' : safePercent > 75 ? ' warn' : ''}`;
  meter.firstElementChild.style.width = `${Math.min(100, Math.max(0, safePercent))}%`;
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

  $('set-browser-enabled').checked = settings.browserEnabled;
  $('set-browser-headless').checked = settings.browserHeadless;
  $('set-chrome').value = settings.chromePath;

  $('set-allow-browser').checked = settings.allowBrowser;
  $('set-allow-lookup').checked = settings.allowWebLookup;
  $('set-allow-read').checked = settings.allowReadFile;
  $('set-thinking').checked = settings.thinking;
  $('set-allow-shell').checked = settings.allowShell;
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
    state.chatId = await api.agent.send(state.chatId, prompt);
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

    case 'download:progress':
      $('download-status').textContent = `${payload.filename} — ${payload.percent.toFixed(1)}% (${formatSize(
        payload.received,
      )}${payload.total ? ` / ${formatSize(payload.total)}` : ''})`;
      $('download-meter').firstElementChild.style.width = `${payload.percent}%`;
      break;

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

  bindCheck('set-browser-enabled', 'browserEnabled');
  bindCheck('set-browser-headless', 'browserHeadless');
  bindCheck('set-allow-browser', 'allowBrowser');
  bindCheck('set-allow-lookup', 'allowWebLookup');
  bindCheck('set-allow-read', 'allowReadFile');
  bindCheck('set-allow-shell', 'allowShell');
  bindCheck('set-crt', 'crtEffects');

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
  // Set before `applySettings`, which paints the context row from it.
  state.autoContext = snapshot.llm.autoContext ?? null;
  state.autoGpu = snapshot.llm.autoGpu ?? null;
  applySettings(snapshot.settings);
  paintLlm(snapshot.llm);
  paintCompute(snapshot.llm);
  paintBrowser({ ...snapshot.browser, engine: snapshot.engine });
  paintCtx({ used: 0, max: snapshot.settings.nCtx, percent: 0 });

  // Attachments outlive a reload — they live in the main process — so the row
  // is painted from what is actually pending, not assumed empty.
  paintAttachments(await api.attach.list());

  await Promise.all([refreshVault(), refreshChats(), refreshTool()]);

  if (!snapshot.engine) activity('manul-browser engine not built — run `npm run engine` for browser control.', 'bad');
  status('Ready');
}

boot().catch((err) => {
  status(`Boot failed: ${err.message}`);
  activity(err.message, 'bad');
});
