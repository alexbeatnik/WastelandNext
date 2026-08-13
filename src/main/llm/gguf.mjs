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
    // Arrays are only ever the tokenizer's, which nothing here needs. Fixed
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
  ]);
}

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
    const interesting = key.startsWith('general.') || /\.(context_length|block_count|embedding_length|head_count|head_count_kv)$/.test(key);
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
 * Bytes of KV cache one token costs.
 *
 * Both K and V are stored for every layer, at `n_embd_head * n_head_kv` values
 * each. Grouped-query attention shows up here as `head_count_kv` being a
 * fraction of `head_count`, which is why a modern 7B is far cheaper per token
 * than an older one of the same size.
 */
export function kvBytesPerToken(meta, { bytesPerElement = 2 } = {}) {
  const heads = Number(meta?.headCount) || 0;
  const layers = Number(meta?.blockCount) || 0;
  const embedding = Number(meta?.embeddingLength) || 0;
  if (!heads || !layers || !embedding) return null;

  const headsKv = Number(meta?.headCountKv) || heads;
  const embeddingKv = (embedding / heads) * headsKv;
  return 2 * layers * embeddingKv * bytesPerElement;
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
  const perToken = kvBytesPerToken(meta);

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

  const budget = totalMemory * memoryShare - fileSize - overheadBytes;
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
