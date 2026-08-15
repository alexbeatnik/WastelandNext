/**
 * Where the model actually ended up, read from llama.cpp's own output.
 *
 * The plan in `gpu.mjs` is a request, not an outcome. `recommendGpuLayers`
 * answers "VRAM unknown" with full offload — which is right, because AMD and
 * Intel cards under Vulkan are invisible to `nvidia-smi` and offload there is
 * real — but a machine with no GPU at all lands in exactly the same branch, and
 * the status bar then reported `RUN: GPU` for a model running entirely on the
 * processor. A wrong answer that looks like a right one.
 *
 * llama.cpp knows. It prints an offload summary and one buffer line per device
 * as it loads the tensors, so the honest reading is there for the taking. Lines
 * are fed in as they arrive rather than scanned afterwards: the tail we keep is
 * 60 lines, a model load prints many more, and the interesting ones are near
 * the start.
 *
 * It only prints them when asked: current builds put both behind the `trace`
 * threshold, which is why `server.mjs` spawns with `-lv 4`. Nothing here can
 * make up for that flag being absent — there is no other source. `/props`,
 * `/v1/models` and `/slots` were all checked, and none of them mentions a
 * device.
 *
 * Nothing here guesses. When llama.cpp says nothing we recognise, the placement
 * stays null and the UI says it does not know — which is a true statement, and
 * the previous behaviour was not.
 */

/**
 * `load_tensors: offloaded 29/29 layers to GPU`
 *
 * Older builds print the same sentence behind `llm_load_tensors:`, so the
 * prefix is not matched at all — only the sentence, which has been stable
 * across every build this app has seen.
 */
const OFFLOAD_RE = /offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers?\s+to\s+GPU/i;

/**
 * `load_tensors:        CUDA0 model buffer size =  4095.05 MiB`, and in a
 * current build the same line behind a timestamp and a severity field:
 * `0.01.369.130 I load_tensors:      Vulkan0 model buffer size =  4241.18 MiB`.
 *
 * The word `model` appeared partway through llama.cpp's history and the older
 * form is still met in the wild, so it is optional here.
 *
 * What must not be relaxed is `load_tensors:` itself. The KV cache and the
 * compute buffers print in the same shape — `llama_kv_cache: CPU KV buffer
 * size`, `sched_reserve: Vulkan0 compute buffer size` — and they say where the
 * *cache* went, which is a different question with a different answer. Anchoring
 * at the start of the line used to do that job and no longer can, so the marker
 * carries it instead.
 *
 * The size is captured as well as the device. How many layers were offloaded
 * and how many bytes went with them are different questions, and on some
 * architectures they have very different answers — see `CPU_WEIGHT_LIMIT`.
 */
const BUFFER_RE =
  /(?:^|\s)(?:llm_)?load_tensors:\s+(\S+)\s+(?:model\s+)?buffer size\s*=\s*([\d.]+)\s*([KMG]i?B)?/i;

/** Buffer owners that are the processor under another name. */
const CPU_DEVICE = /^(?:CPU|BLAS|AMX|RPC)/i;

const UNIT = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3 };

/**
 * How much of the weights may sit in RAM before a "full" offload is not one.
 *
 * `offloaded 43/43 layers to GPU` is not the same statement as "the model is on
 * the GPU", and reading it as one is what this constant exists to stop. Gemma's
 * per-layer input embeddings never leave the processor whatever `-ngl` says: on
 * the machine that reported this, a 7.1 GB gemma-4-E4B loaded as 3876 MiB on
 * Vulkan0 and 3381 MiB `CPU_Mapped` — 47% of the weights in RAM, and every
 * token paying for them — under a badge reading `RUN: GPU`. That is the same
 * class of wrong answer as reporting a GPU on a machine that has none, and the
 * user feels it in tokens per second either way.
 *
 * A genuinely full offload still leaves the token-embedding table behind on
 * many models, so the line cannot be drawn at zero. The largest vocabulary in
 * circulation — 262144 tokens at 2560 wide, quantised — is around 0.55 GB, or
 * under 8% of the 7 GB model it belongs to. 15% clears that comfortably and is
 * nowhere near the case above.
 */
