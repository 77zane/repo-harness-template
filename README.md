> **给 AI 的参考说明（参考本仓建新仓时先读，勿照抄进目标项目）**
>
> 本仓库是唯一自包含的**仓库级 AI 工程 Harness 参考示例**，默认按**大型多模块单仓（满配形态）**搭建，并采用标准 `AGENTS.md` + `.agents/`（`hooks.json`、`skills/*/SKILL.md`）格式。当你被要求参考本仓为目标项目建立 Harness 时：
>
> 1. **按目标项目与当前 Agent 双向伸缩适配，切勿机械照抄**：先摸清目标项目的语言栈、构建/测试命令、仓库形态与高风险边界，并**基于你当前使用的 Agent 运行时自行适配**规则入口、钩子协议与权限配置（注意核对各运行时的 Hook 工作目录与工具 `matcher` 差异：Antigravity 默认以 `.agents/` 为 CWD，Claude Code 等以仓库根为 CWD）：
>    - **向下收束**：小项目自行精简多余层级（如不拆多业务域、精简门禁脚本）。
>    - **向上/按栈补齐**：① 目标语言有成熟工具链（类型检查、`ruff`/`biome`/`golangci-lint`/`clippy`/死代码与依赖图）时直接接入原生工具，本仓零依赖正则脚本仅作思想示范，不要重复造轮子；② 含前端 UI、真实数据库、外部协议或真终端交互时，在无头边界测试之外补真环境冒烟 / E2E；③ 跨语言或超大型多包 Monorepo 按子项目边界拆子目录 `AGENTS.md`（同步纳入预算门禁）；④ 多人协作需防绕过本地检查时，按需加 Git `pre-commit`（如 Lefthook）。
>    - **多仓平铺（Polyrepo）拓扑**：若目标工作区是“非 Git 父目录 + 总控/集成仓 + 多个独立交付子仓”，全部规则、门禁、Skill 与钩子真源放总控仓版本管理，跨仓 `check` 保持 Agent 无关；在总控仓入口显式引导新环境与各成员 AI 按本地父目录与自身运行时自行适配挂载；父目录 `AGENTS.md` 需带极简路由、核心命令与红线摘要（勿仅放纯链接，避免只向上发现规则的 Agent 漏读子仓红线）；各交付子仓保持各自契约文档与单仓原生检查独立可跑、不反向依赖非交付总控仓。
> 2. **只复用工程骨架，彻底替换示例业务**：下方正文以及 `src/`、`docs/`、`tests/` 中的“会话回放与配额服务”仅为可运行演示，落地时需全部替换为目标项目的真实业务、架构红线与对应语言栈的检查命令。
> 3. **严守共享与私有边界**：团队与 CI 共同依赖的入口文档、业务契约、无密钥 Hook、项目 Skill 与门禁脚本提交进仓库；本机路径/密钥与临时产物一律走 `.gitignore`（`*.local.*`、`AGENTS.override.md`、`HANDOFF.md`、`.scratch/`）；跨项目个人习惯留在用户全局配置，不放进业务仓。
> 4. **只留“现在时活文档”，不建只写不读的历史复盘或决策库**：AI 改代码按 `AGENTS.md -> docs/ARCHITECTURE.md -> 域 contract.md -> 源码 Why 注释` 顺序查阅；防复发不靠事后文章，而是原地沉淀进三件活东西——补活文档红线、关键常量/逻辑旁补 1 行 `Why` 注释、在真实装配输出边界补“撤掉修复真会红灯”的回归测试或静态门禁；每新建或改动一条静态门禁与 Hook，同步在 `tests/architecture/` 补反例自测证明其真实会拦。
> 5. **防反噬红线**：不要生成百科全书式 `AGENTS.md`（受硬预算保护）；偶发问题按上一条就地沉淀进活文档与门禁，同一流程性失误跨 2 次会话复发才按零和原则准入根入口；阻塞门禁若需临时破例或存量老项目平滑接入，做精确到文件/符号且带理由的单点基线豁免并配套死豁免自动报红防残留，不让门禁长期带病红灯；原型探索未定型前保持零 Harness。交付前必须在目标项目实跑统一验证命令确认绿灯。

