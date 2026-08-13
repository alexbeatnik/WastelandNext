/**
 * Chat persistence.
 *
 * One JSON file per chat under `chats/`. The original stored a flat
 * `> prompt\nreply` transcript because C had no JSON to hand; here the roles
 * are kept structurally, so a reply that itself begins with `> ` cannot be
 * mistaken for a new turn.
 *
 * Chats are created lazily, on the first message. Clicking NEW CHAT and then
 * switching away leaves nothing behind.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatsDir } from './paths.mjs';

/** Longest title we keep, in characters (not bytes — JS strings are fine here). */
const TITLE_CAP = 40;

/**
 * Clean a model-proposed title down to something that fits a sidebar row.
 *
 * Strips markdown/punctuation noise the model wraps titles in, collapses
 * whitespace runs, and caps the length on a word boundary when it can.
 */
export function sanitizeTitle(raw) {
  if (!raw) return '';
  let title = String(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\s"'`*_#\-–—:.]+/u, '')
    .replace(/[\s"'`*_#\-–—:.]+$/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (title.length <= TITLE_CAP) return title;
  const cut = title.slice(0, TITLE_CAP);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > TITLE_CAP / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

/** First-pass title, taken from the user's own words before the model replies. */
export function titleFromPrompt(prompt) {
  const cleaned = sanitizeTitle(String(prompt ?? '').split('\n').find((l) => l.trim()) ?? '');
  return cleaned || 'New Chat';
}

function newId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ids we are willing to turn into a filename.
 *
 * `read`, `remove` and `rename` all take an id straight from an IPC call, and
 * an id is interpolated into a path. Without this a `../` in one would reach
 * outside the chats directory. The generated form is `<timestamp>-<random>`,
 * which this admits.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeId(id) {
  return SAFE_ID.test(String(id ?? ''));
}

function fileFor(id) {
  if (!isSafeId(id)) throw new Error(`unsafe chat id: ${id}`);
  return join(chatsDir(), `${id}.json`);
}

function readFile(id) {
  try {
    const chat = JSON.parse(readFileSync(fileFor(id), 'utf8'));
    if (!Array.isArray(chat.messages)) chat.messages = [];
    return chat;
  } catch {
    return null;
  }
}

function writeChat(chat) {
  mkdirSync(chatsDir(), { recursive: true });
  writeFileSync(fileFor(chat.id), `${JSON.stringify(chat, null, 2)}\n`, 'utf8');
  return chat;
}

/** Newest first — the order the sidebar shows them in. */
export function list() {
  const dir = chatsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readFile(f.slice(0, -5)))
    .filter(Boolean)
    .map(({ id, title, created, updated, messages }) => ({
      id,
      title,
      created,
      updated,
      turns: messages.filter((m) => m.role === 'user').length,
    }))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

export function read(id) {
  return id ? readFile(id) : null;
}

export function create(title) {
  const now = new Date().toISOString();
  return writeChat({
    id: newId(),
    title: sanitizeTitle(title) || 'New Chat',
    created: now,
    updated: now,
    messages: [],
  });
}

/** Append one message, creating the chat if this is the first thing said. */
export function append(id, message) {
  const chat = read(id) ?? create(message.role === 'user' ? titleFromPrompt(message.content) : '');
  chat.messages.push({ ...message, ts: new Date().toISOString() });
  chat.updated = new Date().toISOString();
  return writeChat(chat);
}

/**
 * Write a whole chat back as given.
 *
 * The rewriting path (compaction) replaces the message list wholesale, and
 * doing that through `append` would restamp every surviving message.
 */
export function overwrite(chat) {
  if (!chat?.id) return null;
  return writeChat({ ...chat, updated: new Date().toISOString() });
}

export function rename(id, title) {
  const chat = read(id);
  if (!chat) return null;
  const clean = sanitizeTitle(title);
  if (!clean) return chat;
  chat.title = clean;
  return writeChat(chat);
}

export function remove(id) {
  try {
    rmSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}
