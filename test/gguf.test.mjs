/**
 * GGUF header parsing and context sizing.
 *
 * The parser is tested against bytes built here rather than a checked-in model
 * file: a fixture that matches the spec is the point, and a multi-gigabyte
 * download is not something a test suite should need. The real file on this
 * machine is exercised separately, and skipped when it is absent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kvBytesPerToken, parseGgufHeader, readGgufMetadata, recommendContext } from '../src/main/llm/gguf.mjs';

/* ============================ fixture writer ============================ */

const TYPE = { UINT32: 4, STRING: 8, ARRAY: 9, FLOAT32: 6, BOOL: 7 };

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function u64(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function str(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
}

/** One metadata entry: key, type tag, then the encoded value. */
function entry(key, type, value) {
  const head = Buffer.concat([str(key), u32(type)]);
  if (type === TYPE.UINT32) return Buffer.concat([head, u32(value)]);
  if (type === TYPE.STRING) return Buffer.concat([head, str(value)]);
  if (type === TYPE.FLOAT32) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(value);
    return Buffer.concat([head, b]);
  }
  if (type === TYPE.BOOL) return Buffer.concat([head, Buffer.from([value ? 1 : 0])]);
  throw new Error(`fixture: unhandled type ${type}`);
}

/** A string array, as the tokenizer vocabulary is stored. */
function stringArray(key, items) {
  return Buffer.concat([str(key), u32(TYPE.ARRAY), u32(TYPE.STRING), u64(items.length), ...items.map(str)]);
}

/** A fixed-width array, which the parser skips in one jump. */
function u32Array(key, items) {
  return Buffer.concat([str(key), u32(TYPE.ARRAY), u32(TYPE.UINT32), u64(items.length), ...items.map(u32)]);
}

function buildGguf(entries, { version = 3, tensors = 0 } = {}) {
  return Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(version),
    u64(tensors),
    u64(entries.length),
    ...entries,
  ]);
}

/** A plausible 7B with grouped-query attention. */
function qwenLike(extra = []) {
  return buildGguf([
    entry('general.architecture', TYPE.STRING, 'qwen2'),
    entry('general.name', TYPE.STRING, 'Qwen2.5 7B Instruct'),
    entry('qwen2.context_length', TYPE.UINT32, 32768),
    entry('qwen2.block_count', TYPE.UINT32, 28),
    entry('qwen2.embedding_length', TYPE.UINT32, 3584),
    entry('qwen2.attention.head_count', TYPE.UINT32, 28),
    entry('qwen2.attention.head_count_kv', TYPE.UINT32, 4),
    ...extra,
  ]);
}

/* ============================ parsing ============================ */

test('reads architecture and dimensions from a header', () => {
  const meta = parseGgufHeader(qwenLike());
  assert.equal(meta.arch, 'qwen2');
  assert.equal(meta.name, 'Qwen2.5 7B Instruct');
  assert.equal(meta.contextLength, 32768);
  assert.equal(meta.blockCount, 28);
  assert.equal(meta.embeddingLength, 3584);
  assert.equal(meta.headCount, 28);
  assert.equal(meta.headCountKv, 4);
});

test('skips a tokenizer vocabulary sitting between the keys it wants', () => {
  const vocab = Array.from({ length: 5000 }, (_, i) => `token_${i}`);
  const meta = parseGgufHeader(
    buildGguf([
      entry('general.architecture', TYPE.STRING, 'llama'),
      stringArray('tokenizer.ggml.tokens', vocab),
      u32Array('tokenizer.ggml.token_type', vocab.map(() => 1)),
      entry('llama.context_length', TYPE.UINT32, 4096),
      entry('llama.block_count', TYPE.UINT32, 32),
      entry('llama.embedding_length', TYPE.UINT32, 4096),
      entry('llama.attention.head_count', TYPE.UINT32, 32),
    ]),
  );
  assert.equal(meta.contextLength, 4096);
  assert.equal(meta.blockCount, 32);
});

