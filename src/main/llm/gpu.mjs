/**
 * Fitting a model onto the GPU.
 *
 * Asking for full offload (`-ngl 999`) is right whenever the model fits and
 * fatal when it does not: llama.cpp allocates until the driver refuses and then
 * exits, which the user sees as a load that simply failed. Partial offload is
 * well supported — the layers that fit go to the GPU, the rest stay on the CPU
 * — so the useful question is how many fit, not whether all of them do.
 */
import { spawnSync } from 'node:child_process';

/** Ask the NVIDIA driver how much memory the card has, in bytes, or null. */
function nvidiaVram() {
  const probe = spawnSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0 || !probe.stdout) return null;

  // Several cards report one line each; the largest is the one worth using,
  // since that is where llama.cpp will put the model by default.
  const sizes = String(probe.stdout)
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (sizes.length === 0) return null;
  return Math.max(...sizes) * 1024 * 1024;
}

/**
 * Total VRAM on the best available card, in bytes, or null when unknown.
 *
 * Only NVIDIA is probed. Windows' `Win32_VideoController.AdapterRAM` is a
 * 32-bit field that reports 4 GB for anything larger, which is worse than no
 * answer — a wrong number here silently cripples offload on a big card.
 */
export function detectVram() {
  if (process.platform === 'darwin') return null; // unified memory; -ngl is not the same trade
  return nvidiaVram();
}

/**
 * Where a model of this size would run, judged from the file alone.
 *
 * Used before a download, when the header is not available — so it is an
 * estimate and labelled as one. The margin covers the KV cache and the compute
 * buffers that share the card with the weights.
 *
 * Returns `'gpu'`, `'partial'`, `'cpu'`, or `'unknown'` when there is no card
 * to compare against.
 */
export function placementForSize(fileSize, vramBytes, { weightsShare = 0.65 } = {}) {
  if (!vramBytes) return 'unknown';
  if (!fileSize) return 'unknown';
  // Only about two thirds of the card is available to the weights. The KV cache
  // takes the rest and is not a small correction — on a 9B at 32k context it is
  // several gigabytes, which is why a flat "size + 25%" margin called models
  // GPU-resident that in fact run two thirds of their layers on the CPU.
  if (fileSize <= vramBytes * weightsShare) return 'gpu';
  // Below roughly a fifth of the card there is not enough room for a
  // worthwhile share of the layers, and it is honest to call that CPU.
  if (fileSize <= vramBytes * 5) return 'partial';
  return 'cpu';
}

/**
 * How many layers to offload.
 *
 * The per-layer cost is approximated as `fileSize / blockCount`. That is
 * slightly optimistic — embeddings and the output head live outside the blocks
 * — which the safety margin below absorbs.
 *
 * Returns `{ layers, reason }`. `layers` of `full` means "offload everything".
 */
export function recommendGpuLayers({
  meta,
  fileSize = 0,
  contextTokens = 0,
  kvBytesPerToken = 0,
  vramBytes = 0,
  share = 0.9,
  overheadBytes = 700 * 1024 * 1024,
  full = 999,
} = {}) {
  const layers = Number(meta?.blockCount) || 0;
  if (!vramBytes) return { layers: full, reason: 'VRAM unknown — offloading everything' };
  if (!layers || !fileSize) return { layers: full, reason: 'model shape unknown — offloading everything' };

  const kv = contextTokens * kvBytesPerToken;
  const budget = vramBytes * share - kv - overheadBytes;
  const perLayer = fileSize / layers;

  if (budget <= 0) {
    return { layers: 0, reason: 'the context alone fills VRAM — running on the CPU' };
  }

  const affordable = Math.floor(budget / perLayer);
  if (affordable >= layers) {
    return { layers: full, reason: 'the whole model fits in VRAM' };
  }
  if (affordable <= 0) {
    return { layers: 0, reason: 'not enough VRAM for even one layer — running on the CPU' };
  }

  return {
    layers: affordable,
    reason: `${affordable} of ${layers} layers fit in VRAM; the rest run on the CPU`,
  };
}
