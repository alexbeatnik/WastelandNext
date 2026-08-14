/**
 * Reading where the model actually ran out of llama.cpp's own output.
 *
 * The bug this exists for: a machine with no GPU showed `RUN: GPU`. Nothing had
 * measured anything — `nvidia-smi` is absent there, the planner reads that as
 * "VRAM unknown" and asks for full offload, and the badge reported the request
 * as though it were the result.
 *
 * The excerpts below are in llama.cpp's shape, including the older
 * `llm_load_tensors:` prefix, which is still met on binaries people already
 * have on PATH.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlacementReader, readOffload, readWeightsDevice } from '../src/main/llm/offload.mjs';
import { describePlacement } from '../src/shared/render.mjs';

/** Feed a block of output through a reader, the way the relay does. */
function read(lines) {
  const reader = new PlacementReader();
  for (const line of lines.trim().split('\n')) reader.feed(line);
  return reader.placement;
}

test('a full offload reads as the GPU, small CPU buffer notwithstanding', () => {
  // Many models keep the token embeddings on the processor even when every
  // layer is offloaded. Counting devices alone would call this partial, which
  // is why the summary line wins.
  const placement = read(`
load_tensors: loading model to 1 device(s)
load_tensors: offloading 28 repeating layers to GPU
load_tensors: offloading output layer to GPU
load_tensors: offloaded 29/29 layers to GPU
load_tensors:        CUDA0 model buffer size =  4095.05 MiB
load_tensors:   CPU_Mapped model buffer size =   308.23 MiB
`);
  assert.equal(placement.where, 'gpu');
  assert.deepEqual([placement.layers, placement.blocks], [29, 29]);
  assert.equal(describePlacement(placement), 'RUN: GPU');
});

test('a partial offload keeps both numbers, because the split is the point', () => {
  const placement = read(`
load_tensors: offloaded 23/33 layers to GPU
load_tensors:      Vulkan0 model buffer size =  5310.98 MiB
load_tensors:          CPU model buffer size =  2450.11 MiB
`);
  assert.equal(placement.where, 'partial');
  assert.equal(describePlacement(placement), 'RUN: GPU 23/33 LAYERS + CPU');
  assert.ok(placement.devices.includes('Vulkan0'));
});

test('nothing offloaded is the processor, whatever was asked for', () => {
  const placement = read(`
load_tensors: offloaded 0/29 layers to GPU
load_tensors:          CPU model buffer size =  4403.49 MiB
`);
  assert.equal(placement.where, 'cpu');
  assert.equal(describePlacement(placement), 'RUN: CPU');
});

test('a CPU-only build prints no summary at all, and is still read correctly', () => {
  // This is the reported machine: no GPU backend, so llama.cpp has nothing to
  // report offloading to, and the buffer lines are the whole story.
  const placement = read(`
llama_model_loader: loaded meta data with 30 key-value pairs and 291 tensors
load_tensors:          CPU model buffer size =  4165.37 MiB
`);
  assert.equal(placement.where, 'cpu');
  assert.equal(describePlacement(placement), 'RUN: CPU');
});

test('the older llm_load_tensors prefix is read the same way', () => {
  const placement = read(`
llm_load_tensors: offloaded 33/33 layers to GPU
llm_load_tensors:      CUDA0 buffer size =  4095.05 MiB
`);
  assert.equal(placement.where, 'gpu');
  assert.deepEqual([placement.layers, placement.blocks], [33, 33]);
});

/*
 * The three below are verbatim from the machine that reported `RUN: ?` — build
 * 10405, an RTX 5070 under Vulkan, gemma-4-E4B — timestamps and severity field
 * included. That prefix is half the bug: the buffer pattern was anchored at the
 * start of the line, where `load_tensors:` no longer is. The other half is that
 * this build prints none of it below its `trace` threshold, which is why
 * `server.mjs` now spawns with `-lv 4`.
 */
test('a current build says the same thing behind a timestamp and a severity field', () => {
  const placement = read(`
0.00.886.038 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 5070) (0000:01:00.0) - 11387 MiB free
0.01.097.904 I load_tensors: loading model tensors, this can take a while... (load_mode = mmap)
0.01.369.119 I load_tensors: offloading output layer to GPU
0.01.369.124 I load_tensors: offloading 41 repeating layers to GPU
0.01.369.125 I load_tensors: offloaded 43/43 layers to GPU
0.01.369.129 I load_tensors:   CPU_Mapped model buffer size =  3536.00 MiB
0.01.369.130 I load_tensors:      Vulkan0 model buffer size =  4241.18 MiB
`);
  assert.deepEqual([placement.layers, placement.blocks], [43, 43]);
  assert.deepEqual(placement.devices, ['CPU_Mapped', 'Vulkan0']);
});

/*
 * Verbatim from the machine that reported "it says it is loading onto the GPU
 * and it is actually running on RAM and the CPU" — build 10428, an RTX 3060
 * under Vulkan, the same gemma-4-E4B. Both readings are in here and they
 * disagree: every layer is on the card, and 47% of the weights are not.
 */
