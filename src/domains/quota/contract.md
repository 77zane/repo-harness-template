# 配额业务域契约（Quota Domain Contract）

负责租户活跃会话准入配额与释放管理（`src/domains/quota/quota-service.mjs`）。

## 核心不变量

1. **默认单租户上限**：`DEFAULT_MAX_SESSIONS_PER_TENANT = 8`。
2. **注册幂等**：对同一已活跃的 `(tenantId, sessionId)` 重复调用 `registerSession` 直接成功，不重复占用名额。
3. **超限原子拒绝**：超过 `maxSessionsPerTenant` 时抛出 `QuotaExceededError`（附 `{ tenantId, limit, current }`），且不污染现有状态。
4. **干净回收**：`releaseSession()` 释放名额，并在该租户集合清空时删除外层 Map 键，防止内存泄漏。
