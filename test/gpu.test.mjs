/**
 * Fitting layers onto the card.
 *
 * The numbers below are the case that prompted this: a 25 GB model, a 12 GB
 * card, and a request to offload everything — which llama.cpp answers by
 * allocating until the driver refuses and then exiting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextForFullOffload, recommendGpuLayers } from '../src/main/llm/gpu.mjs';

const GB = 1024 ** 3;

/** Roughly a 30B: 48 blocks, GQA, 25 GB on disk at Q6. */
const BIG = { blockCount: 48, embeddingLength: 6144, headCount: 48, headCountKv: 8 };
/** Roughly a 1B. */
const SMALL = { blockCount: 26, embeddingLength: 1152, headCount: 4, headCountKv: 1 };

test('a 25 GB model on a 12 GB card offloads part of itself, not all of it', () => {
  const result = recommendGpuLayers({
    meta: BIG,
    fileSize: 25 * GB,
    contextTokens: 32768,
    kvBytesPerToken: 32768,
    vramBytes: 12 * GB,
  });
  assert.ok(result.layers > 0, 'expected some layers on the GPU');
  assert.ok(result.layers < BIG.blockCount, `expected a partial offload, got ${result.layers}`);
  assert.match(result.reason, /fit in VRAM/);
});

test('a model that fits asks for everything', () => {
  const result = recommendGpuLayers({
    meta: SMALL,
    fileSize: 0.8 * GB,
    contextTokens: 32768,
    kvBytesPerToken: 29952,
    vramBytes: 12 * GB,
  });
  assert.equal(result.layers, 999);
  assert.match(result.reason, /whole model fits/);
});

test('unknown VRAM leaves the request as full offload', () => {
  const result = recommendGpuLayers({ meta: BIG, fileSize: 25 * GB, vramBytes: 0 });
  assert.equal(result.layers, 999);
  assert.match(result.reason, /VRAM unknown/);
});

test('an unreadable header leaves the request alone too', () => {
  const result = recommendGpuLayers({ meta: null, fileSize: 25 * GB, vramBytes: 12 * GB });
  assert.equal(result.layers, 999);
  assert.match(result.reason, /shape unknown/);
});

test('a context that alone fills the card falls back to the CPU', () => {
  const result = recommendGpuLayers({
    meta: BIG,
    fileSize: 25 * GB,
    contextTokens: 131072,
    kvBytesPerToken: 200_000,
    vramBytes: 8 * GB,
  });
  assert.equal(result.layers, 0);
  assert.match(result.reason, /CPU/);
});

test('a tiny card that cannot hold one layer falls back to the CPU', () => {
  const result = recommendGpuLayers({
    meta: BIG,
    fileSize: 25 * GB,
    contextTokens: 2048,
    kvBytesPerToken: 32768,
    vramBytes: 1 * GB,
  });
  assert.equal(result.layers, 0);
  assert.match(result.reason, /CPU/);
});

test('a bigger card takes more layers than a smaller one', () => {
  const shared = { meta: BIG, fileSize: 25 * GB, contextTokens: 8192, kvBytesPerToken: 32768 };
  const small = recommendGpuLayers({ ...shared, vramBytes: 8 * GB }).layers;
  const large = recommendGpuLayers({ ...shared, vramBytes: 16 * GB }).layers;
  assert.ok(large > small, `${large} should exceed ${small}`);
});

test('a larger context leaves room for fewer layers', () => {
  const shared = { meta: BIG, fileSize: 25 * GB, kvBytesPerToken: 32768, vramBytes: 12 * GB };
  const tight = recommendGpuLayers({ ...shared, contextTokens: 65536 }).layers;
  const roomy = recommendGpuLayers({ ...shared, contextTokens: 2048 }).layers;
  assert.ok(roomy > tight, `${roomy} should exceed ${tight}`);
});

test('the answer never exceeds the layers the model actually has', () => {
  for (const vram of [4, 8, 12, 16, 24, 48].map((gb) => gb * GB)) {
    const { layers } = recommendGpuLayers({
      meta: BIG,
      fileSize: 25 * GB,
      contextTokens: 8192,
      kvBytesPerToken: 32768,
      vramBytes: vram,
    });
    assert.ok(layers === 999 || (layers >= 0 && layers <= BIG.blockCount), `${layers} out of range`);
  }
});

/* ============================ trading context for offload ============================ */

/** The real case: Qwen3.5-9B UD-Q6_K_XL on a 12 GB card. */
const QWEN9B = { fileSize: 8.16 * GB, kvBytesPerToken: 128 * 1024, vramBytes: 11.94 * GB };

test('finds the largest context that keeps every layer on the card', () => {
  const context = contextForFullOffload({ ...QWEN9B, maxContext: 32768 });
  assert.ok(context > 0, 'expected a workable context');
  assert.equal(context % 512, 0);

  // The point of it: at this context the whole model fits, one step up it does not.
  const meta = { blockCount: 32, embeddingLength: 4096, headCount: 16, headCountKv: 4 };
  const fits = recommendGpuLayers({ meta, ...QWEN9B, contextTokens: context });
  const overshoots = recommendGpuLayers({ meta, ...QWEN9B, contextTokens: context + 512 });
  assert.equal(fits.layers, 999, `expected full offload at ${context}`);
  assert.notEqual(overshoots.layers, 999, `${context + 512} should no longer fit`);
});

test('never raises the context above the ceiling it was given', () => {
  const context = contextForFullOffload({ ...QWEN9B, maxContext: 4096 });
  assert.ok(context <= 4096, `${context} exceeded the ceiling`);
});

test('declines when the weights alone do not fit', () => {
  // The 30B: no context, however small, puts every layer on a 12 GB card.
  assert.equal(contextForFullOffload({ fileSize: 24 * GB, kvBytesPerToken: 84 * 1024, vramBytes: 12 * GB, maxContext: 32768 }), 0);
});

test('declines rather than proposing a uselessly short context', () => {
  // Room for only ~2k tokens is not a trade worth making.
  const context = contextForFullOffload({
    fileSize: 10.2 * GB,
    kvBytesPerToken: 128 * 1024,
    vramBytes: 11.94 * GB,
    maxContext: 32768,
    floor: 4096,
  });
  assert.equal(context, 0);
});

test('declines when anything it needs is unknown', () => {
  assert.equal(contextForFullOffload({ ...QWEN9B, maxContext: 0 }), 0);
  assert.equal(contextForFullOffload({ ...QWEN9B, vramBytes: 0, maxContext: 32768 }), 0);
  assert.equal(contextForFullOffload({ ...QWEN9B, kvBytesPerToken: 0, maxContext: 32768 }), 0);
  assert.equal(contextForFullOffload({}), 0);
});

test('a bigger card buys a longer context', () => {
  const small = contextForFullOffload({ ...QWEN9B, vramBytes: 12 * GB, maxContext: 131072 });
  const large = contextForFullOffload({ ...QWEN9B, vramBytes: 24 * GB, maxContext: 131072 });
  assert.ok(large > small, `${large} should exceed ${small}`);
});
