/**
 * Reading a GGUF file's header, and sizing the context window from it.
 *
 * File size alone cannot answer "how big a context fits". Two 4 GB models can
 * differ tenfold in KV-cache cost per token depending on layer count and
 * whether they use grouped-query attention — and one of them may have been
 * trained for 4096 tokens while the other handles 128k. Both facts are in the
 * header, so they are read rather than guessed.
 *
 * Only the metadata block is read, never the tensors.
 */
import { open } from 'node:fs/promises';

/** GGUF metadata value types, in the order the spec numbers them. */
const T = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
};

/** Fixed widths, in bytes. STRING and ARRAY are variable and handled apart. */
const WIDTH = {
  [T.UINT8]: 1,
  [T.INT8]: 1,
  [T.BOOL]: 1,
  [T.UINT16]: 2,
  [T.INT16]: 2,
  [T.UINT32]: 4,
  [T.INT32]: 4,
  [T.FLOAT32]: 4,
  [T.UINT64]: 8,
  [T.INT64]: 8,
  [T.FLOAT64]: 8,
};

/**
 * Windows to try when reading the header.
 *
 * A header is usually well under a megabyte, but the tokenizer vocabulary is
 * metadata too and a 128k-token vocabulary runs to several megabytes. Growing
 * on demand keeps the common case to one small read instead of always paying
 * for the worst one.
 */
const WINDOWS = [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];

