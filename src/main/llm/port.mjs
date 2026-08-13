/**
 * Is something already listening where we are about to start?
 *
 * This matters more than it looks. `#waitForReady` decides the server is up by
 * polling `/health` — and a *different* llama-server holding the port answers
 * that poll perfectly well. Our own child can have exited on a bind failure
 * while the app reports "ready" and quietly talks to a model nobody loaded.
 *
 * Checking first turns a silent wrong answer into an obvious error.
 */
import { createConnection } from 'node:net';

/** Resolves true when a TCP connection is accepted within `timeoutMs`. */
export function portInUse(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    // ECONNREFUSED — nothing there, which is what we want.
    socket.once('error', () => done(false));
  });
}
