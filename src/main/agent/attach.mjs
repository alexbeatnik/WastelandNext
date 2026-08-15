/**
 * Files and folders the *user* put in front of the model.
 *
 * Distinct from `readfile.mjs` on purpose. There a model names a path and the
 * app decides whether to obey, so the reach is confined to the home directory.
 * Here a person has pointed at something through a file dialog or dropped it on
 * the window — an explicit act, and a project checked out on another drive is
 * ordinary. So the home-directory confinement does not apply; the credential
 * directories still do, because "I dragged the wrong folder in" is a mistake
 * worth catching whoever made it.
 *
 * Collection and formatting are deliberately separate. What a folder *contains*
 * is settled when it is attached; how much of it fits in a prompt cannot be,
 * because the window belongs to whichever model is loaded at the time — and on
 * a small one the structure alone is worth more than three files read in full.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { estimateTokens } from '../llm/client.mjs';
import { SECRET_DIRS } from './readfile.mjs';

/** Never walked into: build output and dependency trees, which are not the project. */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', 'coverage',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'venv', '.venv', 'env',
  'vendor', 'Pods', '.gradle', '.idea', '.vs', 'bin', 'obj',
]);

/** Extensions never worth sniffing: known binary, and often very large. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'psd',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar', 'whl',
  'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib', 'pdb',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'sqlite', 'db',
  'gguf', 'safetensors', 'onnx', 'pt', 'pth', 'ttf', 'otf', 'woff', 'woff2',
]);

/** Names worth reading before anything else — they explain the rest. */
const PRIORITY_NAMES = [
  'readme.md', 'readme', 'claude.md', 'agents.md', 'contributing.md', 'roadmap.md',
  'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml',
  'makefile', 'dockerfile', 'tsconfig.json', 'requirements.txt',
];

/** Walk limits. A folder is a convenience, not an excuse to read a disk. */
export const MAX_DEPTH = 8;
export const MAX_FILES = 600;
/** Biggest single file body kept. Beyond this the head is kept and marked. */
export const MAX_FILE_BYTES = 64 * 1024;
/** Everything held for one attachment, before any prompt budget is applied. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Refuse a path that leads somewhere nobody meant to share. */
export function vetAttachmentPath(input) {
  const raw = String(input ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return { ok: false, reason: 'no path given' };

  const full = resolve(raw);
  const secret = full.split(sep).find((segment) => SECRET_DIRS.has(segment.toLowerCase()));
  if (secret) return { ok: false, reason: `${secret} holds credentials` };
  return { ok: true, path: full };
}

/** Does this look like text? Extension first, then a NUL-byte sniff. */
function looksBinary(name, buffer) {
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (BINARY_EXTENSIONS.has(extension)) return true;
  // A NUL in the first few kilobytes is the classic test, and the one `git`
  // itself uses. Cheap, and wrong far less often than an extension allowlist.
  return buffer.subarray(0, 8192).includes(0);
}

/** Read one file as text, or say why it was not. */
async function readEntry(path, name, size) {
  if (size > MAX_TOTAL_BYTES) return { skipped: 'too large' };
  let buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    return { skipped: err.code === 'EACCES' ? 'no permission' : 'unreadable' };
  }
  if (looksBinary(name, buffer)) return { skipped: 'binary' };

  const truncated = buffer.length > MAX_FILE_BYTES;
  return {
    text: buffer.subarray(0, MAX_FILE_BYTES).toString('utf8'),
    truncated,
  };
}

/**
 * Order files by how much they explain per byte read.
 *
 * A README and a manifest first, then shallow before deep and small before
 * large — small top-level files are cheap and say what a project *is*, which is
 * exactly what "look at the structure and suggest improvements" needs. Reading
 * one 60 KB module instead would answer a question nobody asked.
 */
function byUsefulness(a, b) {
  const rank = (file) => {
    const index = PRIORITY_NAMES.indexOf(basename(file.rel).toLowerCase());
    return index === -1 ? PRIORITY_NAMES.length : index;
  };
  return rank(a) - rank(b) || a.depth - b.depth || a.size - b.size || a.rel.localeCompare(b.rel);
}

/**
 * Gather a file or a whole directory tree.
 *
 * Everything found is listed; only what fits the walk limits is read. A file
 * that could not be read is still reported with the reason, because a silent
 * omission looks to the user like the app ignored what they dropped.
 */
