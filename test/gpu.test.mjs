/**
 * Fitting layers onto the card.
 *
 * The numbers below are the case that prompted this: a 25 GB model, a 12 GB
 * card, and a request to offload everything — which llama.cpp answers by
 * allocating until the driver refuses and then exiting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommendGpuLayers } from '../src/main/llm/gpu.mjs';

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
