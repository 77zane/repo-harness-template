import { assertPositiveInt, ValidationError } from './errors.mjs';

/**
 * 定容 FIFO 字节环形缓冲区，为每块非空写入分配单调递增序号。
 */
export class ByteRingBuffer {
  /** @type {number} */
  #maxBytes;
  /** @type {Array<{ seq: number, chunk: Uint8Array }>} */
  #entries = [];
  /** @type {number} */
  #totalBytes = 0;
  /** @type {number} */
  #nextSeq = 1;
  /** @type {number} */
  #evictedUpToSeq = 0;

  /**
   * @param {number} maxBytes
   */
  constructor(maxBytes) {
    this.#maxBytes = assertPositiveInt(maxBytes, 'maxBytes');
  }

  get maxBytes() {
    return this.#maxBytes;
  }

  get totalBytes() {
    return this.#totalBytes;
  }

  get latestSeq() {
    return this.#nextSeq - 1;
  }

  /**
   * 追加 UTF-8 字符串或 Uint8Array；超出容量时按 FIFO 淘汰最早的整块数据。
   * 空载荷不推进序号，避免触发虚假的 truncated 标记。
   * @param {string | Uint8Array} data
   * @returns {number} 分配到的单调递增序号（空写入返回当前 latestSeq）
   */
  push(data) {
    const bytes =
      typeof data === 'string'
        ? Buffer.from(data, 'utf8')
        : data instanceof Uint8Array
          ? Uint8Array.from(data)
          : null;
    if (!bytes) {
      throw new ValidationError('写入数据必须为 string 或 Uint8Array', 'data');
    }
    if (bytes.byteLength === 0) {
      return this.latestSeq;
    }

    const seq = this.#nextSeq++;

    // 单块超过容量上限时仅保留尾部 maxBytes 切片，并标记该序号已发生字节截断。
    let stored = bytes;
    if (bytes.byteLength > this.#maxBytes) {
      stored = bytes.subarray(bytes.byteLength - this.#maxBytes);
      this.#evictedUpToSeq = Math.max(this.#evictedUpToSeq, seq);
    }

    this.#entries.push({ seq, chunk: stored });
    this.#totalBytes += stored.byteLength;

    while (this.#totalBytes > this.#maxBytes && this.#entries.length > 0) {
      const evicted = this.#entries.shift();
      this.#totalBytes -= evicted.chunk.byteLength;
      this.#evictedUpToSeq = Math.max(this.#evictedUpToSeq, evicted.seq);
    }
    return seq;
  }

  /**
   * 获取快照：sinceSeq 为空时返回全部保留字节；否则仅返回序号严格大于 sinceSeq 的增量块。
   * @param {number | null | undefined} [sinceSeq]
   * @returns {{ data: Uint8Array, latestSeq: number, truncated: boolean }}
   */
  snapshot(sinceSeq = null) {
    if (sinceSeq !== null && sinceSeq !== undefined) {
      if (typeof sinceSeq !== 'number' || !Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
        throw new ValidationError(
          `sinceSeq 必须为非负安全整数或 null，实际收到 ${JSON.stringify(sinceSeq)}`,
          'sinceSeq',
        );
      }
    }

    const selected =
      sinceSeq == null
        ? this.#entries
        : this.#entries.filter((entry) => entry.seq > sinceSeq);

    const out = Buffer.concat(selected.map((entry) => entry.chunk));
    const truncated = sinceSeq != null && sinceSeq < this.#evictedUpToSeq;

    return {
      data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
      latestSeq: this.latestSeq,
      truncated,
    };
  }
}
