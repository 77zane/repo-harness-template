import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../src/app/server.mjs';
import { QuotaExceededError, ValidationError } from '../../src/foundation/errors.mjs';

/**
 * REAL-composition 真实装配输出边界测试：
 * 直接从 createApp() 对外边界验证核心业务承重墙。
 * 若有人在 handleAttach() 偷偷加 256 KiB / 512 KiB 尾部截断，底层 ByteRingBuffer 单测仍会绿，
 * 但本测试会立刻红灯拦截。
 */

test('冷连接 handleAttach 必须 100% 无损保留 >1.2 MiB 历史输出且首尾标记完整', () => {
  const app = createApp();
  app.openSession('tenant-a', 'sess-1');

  const startMarker = '<<<START_MARKER_0001>>>\n';
  const endMarker = '\n<<<END_MARKER_9999>>>';
  const linePayload = '\x1b[32mINFO\x1b[0m 构建输出日志行含 ANSI 转义序列 0123456789abcdef\n';

  app.appendOutput('tenant-a', 'sess-1', startMarker);
  // 以真实流式分块写入约 1.3 MiB（远大于 512 KiB、小于默认 4 MiB 上限）。
  const chunk = linePayload.repeat(64);
  for (let i = 0; i < 280; i += 1) {
    app.appendOutput('tenant-a', 'sess-1', chunk);
  }
  app.appendOutput('tenant-a', 'sess-1', endMarker);

  const expectedBytes =
    Buffer.byteLength(startMarker) + 280 * Buffer.byteLength(chunk) + Buffer.byteLength(endMarker);
  assert.ok(expectedBytes > 1_200_000, '测试样本载荷必须大于 1.2 MiB');

  const snap = app.handleAttach('tenant-a', 'sess-1');
  assert.equal(snap.data.byteLength, expectedBytes);
  assert.equal(snap.truncated, false);

  const decoded = Buffer.from(snap.data).toString('utf8');
  assert.ok(decoded.startsWith(startMarker), '冷连接回放不得截断起始标记');
  assert.ok(decoded.endsWith(endMarker), '冷连接回放必须保留末尾标记');
});

test('增量 handleAttach 应仅返回新输出，且在真实淘汰后标记 truncated: true', () => {
  const app = createApp({ maxReplayBytes: 12 });
  app.openSession('tenant-a', 'sess-2');
  const seq1 = app.appendOutput('tenant-a', 'sess-2', '123456');
  const seq2 = app.appendOutput('tenant-a', 'sess-2', 'abcdef');

  const delta = app.handleAttach('tenant-a', 'sess-2', { sinceSeq: seq1 });
  assert.equal(Buffer.from(delta.data).toString('utf8'), 'abcdef');
  assert.equal(delta.latestSeq, seq2);
  assert.equal(delta.truncated, false);

  // 追加新块挤出 seq1，增量查询 sinceSeq=0 必须在真实装配边界显式返回 truncated: true。
  const seq3 = app.appendOutput('tenant-a', 'sess-2', 'XYZ');
  const evictedDelta = app.handleAttach('tenant-a', 'sess-2', { sinceSeq: 0 });
  assert.equal(Buffer.from(evictedDelta.data).toString('utf8'), 'abcdefXYZ');
  assert.equal(evictedDelta.latestSeq, seq3);
  assert.equal(evictedDelta.truncated, true);
});

test('未知会话 handleAttach 应返回空且不建孤儿缓冲，非法 sinceSeq 快速失败', () => {
  const app = createApp();
  const empty = app.handleAttach('tenant-x', 'unknown-sess');
  assert.equal(empty.data.byteLength, 0);
  assert.equal(empty.latestSeq, 0);
  assert.equal(empty.truncated, false);
  assert.equal(app.getTenantUsage('tenant-x').allocatedBuffers, 0);

  assert.throws(() => app.handleAttach('tenant-x', 'unknown-sess', { sinceSeq: -1 }), ValidationError);
});

test('装配边界应拦截非法配置、阻止绕过配额写入、隔离跨租户会话并在关闭时回收缓冲', () => {
  assert.throws(() => createApp({ maxReplayBytes: /** @type {any} */ ('512kb') }), ValidationError);
  assert.throws(() => createApp({ maxReplayBytes: Number.NaN }), ValidationError);

  const app = createApp({ maxSessionsPerTenant: 1 });
  // 未调用 openSession 直接写入必须被拒绝，防止绕过配额无限分配 4 MiB 缓冲。
  assert.throws(() => app.appendOutput('tenant-a', 'ghost', 'hi'), ValidationError);

  app.openSession('tenant-a', 'shared-id');
  app.openSession('tenant-b', 'shared-id');
  app.appendOutput('tenant-a', 'shared-id', 'SECRET-A');
  app.appendOutput('tenant-b', 'shared-id', 'SECRET-B');

  assert.equal(Buffer.from(app.handleAttach('tenant-a', 'shared-id').data).toString('utf8'), 'SECRET-A');
  assert.equal(Buffer.from(app.handleAttach('tenant-b', 'shared-id').data).toString('utf8'), 'SECRET-B');
  assert.throws(() => app.openSession('tenant-a', 'second-sess'), QuotaExceededError);
  assert.equal(app.getTenantUsage('tenant-a').allocatedBuffers, 2);

  app.closeSession('tenant-a', 'shared-id');
  assert.equal(app.getTenantUsage('tenant-a').activeSessions, 0);
  assert.equal(app.getTenantUsage('tenant-a').allocatedBuffers, 1);
  assert.equal(app.handleAttach('tenant-a', 'shared-id').data.byteLength, 0);
  assert.throws(() => app.appendOutput('tenant-a', 'shared-id', 'after-close'), ValidationError);
});
