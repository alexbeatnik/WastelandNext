/**
 * Interrupted downloads, and the placement estimate shown before one starts.
 *
 * The resume path is what turns a failed transfer from "start the 25 GB again"
 * into "carry on", and the `.part` file surviving a failure is the whole
 * mechanism — so that is what these pin.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataRoot } from '../src/main/paths.mjs';

setDataRoot(mkdtempSync(join(tmpdir(), 'wl-dl-')));

const { discardPartial, download, listPartials } = await import('../src/main/models/manager.mjs');
const { modelsDir } = await import('../src/main/paths.mjs');
const { placementForSize } = await import('../src/main/llm/gpu.mjs');

/** Serve `body`, recording the request so the Range header can be checked. */
function serve(body, { status = 200, headers = {} } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers ?? {} });
    return new Response(body, { status, headers: { 'content-length': String(body.length), ...headers } });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('a download lands in the vault under its own name', async () => {
  const stub = serve('GGUF-whole-file');
  try {
    const result = await download({ url: 'https://x/model.gguf', filename: 'model.gguf' });
    assert.equal(result.name, 'model.gguf');
    assert.equal(readFileSync(join(modelsDir(), 'model.gguf'), 'utf8'), 'GGUF-whole-file');
  } finally {
    stub.restore();
  }
});

test('an interrupted transfer keeps its .part file', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('GGUF-half'));
          controller.error(new Error('connection reset'));
        },
      }),
      { headers: { 'content-length': '99' } },
    );
  try {
    await assert.rejects(() => download({ url: 'https://x/big.gguf', filename: 'big.gguf' }));
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(existsSync(join(modelsDir(), 'big.gguf.part')), true, 'the partial must survive for resuming');
  assert.equal(existsSync(join(modelsDir(), 'big.gguf')), false, 'an incomplete file must not look finished');
});

test('the interrupted transfer is listed as resumable', async () => {
  const partials = await listPartials();
  const entry = partials.find((p) => p.name === 'big.gguf');
  assert.ok(entry, 'expected the partial to be listed');
  // Whatever the stream managed to flush before the error, not a fixed count:
  // the tail sitting in a buffer when the connection drops is simply lost, and
  // the resume asks from whatever did land.
  assert.equal(typeof entry.received, 'number');
});

test('resuming asks for exactly the bytes on disk and appends the rest', async () => {
  // Written directly so the resume offset is known, rather than depending on
  // how much of a failed stream happened to be flushed.
  writeFileSync(join(modelsDir(), 'big.gguf.part'), 'GGUF-half');

  const stub = serve('-and-the-rest', { status: 206, headers: { 'content-range': 'bytes 9-21/22' } });
  try {
    const result = await download({ url: 'https://x/big.gguf', filename: 'big.gguf' });
    assert.equal(stub.calls[0].headers.Range, 'bytes=9-');
    assert.equal(readFileSync(join(modelsDir(), 'big.gguf'), 'utf8'), 'GGUF-half-and-the-rest');
    assert.equal(result.size, 22);
  } finally {
    stub.restore();
  }
});

test('a fresh download sends no Range header at all', async () => {
  const stub = serve('GGUF-fresh');
  try {
    await download({ url: 'https://x/fresh.gguf', filename: 'fresh.gguf' });
    assert.deepEqual(stub.calls[0].headers, {});
  } finally {
    stub.restore();
  }
});

test('a 206 with nothing to resume does not put the writer into append mode', async () => {
  // A server volunteering 206 when we asked for no range must not cause the
  // body to be appended to whatever happened to be there.
  const stub = serve('GGUF-body', { status: 206 });
  try {
    await download({ url: 'https://x/odd.gguf', filename: 'odd.gguf' });
    assert.equal(readFileSync(join(modelsDir(), 'odd.gguf'), 'utf8'), 'GGUF-body');
  } finally {
    stub.restore();
  }
});

test('a server that ignores the range restarts rather than corrupting the file', async () => {
  writeFileSync(join(modelsDir(), 'again.gguf.part'), 'stale-bytes');
  // 200, not 206: the body is the whole file, so appending would duplicate.
  const stub = serve('GGUF-complete-body');
  try {
    await download({ url: 'https://x/again.gguf', filename: 'again.gguf' });
    assert.equal(readFileSync(join(modelsDir(), 'again.gguf'), 'utf8'), 'GGUF-complete-body');
  } finally {
    stub.restore();
  }
});

test('discarding a partial removes it and nothing else', async () => {
  writeFileSync(join(modelsDir(), 'junk.gguf.part'), 'x');
  await discardPartial('junk.gguf');
  assert.equal(existsSync(join(modelsDir(), 'junk.gguf.part')), false);
  assert.equal(existsSync(join(modelsDir(), 'model.gguf')), true, 'finished models must be untouched');
});

test('listPartials ignores finished models', async () => {
  const names = (await listPartials()).map((p) => p.name);
  assert.equal(names.includes('model.gguf'), false);
});

/* ============================ placement estimate ============================ */

const GB = 1024 ** 3;

test('a model comfortably smaller than the card is called GPU', () => {
  assert.equal(placementForSize(4 * GB, 12 * GB), 'gpu');
});

test('a model a little too big is called partial, not GPU', () => {
  assert.equal(placementForSize(11 * GB, 12 * GB), 'partial');
});

test('a model many times the card is called CPU', () => {
  assert.equal(placementForSize(70 * GB, 12 * GB), 'cpu');
});

test('with no card detected the estimate declines to guess', () => {
  assert.equal(placementForSize(4 * GB, 0), 'unknown');
  assert.equal(placementForSize(0, 12 * GB), 'unknown');
});

test('the estimate is monotonic in size', () => {
  const order = { gpu: 0, partial: 1, cpu: 2 };
  let previous = -1;
  for (const gb of [1, 4, 8, 11, 20, 40, 80]) {
    const rank = order[placementForSize(gb * GB, 12 * GB)];
    assert.ok(rank >= previous, `${gb} GB ranked below a smaller model`);
    previous = rank;
  }
});

test('the estimate is not fooled by a model that only just fits on paper', () => {
  // 8.2 GB of weights on a 12 GB card leaves too little for a 32k KV cache;
  // the exact plan puts 23 of 32 layers on the GPU, so "gpu" would mislead.
  assert.equal(placementForSize(8.2 * GB, 12 * GB), 'partial');
});

test('a comfortably small model is still called GPU', () => {
  assert.equal(placementForSize(6.9 * GB, 12 * GB), 'gpu');
});
