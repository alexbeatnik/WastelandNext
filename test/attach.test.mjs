/**
 * Attaching a file or a folder to the conversation.
 *
 * The shape that matters: a user drops a project directory and asks what could
 * be improved. That has to arrive as a listing the model can reason about, with
 * the build output left out, the binaries named but not pasted, and the whole
 * thing bounded by whatever window happens to be loaded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Attachments,
  collect,
  formatAttachment,
  renderTree,
  vetAttachmentPath,
} from '../src/main/agent/attach.mjs';

/** A small project with everything the walk is supposed to have an opinion on. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'wl-attach-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(join(root, '.git'));

  writeFileSync(join(root, 'README.md'), '# Project\n\nWhat it is.\n');
  writeFileSync(join(root, 'package.json'), '{"name":"project"}\n');
  writeFileSync(join(root, 'src', 'main.mjs'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return root;
}

const rels = (result) => result.files.map((file) => file.rel.replace(/\\/g, '/')).sort();

/* ============================ the guardrail ============================ */

test('a credential directory is refused wherever it sits in the path', () => {
  const refused = vetAttachmentPath(join('C:', 'Users', 'someone', '.ssh', 'id_rsa'));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /credentials/);
});

test('an ordinary path outside home is allowed', () => {
  // Deliberately unlike `readfile.mjs`: there a *model* names the path, here a
  // person picked it. A checkout on another drive is not suspicious.
  assert.equal(vetAttachmentPath(join('D:', 'code', 'project')).ok, true);
});

test('an empty path is refused before it resolves to the working directory', () => {
  assert.equal(vetAttachmentPath('').ok, false);
  assert.equal(vetAttachmentPath('   ').ok, false);
});

