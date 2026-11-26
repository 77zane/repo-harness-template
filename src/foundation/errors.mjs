/**
 * 跨业务域与装配入口共享的结构化错误类型与严格参数校验。
 */

export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} [field]
   */
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.field = field ?? null;
  }
}

export class QuotaExceededError extends Error {
  /**
   * @param {string} message
   * @param {{ tenantId: string, limit: number, current: number }} details
   */
  constructor(message, details) {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = 'QUOTA_EXCEEDED';
    this.details = details;
  }
}

/**
 * 严格校验正安全整数配置；直接拒绝 NaN、小数以及带单位字符串（如 "512kb"）。
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function assertPositiveInt(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(
      `配置项 ${field} 必须为正安全整数，实际收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}