class Cursor {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  /** Throws when the window ended mid-value; the caller retries with a bigger one. */
  #need(bytes) {
    if (this.pos + bytes > this.buf.length) throw new RangeError('gguf: header window exhausted');
  }

  u8() {
    this.#need(1);
    return this.buf.readUInt8(this.pos++);
  }

  u32() {
    this.#need(4);
    const value = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  /**
   * A count or length. GGUF v1 wrote these as 32-bit; v2 widened them to 64.
   *
   * Returned as a Number: these are counts and byte lengths of a file header,
   * so they are nowhere near 2^53, and a BigInt here would infect every
   * arithmetic site downstream.
   */
  size(version) {
    if (version === 1) return this.u32();
    this.#need(8);
    const value = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return Number(value);
  }

  string(version) {
    const length = this.size(version);
    this.#need(length);
    const value = this.buf.toString('utf8', this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  skip(bytes) {
    this.#need(bytes);
    this.pos += bytes;
  }
}

/** Read one metadata value, or skip past it when its content is not wanted. */
function readValue(cursor, type, version, { wanted }) {
  if (type === T.STRING) {
    const value = cursor.string(version);
    return wanted ? value : undefined;
  }

  if (type === T.ARRAY) {
    const itemType = cursor.u32();
    const count = cursor.size(version);
    // One array is worth reading: the sliding-window pattern, which says which
    // layers hold a full-size KV cache and which hold a window's worth. It is
    // one bool per layer, so tens of bytes.
    if (wanted && itemType === T.BOOL) {
      const values = [];
      for (let i = 0; i < count; i += 1) values.push(cursor.u8() !== 0);
      return values;
    }
    // Everything else is the tokenizer's, which nothing here needs. Fixed
    // widths are skipped in one jump; strings have to be walked to be measured.
    if (WIDTH[itemType]) {
      cursor.skip(WIDTH[itemType] * count);
    } else if (itemType === T.STRING) {
      for (let i = 0; i < count; i += 1) cursor.skip(cursor.size(version));
    } else {
      throw new RangeError(`gguf: unsupported array item type ${itemType}`);
    }
    return undefined;
  }

  const width = WIDTH[type];
  if (!width) throw new RangeError(`gguf: unknown value type ${type}`);
  if (!wanted) {
    cursor.skip(width);
    return undefined;
  }

  switch (type) {
    case T.UINT8:
    case T.BOOL:
      return cursor.u8();
    case T.INT8: {
      const value = cursor.buf.readInt8(cursor.pos);
      cursor.pos += 1;
      return value;
    }
    case T.UINT16: {
      const value = cursor.buf.readUInt16LE(cursor.pos);
      cursor.pos += 2;
      return value;
    }
    case T.INT16: {
      const value = cursor.buf.readInt16LE(cursor.pos);
      cursor.pos += 2;
      return value;
    }
    case T.UINT32:
      return cursor.u32();
    case T.INT32: {
      const value = cursor.buf.readInt32LE(cursor.pos);
      cursor.pos += 4;
      return value;
    }
    case T.FLOAT32: {
      const value = cursor.buf.readFloatLE(cursor.pos);
      cursor.pos += 4;
      return value;
    }
    case T.UINT64:
    case T.INT64: {
      const value = Number(cursor.buf.readBigInt64LE(cursor.pos));
      cursor.pos += 8;
      return value;
    }
    case T.FLOAT64: {
      const value = cursor.buf.readDoubleLE(cursor.pos);
      cursor.pos += 8;
      return value;
    }
    default:
      throw new RangeError(`gguf: unhandled value type ${type}`);
  }
}

/** The keys worth keeping, once the architecture is known. */
function wantedKeys(arch) {
  return new Set([
    'general.architecture',
    'general.name',
    `${arch}.context_length`,
    `${arch}.block_count`,
    `${arch}.embedding_length`,
    `${arch}.attention.head_count`,
    `${arch}.attention.head_count_kv`,
    `${arch}.attention.key_length`,
    `${arch}.attention.value_length`,
    `${arch}.attention.key_length_swa`,
    `${arch}.attention.value_length_swa`,
    `${arch}.attention.sliding_window`,
    `${arch}.attention.sliding_window_pattern`,
    `${arch}.attention.shared_kv_layers`,
  ]);
}

/**
 * The suffixes worth materialising, as a cheap filter before the value is read.
 *
 * Deliberately not a prefix test on the architecture: `general.architecture` is
 * written first in practice but not by requirement, so the arch may still be
 * unknown here.
 */
const INTERESTING_SUFFIX =
  /\.(context_length|block_count|embedding_length|head_count|head_count_kv|key_length|value_length|key_length_swa|value_length_swa|sliding_window|sliding_window_pattern|shared_kv_layers)$/;

/**
 * Parse a header out of `buffer`.
 *
 * `general.architecture` prefixes every key that matters and is written first
 * in practice, but not by requirement — so every key is collected and the
 * architecture-specific ones are picked out at the end.
 */
export function parseGgufHeader(buffer) {
  const cursor = new Cursor(buffer);

  if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== 'GGUF') {
    throw new Error('not a GGUF file (bad magic)');
  }
  cursor.skip(4);

  const version = cursor.u32();
  if (version < 1 || version > 3) throw new Error(`unsupported GGUF version ${version}`);

  cursor.size(version); // tensor count — not needed
  const kvCount = cursor.size(version);

  const raw = new Map();
  for (let i = 0; i < kvCount; i += 1) {
    const key = cursor.string(version);
    const type = cursor.u32();
    // Cheap filter: anything not under `general.` or `<arch>.attention`-shaped
    // is skipped without being materialised. Tokenizer data is the bulk.
    const interesting = key.startsWith('general.') || INTERESTING_SUFFIX.test(key);
    const value = readValue(cursor, type, version, { wanted: interesting });
    if (interesting && value !== undefined) raw.set(key, value);
  }

  const arch = raw.get('general.architecture') ?? '';
  const keys = wantedKeys(arch);
  const pick = (suffix) => raw.get(`${arch}.${suffix}`);

  return {
    version,
    arch,
    name: raw.get('general.name') ?? '',
    contextLength: pick('context_length') ?? null,
    blockCount: pick('block_count') ?? null,
    embeddingLength: pick('embedding_length') ?? null,
    headCount: pick('attention.head_count') ?? null,
    headCountKv: pick('attention.head_count_kv') ?? pick('attention.head_count') ?? null,
    // Head width is stated outright by the models that do not derive it from
    // `embedding_length / head_count`. Gemma 4 is one: 2560/8 gives 320, and
    // the header says 512. Guessing costs 60% of the KV estimate.
    keyLength: pick('attention.key_length') ?? null,
    valueLength: pick('attention.value_length') ?? null,
    keyLengthSwa: pick('attention.key_length_swa') ?? null,
    valueLengthSwa: pick('attention.value_length_swa') ?? null,
    slidingWindow: pick('attention.sliding_window') ?? null,
    slidingWindowPattern: pick('attention.sliding_window_pattern') ?? null,
    sharedKvLayers: pick('attention.shared_kv_layers') ?? null,
    keys,
  };
}

/**
 * Read the header of a GGUF file on disk.
 *
 * Returns null rather than throwing when the file cannot be understood: an
 * unreadable header is a reason to fall back to a heuristic, not to refuse to
 * load a model that llama.cpp may well handle.
 */
export async function readGgufMetadata(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();

    for (const window of WINDOWS) {
      const length = Math.min(window, size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      try {
        return parseGgufHeader(buffer);
      } catch (err) {
        // Only a truncated window is worth retrying larger; a bad magic or an
        // unknown type will fail the same way however much we read.
        if (!(err instanceof RangeError) || length >= size) return null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * How much of the KV cache is paid up front, regardless of context length.
 *
 * A sliding-window layer never caches more than its window, plus the batch in
 * flight — llama.cpp sizes that cache at `n_swa + n_batch` cells and stops. So
 * the cost of those layers is a constant, not a rate, and calling it a rate is
 * what made the estimate wrong by nearly five times.
 */
const BATCH_TOKENS = 2048;

/**
 * What a KV cache costs: a rate per token, plus a fixed part.
 *
 * `perToken` is the layers that cache the whole conversation. `fixedBytes` is
 * the sliding-window layers, which do not grow with it.
 *
 * Three things in the header change this and were all being ignored:
 *
 *   - **Head width.** K and V are `key_length * head_count_kv` values each.
 *     Most models leave `key_length` out and `embedding_length / head_count` is
 *     the right answer; the ones that state it mean it. Gemma 4 states 512
 *     where the division gives 320.
 *   - **Shared KV layers.** `shared_kv_layers` counts trailing layers that
 *     reuse an earlier layer's cache and allocate none of their own — 18 of
 *     gemma-4-E4B's 42.
 *   - **Sliding-window attention.** `sliding_window_pattern` is one bool per
 *     layer saying which of the rest are windowed.
 *
 * Measured against llama.cpp on gemma-4-E4B at 15872 tokens: 4 full layers at
 * 248 MiB and 20 windowed layers at 100 MiB, against the 1.6 GB the old formula
 * predicted. That gap is not academic — it is subtracted from the VRAM budget
 * before layers are placed, so an imaginary gigabyte of cache pushes real
 * layers onto the processor, and it caps the context at a fraction of what the
 * card would hold. This is a model that can afford 32768 and was being given
 * 15872.
 *
 * Everything falls back to the old reading when the keys are absent, which is
 * most models: no pattern means no windowed layers, and the estimate stays the
 * pessimistic one it always was.
 */
export function kvBudget(meta, { bytesPerElement = 2, batchTokens = BATCH_TOKENS } = {}) {
  const heads = Number(meta?.headCount) || 0;
  const layers = Number(meta?.blockCount) || 0;
  const embedding = Number(meta?.embeddingLength) || 0;
  if (!layers) return null;

  const headsKv = Number(meta?.headCountKv) || heads;
  if (!headsKv) return null;

  const headDim = heads && embedding ? embedding / heads : 0;
  const keyLength = Number(meta?.keyLength) || headDim;
  const valueLength = Number(meta?.valueLength) || headDim;
  if (!keyLength || !valueLength) return null;

  const perFullLayer = (keyLength + valueLength) * headsKv * bytesPerElement;
  const keySwa = Number(meta?.keyLengthSwa) || keyLength;
  const valueSwa = Number(meta?.valueLengthSwa) || valueLength;
  const perSwaLayer = (keySwa + valueSwa) * headsKv * bytesPerElement;

  // Trailing layers that share an earlier cache allocate nothing.
  const shared = Math.min(layers, Math.max(0, Number(meta?.sharedKvLayers) || 0));
  const cached = layers - shared;

  const window = Number(meta?.slidingWindow) || 0;
  const pattern = Array.isArray(meta?.slidingWindowPattern) ? meta.slidingWindowPattern : null;
  const swaLayers = window && pattern ? pattern.slice(0, cached).filter(Boolean).length : 0;
  const fullLayers = cached - swaLayers;

  return {
    perToken: fullLayers * perFullLayer,
    fixedBytes: swaLayers * perSwaLayer * (window + batchTokens),
  };
}

/**
 * Bytes of KV cache one token costs, for the layers that scale with context.
 *
 * Kept as its own function because that rate is what the offload arithmetic
 * divides by. Callers that are budgeting memory want `kvBudget` — dropping
 * `fixedBytes` understates a windowed model by a few hundred megabytes.
 */
export function kvBytesPerToken(meta, options) {
  return kvBudget(meta, options)?.perToken ?? null;
}

/** Context sizes are kept to a round number; llama.cpp is happier and so are logs. */
function roundContext(tokens) {
  return Math.max(512, Math.floor(tokens / 512) * 512);
}

/**
 * Choose a context window for a model.
 *
 * Three limits apply, and the smallest wins:
 *   1. what the model was trained for — exceeding it degrades output;
 *   2. what memory allows once the weights are resident;
 *   3. a ceiling, so a small model on a large machine does not reserve
 *      gigabytes of KV cache nobody asked for.
 *
 * `availableBytes` is deliberately derived from *total* rather than free
 * memory: free memory swings by the minute, and a setting that lands on a
 * different number every launch is worse than one that is merely approximate.
 */
export function recommendContext({
  meta,
  fileSize = 0,
  totalMemory = 0,
  memoryShare = 0.75,
  overheadBytes = 768 * 1024 * 1024,
  ceiling = 32768,
  floor = 2048,
} = {}) {
  const modelMax = Number(meta?.contextLength) || 0;
  const budget_ = kvBudget(meta);
  const perToken = budget_?.perToken || null;

  // No usable metadata: fall back to the model's footprint. A bigger file means
  // more layers and a wider embedding, so it buys less context per gigabyte.
  if (!perToken) {
    const gb = fileSize / 1024 ** 3;
    const guess = gb > 16 ? 4096 : gb > 8 ? 8192 : gb > 3 ? 8192 : 16384;
    const context = roundContext(Math.min(guess, modelMax || guess, ceiling));
    return {
      context,
      source: 'estimated',
      reason: `no usable header; sized from a ${gb.toFixed(1)} GB file`,
      modelMax: modelMax || null,
      kvPerToken: null,
    };
  }

  // The windowed layers are paid whatever the context ends up being, so they
  // come off the budget before it is divided rather than out of the rate.
  const budget = totalMemory * memoryShare - fileSize - overheadBytes - (budget_.fixedBytes ?? 0);
  const affordable = budget > 0 ? Math.floor(budget / perToken) : 0;

  const limits = [
    { name: 'memory', value: affordable },
    { name: 'ceiling', value: ceiling },
    ...(modelMax ? [{ name: 'model maximum', value: modelMax }] : []),
  ];
  const binding = limits.reduce((lowest, limit) => (limit.value < lowest.value ? limit : lowest));

  // The floor is intentionally allowed to win over a tight memory budget: a
  // context too small to hold one exchange is useless, and llama.cpp reporting
  // an out-of-memory error is more honest than us silently crippling the model.
  const context = roundContext(Math.max(floor, Math.min(...limits.map((l) => l.value))));

  return {
    context,
    source: 'measured',
    reason:
      affordable <= 0
        ? `memory is too tight for a KV cache; using the ${floor}-token floor`
        : `limited by ${binding.name}`,
    modelMax: modelMax || null,
    kvPerToken: perToken,
    affordable,
  };
}
