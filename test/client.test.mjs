/**
 * SSE stream handling, driven against a fake endpoint.
 *
 * The interesting cases are all about framing: a server is under no obligation
 * to end its stream on a newline, and the last chunk is the one carrying both
 * the final token and the usage report.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRunaway, streamChat } from '../src/main/llm/client.mjs';

/** Serve a fixed body as a streaming response, in chunks we control. */
function fakeEndpoint(chunks, { status = 200 } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status, headers: { 'Content-Type': 'text/event-stream' } },
    );
  return () => {
    globalThis.fetch = original;
  };
}

const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;

test('assembles tokens across chunk boundaries', async () => {
  const restore = fakeEndpoint([delta('Hello'), delta(', '), delta('world')]);
  try {
    const seen = [];
    const result = await streamChat({ baseUrl: 'http://x', messages: [], onToken: (t) => seen.push(t) });
    assert.equal(result.text, 'Hello, world');
    assert.deepEqual(seen, ['Hello', ', ', 'world']);
  } finally {
    restore();
  }
});

test('an event split across two network chunks still arrives once', async () => {
  const whole = delta('split');
  const restore = fakeEndpoint([whole.slice(0, 12), whole.slice(12)]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.text, 'split');
  } finally {
    restore();
  }
});

test('the final event is not lost when the stream ends without a newline', async () => {
  // The regression: a server that closes the socket straight after its last
  // event leaves it in the buffer, costing the last token.
  const restore = fakeEndpoint([delta('first'), delta('last').trimEnd()]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.text, 'firstlast');
  } finally {
    restore();
  }
});

test('usage riding on an unterminated final chunk is still read', async () => {
  const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, total_tokens: 42 } })}`;
  const restore = fakeEndpoint([delta('hi'), usage]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.text, 'hi');
    assert.equal(result.usage.total_tokens, 42);
  } finally {
    restore();
  }
});

test('[DONE] and blank lines are ignored', async () => {
  const restore = fakeEndpoint([delta('a'), '\n', 'data: [DONE]\n']);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.text, 'a');
  } finally {
    restore();
  }
});

test('a malformed event does not abort the stream', async () => {
  const restore = fakeEndpoint([delta('good '), 'data: {not json}\n', delta('still here')]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.text, 'good still here');
  } finally {
    restore();
  }
});

test('an empty trailing buffer does not produce a phantom token', async () => {
  const restore = fakeEndpoint([delta('done'), '\n\n   ']);
  try {
    const seen = [];
    const result = await streamChat({ baseUrl: 'http://x', messages: [], onToken: (t) => seen.push(t) });
    assert.deepEqual(seen, ['done']);
    assert.equal(result.text, 'done');
  } finally {
    restore();
  }
});

test('a missing endpoint is refused before any request', async () => {
  await assert.rejects(() => streamChat({ baseUrl: '', messages: [] }), /no inference endpoint/);
});

test('an error status is reported with its body', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('model not found', { status: 503 });
  try {
    await assert.rejects(() => streamChat({ baseUrl: 'http://x', messages: [] }), /503.*model not found/s);
  } finally {
    globalThis.fetch = original;
  }
});

test('thinking reported in its own field is not lost', async () => {
  // Some endpoints put the model's reasoning in `reasoning_content`; a client
  // reading only `content` shows an empty reply despite tokens being generated.
  const reason = (t) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] })}\n`;
  const restore = fakeEndpoint([reason('weighing it up'), delta('Red, blue, green.')]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.match(result.text, /<think>\nweighing it up\n<\/think>/);
    assert.match(result.text, /Red, blue, green\./);
  } finally {
    restore();
  }
});

test('a reply with no separate thinking is left exactly as it came', async () => {
  const restore = fakeEndpoint([delta('Just the answer.')]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.text, 'Just the answer.');
  } finally {
    restore();
  }
});

test('thinking with no answer still yields something to render', async () => {
  const reason = (t) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] })}\n`;
  const restore = fakeEndpoint([reason('thought but never spoke')]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.match(result.text, /thought but never spoke/);
  } finally {
    restore();
  }
});

test('a stop that lands before the first byte is a stop, not a failure', async () => {
  // llama.cpp sends no headers until the prompt has been processed and the
  // first token exists, so "Thinking…" is spent inside `fetch` itself — and
  // that is exactly when Stop gets pressed. The request rejects there rather
  // than mid-stream, which used to escape as "This operation was aborted",
  // drawn in the transcript as a failed reply.
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  try {
    const controller = new AbortController();
    const pending = streamChat({ baseUrl: 'http://x', messages: [], signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.text, '');
  } finally {
    globalThis.fetch = original;
  }
});

test('a request that fails for its own reasons is still a failure', async () => {
  // The other half: only a stop is forgiven. A dead endpoint with no stop
  // pressed must go on being reported as one.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  try {
    const controller = new AbortController();
    await assert.rejects(
      () => streamChat({ baseUrl: 'http://x', messages: [], signal: controller.signal }),
      /ECONNREFUSED/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

/* ---------- reasoning that goes round in circles ---------- */

/**
 * The loop from the session that was reported, a turn of it.
 *
 * Asked for a playlist, the model chose the right action in its first ten
 * lines and then wrote this until it was stopped — several hundred times, with
 * nothing on screen but "Thinking…".
 */
const ROUND = [
  'I will output the response.',
  'I will not add any other text.',
  'The user expects a confirmation.',
  '"Я пограв весь плейліст пісень Перл джем." is the confirmation.',
  '',
  'I will output the response.',
  'I will use the action block.',
  '',
].join('\n');

const HEAD = [
  'The user wants a playlist of songs by Pearl Jam.',
  'I need to use the `queue_music` tool to create this playlist.',
  'So I should use {"type":"queue_music","steps":"pearl jam"}.',
  '',
].join('\n');

const reason = (t) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] })}\n`;