test('architecture keys are found even when written before the architecture itself', () => {
  const meta = parseGgufHeader(
    buildGguf([
      entry('llama.block_count', TYPE.UINT32, 32),
      entry('llama.context_length', TYPE.UINT32, 4096),
      entry('general.architecture', TYPE.STRING, 'llama'),
      entry('llama.embedding_length', TYPE.UINT32, 4096),
      entry('llama.attention.head_count', TYPE.UINT32, 32),
    ]),
  );
  assert.equal(meta.arch, 'llama');
  assert.equal(meta.blockCount, 32);
  assert.equal(meta.contextLength, 4096);
});

test('head_count_kv defaults to head_count when the model predates GQA', () => {
  const meta = parseGgufHeader(
    buildGguf([
      entry('general.architecture', TYPE.STRING, 'llama'),
      entry('llama.block_count', TYPE.UINT32, 32),
      entry('llama.embedding_length', TYPE.UINT32, 4096),
      entry('llama.attention.head_count', TYPE.UINT32, 32),
    ]),
  );
  assert.equal(meta.headCountKv, 32);
});

test('irrelevant value types are skipped without upsetting the walk', () => {
  const meta = parseGgufHeader(
    qwenLike([
      entry('general.file_type', TYPE.UINT32, 15),
      entry('qwen2.rope.freq_base', TYPE.FLOAT32, 1000000),
      entry('tokenizer.ggml.add_bos_token', TYPE.BOOL, false),
    ]),
  );
  assert.equal(meta.contextLength, 32768);
});

test('rejects a file that is not GGUF', () => {
  assert.throws(() => parseGgufHeader(Buffer.from('NOPE and then some')), /bad magic/);
});

test('rejects a version it does not understand', () => {
  const bad = qwenLike();
  bad.writeUInt32LE(99, 4);
  assert.throws(() => parseGgufHeader(bad), /unsupported GGUF version/);
});

test('a truncated header raises RangeError so the reader can retry larger', () => {
  assert.throws(() => parseGgufHeader(qwenLike().subarray(0, 60)), RangeError);
});

test('readGgufMetadata returns null for a file that is not a model', async () => {
  assert.equal(await readGgufMetadata(join(process.cwd(), 'package.json')), null);
});

test('readGgufMetadata returns null for a path that does not exist', async () => {
  assert.equal(await readGgufMetadata(join(process.cwd(), 'no-such-model.gguf')), null);
});

/* ============================ KV maths ============================ */

test('KV cost per token accounts for grouped-query attention', () => {
  const meta = parseGgufHeader(qwenLike());
  // 2 (K and V) × 28 layers × (3584/28 × 4) heads-worth × 2 bytes = 57344
  assert.equal(kvBytesPerToken(meta), 2 * 28 * ((3584 / 28) * 4) * 2);
  assert.equal(kvBytesPerToken(meta), 57344);
});

test('a model without GQA costs several times more per token', () => {
  const withGqa = kvBytesPerToken({ blockCount: 32, embeddingLength: 4096, headCount: 32, headCountKv: 8 });
  const without = kvBytesPerToken({ blockCount: 32, embeddingLength: 4096, headCount: 32, headCountKv: 32 });
  assert.equal(without / withGqa, 4);
});

test('KV cost is null when the header lacked what it needs', () => {
  assert.equal(kvBytesPerToken({ blockCount: 32 }), null);
  assert.equal(kvBytesPerToken(null), null);
});

/* ============================ recommendation ============================ */

const GB = 1024 ** 3;

test("never exceeds the model's trained context", () => {
  const meta = parseGgufHeader(qwenLike());
  const result = recommendContext({ meta, fileSize: 4.4 * GB, totalMemory: 64 * GB, ceiling: 131072 });
  assert.equal(result.context, 32768);
  assert.equal(result.reason, 'limited by model maximum');
});

