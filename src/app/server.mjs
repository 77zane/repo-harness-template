import { QuotaService } from '../domains/quota/quota-service.mjs';
import { ReplayService } from '../domains/replay/replay-service.mjs';
import { ValidationError } from '../foundation/errors.mjs';

/**
 * 构造碰撞安全的租户隔离会话键，防止不同租户使用相同 sessionId 时串读或串写历史缓冲。
 * @param {string} tenantId
 * @param {string} sessionId
 */
function toSessionKey(tenantId, sessionId) {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new ValidationError('tenantId 必须为非空字符串', 'tenantId');
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ValidationError('sessionId 必须为非空字符串', 'sessionId');
  }
  return JSON.stringify([tenantId, sessionId]);
}

/**
 * 真实应用装配入口：将相互隔离的业务域组装成对外公共边界。
 * 边界测试（tests/boundary/）应直接调用本入口，而非手动拼装内部类。
 *
 * @param {{ maxReplayBytes?: number, maxSessionsPerTenant?: number }} [options]
 */
export function createApp(options = {}) {
  const quota = new QuotaService({ maxSessionsPerTenant: options.maxSessionsPerTenant });
  const replay = new ReplayService({ maxReplayBytes: options.maxReplayBytes });

  return {
    /**
     * @param {string} tenantId
     * @param {string} sessionId
     */
    openSession(tenantId, sessionId) {
      const key = toSessionKey(tenantId, sessionId);
      // 必须先校验租户配额再分配 4 MiB 缓冲，防止超限请求制造未受控的孤儿缓冲区。
      quota.registerSession(tenantId, sessionId);
      replay.ensureSession(key);
      return { tenantId, sessionId, maxReplayBytes: replay.maxReplayBytes };
    },

    /**
     * 向已打开的租户会话追加输出；拒绝未注册会话写入，防止绕过租户配额无限分配缓冲。
     * @param {string} tenantId
     * @param {string} sessionId
     * @param {string | Uint8Array} chunk
     */
    appendOutput(tenantId, sessionId, chunk) {
      const key = toSessionKey(tenantId, sessionId);
      if (!replay.hasSession(key)) {
        throw new ValidationError(`会话未打开或已关闭：${tenantId}/${sessionId}`, 'sessionId');
      }
      return replay.append(key, chunk);
    },

    /**
     * 对外挂载边界（模拟客户端冷挂载与断线增量重连）。
     * @param {string} tenantId
     * @param {string} sessionId
     * @param {{ sinceSeq?: number | null }} [params]
     */
    handleAttach(tenantId, sessionId, params = {}) {
      const key = toSessionKey(tenantId, sessionId);
      return replay.snapshotForAttach(key, params.sinceSeq ?? null);
    },

    /**
     * 关闭会话并同步释放租户配额与回放缓冲区，防止关闭后泄漏 4 MiB 内存。
     * @param {string} tenantId
     * @param {string} sessionId
     */
    closeSession(tenantId, sessionId) {
      const key = toSessionKey(tenantId, sessionId);
      quota.releaseSession(tenantId, sessionId);
      replay.removeSession(key);
    },

    /**
     * @param {string} tenantId
     */
    getTenantUsage(tenantId) {
      return {
        activeSessions: quota.activeCount(tenantId),
        allocatedBuffers: replay.sessionCount,
      };
    },
  };
}
