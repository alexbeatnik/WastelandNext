/**
 * Refusing a browser batch that already ran this turn.
 *
 * From a real session: asked for the cheapest lawnmower on a shop, a model sent
 * the same "open the sort menu, choose price ascending" batch five times. Every
 * one of them resolved — the engine found a target and clicked it — so nothing
 * told the model the sort had not applied, and nothing stopped it repeating.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchGuard, REPEAT_FEEDBACK, batchSignature } from '../src/main/agent/batch-guard.mjs';

/** The batch from that session, verbatim. */
const SORT = "CLICK the 'Сортування' button\nWAIT 2\nSELECT 'Ціна: від низької до високої' from the 'Сортування' dropdown";

test('the first attempt is allowed', () => {
  const guard = new BatchGuard();
  guard.beginTurn();
  assert.equal(guard.check(SORT), null);
});

test('an identical second attempt is refused', () => {
  const guard = new BatchGuard();
  guard.beginTurn();
  guard.check(SORT);
  assert.equal(guard.check(SORT), REPEAT_FEEDBACK);
});

test('the refusal names a way forward rather than only saying no', () => {
  // A bare "no" tends to produce the same batch a third time, apologetically.
  assert.match(REPEAT_FEEDBACK, /different label/i);
  assert.match(REPEAT_FEEDBACK, /query parameters/i);
  assert.match(REPEAT_FEEDBACK, /tell the user/i);
});

test('whitespace and blank lines do not disguise a repeat', () => {
  const guard = new BatchGuard();
  guard.beginTurn();
  guard.check("CLICK the 'Сортування' button\nWAIT 2");
  assert.equal(guard.check("  CLICK the 'Сортування' button  \n\n   WAIT 2\n"), REPEAT_FEEDBACK);
});

test('a genuinely different batch is allowed', () => {
  const guard = new BatchGuard();
  guard.beginTurn();
  guard.check(SORT);
  assert.equal(guard.check('NAVIGATE to https://shop.test/list?sort=price_asc'), null);
});

test('a step order that differs is a different batch', () => {
  const guard = new BatchGuard();
  guard.beginTurn();
  guard.check('CLICK the X\nCLICK the Y');
  assert.equal(guard.check('CLICK the Y\nCLICK the X'), null);
});

test('a new turn forgets what the last one tried', () => {
  const guard = new BatchGuard();
  guard.beginTurn();
  guard.check(SORT);

  guard.beginTurn();
  assert.equal(guard.check(SORT), null, 'the same steps are legitimate in a later turn');
});

test('an empty batch is never treated as a repeat', () => {
  const guard = new BatchGuard();
  guard.beginTurn();
  assert.equal(guard.check(''), null);
  assert.equal(guard.check('   \n\n  '), null);
  assert.equal(guard.check(null), null);
});

test('the signature is the trimmed, blank-free step list', () => {
  assert.equal(batchSignature('  a \n\n b  \n'), 'a\nb');
  assert.equal(batchSignature(''), '');
});
