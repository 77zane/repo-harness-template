import {
  assertPositiveInt,
  QuotaExceededError,
  ValidationError,
} from '../../foundation/errors.mjs';

// 为什么默认 8：在单机默认内存预算下限制单租户并发活跃会话与缓冲峰值。
export const DEFAULT_MAX_SESSIONS_PER_TENANT = 8;

/**
 * 独立于回放存储，负责校验与回收各租户的活跃会话配额。
 */
export class QuotaService {
  /** @type {number} */
  #maxSessionsPerTenant;
  /** @type {Map<string, Set<string>>} */
  #tenantSessions = new Map();

  /**
   * @param {{ maxSessionsPerTenant?: number }} [options]
   */
  constructor(options = {}) {
    this.#maxSessionsPerTenant =
      options.maxSessionsPerTenant === undefined
        ? DEFAULT_MAX_SESSIONS_PER_TENANT
        : assertPositiveInt(options.maxSessionsPerTenant, 'maxSessionsPerTenant');
  }

  /**
   * 为租户预留会话槽位；对已注册的同一 sessionId 保持幂等。
   * @param {string} tenantId
   * @param {string} sessionId
   */
  registerSession(tenantId, sessionId) {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new ValidationError('tenantId 必须为非空字符串', 'tenantId');
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new ValidationError('sessionId 必须为非空字符串', 'sessionId');
    }

    let sessions = this.#tenantSessions.get(tenantId);
    if (!sessions) {
      sessions = new Set();
      this.#tenantSessions.set(tenantId, sessions);
    }
    if (sessions.has(sessionId)) {
      return;
    }
    if (sessions.size >= this.#maxSessionsPerTenant) {
      throw new QuotaExceededError(
        `租户 ${tenantId} 已达到活跃会话上限（${this.#maxSessionsPerTenant}）`,
        {
          tenantId,
          limit: this.#maxSessionsPerTenant,
          current: sessions.size,
        },
      );
    }
    sessions.add(sessionId);
  }

  /**
   * @param {string} tenantId
   * @param {string} sessionId
   */
  releaseSession(tenantId, sessionId) {
    const sessions = this.#tenantSessions.get(tenantId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.#tenantSessions.delete(tenantId);
    }
  }

  /**
   * @param {string} tenantId
   * @returns {number}
   */
  activeCount(tenantId) {
    return this.#tenantSessions.get(tenantId)?.size ?? 0;
  }
}
