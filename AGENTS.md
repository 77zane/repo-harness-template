# AGENTS.md

面向 AI 编程 Agent 的极简操作指南。本文件**只做路由地图与硬边界**；详细机制归口到对应活文档（`One home per fact`）。

## 路由地图

改代码前按固定链路查阅：**本文件 -> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -> 目标业务域 `contract.md` -> 源码 `Why` 注释**。

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 全局架构、共享底座、承重墙红线、验证边界与源码锚点；改动行为前必读。
- `src/foundation/` — 跨领域共享底座（契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。
- `src/domains/<name>/` — 相互隔离的业务域；修改前先读该目录 `contract.md`。
- `src/app/` — 真实装配入口，组合各业务域并对外暴露公共边界。
- [.agents/skills/pre-pr-check/SKILL.md](.agents/skills/pre-pr-check/SKILL.md) — 高风险改动提交前核对、防复发清单与独立只读 Review 手册（按需加载）。
- 忽略生成/本地目录：`node_modules/`、`dist/`、`coverage/`、`.scratch/`。

## 常用验证命令

```bash
npm run check         # 全量标准门禁（共 7 项，与 CI 跑完全同一套检查）
npm run check:quick   # 快速反馈环：静态边界 + 测试反模式 + 文件卫生 + 单元测试
npm run check:docs    # 文档预算、本地断链与领域契约触碰提醒
npm run test:boundary # REAL-composition 真实装配输出边界测试
npm run fix:hygiene   # 自动修复缺失尾换行与混用换行符
```

迭代时先跑最小相关命令，交付前必须跑全量 `npm run check`。**未经最后一次改动后实跑，严禁宣称检查通过。**

## 不可违背的红线

1. **严格架构边界与防御编码**：遵守 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的域隔离与底座隔离规则，严禁空 `catch {}` 及无理由超大文件（由 `check:boundaries` 拦截）。
2. **禁止制造兼容债**：优先收束到单一实现路径。除非受外部契约强制约束，否则禁止留下 legacy shim、双轨兜底分支、注释掉的旧代码或无消费者的空抽象。
3. **测试钉住外部可观测边界**：用户/协议可见行为必须通过真实装配入口测（`tests/boundary/`），不得只测孤立底层类；新增或改动 `scripts/` 门禁、Hook 或文档锚点时，同步在 `tests/architecture/` 补反例自测。修 Bug 必先**证伪红灯**。
4. **注释只写就近 `Why`**：在反直觉常量、顺序约束或不变量旁写 1–2 行原因；禁止写历史流水账或复述代码。
5. **只留现在时活文档 & 修 Bug 防复发三件套**：严禁堆进根入口或写历史复盘/决策流水账；修完真实 Bug 同轮补齐活文档（`ARCHITECTURE.md`/`contract.md`）+ 就近 `Why` 注释 + 边界红灯测试或静态门禁（细则见 `pre-pr-check` skill）。
6. **高风险改动必过独立只读 Review**：触发范围与双尺子核对清单见 [pre-pr-check/SKILL.md](.agents/skills/pre-pr-check/SKILL.md)。
7. **3 次失败止损 & Git 安全**：同一根因连改 3 次仍失败立刻停手上浮；未经用户同轮明确指令，严禁执行 `git commit`、`git push`、`rm -rf` 或 `--no-verify`（高危命令与受保护路径同时受 `.agents/hooks.json` 绊线拦截）。

## 文档写作与预算维护

- **反废话纪律**：只写当前已生效事实，严禁跨文档复述规则（改用相对链接）、写 `WIP/TODO` 标签、留流水账或贴通用语言教程；相对链接与源码锚点由 `check:links` 与 `test:arch` 机械校验。
- **常驻预算与准入**：本文件与 `docs/ARCHITECTURE.md` 受 [scripts/doc-budgets.manifest.json](scripts/doc-budgets.manifest.json) 硬预算约束（`npm run check:budgets`）。超限时按「**下沉迁移 -> 提炼压缩 -> 有理由再调上限**」处理；同一流程失误跨 **2 次会话**复发才准入本文件，且实行零和替换。
