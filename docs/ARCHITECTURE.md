# docs/ARCHITECTURE.md — 全局架构、承重墙红线与验证边界

> 仅记录**当前代码已生效**的全局架构与承重墙快照（现在时），不写未实现需求（避免 spec-speak）与编年史日志；契约变化时原地更新。各业务域细则下沉至 `src/domains/<name>/contract.md`。

## 1. 不可违背的承重墙红线

1. **冷连接必须全量无损回放（上限 4 MiB）**：冷挂载（`sinceSeq == null`）必须原样返回环形缓冲区中保留的全部历史字节（默认 `DEFAULT_MAX_REPLAY_BYTES = 4 MiB`），严禁为追求首屏速度静默截断尾部。**验证本红线的唯一有效边界是真实装配出口 `createApp().handleAttach()`（见 `tests/boundary/attach-replay.test.mjs`），仅测底层 `ByteRingBuffer` 不构成有效保护。** 详见 [src/domains/replay/replay-service.mjs](../src/domains/replay/replay-service.mjs) 与 [src/domains/replay/contract.md](../src/domains/replay/contract.md)。
2. **业务域与租户严格隔离**：`src/domains/replay/` 与 `src/domains/quota/` 禁止互相导入；`src/foundation/` 禁止反向依赖 `src/domains/` 或 `src/app/`。跨领域编排与租户级会话隔离统一收口在 `src/app/server.mjs`（先过配额准入再建缓冲，关闭会话同步回收配额与回放缓冲）。
3. **配置与参数快速失败（Fail-Loud）**：非法数值配置（如 `NaN`、非正整数、带单位字符串 `"512kb"`）、未打开会话写入或非法 `sinceSeq` 必须在入口立即抛出 `ValidationError`，禁止静默回退或绕过配额。
4. **单文件复杂度红线**：`src/` 下单文件上限 500 行（`check:boundaries` 拦截）；确需豁免时必须注明带理由的 `// harness-allow(file-size-cap): <原因>`。

## 2. 核心架构与源码锚点

- **共享底座（`src/foundation/`）**：
  - `ByteRingBuffer` 位于 [src/foundation/ring-buffer.mjs](../src/foundation/ring-buffer.mjs)（`src/foundation/ring-buffer.mjs`）— 定容 FIFO 字节环，非空写入分配 1 起始单调递增序号；单块超容保留尾部 `maxBytes` 并标记截断；`snapshot(null)` 返回全量保留字节，`snapshot(sinceSeq)` 返回增量并在真实发生字节淘汰/截断时置 `truncated: true`。
  - 结构化错误（`ValidationError`、`QuotaExceededError`）与严格正整数解析 `assertPositiveInt` 位于 [src/foundation/errors.mjs](../src/foundation/errors.mjs)（`src/foundation/errors.mjs`）。
- **回放业务域（`src/domains/replay/`）**：
  - `ReplayService` 位于 [src/domains/replay/replay-service.mjs](../src/domains/replay/replay-service.mjs)（`src/domains/replay/replay-service.mjs`）— 管理单会话历史缓冲、全量/增量回放与释放回收（详见 `src/domains/replay/contract.md`）。
- **配额业务域（`src/domains/quota/`）**：
  - `QuotaService` 位于 [src/domains/quota/quota-service.mjs](../src/domains/quota/quota-service.mjs)（`src/domains/quota/quota-service.mjs`）— 管理租户活跃会话数配额与释放回收（详见 `src/domains/quota/contract.md`）。
- **真实装配入口（`src/app/server.mjs`）**：
  - `createApp()` 位于 [src/app/server.mjs](../src/app/server.mjs)（`src/app/server.mjs`）— 组合 `QuotaService` 与 `ReplayService`，对外暴露 `openSession`、`appendOutput`、`handleAttach`、`closeSession`、`getTenantUsage` 公共边界。

## 3. 已验证边界

- **自动化门禁覆盖（`npm run check`）**：常驻文档硬预算、受管 Markdown 本地相对链接、架构依赖/空 catch/单文件上限、测试反模式、双模式文件卫生、非阻塞领域契约触碰提醒、三层测试（单元测试、真实装配输出边界测试，以及全量静态门禁与安全 Hook 的反例自测）。
- **需人工 / 真环境确认**：`.agents/hooks.json` 在真实 Agent 运行时（如 Antigravity CLI）中的自动发现、工作目录解析与实时拦截触发需人工真机冒烟（CI 仅验证脚本子进程，未挂载真实 Agent 运行时）。