export async function collect(input) {
  const vetted = vetAttachmentPath(input);
  if (!vetted.ok) return { ok: false, reason: vetted.reason };

  // The walk below refuses to follow links; the path handed in is followed by
  // `stat` and `readFile` whether we like it or not, so it is vetted by where
  // it lands rather than by what it is called. A file named `notes.txt` that
  // points at `~/.ssh/id_rsa` otherwise clears the name check and then pastes
  // the key into the prompt.
  let landed;
  try {
    landed = vetAttachmentPath(await realpath(vetted.path));
  } catch {
    return { ok: false, reason: 'no such file or folder' };
  }
  if (!landed.ok) return { ok: false, reason: `${landed.reason} — that path is a link` };

  let info;
  try {
    info = await stat(landed.path);
  } catch {
    return { ok: false, reason: 'no such file or folder' };
  }

  if (info.isFile()) {
    const entry = await readEntry(landed.path, basename(landed.path), info.size);
    if (entry.skipped) return { ok: false, reason: entry.skipped };
    return {
      ok: true,
      kind: 'file',
      path: landed.path,
      name: basename(landed.path),
      bytes: info.size,
      files: [{ rel: basename(landed.path), size: info.size, depth: 0, ...entry }],
      truncatedWalk: false,
    };
  }
  if (!info.isDirectory()) return { ok: false, reason: 'not a file or folder' };

  const files = [];
  let bytes = 0;
  let truncatedWalk = false;

  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
      truncatedWalk = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is reported by its absence, not a throw
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncatedWalk = true;
        return;
      }
      // Symlinks are not followed: a link back up the tree turns a walk into a
      // loop, and the target is reachable on its own if the user wants it.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || SECRET_DIRS.has(entry.name.toLowerCase())) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      let size = 0;
      try {
        ({ size } = await stat(full));
      } catch {
        continue;
      }
      const rel = relative(landed.path, full);
      const record = { rel, size, depth };
      if (bytes < MAX_TOTAL_BYTES) {
        Object.assign(record, await readEntry(full, entry.name, size));
        bytes += record.text ? Buffer.byteLength(record.text) : 0;
      } else {
        record.skipped = 'past the size limit';
      }
      files.push(record);
    }
  };

  await walk(landed.path, 0);

  return {
    ok: true,
    kind: 'dir',
    path: landed.path,
    name: basename(landed.path) || landed.path,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
    truncatedWalk,
  };
}

/** Draw the listing: one line per file, indented by folder, sizes on the right. */
export function renderTree(files) {
  const lines = [];
  let previous = [];
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const parts = file.rel.split(/[/\\]/);
    const dirs = parts.slice(0, -1);
    for (let i = 0; i < dirs.length; i += 1) {
      if (previous[i] !== dirs[i]) {
        lines.push(`${'  '.repeat(i)}${dirs[i]}/`);
        previous = dirs.slice(0, i + 1);
      }
    }
    previous = dirs;
    const note = file.skipped ? ` (${file.skipped})` : '';
    lines.push(`${'  '.repeat(dirs.length)}${parts.at(-1)}  ${file.size}B${note}`);
  }
  return lines.join('\n');
}

/**
 * Render one attachment into as much prompt as it is allowed.
 *
 * The listing is never dropped. It is the cheapest thing here and the most
 * useful — "what is the shape of this project" is answerable from names alone,
 * and a model that has been shown the tree can ask for a file it wants. Bodies
 * are filled in until the budget runs out and the rest are named as such, so
 * the model can tell "there is no more" from "there is more I have not seen".
 */
