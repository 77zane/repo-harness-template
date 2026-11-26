import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPositiveInt, ValidationError } from '../../src/foundation/errors.mjs';
import { ByteRingBuffer } from '../../src/foundation/ring-buffer.mjs';

test('assertPositiveInt 应拒绝 NaN、0、负数、小数与带单位字符串', () => {
  assert.equal(assertPositiveInt(4096, 'limit'), 4096);
  for (const bad of [0, -1, 1.5, Number.NaN, '512kb', null, undefined]) {
    assert.throws(() => assertPositiveInt(bad, 'limit'), ValidationError);
  }
});

test('ByteRingBuffer 在容量内全量保留，超出上限时按 FIFO 淘汰最早分块', () => {
  const buf = new ByteRingBuffer(10);
  const seq1 = buf.push('12345');
  const seq2 = buf.push('67890');
  assert.equal(seq1, 1);
  assert.equal(seq2, 2);

  const full = buf.snapshot(null);
  assert.equal(Buffer.from(full.data).toString('utf8'), '1234567890');
  assert.equal(full.latestSeq, 2);
  assert.equal(full.truncated, false);

  buf.push('abc');
  const afterEvict = buf.snapshot(null);
  assert.equal(Buffer.from(afterEvict.data).toString('utf8'), '67890abc');

  const deltaEvicted = buf.snapshot(0);
  assert.equal(deltaEvicted.truncated, true);

  const deltaIntact = buf.snapshot(1);
  assert.equal(deltaIntact.truncated, false);
  assert.equal(Buffer.from(deltaIntact.data).toString('utf8'), '67890abc');
});

test('ByteRingBuffer 遇空块不应误报截断，遇单块超容截断必须如实标记 truncated', () => {
  const b1 = new ByteRingBuffer(100);
  assert.equal(b1.push(''), 0);
  assert.equal(b1.snapshot(0).truncated, false);
  assert.equal(b1.push('hello'), 1);
  const snap1 = b1.snapshot(0);
  assert.equal(Buffer.from(snap1.data).toString('utf8'), 'hello');
  assert.equal(snap1.truncated, false);

  const b2 = new ByteRingBuffer(4);
  const seq = b2.push('12345678');
  assert.equal(seq, 1);
  const snap2 = b2.snapshot(0);
  assert.equal(Buffer.from(snap2.data).toString('utf8'), '5678');
  assert.equal(snap2.truncated, true);
  assert.equal(b2.snapshot(1).truncated, false);
});