test('every layer on the card is not a full offload when half the bytes are in RAM', () => {
  const placement = read(`
0.02.606.286 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3060) (0000:01:00.0) - 11324 MiB free
0.03.311.436 I load_tensors: offloading output layer to GPU
0.03.311.441 I load_tensors: offloading 41 repeating layers to GPU
0.03.311.442 I load_tensors: offloaded 43/43 layers to GPU
0.03.311.452 I load_tensors:   CPU_Mapped model buffer size =  3381.00 MiB
0.03.311.454 I load_tensors:      Vulkan0 model buffer size =  3876.08 MiB
`);
  // Gemma keeps its per-layer input embeddings on the processor whatever `-ngl`
  // says, and they are not a rounding error. Reporting `RUN: GPU` here is the
  // wrong answer that looks like a right one — the user reads the badge, then
  // waits on tokens computed from RAM.
  assert.equal(placement.where, 'partial');
  assert.equal(Math.round(placement.gpuShare * 100), 53);
  // Not `43/43 LAYERS + CPU`: the layer count is true and says nothing, because
  // layers are not what was split here.
  assert.equal(describePlacement(placement), 'RUN: GPU 53% WEIGHTS + CPU');
});

test('a token-embedding table left behind is still a full offload', () => {
  // The other side of the same line. Every model that keeps its embeddings on
  // the processor would read as partial if the threshold were zero, and calling
  // a 96%-resident model partial is its own wrong answer.
  const placement = read(`
load_tensors: offloaded 29/29 layers to GPU
load_tensors:        CUDA0 model buffer size =  7168.00 MiB
load_tensors:   CPU_Mapped model buffer size =   308.23 MiB
`);
  assert.equal(placement.where, 'gpu');
  assert.equal(describePlacement(placement), 'RUN: GPU');
});

test('the same build, partly offloaded, keeps both numbers', () => {
  const placement = read(`
0.01.431.841 I load_tensors: offloading output layer to GPU
0.01.431.845 I load_tensors: offloading 4 repeating layers to GPU
0.01.431.846 I load_tensors: offloaded 5/43 layers to GPU
0.01.431.848 I load_tensors:   CPU_Mapped model buffer size =  6758.41 MiB
0.01.431.849 I load_tensors:      Vulkan0 model buffer size =  1018.77 MiB
`);
  assert.equal(placement.where, 'partial');
  assert.equal(describePlacement(placement), 'RUN: GPU 5/43 LAYERS + CPU');
});

test('a prefixed KV or compute line is still the other question', () => {
  // Losing the start-of-line anchor must not cost the distinction it was
  // carrying: every line here but the last is about the cache, and reading one
  // of them would report a GPU for weights that never left the processor.
  const placement = read(`
0.01.776.281 I llama_context: Vulkan_Host  output buffer size =     4.00 MiB
0.01.776.328 I llama_kv_cache:        CPU KV buffer size =     8.00 MiB
0.01.787.337 I sched_reserve:    Vulkan0 compute buffer size =   114.67 MiB
0.01.369.129 I load_tensors:   CPU_Mapped model buffer size =  6758.41 MiB
`);
  assert.equal(placement.where, 'cpu');
  assert.deepEqual(placement.devices, ['CPU_Mapped']);
});

test('the KV cache is a different question and is not mistaken for the weights', () => {
  // These lines have the same shape and would otherwise report a GPU for a
  // model whose weights are entirely on the processor.
  const placement = read(`
llama_kv_cache_unified:      CUDA0 KV buffer size =  1024.00 MiB
llama_context:      CUDA0 compute buffer size =   304.00 MiB
load_tensors:          CPU model buffer size =  4165.37 MiB
`);
  assert.equal(placement.where, 'cpu');
  assert.deepEqual(placement.devices, ['CPU']);
});

test('silence stays silence — nothing recognised is not a guess', () => {
  // What the badge draws as `RUN: ?`. Reporting a placement here is the exact
  // bug being fixed, one layer down.
  assert.equal(read('main: server is listening on http://127.0.0.1:8080'), null);
  assert.equal(describePlacement(null), 'RUN: ?');
});

test('the pieces read on their own', () => {
  assert.deepEqual(readOffload('load_tensors: offloaded 7/32 layers to GPU'), { layers: 7, blocks: 32 });
  assert.equal(readOffload('load_tensors: offloading output layer to GPU'), null);
  assert.equal(readWeightsDevice('load_tensors:   CPU_Mapped model buffer size =   308.23 MiB'), 'CPU_Mapped');
  assert.equal(readWeightsDevice('llama_context: CUDA0 compute buffer size = 304.00 MiB'), null);
  assert.equal(
    readWeightsDevice('0.01.369.130 I load_tensors:      Vulkan0 model buffer size =  4241.18 MiB'),
    'Vulkan0',
  );
  assert.equal(
    readWeightsDevice('0.01.787.337 I sched_reserve:    Vulkan0 compute buffer size =   114.67 MiB'),
    null,
  );
});

test('a reader keeps the line it concluded from', () => {
  const placement = read(`
load_tensors: offloaded 12/40 layers to GPU
load_tensors:        ROCm0 model buffer size =  3000.00 MiB
`);
  assert.match(placement.evidence, /offloaded 12\/40/);
});