export function formatAttachment(item, budgetTokens = Infinity) {
  const tree = renderTree(item.files);
  const head =
    item.kind === 'file'
      ? `[ATTACHED FILE] ${item.path}`
      : `[ATTACHED FOLDER] ${item.path} — ${item.files.length} file(s)${item.truncatedWalk ? ', listing cut short at the walk limit' : ''}`;

  const lines = [head];
  if (item.kind === 'dir') lines.push('', 'Structure:', tree);

  const readable = item.files.filter((file) => file.text !== undefined).sort(byUsefulness);
  const included = [];
  let spent = estimateTokens(lines.join('\n'));

  for (const file of readable) {
    const block = `\n=== ${file.rel} ===\n${file.text}${file.truncated ? '\n… (file truncated)' : ''}`;
    const cost = estimateTokens(block);
    if (spent + cost > budgetTokens && included.length > 0) break;
    // The first file goes in even when it alone blows the budget: an attachment
    // that renders to a listing and nothing else, for a single dropped file, is
    // indistinguishable from a bug. `fitToWindow` is what stops it overflowing.
    included.push(block);
    spent += cost;
  }

  if (included.length > 0) {
    lines.push('', item.kind === 'file' ? 'Contents:' : 'Contents of the files that fit:', ...included);
  }

  const omitted = readable.length - included.length;
  const closer = item.kind === 'file' ? '[END ATTACHED FILE]' : '[END ATTACHED FOLDER]';
  lines.push(
    '',
    omitted > 0
      ? `${closer} ${included.length} of ${readable.length} readable file(s) shown in full; the other ${omitted} are in the listing above with their sizes. Ask for one by name if you need it.`
      : closer,
  );
  return lines.join('\n');
}

/**
 * What the user has attached, and which conversations have already seen it.
 *
 * Two rules that sound contradictory and are not.
 *
 * An attachment **stays attached until the user detaches it**. The first version
 * emptied the list at send time, and a chip that vanished the moment a question
 * was asked read as the app having thrown the folder away — the user then
 * re-attached it to ask a second question about the same project. What they were
 * telling the app was "this is what I am working on", which does not stop being
 * true after one message. Nothing is removed here except by `remove` or
 * `clear`, both of which are buttons.
 *
 * An attachment is nevertheless **folded into a conversation exactly once**.
 * Re-sending it every turn would put the same folder in the prompt five times in
 * five turns, and would keep it outside compaction — the one thing that can
 * shrink it once the conversation grows. Once it is in the transcript the model
 * can already see it; sending it again buys nothing and costs the window.
 *
 * So what is remembered is not "has this been used up" but "has this chat seen
 * it". A folder attached once and asked about in two conversations goes into
 * both — which is why the record is per chat rather than a single flag.
 */
export class Attachments {
  #items = [];
  /** `attachment id → Set(chat id)`: where each one has already been folded in. */
  #included = new Map();

  /** Attach a path. Returns the stored item, or throws with a reason to show. */
  async add(path) {
    const collected = await collect(path);
    if (!collected.ok) throw new Error(`${basename(String(path))}: ${collected.reason}`);
    if (this.#items.some((item) => item.path === collected.path)) {
      throw new Error(`${collected.name} is already attached`);
    }
    const item = { id: randomUUID(), ...collected };
    this.#items.push(item);
    return this.summary(item);
  }

  #chatsFor(id) {
    if (!this.#included.has(id)) this.#included.set(id, new Set());
    return this.#included.get(id);
  }

  /** What the composer draws: no file bodies, so the IPC reply stays small. */
  summary(item) {
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      path: item.path,
      files: item.files.length,
      bytes: item.bytes,
      /**
       * The chats this one is already part of.
       *
       * Sent as a list rather than resolved here against "the current chat",
       * because the main process does not have one — the renderer knows which
       * conversation is on screen, and it is the only thing that does.
       */
      includedIn: [...this.#chatsFor(item.id)],
    };
  }

  list() {
    return this.#items.map((item) => this.summary(item));
  }

  get size() {
    return this.#items.length;
  }

  remove(id) {
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#included.delete(id);
    return this.list();
  }

  clear() {
    this.#items = [];
    this.#included.clear();
    return [];
  }

  /**
   * Render whatever this chat has not seen yet into one message.
   *
   * The list is left alone — see the note above — but every attachment rendered
   * here is marked as having reached this conversation, so the next turn in it
   * sends nothing. Returns '' when there is nothing new, which is the ordinary
   * case for every turn after the first.
   *
   * `budgetTokens` is shared out evenly rather than first-come: three folders
   * where the first eats the whole budget is not what dropping three folders
   * asked for.
   */
  take(chatId, budgetTokens = Infinity) {
    const chat = String(chatId ?? '');
    const pending = this.#items.filter((item) => !this.#chatsFor(item.id).has(chat));
    if (pending.length === 0) return '';

    const share = Number.isFinite(budgetTokens) ? Math.floor(budgetTokens / pending.length) : Infinity;
    const text = pending.map((item) => formatAttachment(item, share)).join('\n\n');
    for (const item of pending) this.#chatsFor(item.id).add(chat);
    return text;
  }
}
