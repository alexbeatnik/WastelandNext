/**
 * Model search: parsing quantisation names, ordering files, and shaping the
 * two HuggingFace responses. The network is stubbed — the API shapes here were
 * taken from real responses, so the fixtures are what the code will actually
 * meet.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  downloadUrlFor,
  isShard,
  listGgufFiles,
  parseQuant,
  searchModels,
  sortGgufFiles,
  toResult,
} from '../src/main/models/search.mjs';

/** Serve one JSON body for the next fetch, then restore. */
function stubFetch(body, { status = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/* ============================ quantisation names ============================ */

test('reads the quantisation out of a filename', () => {
  assert.equal(parseQuant('Qwen2.5-7B-Instruct-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(parseQuant('gemma-3-1b-it-Q8_0.gguf'), 'Q8_0');
  assert.equal(parseQuant('model-IQ3_XS.gguf'), 'IQ3_XS');
  assert.equal(parseQuant('llama-3.1-8b.F16.gguf'), 'F16');
});

test('prefers the longest match so Q4_K_M is not read as Q4_K_S', () => {
  assert.equal(parseQuant('x-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(parseQuant('x-Q4_K_S.gguf'), 'Q4_K_S');
  assert.equal(parseQuant('x-Q3_K_L.gguf'), 'Q3_K_L');
});

test('returns empty for a name with no quantisation in it', () => {
  assert.equal(parseQuant('model.gguf'), '');
  assert.equal(parseQuant(''), '');
  assert.equal(parseQuant(null), '');
});

test('does not match a quantisation glued into a longer word', () => {
  assert.equal(parseQuant('someQ4_K_Mthing.gguf'), '');
});

test('recognises a multi-part shard', () => {
  assert.equal(isShard('big-Q4_K_M-00001-of-00003.gguf'), true);
  assert.equal(isShard('big-Q4_K_M.gguf'), false);
});

/* ============================ ordering ============================ */

test('orders files as a quality ladder, cheapest first', () => {
  const files = [
    { name: 'a-Q8_0.gguf', quant: 'Q8_0', size: 8 },
    { name: 'a-Q4_K_M.gguf', quant: 'Q4_K_M', size: 4 },
    { name: 'a-Q2_K.gguf', quant: 'Q2_K', size: 2 },
    { name: 'a-Q6_K.gguf', quant: 'Q6_K', size: 6 },
  ];
  assert.deepEqual(
    sortGgufFiles(files).map((f) => f.quant),
    ['Q2_K', 'Q4_K_M', 'Q6_K', 'Q8_0'],
  );
});

test('unrecognised quantisations sort to the end rather than to the front', () => {
  const files = [
    { name: 'weird.gguf', quant: '', size: 1 },
    { name: 'a-Q4_K_M.gguf', quant: 'Q4_K_M', size: 4 },
  ];
  assert.deepEqual(
    sortGgufFiles(files).map((f) => f.name),
    ['a-Q4_K_M.gguf', 'weird.gguf'],
  );
});

test('sorting does not mutate the input', () => {
  const files = [
    { name: 'b', quant: 'Q8_0', size: 2 },
    { name: 'a', quant: 'Q2_K', size: 1 },
  ];
  const before = files.map((f) => f.name).join();
  sortGgufFiles(files);
  assert.equal(files.map((f) => f.name).join(), before);
});

/* ============================ URLs ============================ */

test('builds a resolve URL, encoding an awkward filename', () => {
  assert.equal(
    downloadUrlFor('owner/repo', 'my model Q4_K_M.gguf'),
    'https://huggingface.co/owner/repo/resolve/main/my%20model%20Q4_K_M.gguf',
  );
});

/* ============================ search ============================ */

test('shapes a search hit down to what the list shows', () => {
  const result = toResult({
    id: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    likes: 73,
    downloads: 241649,
    tags: ['gguf', 'en', 'uk', 'license:apache-2.0', 'conversational'],
    createdAt: '2024-09-16T14:13:33.000Z',
  });
  assert.equal(result.id, 'bartowski/Qwen2.5-7B-Instruct-GGUF');
  assert.equal(result.downloads, 241649);
  assert.equal(result.likes, 73);
  assert.deepEqual(result.languages, ['en', 'uk']);
  assert.equal(result.gated, false);
});

test('search filters to GGUF and sorts by downloads', async () => {
  const stub = stubFetch([{ id: 'a/b', downloads: 5, likes: 1, tags: [] }]);
  try {
    const results = await searchModels({ query: 'qwen 7b' });
    assert.equal(results.length, 1);
    assert.match(stub.calls[0], /filter=gguf/);
    assert.match(stub.calls[0], /sort=downloads/);
    assert.match(stub.calls[0], /search=qwen\+7b|search=qwen%207b/);
  } finally {
    stub.restore();
  }
});

test('an empty query does not hit the network', async () => {
  const stub = stubFetch([]);
  try {
    assert.deepEqual(await searchModels({ query: '   ' }), []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('entries without an id are dropped rather than rendered blank', async () => {
  const stub = stubFetch([{ downloads: 1 }, { id: 'a/b', downloads: 2 }]);
  try {
    const results = await searchModels({ query: 'x' });
    assert.deepEqual(results.map((r) => r.id), ['a/b']);
  } finally {
    stub.restore();
  }
});

test('an API error is reported with its status', async () => {
  const stub = stubFetch({ error: 'nope' }, { status: 503 });
  try {
    await assert.rejects(() => searchModels({ query: 'x' }), /503/);
  } finally {
    stub.restore();
  }
});

/* ============================ file listing ============================ */

const TREE = [
  { type: 'file', size: 3209, path: '.gitattributes' },
  { type: 'file', size: 1000, path: 'README.md' },
  {
    type: 'file',
    size: 135,
    lfs: { size: 4683073344, pointerSize: 135 },
    path: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
  },
  { type: 'file', size: 135, lfs: { size: 2780342976 }, path: 'Qwen2.5-7B-Instruct-IQ2_M.gguf' },
  { type: 'directory', path: 'subdir' },
];

test('lists only GGUF files, with their real LFS sizes', async () => {
  const stub = stubFetch(TREE);
  try {
    const files = await listGgufFiles('owner/repo');
    assert.deepEqual(files.map((f) => f.quant), ['IQ2_M', 'Q4_K_M']);
    // The pointer file is 135 bytes; the real thing is 4.68 GB.
    assert.equal(files.find((f) => f.quant === 'Q4_K_M').size, 4683073344);
  } finally {
    stub.restore();
  }
});

test('each listed file carries a ready-to-use download URL', async () => {
  const stub = stubFetch(TREE);
  try {
    const [first] = await listGgufFiles('owner/repo');
    assert.equal(first.url, 'https://huggingface.co/owner/repo/resolve/main/Qwen2.5-7B-Instruct-IQ2_M.gguf');
  } finally {
    stub.restore();
  }
});

test('shards are listed but flagged, so the UI can explain them', async () => {
  const stub = stubFetch([
    { type: 'file', size: 10, lfs: { size: 40e9 }, path: 'big-Q4_K_M-00001-of-00003.gguf' },
  ]);
  try {
    const [file] = await listGgufFiles('owner/repo');
    assert.equal(file.shard, true);
  } finally {
    stub.restore();
  }
});

test('a repository with no GGUF files yields an empty list, not an error', async () => {
  const stub = stubFetch([{ type: 'file', size: 1, path: 'README.md' }]);
  try {
    assert.deepEqual(await listGgufFiles('owner/repo'), []);
  } finally {
    stub.restore();
  }
});

test('listing refuses an empty repository id before hitting the network', async () => {
  const stub = stubFetch([]);
  try {
    await assert.rejects(() => listGgufFiles('  '), /no repository/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});
