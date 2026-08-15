/**
 * Where a model will run, worked out before anyone clicks LOAD.
 *
 * "4.4 GB" does not tell you whether a model will fit on your card, and finding
 * out by loading it costs a minute and, until recently, an unexplained failure.
 * The same arithmetic the launcher uses is run here so the vault can say
 * `GPU 15/52` next to the size.
 *
 * Headers are cached by path, size and mtime: the answer only changes when the
 * file does, and re-reading one on every list refresh would be wasteful.
 */
import { stat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { kvBudget, readGgufMetadata, recommendContext } from '../llm/gguf.mjs';
import { detectVram, recommendGpuLayers } from '../llm/gpu.mjs';

const cache = new Map();

/** Read a header, or serve the cached answer for an unchanged file. */
async function metaFor(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }

  const key = `${path}:${info.size}:${info.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);

  const meta = await readGgufMetadata(path);
  const entry = meta ? { meta, fileSize: info.size } : null;
  cache.set(key, entry);
  return entry;
}

/**
 * How a model would be loaded right now.
 *
 * Returns null when the header cannot be read — the caller then falls back to
 * the size-only estimate, which is all a search result ever has.
 */
export async function planFor(path) {
  const entry = await metaFor(path);
  if (!entry) return null;

  const { meta, fileSize } = entry;
  const context = recommendContext({ meta, fileSize, totalMemory: totalmem() });
  const vramBytes = detectVram();
  const kvCost = kvBudget(meta) ?? { perToken: 0, fixedBytes: 0 };
  const gpu = recommendGpuLayers({
    meta,
    fileSize,
    contextTokens: context.context,
    kvBytesPerToken: kvCost.perToken,
    kvFixedBytes: kvCost.fixedBytes,
    vramBytes: vramBytes ?? 0,
  });

  const blocks = Number(meta.blockCount) || 0;
  const where = !vramBytes ? 'unknown' : gpu.layers === 999 ? 'gpu' : gpu.layers === 0 ? 'cpu' : 'partial';

  return {
    where,
    layers: gpu.layers === 999 ? blocks : gpu.layers,
    blocks,
    context: context.context,
    modelMax: context.modelMax,
    vramBytes: vramBytes ?? 0,
    reason: gpu.reason,
  };
}

/** A short label for a row: `GPU`, `GPU 15/52`, `CPU`. */
export function placementLabel(plan) {
  if (!plan || plan.where === 'unknown') return '';
  if (plan.where === 'gpu') return 'GPU';
  if (plan.where === 'cpu') return 'CPU';
  return `GPU ${plan.layers}/${plan.blocks}`;
}
