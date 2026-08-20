/**
 * URL rewriting and quantisation choice — the two pure decisions in the model
 * manager, and the two a user notices immediately when they are wrong.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isShard, looksLikeRepoId, pickGgufFile, removeWhenReleased, resolveTarget, rewriteHuggingFaceUrl } from '../src/main/models/manager.mjs';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSize } from '../src/shared/render.mjs';

test('rewrites a blob URL into a resolve URL', () => {
  assert.equal(
    rewriteHuggingFaceUrl('https://huggingface.co/owner/repo/blob/main/model.gguf'),
    'https://huggingface.co/owner/repo/resolve/main/model.gguf',
  );
});

test('leaves a resolve URL alone', () => {
  const url = 'https://huggingface.co/owner/repo/resolve/main/model.gguf';
  assert.equal(rewriteHuggingFaceUrl(url), url);
});

test('does not rewrite a blob path on some other host', () => {
  const url = 'https://example.com/owner/repo/blob/main/model.gguf';
  assert.equal(rewriteHuggingFaceUrl(url), url);
});

test('does not rewrite the word blob inside a filename', () => {
  const url = 'https://huggingface.co/owner/repo/resolve/main/blob-model.gguf';
  assert.equal(rewriteHuggingFaceUrl(url), url);
});

test('handles empty input', () => {
  assert.equal(rewriteHuggingFaceUrl(''), '');
  assert.equal(rewriteHuggingFaceUrl(null), '');
});

test('tells a repo id from a URL', () => {
  assert.equal(looksLikeRepoId('Qwen/Qwen2.5-7B-Instruct-GGUF'), true);
  assert.equal(looksLikeRepoId('https://huggingface.co/owner/repo'), false);
  assert.equal(looksLikeRepoId('justaname'), false);
  assert.equal(looksLikeRepoId('a/b/c'), false);
});

test('prefers Q4_K_M when a repo offers several quantisations', () => {
  const files = ['README.md', 'model-Q8_0.gguf', 'model-Q4_K_M.gguf', 'model-Q5_K_M.gguf'];
  assert.equal(pickGgufFile(files), 'model-Q4_K_M.gguf');
});

test('falls back to the next preference when Q4_K_M is absent', () => {
  assert.equal(pickGgufFile(['model-Q8_0.gguf', 'model-Q5_K_M.gguf']), 'model-Q5_K_M.gguf');
});

test('skips multi-part shards, which one download cannot assemble', () => {
  const files = ['big-Q4_K_M-00001-of-00003.gguf', 'big-Q8_0.gguf'];
  assert.equal(pickGgufFile(files), 'big-Q8_0.gguf');
});

test('never falls back to a shard, even when the repo holds nothing else', () => {
  // One shard downloads cleanly, is a real GGUF of a plausible size, and is
  // accepted into the vault — and then fails inside llama-server minutes later,
  // long after the progress bar said the model had arrived. Refusing it here is
  // the only place the user can still be told something useful.
  const files = ['big-Q4_K_M-00001-of-00003.gguf', 'big-Q4_K_M-00002-of-00003.gguf'];
  assert.equal(pickGgufFile(files), null);
});

test('a shard is recognised by its numbering, not by anything around it', () => {
  assert.equal(isShard('big-Q4_K_M-00001-of-00003.gguf'), true);
  assert.equal(isShard('big-Q4_K_M.gguf'), false);
  // A version number is not a shard suffix; neither is a shard-shaped name that
  // is not at the end.
  assert.equal(isShard('model-v2-00001-of-00003-extra.gguf'), false);
  assert.equal(isShard('model-1-of-3.gguf'), false);
});

test('returns null when a repo holds no GGUF at all', () => {
  assert.equal(pickGgufFile(['README.md', 'config.json']), null);
});

test('formatSize reads the way a file listing should', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(4.4 * 1024 ** 3), '4.4 GB');
  assert.equal(formatSize(15 * 1024 ** 2), '15 MB');
});

test('a stray trailing slash is stripped rather than producing an empty filename', async () => {
  // Pasting from an address bar sometimes brings a slash along. The filename is
  // still recoverable, so recover it — the bug being guarded against is the
  // empty name that would turn into a write to the models directory itself.
  const target = await resolveTarget('https://huggingface.co/owner/repo/resolve/main/model.gguf/');
  assert.equal(target.filename, 'model.gguf');
});

test('a URL with no filename at all is refused', async () => {
  await assert.rejects(() => resolveTarget('https://huggingface.co/'), /names no file/);
  await assert.rejects(() => resolveTarget('https://huggingface.co///'), /names no file/);
});

test('a direct URL resolves to its filename', async () => {
  const target = await resolveTarget('https://huggingface.co/owner/repo/blob/main/model-Q4_K_M.gguf');
  assert.equal(target.filename, 'model-Q4_K_M.gguf');
  assert.match(target.url, /\/resolve\/main\//);
});

test('a percent-encoded filename is decoded for disk', async () => {
  const target = await resolveTarget('https://example.com/models/my%20model.gguf');
  assert.equal(target.filename, 'my model.gguf');
});

test('a repo id encodes its chosen filename the same way a direct URL does', async () => {
  // The repo-id branch built its own URL with `encodeURI`, so a `#` in a
  // filename ended the path and started a fragment — and this half had no test
  // on it. It now shares `downloadUrlFor` with the search list.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ siblings: [{ rfilename: 'model#2-Q4_K_M.gguf' }] }),
  });
  try {
    const target = await resolveTarget('owner/repo');
    assert.equal(target.url, 'https://huggingface.co/owner/repo/resolve/main/model%232-Q4_K_M.gguf');
    assert.equal(target.filename, 'model#2-Q4_K_M.gguf');
  } finally {
    globalThis.fetch = original;
  }
});

test('removeWhenReleased reports success when the file is already gone', async () => {
  assert.equal(await removeWhenReleased(join(tmpdir(), 'wl-not-here-at-all.part')), true);
});

test('removeWhenReleased deletes a file that is free', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wl-rm-')), 'a.part');
  writeFileSync(path, 'x');
  assert.equal(await removeWhenReleased(path), true);
  assert.equal(existsSync(path), false);
});