test('a small-context model is held to its own limit however much RAM there is', () => {
  const meta = parseGgufHeader(
    buildGguf([
      entry('general.architecture', TYPE.STRING, 'llama'),
      entry('llama.context_length', TYPE.UINT32, 4096),
      entry('llama.block_count', TYPE.UINT32, 32),
      entry('llama.embedding_length', TYPE.UINT32, 4096),
      entry('llama.attention.head_count', TYPE.UINT32, 32),
    ]),
  );
  const result = recommendContext({ meta, fileSize: 4 * GB, totalMemory: 128 * GB });
  assert.equal(result.context, 4096);
});

test('memory binds on a small machine', () => {
  const meta = parseGgufHeader(qwenLike());
  const result = recommendContext({ meta, fileSize: 4.4 * GB, totalMemory: 8 * GB });
  assert.equal(result.reason, 'limited by memory');
  assert.ok(result.context < 32768, `expected a reduced context, got ${result.context}`);
  assert.equal(result.context % 512, 0);
});

test('the ceiling stops a tiny model reserving a huge cache', () => {
  const meta = parseGgufHeader(
    buildGguf([
      entry('general.architecture', TYPE.STRING, 'qwen2'),
      entry('qwen2.context_length', TYPE.UINT32, 131072),
      entry('qwen2.block_count', TYPE.UINT32, 24),
      entry('qwen2.embedding_length', TYPE.UINT32, 896),
      entry('qwen2.attention.head_count', TYPE.UINT32, 14),
      entry('qwen2.attention.head_count_kv', TYPE.UINT32, 2),
    ]),
  );
  const result = recommendContext({ meta, fileSize: 0.4 * GB, totalMemory: 64 * GB, ceiling: 32768 });
  assert.equal(result.context, 32768);
  assert.equal(result.reason, 'limited by ceiling');
});

test('an impossible budget falls back to the floor rather than to zero', () => {
  const meta = parseGgufHeader(qwenLike());
  const result = recommendContext({ meta, fileSize: 30 * GB, totalMemory: 8 * GB, floor: 2048 });
  assert.equal(result.context, 2048);
  assert.match(result.reason, /too tight/);
});

test('a header with no usable dimensions is sized from the file instead', () => {
  const result = recommendContext({ meta: { contextLength: 8192 }, fileSize: 4 * GB, totalMemory: 32 * GB });
  assert.equal(result.source, 'estimated');
  assert.ok(result.context > 0 && result.context <= 8192);
  assert.match(result.reason, /4\.0 GB file/);
});

test('the estimate still respects the model maximum', () => {
  const result = recommendContext({ meta: { contextLength: 4096 }, fileSize: 1 * GB, totalMemory: 32 * GB });
  assert.equal(result.context, 4096);
});

test('every recommendation is a usable, round number', () => {
  const meta = parseGgufHeader(qwenLike());
  for (const totalMemory of [4, 8, 16, 32, 64, 128].map((gb) => gb * GB)) {
    const { context } = recommendContext({ meta, fileSize: 4.4 * GB, totalMemory });
    assert.equal(context % 512, 0, `${context} is not a multiple of 512`);
    assert.ok(context >= 512, `${context} is too small to be usable`);
    assert.ok(context <= 32768, `${context} exceeds the model maximum`);
  }
});

/* ============================ the real thing ============================ */

test('parses a real model file when one is on this machine', async (t) => {
  const model = join(
    process.env['APPDATA'] ?? homedir(),
    'Wasteland Next',
    'models',
    'gemma-3-1b-it-Q4_K_M.gguf',
  );
  if (!existsSync(model)) return t.skip('no local model to read');

  const meta = await readGgufMetadata(model);
  assert.ok(meta, 'expected the header to parse');
  assert.ok(meta.arch, 'expected an architecture');
  assert.ok(meta.blockCount > 0 && meta.embeddingLength > 0 && meta.headCount > 0);
  assert.ok(kvBytesPerToken(meta) > 0);
});
