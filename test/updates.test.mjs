/**
 * Update status: what a failure means, and how it is said.
 *
 * `updater.mjs` imports `electron` and cannot run here, which is exactly why
 * the two decisions worth checking — is this actually a failure, and what does
 * the user read — live in `shared/updates.mjs` instead.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyError, describeUpdate, isBusy, isReady } from '../src/shared/updates.mjs';

/* ============================ what a failure means ============================ */

test('a repository with no releases yet is not a failure', () => {
  // The first run of any new project hits this. Reported as an error, it sends
  // the user looking for a firewall that was never in the way.
  const status = classifyError(new Error('Error: No published versions on GitHub'));
  assert.deepEqual(status, { state: 'current' });
});

test('a release published without latest.yml is named exactly', () => {
  const status = classifyError(new Error('HttpError: 404 Not Found: latest.yml'));
  assert.equal(status.state, 'error');
  assert.match(status.message, /missing latest\.yml/);
});

test('a network failure says so in words, not in error codes', () => {
  for (const raw of ['net::ERR_INTERNET_DISCONNECTED', 'getaddrinfo ENOTFOUND github.com', 'connect ETIMEDOUT']) {
    assert.equal(classifyError(new Error(raw)).message, 'could not reach GitHub', raw);
  }
});

test('a rate limit is its own answer, since waiting is the fix', () => {
  assert.match(classifyError(new Error('API rate limit exceeded')).message, /rate limit/);
});

test('an unrecognised failure keeps its first line and nothing more', () => {
  const status = classifyError(new Error('Something odd happened\n    at Object.<anonymous>\n    at Module._compile'));
  assert.equal(status.message, 'Something odd happened');
});

test('a very long message is cut rather than allowed to break the line', () => {
  assert.ok(classifyError(new Error('x'.repeat(500))).message.length <= 200);
});

test('anything at all can be thrown at it', () => {
  assert.equal(classifyError('plain string').state, 'error');
  assert.equal(classifyError(null).message, 'update check failed');
  assert.equal(classifyError(undefined).message, 'update check failed');
});

/* ============================ how it is said ============================ */

test('every state has a sentence', () => {
  const states = ['idle', 'checking', 'current', 'available', 'downloading', 'ready', 'error', 'unsupported'];
  for (const state of states) {
    const text = describeUpdate({ state });
    assert.ok(text.length > 0, `${state} said nothing`);
    assert.ok(!/undefined|NaN|\[object/.test(text), `${state} → ${text}`);
  }
});

test('an unknown state falls back rather than showing a blank line', () => {
  assert.equal(describeUpdate({ state: 'something-new' }), 'Not checked yet.');
  assert.equal(describeUpdate(undefined), 'Not checked yet.');
});

test('the version is named when known and elided when not', () => {
  assert.match(describeUpdate({ state: 'ready', version: '0.2.0' }), /version 0\.2\.0/);
  assert.match(describeUpdate({ state: 'ready' }), /a new version/);
});

test('progress is shown, and a missing percentage reads as zero rather than nothing', () => {
  assert.match(describeUpdate({ state: 'downloading', version: '0.2.0', percent: 42 }), /42%/);
  assert.match(describeUpdate({ state: 'downloading' }), /0%/);
});

test('a build that cannot update itself says so instead of offering to try', () => {
  assert.match(describeUpdate({ state: 'unsupported' }), /by hand/);
});

/* ============================ what the button does ============================ */

test('the button is offered only when there is something to press it for', () => {
  assert.equal(isReady({ state: 'ready' }), true);
  assert.equal(isReady({ state: 'available' }), false, 'downloading is not installable yet');

  assert.equal(isBusy({ state: 'checking' }), true);
  assert.equal(isBusy({ state: 'downloading' }), true);
  assert.equal(isBusy({ state: 'current' }), false);
  assert.equal(isBusy(undefined), false);
});
