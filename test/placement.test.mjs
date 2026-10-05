/**
 * Where a model will run, worked out before anyone clicks LOAD.
 *
 * The arithmetic itself is `gguf.mjs` and `gpu.mjs`, and both are tested where
 * they live. What is tested here is the part that decides how often that
 * arithmetic is *believed*: headers are cached by path, size and mtime, and a
 * cache keyed on the path alone would go on reporting a shape the file no
 * longer has — a model replaced in place by a re-download or a repack would be
 * labelled `GPU 15/52` from the header of the file it used to be.
 *
 * The plan itself is asserted for internal consistency rather than against a
 * particular card: this suite has to give the same answer on a machine with an
 * NVIDIA GPU and on one without.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placementLabel, planFor } from '../src/main/models/placement.mjs';

/* A GGUF header, written by hand — the spec is the point, and a real model is
 * gigabytes. Same shape as the fixture writer in `gguf.test.mjs`. */
const TYPE = { UINT32: 4, STRING: 8 };

const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};

const u64 = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
};

const str = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
};

function entry(key, type, value) {
  const head = Buffer.concat([str(key), u32(type)]);
  return Buffer.concat([head, type === TYPE.STRING ? str(value) : u32(value)]);
}

/** A plausible 7B, and a knob for the one number the second write changes. */
function modelFile(dir, name, { blocks = 28, padBytes = 0 } = {}) {
  const entries = [
    entry('general.architecture', TYPE.STRING, 'qwen2'),
    entry('general.name', TYPE.STRING, 'Qwen2.5 7B Instruct'),
    entry('qwen2.context_length', TYPE.UINT32, 32768),
    entry('qwen2.block_count', TYPE.UINT32, blocks),
    entry('qwen2.embedding_length', TYPE.UINT32, 3584),
    entry('qwen2.attention.head_count', TYPE.UINT32, 28),
    entry('qwen2.attention.head_count_kv', TYPE.UINT32, 4),
  ];
  const path = join(dir, name);
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from('GGUF', 'ascii'),
      u32(3),
      u64(0),
      u64(entries.length),
      ...entries,
      // Stands in for the tensors, so the file has a plausible size — which is
      // half of what the placement arithmetic weighs.
      Buffer.alloc(padBytes),
    ]),
  );
  return path;
}

test('a plan says what the header knows, whatever card is fitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wl-placement-'));
  const plan = await planFor(modelFile(dir, 'qwen.gguf', { padBytes: 4096 }));

  assert.ok(plan, 'a readable header is a plan');
  assert.equal(plan.blocks, 28);
  assert.equal(plan.modelMax, 32768, 'the trained context is a hard cap, and comes from the header');
  assert.ok(plan.context > 0 && plan.context <= plan.modelMax);
  assert.ok(plan.reason, 'a placement with no reason cannot be explained on the row');

  // The three facts have to agree, however much VRAM this machine has.
  assert.ok(['gpu', 'cpu', 'partial', 'unknown'].includes(plan.where));
  assert.equal(plan.where === 'unknown', plan.vramBytes === 0, 'no card is the only reason not to know');
  assert.ok(plan.layers <= plan.blocks, 'more layers offloaded than the model has is not an answer');
  if (plan.where === 'gpu') assert.equal(plan.layers, plan.blocks);
  if (plan.where === 'cpu') assert.equal(plan.layers, 0);
});

test('the header is re-read when the file it came from changes', async () => {
  // Cached by path, size and mtime — never by path alone. A model replaced in
  // place is the case that goes wrong quietly: the row would go on quoting the
  // shape of the file it used to be, and the label is the whole reason the
  // header is read before a load rather than after one.
  const dir = mkdtempSync(join(tmpdir(), 'wl-placement-cache-'));
  const path = join(dir, 'model.gguf');

  modelFile(dir, 'model.gguf', { blocks: 28, padBytes: 4096 });
  assert.equal((await planFor(path)).blocks, 28);
  assert.equal((await planFor(path)).blocks, 28, 'an unchanged file is answered from the cache');

  modelFile(dir, 'model.gguf', { blocks: 40, padBytes: 8192 });
  assert.equal((await planFor(path)).blocks, 40);
});

test('a file that is not a model has no plan, and the caller falls back', async () => {
  // Null rather than a guess: the size-only estimate is what a search result
  // has, and it is labelled as an estimate where it is drawn.
  assert.equal(await planFor(join(process.cwd(), 'package.json')), null);
  assert.equal(await planFor(join(process.cwd(), 'no-such-model.gguf')), null);
  assert.equal(await planFor(''), null);
});

test('the label is short enough for a row, and says nothing when it knows nothing', () => {
  assert.equal(placementLabel({ where: 'gpu', layers: 28, blocks: 28 }), 'GPU');
  assert.equal(placementLabel({ where: 'cpu', layers: 0, blocks: 52 }), 'CPU');
  assert.equal(placementLabel({ where: 'partial', layers: 15, blocks: 52 }), 'GPU 15/52');
  // A machine with no readable card says nothing at all, rather than guessing
  // out loud on every row of the vault.
  assert.equal(placementLabel({ where: 'unknown', layers: 0, blocks: 52 }), '');
  assert.equal(placementLabel(null), '');
});
