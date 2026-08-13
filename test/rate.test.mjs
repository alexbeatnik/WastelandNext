/**
 * Download speed and time remaining.
 *
 * The clock is passed in throughout, because both bugs this guards against are
 * only visible with time under the test's control: a resumed transfer crediting
 * yesterday's bytes to today's speed, and a stalled one going on quoting the
 * rate it managed before it stopped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateMeter } from '../src/main/models/rate.mjs';
import { formatDuration } from '../src/shared/render.mjs';

const MB = 1024 * 1024;

/* ============================ the meter ============================ */

test('one sample is a baseline, not a reading', () => {
  const meter = new RateMeter();
  meter.sample(0, 1000);
  assert.equal(meter.rate(1000), 0, 'nothing can be said from a single point');
});

test('a steady transfer reports the rate it is running at', () => {
  const meter = new RateMeter();
  meter.sample(0, 0);
  meter.sample(10 * MB, 1000);
  meter.sample(20 * MB, 2000);

  assert.equal(Math.round(meter.rate(2000) / MB), 10);
});

test('bytes already on disk are not credited to this session', () => {
  // The real case: a 4 GB download resumed at 3 GB. Divide `received` by
  // elapsed time and the first reading is gigabytes per second, all of it
  // bytes that arrived on a previous run.
  const resumedAt = 3000 * MB;
  const meter = new RateMeter();
  meter.sample(resumedAt, 0);
  meter.sample(resumedAt + 5 * MB, 1000);

  assert.equal(Math.round(meter.rate(1000) / MB), 5, 'only the new bytes count');
});

test('the reading follows the recent window, not the whole transfer', () => {
  const meter = new RateMeter({ windowMs: 2000 });
  // A fast minute…
  for (let second = 0; second <= 60; second += 1) meter.sample(second * 40 * MB, second * 1000);
  // …then a crawl.
  meter.sample(60 * 40 * MB + 1 * MB, 61_000);
  meter.sample(60 * 40 * MB + 2 * MB, 62_000);

  assert.equal(Math.round(meter.rate(62_000) / MB), 1, 'it must report the crawl, not the minute before it');
});

test('a transfer gone quiet reports nothing rather than its old speed', () => {
  const meter = new RateMeter({ windowMs: 2000 });
  meter.sample(0, 0);
  meter.sample(40 * MB, 1000);
  assert.ok(meter.rate(1000) > 0);

  // Ten seconds later, with nothing having landed since.
  assert.equal(meter.rate(11_000), 0);
});

test('time going backwards or standing still yields no reading', () => {
  const meter = new RateMeter();
  meter.sample(0, 5000);
  meter.sample(10 * MB, 5000);
  assert.equal(meter.rate(5000), 0, 'two samples at the same instant are not a speed');
});

/* ============================ time remaining ============================ */

test('the estimate is the remainder over the measured rate', () => {
  const meter = new RateMeter();
  meter.sample(0, 0);
  meter.sample(10 * MB, 1000);

  // 90 MB left at 10 MB/s.
  assert.equal(Math.round(meter.eta(10 * MB, 100 * MB, 1000)), 9);
});

test('no total, no speed and no bytes left each yield null, never a guess', () => {
  const meter = new RateMeter();
  meter.sample(0, 0);
  meter.sample(10 * MB, 1000);

  assert.equal(meter.eta(10 * MB, 0, 1000), null, 'a server that sent no length gives no estimate');
  assert.equal(meter.eta(100 * MB, 100 * MB, 1000), null, 'nothing left to wait for');

  const cold = new RateMeter();
  cold.sample(0, 0);
  assert.equal(cold.eta(0, 100 * MB, 0), null, '"0s left" before the first measurement would be a lie');
});

/* ============================ formatting ============================ */

test('a duration is coarse on purpose', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(60), '1m 0s');
  assert.equal(formatDuration(200), '3m 20s');
  assert.equal(formatDuration(3600), '1h 0m');
  assert.equal(formatDuration(3900), '1h 5m');
});

test('a duration never comes out negative or unreadable', () => {
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(NaN), '0s');
  assert.equal(formatDuration(null), '0s');
  assert.equal(formatDuration(undefined), '0s');
});
