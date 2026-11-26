# 回放业务域契约（Replay Domain Contract）

负责单会话历史字节保留、挂载回放与缓冲回收语义（`src/domains/replay/replay-service.mjs`）。

## 核心不变量

1. **默认保留容量**：`DEFAULT_MAX_REPLAY_BYTES = 4 MiB`（`4 * 1024 * 1024`）。
2. **冷连接全量无损**：`snapshotForAttach(sessionKey, null)` 必须 100% 返回会话环内保留的全部字节，严禁叠加更小的尾部截断上限（如 256 KiB / 512 KiB）。
3. **增量续传与截断标记**：`snapshotForAttach(sessionKey, sinceSeq)` 仅返回 `seq > sinceSeq` 的数据块；仅在 `sinceSeq` 之后真实发生过淘汰或单块截断时置 `truncated: true`，空写入不触发误报。
4. **未知会话查询**：返回 `{ data: Uint8Array(0), latestSeq: 0, truncated: false }`，不得顺带创建孤儿缓冲区；非法 `sinceSeq` 同样立即抛 `ValidationError`。
5. **缓冲回收与配置快速失败**：`removeSession(sessionKey)` 释放对应缓冲区防止内存泄漏；非整数或非正数 `maxReplayBytes` 在构造期立即抛 `ValidationError`。

## 已知非目标

- 传输层压缩与前端增量渲染不属于本域职责。
