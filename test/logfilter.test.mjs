/**
 * Which of llama-server's lines reach the activity log.
 *
 * The app asks for `trace` output because that is the only place llama.cpp
 * still says where the weights went. The bill for that is 246 lines on a load
 * and 38 on every turn — every key-value pair in the GGUF header, every slot
 * decision, the whole sampler chain — arriving in the pane where the user
 * watches the browser and the agent work.
 *
 * The excerpts are verbatim from build 10405 on the machine that reported it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logFilter } from '../src/main/llm/server.mjs';

/** Run a block through one filter, the way a single stream does. */
function shown(lines) {
  const worthShowing = logFilter();
  return lines
    .trim()
    .split('\n')
    .filter((line) => worthShowing(line));
}

test('a warning is shown and the routine line beside it is not', () => {
  const kept = shown(`
0.00.087.934 I cmn  common_param: common_params_print_info: verbosity = 3
0.00.088.882 W srv  llama_server: CORS is set to allow all origins ('*') and no API key is set
0.01.369.125 I load_tensors: offloaded 43/43 layers to GPU
0.01.083.776 W load: special_eog_ids contains '<|tool_response>', removing '</s>' token from EOG list
`);
  assert.deepEqual(
    kept.map((line) => line.slice(0, 24)),
    ['0.00.088.882 W srv  llam', '0.01.083.776 W load: spe'],
  );
});

test('an error is never routine', () => {
  const kept = shown(`
0.01.369.129 I load_tensors:   CPU_Mapped model buffer size =  3536.00 MiB
0.02.000.000 E srv  llama_server: failed to allocate compute buffers
`);
  assert.equal(kept.length, 1);
  assert.match(kept[0], /failed to allocate/);
});

test('a wrapped line shares the fate of the line it belongs to', () => {
  // Two shapes, both real. The sampler parameters wrap indented; the chat
  // template llama.cpp echoes back wraps at column 0, in the model's own
  // syntax. Neither says anything without the heading above it, which is
  // routine — so a filter that kept them would put eleven lines of Gemma's
  // turn markers in the log with nothing to explain them.
  const kept = shown(`
0.03.449.455 I slot launch_slot_: id  3 | task -1 | sampler params:
	repeat_last_n = 64, repeat_penalty = 1.000, frequency_penalty = 0.000
	top_k = 64, top_p = 0.950, min_p = 0.050, temp = 1.000
0.03.002.267 I srv          init: init: chat template, example_format: '<|turn>system
<|think|>
You are a helpful assistant<turn|>
<|turn>user
Hello<turn|>
'
0.03.003.043 I srv  llama_server: model loaded
`);
  assert.deepEqual(kept, []);
});

test('a bare abort is not mistaken for a continuation', () => {
  // A failed GGML_ASSERT prints without a severity field and aborts on the
  // spot. Whatever routine line happens to precede it, it is the one line in
  // the log worth having.
  const kept = shown(`
0.03.449.456 I slot launch_slot_: id  3 | task 0 | processing task, is_child = 0
D:/a/llama.cpp/ggml/src/ggml.c:5678: GGML_ASSERT(ggml_nelements(a) == ne0*ne1) failed
`);
  assert.equal(kept.length, 1);
  assert.match(kept[0], /GGML_ASSERT/);
});

test('a build that prints no severity field at all is left alone', () => {
  // Every line here would have been shown before the filter existed, and still
  // is: there is nothing in them to filter on, and guessing would be worse.
  const kept = shown(`
llm_load_tensors: offloaded 33/33 layers to GPU
llm_load_tensors:      CUDA0 buffer size =  4095.05 MiB
main: server is listening on http://127.0.0.1:8080
`);
  assert.equal(kept.length, 3);
});

test('the filter is per stream, so one does not silence the other', () => {
  const stdout = logFilter();
  const stderr = logFilter();
  assert.equal(stdout('0.00.1 I srv init: quiet'), false);
  // stderr has seen no prefix yet, so it is still in the unfiltered case — a
  // shared filter would have carried stdout's verdict across.
  assert.equal(stderr('something without a prefix'), true);
});