test('a passage coming round again and again is a loop', () => {
  assert.equal(isRunaway(HEAD + ROUND.repeat(8)), true);
  // Whichever point of the cycle the stream happens to be at.
  assert.equal(isRunaway(HEAD + ROUND.repeat(8) + 'I will output the resp'), true);
  // One blank line or two between turns of it is the same loop.
  assert.equal(isRunaway(HEAD + `${ROUND}\n`.repeat(4) + ROUND.repeat(4)), true);
  // A single word, which is how the smallest models do it.
  assert.equal(isRunaway(`Let me think. ${'the '.repeat(200)}`), true);
});

test('thinking that is merely long, or says a thing twice, is not', () => {
  assert.equal(isRunaway(''), false);
  assert.equal(isRunaway(HEAD), false);
  // Coming back to a point is what deliberating is. Twice is not a loop, and
  // neither is three times.
  assert.equal(isRunaway(HEAD + ROUND.repeat(3)), false);
  // A long list whose lines differ, however alike they look.
  const steps = Array.from({ length: 200 }, (_, at) => `Step ${at + 1}: check item ${at * 7} against the list.`).join('\n');
  assert.equal(isRunaway(steps), false);
  // A loop that was left: the tail is new, so it is going somewhere again.
  assert.equal(isRunaway(ROUND.repeat(8) + 'On reflection the request is simple, so the plan stands and the action goes out as written above.'), false);
});

test('reasoning that loops is stopped, and what looped is not kept', async () => {
  const turns = Array.from({ length: 400 }, () => reason(ROUND));
  const restore = fakeEndpoint([reason(HEAD), ...turns, delta('never reached')]);
  try {
    const seen = [];
    const result = await streamChat({ baseUrl: 'http://x', messages: [], onToken: (t) => seen.push(t) });
    assert.equal(result.runaway, true);
    // Nobody pressed Stop, so it is not reported as one.
    assert.equal(result.aborted, false);
    // Stopped within a handful of turns of the loop, not at the end of it.
    assert.ok(seen.length < 20, `listened to ${seen.length} chunks of it`);
    // The part that was still thought survives; several hundred copies do not.
    assert.match(result.text, /^<think>\nThe user wants a playlist/);
    assert.ok(result.text.length < 2000, `kept ${result.text.length} characters of a loop`);
    assert.doesNotMatch(result.text, /never reached/);
  } finally {
    restore();
  }
});

test('a loop inside an inline <think> is stopped the same way', async () => {
  // An endpoint that does not parse reasoning out leaves it in the content.
  const restore = fakeEndpoint([delta(`<think>\n${HEAD}`), ...Array.from({ length: 200 }, () => delta(ROUND))]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.runaway, true);
    assert.ok(result.text.length < 2000);
    // Closed, so the rest of the app reads it as reasoning and not as an answer.
    assert.match(result.text, /<\/think>\n$/);
  } finally {
    restore();
  }
});

test('an answer may repeat itself as much as it was asked to', async () => {
  // Only reasoning is watched. "Print it fifty times" is a request, and an
  // answer cut short would be the app deciding what a reply may contain.
  const line = 'All work and no play makes Jack a dull boy.\n';
  const restore = fakeEndpoint(Array.from({ length: 120 }, () => delta(line)));
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.runaway, false);
    assert.equal(result.text, line.repeat(120));
  } finally {
    restore();
  }
});

test('a loop that ended inside its own </think> is not held against the answer', async () => {
  const restore = fakeEndpoint([delta(`<think>\n${HEAD}${ROUND.repeat(2)}</think>\n`), ...Array.from({ length: 60 }, () => delta('la la la la\n'))]);
  try {
    const result = await streamChat({ baseUrl: 'http://x', messages: [] });
    assert.equal(result.runaway, false);
    assert.match(result.text, /la la la la\n$/);
  } finally {
    restore();
  }
});
