/**
 * Explaining a llama-server crash.
 *
 * The log excerpts here are real output, captured from a failing load. An exit
 * code alone names no cause, so what matters is that each of these produces a
 * sentence the user can act on.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summariseFailure } from '../src/main/llm/failure.mjs';

/** Verbatim tail of a 25 GB model loaded onto a 12 GB card. */
const VRAM_OOM = [
  "0.00.947.119 W load: special_eot_id is not in special_eog_ids - the tokenizer config may be incorrect",
  'ggml_vulkan: Device memory allocation of size 1037832192 failed.',
  'ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory',
  '0.02.468.179 E alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1037832192',
  '0.02.672.374 E llama_model_load: error loading model: unable to allocate Vulkan0 buffer',
  '0.02.672.380 E llama_model_load_from_file_impl: failed to load model',
  '0.02.672.398 I srv    operator(): operator(): cleaning up before exit...',
  '0.02.673.253 E srv  llama_server: exiting due to model loading error',
];

test('an out-of-VRAM failure says so, and says what to change', () => {
  const summary = summariseFailure(VRAM_OOM, { code: 1 });
  assert.match(summary, /VRAM/);
  assert.match(summary, /GPU LAYERS/);
});

test('a CUDA build gets the same explanation', () => {
  const summary = summariseFailure(
    ['ggml_cuda: cudaMalloc failed: out of memory', 'E llama_model_load: error loading model'],
    { code: 1 },
  );
  assert.match(summary, /VRAM/);
});

test('a port clash is named rather than blamed on the model', () => {
  const summary = summariseFailure(
    ['E srv main: failed to bind to 127.0.0.1:8080 (address already in use)'],
    { code: 1 },
  );
  assert.match(summary, /already in use/);
  assert.match(summary, /llama-server/);
});

test('plain host memory exhaustion is distinguished from VRAM', () => {
  const summary = summariseFailure(['terminate called after throwing an instance of std::bad_alloc'], { code: 134 });
  assert.match(summary, /out of memory/);
  assert.doesNotMatch(summary, /VRAM/);
});

test('an option the build does not know points at updating it', () => {
  const summary = summariseFailure(['error: invalid argument: --reasoning-budget'], { code: 1 });
  assert.match(summary, /update it/);
});

test('an unrecognised failure quotes the complaint rather than inventing one', () => {
  const summary = summariseFailure([
    '0.00.100.000 I srv starting',
    '0.00.200.000 E srv something nobody has seen before went wrong',
    '0.00.300.000 I srv cleaning up before exit...',
  ]);
  assert.match(summary, /something nobody has seen before went wrong/);
  // The timestamp and severity marker are stripped for readability.
  assert.doesNotMatch(summary, /0\.00\.200\.000/);
});

test('the complaint is preferred over the last line, which is usually cleanup', () => {
  const summary = summariseFailure([
    'E model: the real problem',
    'I srv: cleaning up before exit...',
  ]);
  assert.match(summary, /the real problem/);
});

test('with no output at all it still says something true', () => {
  assert.match(summariseFailure([], { code: 1 }), /exited \(1\)/);
  assert.match(summariseFailure([], { signal: 'SIGKILL' }), /SIGKILL/);
  assert.match(summariseFailure(null, { code: 9 }), /exited \(9\)/);
});

test('an uneventful log falls back to its last line', () => {
  assert.equal(summariseFailure(['I srv: all quiet', 'I srv: goodbye']), 'srv: goodbye');
});

test('a very long line is truncated rather than flooding the status bar', () => {
  const summary = summariseFailure([`E ${'x'.repeat(500)}`]);
  assert.ok(summary.length <= 200, `too long: ${summary.length}`);
});
