import { assertPositiveInt, ValidationError } from '../../foundation/errors.mjs';
import { ByteRingBuffer } from '../../foundation/ring-buffer.mjs';

// 为什么是 4 MiB：冷重连全量无损回溯是核心产品承重墙，禁止静默截断（详见 docs/ARCHITECTURE.md 与 src/domains/replay/contract.md）。
export const DEFAULT_MAX_REPLAY_BYTES = 4 * 1024 * 1024;

/**
 * 负责管理各会话的字节历史缓冲与挂载回放语义。
 */
export class ReplayService {
  /** @type {number} */
  #maxReplayBytes;
  /** @type {Map<string, ByteRingBuffer>} */
  #buffers = new Map();

  /**
   * @param {{ maxReplayBytes?: number }} [options]
   */
  constructor(options = {}) {
    this.#maxReplayBytes =
      options.maxReplayBytes === undefined
        ? DEFAULT_MAX_REPLAY_BYTES
        : assertPositiveInt(options.maxReplayBytes, 'maxReplayBytes');
  }

  get maxReplayBytes() {
    return this.#maxReplayBytes;
  }

  get sessionCount() {
    return this.#buffers.size;
  }

  /**
   * @param {string} sessionKey
   */
  hasSession(sessionKey) {
    return this.#buffers.has(sessionKey);
  }

  /**
   * @param {string} sessionKey
   */
  ensureSession(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.trim() === '') {
      throw new ValidationError('sessionKey 必须为非空字符串', 'sessionKey');
    }
    if (!this.#buffers.has(sessionKey)) {
      this.#buffers.set(sessionKey, new ByteRingBuffer(this.#maxReplayBytes));
    }
  }

  /**
   * @param {string} sessionKey
   * @param {string | Uint8Array} chunk
   * @returns {number}
   */
  append(sessionKey, chunk) {
    this.ensureSession(sessionKey);
    return this.#buffers.get(sessionKey).push(chunk);
  }

  /**
   * 冷挂载（sinceSeq == null）必须返回环内保留的全部字节，严禁额外截断尾部。
   * 未知会话查询不得顺带创建孤儿缓冲区，且非法 sinceSeq 同样快速失败。
   * @param {string} sessionKey
   * @param {number | null | undefined} [sinceSeq]
   * @returns {{ data: Uint8Array, latestSeq: number, truncated: boolean }}
   */
  snapshotForAttach(sessionKey, sinceSeq = null) {
    if (sinceSeq !== null && sinceSeq !== undefined) {
      if (typeof sinceSeq !== 'number' || !Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
        throw new ValidationError(
          `sinceSeq 必须为非负安全整数或 null，实际收到 ${JSON.stringify(sinceSeq)}`,
          'sinceSeq',
        );
      }
    }

    const buffer = this.#buffers.get(sessionKey);
    if (!buffer) {
      return { data: new Uint8Array(0), latestSeq: 0, truncated: false };
    }
    return buffer.snapshot(sinceSeq);
  }

  /**
   * 释放会话关联的历史缓冲区，防止关闭会话后长期滞留最高 4 MiB 内存。
   * @param {string} sessionKey
   */
  removeSession(sessionKey) {
    this.#buffers.delete(sessionKey);
  }
}