---

# 会话回放与配额服务

零外部依赖的 Node.js（>= 20）无头会话服务示例，提供单会话历史字节无损回放、按序号增量续传与租户级活跃会话配额隔离，并内置完整的工程质量门禁与 AI 协作护栏。

## 核心能力

- **4 MiB 全量无损冷回放**：客户端冷挂载（`sinceSeq == null`）原样返回环形缓冲区中保留的全部历史字节，拒绝任何静默截断。
- **单调序号增量续传**：客户端携带 `sinceSeq` 重连时仅返回增量字节，若期间发生环形淘汰则显式标记 `truncated: true`。
- **租户级并发配额控制**：按租户限制活跃会话上限，支持幂等注册、超限原子拒绝与关闭时干净回收。
- **参数快速失败（Fail-Loud）**：构造期与入口处严格校验数值与字符串入参，非法配置立即抛出结构化错误。

## 快速开始与常用命令

环境要求：**Node.js >= 20**（无需执行 `npm install`，零第三方依赖）。

```bash
npm run check          # 全量标准门禁（共 7 项：6 项静态/契约门禁 + 三层全套测试，与 CI 同源）
npm run check:quick    # 快速反馈环（静态边界 + 测试反模式 + 文件卫生 + 单元测试）
npm run check:docs     # 文档硬预算、本地相对断链与领域契约触碰提醒
npm run test:boundary  # REAL-composition 真实装配输出边界测试
npm run check:budgets -- --list  # 查看常驻文档当前词字数与字节占用
npm run fix:hygiene    # 自动修复缺失尾换行与混用换行符
```

## 项目结构

| 路径 | 说明 |
| :--- | :--- |
| [src/foundation/](src/foundation/) | 跨领域共享底座（定容字节环 `ByteRingBuffer`、结构化错误与正整数校验），禁止反向依赖业务域 |
| ─── | ─── |
| [src/domains/replay/](src/domains/replay/) | 回放业务域与 [contract.md](src/domains/replay/contract.md)，管理单会话历史字节留存与挂载快照 |
| ─── | ─── |
| [src/domains/quota/](src/domains/quota/) | 配额业务域与 [contract.md](src/domains/quota/contract.md)，管理租户活跃会话配额与释放回收 |
| ─── | ─── |
| [src/app/server.mjs](src/app/server.mjs) | 真实应用装配入口 `createApp()`，组合各隔离业务域并暴露对外公共边界 |
| ─── | ─── |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 全局架构、共享底座契约、不可违背的承重墙红线与源码锚点 |
| ─── | ─── |
| [tests/](tests/) | 三层测试：`unit/` 底层单测、`boundary/` 真实装配输出边界测试、`architecture/` 文档锚点与门禁反例自测 |
| ─── | ─── |
| [scripts/](scripts/) | 统一门禁调度器（`run-gates.mjs`）及预算、断链、架构边界、测试反模式、文件卫生、契约触碰与安全 Hook 脚本 |
| ─── | ─── |
| [AGENTS.md](AGENTS.md) | 面向 AI 编程 Agent 的唯一常驻路由入口与全局操作红线 |
| ─── | ─── |
| [.agents/](.agents/) | 标准 `PreToolUse` 安全守卫配置（`hooks.json`）与按需加载的高风险提交核对 Skill（`skills/pre-pr-check/`） |
| ─── | ─── |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI 流水线，与本地执行完全同一套 `npm run check` |

## 架构与协作约束

- 修改代码或新增能力前，请先阅读 [AGENTS.md](AGENTS.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；触及具体业务域时同步阅读对应 `contract.md`。
- 本机私有覆盖与临时文件（`AGENTS.override.md`、`*.local.md`、`*.local.json`、`HANDOFF.md`、`.scratch/`）已由 [.gitignore](.gitignore) 隔离，不会提交进版本库。
