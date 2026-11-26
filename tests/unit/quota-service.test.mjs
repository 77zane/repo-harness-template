import assert from 'node:assert/strict';
import test from 'node:test';
import { QuotaExceededError } from '../../src/foundation/errors.mjs';
import { QuotaService } from '../../src/domains/quota/quota-service.mjs';

test('QuotaService 应限制租户活跃会话数并在释放后正确回收名额', () => {
  const quota = new QuotaService({ maxSessionsPerTenant: 2 });
  quota.registerSession('t1', 's1');
  quota.registerSession('t1', 's1'); // 幂等注册
  quota.registerSession('t1', 's2');
  assert.equal(quota.activeCount('t1'), 2);

  assert.throws(() => quota.registerSession('t1', 's3'), QuotaExceededError);

  quota.releaseSession('t1', 's1');
  assert.equal(quota.activeCount('t1'), 1);
  quota.registerSession('t1', 's3');
  assert.equal(quota.activeCount('t1'), 2);
});
