/**
 * The port guard.
 *
 * This exists because of a failure that looked like success: another
 * llama-server holding the port answered our readiness poll, so the app
 * reported a model as loaded while talking to a process it did not start.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { portInUse } from '../src/main/llm/port.mjs';

/** Listen on an ephemeral port and report which one. */
function listen() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }));
  });
}

test('reports a port that something is listening on', async () => {
  const { port, server } = await listen();
  try {
    assert.equal(await portInUse('127.0.0.1', port), true);
  } finally {
    server.close();
  }
});

test('reports a free port as free', async () => {
  const { port, server } = await listen();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portInUse('127.0.0.1', port), false);
});

test('a refused connection is not treated as in use', async () => {
  // Nothing has ever listened here; ECONNREFUSED must read as "free".
  assert.equal(await portInUse('127.0.0.1', 1), false);
});

test('an unroutable address times out as free rather than hanging', async () => {
  // 203.0.113.0/24 is reserved for documentation and goes nowhere.
  const started = Date.now();
  assert.equal(await portInUse('203.0.113.1', 9999, 300), false);
  assert.ok(Date.now() - started < 5000, 'should give up quickly');
});