test('a link pointing into a credential directory is refused by where it lands', async (t) => {
  // The walk already refuses to follow links; the path handed in is followed by
  // `stat` and `readFile` regardless, so a file called `notes.txt` that points
  // at `.ssh/id_rsa` would clear the name check and paste the key.
  const root = mkdtempSync(join(tmpdir(), 'wl-link-'));
  mkdirSync(join(root, '.ssh'));
  writeFileSync(join(root, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
  try {
    symlinkSync(join(root, '.ssh', 'id_rsa'), join(root, 'notes.txt'), 'file');
  } catch {
    return t.skip('this platform will not let an unprivileged process make a symlink');
  }

  const result = await collect(join(root, 'notes.txt'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /credentials/);
});

test('a folder link into a credential directory is refused as well', async () => {
  // A directory link is the shape Windows allows without privileges, so this is
  // the version of the check that runs on the platform the app ships to.
  const root = mkdtempSync(join(tmpdir(), 'wl-link-dir-'));
  mkdirSync(join(root, '.ssh'));
  writeFileSync(join(root, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
  symlinkSync(join(root, '.ssh'), join(root, 'keys'), 'junction');

  const result = await collect(join(root, 'keys'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /credentials/);
});

/* ============================ collecting ============================ */

test('a folder walk skips dependencies and version control', async () => {
  const result = await collect(makeProject());
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'dir');
  assert.deepEqual(rels(result), ['README.md', 'package.json', 'src/logo.png', 'src/main.mjs']);
});

test('a binary file is listed but never pasted', async () => {
  const result = await collect(makeProject());
  const png = result.files.find((file) => file.rel.endsWith('logo.png'));
  assert.equal(png.skipped, 'binary');
  assert.equal(png.text, undefined);
  assert.ok(png.size > 0, 'it should still be listed with its size');
});

test('a single file collects as itself', async () => {
  const root = makeProject();
  const result = await collect(join(root, 'README.md'));
  assert.equal(result.kind, 'file');
  assert.equal(result.files.length, 1);
  assert.match(result.files[0].text, /What it is/);
});

test('a missing path fails with a reason, not an exception', async () => {
  const result = await collect(join(tmpdir(), 'wl-attach-nothing-here-at-all'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /no such/);
});

/* ============================ rendering ============================ */

test('the tree indents by folder and carries sizes', () => {
  const tree = renderTree([
    { rel: 'README.md', size: 10, depth: 0 },
    { rel: join('src', 'main.mjs'), size: 20, depth: 1 },
  ]);
  assert.match(tree, /^README\.md {2}10B$/m);
  assert.match(tree, /^src\/$/m);
  assert.match(tree, /^ {2}main\.mjs {2}20B$/m);
});

test('the listing survives a budget too small for any file body', async () => {
  const result = await collect(makeProject());
  const text = formatAttachment(result, 60);

  assert.match(text, /Structure:/, 'the tree is the one thing that is never dropped');
  assert.match(text, /main\.mjs/);
  // And it says so, rather than letting the model assume it has seen everything.
  assert.match(text, /in the listing above with their sizes/);
});

test('a generous budget includes the file bodies', async () => {
  const result = await collect(makeProject());
  const text = formatAttachment(result, 100_000);
  assert.match(text, /export const answer = 42/);
  assert.match(text, /\[END ATTACHED FOLDER\]/);
});

test('a single attached file is never rendered as a listing alone', async () => {
  // The first body goes in even when it alone exceeds the budget: an attachment
  // that renders to a filename and nothing else looks exactly like a bug.
  const root = makeProject();
  const result = await collect(join(root, 'README.md'));
  assert.match(formatAttachment(result, 1), /What it is/);
});

test('the README is preferred when only one file fits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-attach-order-'));
  writeFileSync(join(root, 'zzz.mjs'), 'a'.repeat(400));
  writeFileSync(join(root, 'README.md'), 'read me first');

  const result = await collect(root);
  const text = formatAttachment(result, 120);
  assert.match(text, /read me first/, 'the README explains the rest and goes first');
});

/* ============================ the pending list ============================ */

test('attachments accumulate, drop out, and clear', async () => {
  const root = makeProject();
  const pending = new Attachments();

  await pending.add(root);
  await pending.add(join(root, 'README.md'));
  assert.equal(pending.size, 2);

  const [folder] = pending.list();
  assert.equal(folder.kind, 'dir');
  assert.ok(folder.files >= 4);

  pending.remove(folder.id);
  assert.equal(pending.size, 1);
  pending.clear();
  assert.equal(pending.size, 0);
});

test('the same path cannot be attached twice', async () => {
  const root = makeProject();
  const pending = new Attachments();
  await pending.add(root);
  await assert.rejects(() => pending.add(root), /already attached/);
});

test('a bad path rejects with something worth showing the user', async () => {
  const pending = new Attachments();
  await assert.rejects(() => pending.add(join(tmpdir(), 'wl-attach-absent')), /no such file or folder/);
  assert.equal(pending.size, 0);
});

test('an attachment goes into a conversation once, and stays attached', async () => {
  // Both halves of the rule, which sound contradictory and are not. The folder
  // is not sent twice — that would put the same thing in the prompt on every
  // turn, outside compaction. But it is not thrown away either: a chip that
  // vanished the moment a question was asked read as the app having discarded
  // it, and the user re-attached the same folder to ask a second question.
  const root = makeProject();
  const pending = new Attachments();
  await pending.add(root);

  const text = pending.take('chat-1', 100_000);
  assert.match(text, /\[ATTACHED FOLDER\]/);
  assert.equal(pending.take('chat-1', 100_000), '', 'a second turn must not resend the same folder');
  assert.equal(pending.size, 1, 'and it must still be attached');
});

test('a conversation that has not seen an attachment still gets it', async () => {
  // What is remembered is not "used up" but "this chat has it" — which is why
  // a folder attached once and asked about in two conversations reaches both.
  const root = makeProject();
  const pending = new Attachments();
  await pending.add(root);

  assert.match(pending.take('chat-1', 100_000), /\[ATTACHED FOLDER\]/);
  assert.match(pending.take('chat-2', 100_000), /\[ATTACHED FOLDER\]/, 'a second chat has never seen it');
  assert.equal(pending.take('chat-2', 100_000), '', 'but only once there, too');
});

test('the chips say which conversations already hold each attachment', async () => {
  const root = makeProject();
  const pending = new Attachments();
  await pending.add(root);

  assert.deepEqual(pending.list()[0].includedIn, [], 'nothing has been sent yet');
  pending.take('chat-1', 100_000);
  assert.deepEqual(pending.list()[0].includedIn, ['chat-1']);
  // Detaching forgets where it had been: the id is not reused, and a record
  // keyed by it would outlive everything that could read it.
  pending.remove(pending.list()[0].id);
  assert.equal(pending.size, 0);
});

test('the budget is shared out, not spent by whichever folder went first', async () => {
  const root = makeProject();
  const pending = new Attachments();
  await pending.add(root);
  await pending.add(join(root, 'src', 'main.mjs'));

  const text = pending.take('chat-1', 100_000);
  assert.match(text, /\[ATTACHED FOLDER\]/);
  assert.match(text, /\[ATTACHED FILE\]/, 'the second attachment must still be in there');
});
