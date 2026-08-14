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
 */
const BUFFER_RE = /(?:^|\s)(?:llm_)?load_tensors:\s+(\S+)\s+(?:model\s+)?buffer size\s*=/i;

/** Buffer owners that are the processor under another name. */
const CPU_DEVICE = /^(?:CPU|BLAS|AMX|RPC)/i;

/** The offload summary, or null. */
export function readOffload(line) {
  const hit = OFFLOAD_RE.exec(String(line ?? ''));
  if (!hit) return null;
  return { layers: Number(hit[1]), blocks: Number(hit[2]) };
}

/** The device a slice of the weights was loaded onto, or null. */
export function readWeightsDevice(line) {
  const hit = BUFFER_RE.exec(String(line ?? ''));
  return hit ? hit[1] : null;
}

/**
 * Accumulates what llama.cpp said while a model loaded.
 *
 * `placement` is null until something recognisable has been fed in. The offload
 * summary wins over the buffer lines when both are present: a full offload
 * still prints a small CPU buffer for the token embeddings on many models, and
 * counting devices alone would call that a partial one.
 */
export class PlacementReader {
  #offload = null;
  #devices = [];
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

    const device = readWeightsDevice(text);
    if (device && !this.#devices.includes(device)) {
      this.#devices.push(device);
      if (!this.#offload) this.#evidence = text;
    }
  }

  get placement() {
    const devices = [...this.#devices];
    const gpuDevices = devices.filter((name) => !CPU_DEVICE.test(name));

    if (this.#offload) {
      const { layers, blocks } = this.#offload;
      const where = layers === 0 ? 'cpu' : blocks && layers >= blocks ? 'gpu' : 'partial';
      return { where, layers, blocks, devices, evidence: this.#evidence };
    }

    // No summary line — a CPU-only build prints none at all, having no GPU to
    // report on. The buffer lines still say who holds the weights.
    if (devices.length > 0) {
      const where = gpuDevices.length === 0 ? 'cpu' : gpuDevices.length === devices.length ? 'gpu' : 'partial';
      return { where, layers: 0, blocks: 0, devices, evidence: this.#evidence };
    }

    return null;
  }
}

/** One line for the status bar. `plan` is what was asked for, if anything. */
export function describePlacement(placement) {
  if (!placement) return 'RUN: ?';
  if (placement.where === 'cpu') return 'RUN: CPU';
  if (placement.where === 'gpu') return 'RUN: GPU';
  return placement.blocks
    ? `RUN: GPU ${placement.layers}/${placement.blocks} LAYERS + CPU`
    : 'RUN: GPU + CPU';
}
