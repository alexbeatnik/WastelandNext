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
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kvBudget, kvBytesPerToken, parseGgufHeader, readGgufMetadata, recommendContext } from '../src/main/llm/gguf.mjs';

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

/** A bool array — the sliding-window pattern is the one the parser reads. */
function boolArray(key, items) {
  return Buffer.concat([
    str(key),
    u32(TYPE.ARRAY),
    u32(TYPE.BOOL),
    u64(items.length),
    Buffer.from(items.map((v) => (v ? 1 : 0))),
  ]);
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

test('an ordinary model has no fixed part, so the rate is the whole cost', () => {
  const budget = kvBudget(parseGgufHeader(qwenLike()));
  assert.equal(budget.perToken, 57344);
  assert.equal(budget.fixedBytes, 0);
});

/*
 * gemma-4-E4B, verbatim from the header of the file that reported this, and
 * checked against what llama.cpp then allocated:
 *
 *   llama_kv_cache: size = 248.00 MiB (15872 cells,  4 layers)   ← full
 *   llama_kv_cache: size = 100.00 MiB ( 2560 cells, 20 layers)   ← windowed
 *
 * The old formula answered 107520 bytes a token — 1.6 GB at that context, near
 * five times the truth. That surplus comes off the VRAM budget before layers
 * are placed, and caps the context: this model was being given 15872 tokens on
 * a card that holds 32768.
 */
function gemma4Like() {
  // 5 windowed layers to 1 full, which over the first 24 gives 20 and 4.
  const pattern = Array.from({ length: 42 }, (_, i) => i % 6 !== 5);
  return buildGguf([
    entry('general.architecture', TYPE.STRING, 'gemma4'),
    entry('gemma4.block_count', TYPE.UINT32, 42),
    entry('gemma4.context_length', TYPE.UINT32, 131072),
    entry('gemma4.embedding_length', TYPE.UINT32, 2560),
    entry('gemma4.attention.head_count', TYPE.UINT32, 8),
    entry('gemma4.attention.head_count_kv', TYPE.UINT32, 2),
    entry('gemma4.attention.key_length', TYPE.UINT32, 512),
    entry('gemma4.attention.value_length', TYPE.UINT32, 512),
    entry('gemma4.attention.key_length_swa', TYPE.UINT32, 256),
    entry('gemma4.attention.value_length_swa', TYPE.UINT32, 256),
    entry('gemma4.attention.sliding_window', TYPE.UINT32, 512),
    entry('gemma4.attention.shared_kv_layers', TYPE.UINT32, 18),
    boolArray('gemma4.attention.sliding_window_pattern', pattern),
  ]);
}

test('the header states its own head width, and 2560/8 is not it', () => {
  const meta = parseGgufHeader(gemma4Like());
  assert.equal(meta.keyLength, 512);
  assert.equal(meta.valueLength, 512);
  assert.equal(meta.keyLengthSwa, 256);
  assert.equal(meta.slidingWindow, 512);
  assert.equal(meta.sharedKvLayers, 18);
  assert.equal(meta.slidingWindowPattern.length, 42);
});

test('layers that share a cache and layers that window one are both cheaper', () => {
  const budget = kvBudget(parseGgufHeader(gemma4Like()));

  // 4 full layers × (512 + 512) × 2 kv heads × 2 bytes.
  assert.equal(budget.perToken, 4 * (512 + 512) * 2 * 2);
  assert.equal(budget.perToken, 16384);
  // What llama.cpp allocated for those layers at 15872 tokens: 248 MiB.
  assert.equal((budget.perToken * 15872) / 1024 ** 2, 248);

  // 20 windowed layers × (256 + 256) × 2 × 2, over a 512-token window plus the
  // batch in flight — 2560 cells, and 100 MiB, which is what it allocated.
  assert.equal(budget.fixedBytes / 1024 ** 2, 100);

  // And the number this replaces, for the size of the error.
  assert.ok(budget.perToken * 15872 + budget.fixedBytes < 107520 * 15872 / 4);
});

test('a windowed model is no longer told it cannot afford its own context', () => {
  // 12 GB of system RAM and the 7.07 GB file that reported this. Under the old
  // reading the KV cache priced it out at 15872 tokens.
  const choice = recommendContext({
    meta: parseGgufHeader(gemma4Like()),
    fileSize: 7_074_929_792,
    totalMemory: 12 * GB,
  });
  assert.equal(choice.context, 32768);
  assert.equal(choice.reason, 'limited by ceiling');
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
  // Whatever happens to be in the vault, rather than one hardcoded filename:
  // models come and go, and a test that silently skips forever is no test.
  const dir = join(process.env['APPDATA'] ?? homedir(), 'Wasteland Next', 'models');
  const model = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.gguf'))
        .map((name) => join(dir, name))[0]
    : null;
  if (!model) return t.skip('no local model to read');

  const meta = await readGgufMetadata(model);
  assert.ok(meta, 'expected the header to parse');
  assert.ok(meta.arch, 'expected an architecture');
  assert.ok(meta.blockCount > 0 && meta.embeddingLength > 0 && meta.headCount > 0);
  assert.ok(kvBytesPerToken(meta) > 0);
});