export const CPU_WEIGHT_LIMIT = 0.15;

/** The offload summary, or null. */
export function readOffload(line) {
  const hit = OFFLOAD_RE.exec(String(line ?? ''));
  if (!hit) return null;
  return { layers: Number(hit[1]), blocks: Number(hit[2]) };
}

/** A weights buffer as `{device, bytes}`, or null. Unknown units count as 0 bytes. */
export function readWeightsBuffer(line) {
  const hit = BUFFER_RE.exec(String(line ?? ''));
  if (!hit) return null;
  const scale = UNIT[String(hit[3] ?? 'MiB').toUpperCase()] ?? 0;
  return { device: hit[1], bytes: Number(hit[2]) * scale };
}

/** The device a slice of the weights was loaded onto, or null. */
export function readWeightsDevice(line) {
  return readWeightsBuffer(line)?.device ?? null;
}

/**
 * Accumulates what llama.cpp said while a model loaded.
 *
 * `placement` is null until something recognisable has been fed in.
 *
 * Two independent readings are kept, because llama.cpp answers two different
 * questions and they do not always agree: the summary line counts *layers*, the
 * buffer lines weigh *bytes*. The summary decides how the split is described —
 * `23/33 layers` is the useful sentence when layers are what was split — but it
 * cannot promote a load to `gpu` over the bytes' objection. `CPU_WEIGHT_LIMIT`
 * is where that objection starts.
 */
export class PlacementReader {
  #offload = null;
  #devices = [];
  #bytes = new Map();
  #evidence = '';

  feed(line) {
    const text = String(line ?? '').trim();
    if (!text) return;

    const offload = readOffload(text);
    if (offload) {
      this.#offload = offload;
      this.#evidence = text;
      return;
    }

    const buffer = readWeightsBuffer(text);
    if (buffer) {
      if (!this.#devices.includes(buffer.device)) {
        this.#devices.push(buffer.device);
        if (!this.#offload) this.#evidence = text;
      }
      // A device can print more than one weights buffer; they add up.
      this.#bytes.set(buffer.device, (this.#bytes.get(buffer.device) ?? 0) + buffer.bytes);
    }
  }

  /**
   * Share of the weight bytes that landed on a GPU, or null when nothing said.
   *
   * Null and 0 are different answers — "no buffer line was printed" against
   * "every byte is in RAM" — and only the second is a placement.
   */
  get #gpuShare() {
    let gpu = 0;
    let total = 0;
    for (const [device, bytes] of this.#bytes) {
      total += bytes;
      if (!CPU_DEVICE.test(device)) gpu += bytes;
    }
    return total > 0 ? gpu / total : null;
  }

  get placement() {
    const devices = [...this.#devices];
    const gpuShare = this.#gpuShare;

    if (this.#offload) {
      const { layers, blocks } = this.#offload;
      let where = layers === 0 ? 'cpu' : blocks && layers >= blocks ? 'gpu' : 'partial';
      // Every layer on the card and half the weights still in RAM is not a full
      // offload, whatever the summary counted. Gemma does exactly this.
      if (where === 'gpu' && gpuShare !== null && 1 - gpuShare > CPU_WEIGHT_LIMIT) where = 'partial';
      return { where, layers, blocks, devices, gpuShare, evidence: this.#evidence };
    }

    // No summary line — a CPU-only build prints none at all, having no GPU to
    // report on. The buffer lines still say who holds the weights.
    if (devices.length > 0) {
      const where = gpuShare === null || gpuShare === 0 ? 'cpu' : 1 - gpuShare > CPU_WEIGHT_LIMIT ? 'partial' : 'gpu';
      return { where, layers: 0, blocks: 0, devices, gpuShare, evidence: this.#evidence };
    }

    return null;
  }
}

/**
 * The badge this is read for lives in `shared/render.mjs` as `describePlacement`.
 * The renderer draws it and had its own hand-written copy of the branching,
 * which is how the two came to disagree; one definition, imported twice.
 */
export { describePlacement } from '../../shared/render.mjs';
