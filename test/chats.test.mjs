/**
 * Chat storage, driven against a scratch data root rather than the real one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatsDir, setDataRoot } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-data-')));

const chats = await import('../src/main/chats.mjs');

test('sanitizeTitle strips the decoration models wrap titles in', () => {
  assert.equal(chats.sanitizeTitle('  "Fixing the build"  '), 'Fixing the build');
  assert.equal(chats.sanitizeTitle('**Deploy notes**'), 'Deploy notes');
  assert.equal(chats.sanitizeTitle('Title: '), 'Title');
});

test('sanitizeTitle collapses whitespace runs and newlines', () => {
  assert.equal(chats.sanitizeTitle('a\n\nb   c'), 'a b c');
});

test('sanitizeTitle caps length on a word boundary', () => {
  const title = chats.sanitizeTitle('one two three four five six seven eight nine ten eleven');
  assert.ok(title.length <= 40, `too long: ${title.length}`);
  assert.ok(!title.endsWith(' '));
  assert.ok(title.split(' ').every((w) => 'one two three four five six seven eight nine ten eleven'.includes(w)));
});

test('sanitizeTitle keeps Cyrillic intact', () => {
  assert.equal(chats.sanitizeTitle('Огляд коду'), 'Огляд коду');
});

test('titleFromPrompt uses the first non-empty line', () => {
  assert.equal(chats.titleFromPrompt('\n\nopen youtube\nand play something'), 'open youtube');
});

test('titleFromPrompt falls back when there is nothing to use', () => {
  assert.equal(chats.titleFromPrompt('   '), 'New Chat');
});

test('append creates the chat lazily on the first message', () => {
  const chat = chats.append('', { role: 'user', content: 'hello there' });
  assert.ok(chat.id);
  assert.equal(chat.messages.length, 1);
  assert.equal(chats.read(chat.id).messages[0].content, 'hello there');
});

test('roles survive a round-trip, including a reply that starts with >', () => {
  const chat = chats.create('roles');
  chats.append(chat.id, { role: 'user', content: 'quote something' });
  chats.append(chat.id, { role: 'assistant', content: '> this looks like a prompt but is not' });
  chats.append(chat.id, { role: 'tool', content: '[BROWSER] ok' });

  const stored = chats.read(chat.id);
  assert.deepEqual(
    stored.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assert.equal(stored.messages[1].content, '> this looks like a prompt but is not');
});

test('list is newest first and counts user turns', () => {
  const older = chats.create('older');
  chats.append(older.id, { role: 'user', content: 'a' });
  chats.append(older.id, { role: 'assistant', content: 'b' });

  const listed = chats.list().find((c) => c.id === older.id);
  assert.equal(listed.turns, 1);
  assert.equal(chats.list()[0].updated >= chats.list().at(-1).updated, true);
});

test('overwrite replaces the message list without restamping the survivors', () => {
  const chat = chats.create('compact me');
  chats.append(chat.id, { role: 'user', content: 'one' });
  chats.append(chat.id, { role: 'assistant', content: 'two' });

  const stored = chats.read(chat.id);
  const keptStamp = stored.messages[1].ts;
  stored.messages = [{ role: 'tool', content: '[SUMMARY]' }, stored.messages[1]];
  chats.overwrite(stored);

  const after = chats.read(chat.id);
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[0].content, '[SUMMARY]');
  assert.equal(after.messages[1].ts, keptStamp);
});

test('rename ignores an empty proposal', () => {
  const chat = chats.create('keep me');
  assert.equal(chats.rename(chat.id, '   ').title, 'keep me');
  assert.equal(chats.rename(chat.id, 'renamed').title, 'renamed');
});

test('remove deletes the chat', () => {
  const chat = chats.create('temporary');
  assert.equal(chats.remove(chat.id), true);
  assert.equal(chats.read(chat.id), null);
});

test('a chat id that would escape the chats directory is refused', () => {
  // These arrive from IPC and are interpolated into a path, so a traversal
  // attempt must not read or delete anything outside chats/.
  const traversals = [
    '../../etc/passwd',
    '..\\..\\config', // Windows separators, escaped for the source
    'a/b',
    'a\\b',
    '.',
    '..',
    '',
    'has space',
    'quote"',
  ];
  for (const id of traversals) {
    assert.equal(chats.isSafeId(id), false, `${JSON.stringify(id)} should be rejected`);
    assert.equal(chats.read(id), null);
    assert.equal(chats.remove(id), false);
    assert.equal(chats.rename(id, 'nope'), null);
  }
});

test('generated ids are accepted by the same rule', () => {
  const chat = chats.create('naming');
  assert.equal(chats.isSafeId(chat.id), true, `${chat.id} should be allowed`);
  assert.ok(chats.read(chat.id));
});

// Reported as a chat "resurrecting": a turn was running, the conversation was
// deleted from the picker, and when the reply landed it reappeared as a fresh
// "New Chat" holding the reply and none of the words it was answering.
test('appending to a chat that was deleted mid-turn writes nowhere', () => {
  const chat = chats.create('Deleted while the reply was being written');
  chats.append(chat.id, { role: 'user', content: 'a question' });
  chats.remove(chat.id);
  const before = chats.list().length;

  assert.equal(chats.append(chat.id, { role: 'assistant', content: 'the reply' }), null);
  assert.equal(chats.append(chat.id, { role: 'tool', content: '[TOOL] ok' }), null);

  // The refusal is the point: not a new row, and not a revived old one either.
  assert.equal(chats.list().length, before);
  assert.equal(chats.read(chat.id), null);
});

test('an empty id still means "there is no chat yet", not "it is gone"', () => {
  const chat = chats.append('', { role: 'assistant', content: 'unprompted' });
  assert.ok(chat?.id);
  assert.equal(chat.messages.length, 1);
});

test('a half-written chat file does not take the picker down with it', () => {
  // A process that died mid-write leaves a truncated JSON file. It is one
  // conversation, and it must cost one conversation: a picker that throws while
  // being drawn loses every other chat in the app, which is the same failure
  // `#broken` exists to prevent on the plugin list.
  const good = chats.append('', { role: 'user', content: 'still here' });
  writeFileSync(join(chatsDir(), '20250101120000-abcdef.json'), '{"id":"20250101120000-abcdef","messa', 'utf8');

  const listed = chats.list();
  assert.ok(listed.some((row) => row.id === good.id), 'the readable conversations still list');
  assert.equal(listed.some((row) => row.id === '20250101120000-abcdef'), false, 'and the unreadable one is skipped');
  assert.equal(chats.read('20250101120000-abcdef'), null);
});
