/**
 * SSE stream handling, driven against a fake endpoint.
 *
 * The interesting cases are all about framing: a server is under no obligation
 * to end its stream on a newline, and the last chunk is the one carrying both
 * the final token and the usage report.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamChat } from '../src/main/llm/client.mjs';

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
