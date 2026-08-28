# 可观测性与错误压缩

## Goal

为 talkio-mcp 做「纯加固」增强：在不新增任何 MCP 工具、不改变任何工具输入 schema 的前提下，补齐运行期可观测性（分级日志 + 调用汇总），并压缩多卡失败时的报告噪声，让 MCP 在真实运行下从「黑盒」变成「可诊断」。

## Background

当前项目（三概念解耦 + 隐私脱敏两个交付完成后）功能稳定、84 用例全绿，但运行期存在两类短板：

1. **日志无分级**：`config.ts` / `providers/retry.ts` 等处直接 `console.log` / `console.error` 写固定文本，无级别控制。测试里也硬依赖这些 stderr 行（如 `[config]` 迁移提示）。生产跑起来无法按需收敛噪声。
2. **失败噪声**：`consult_experts` 并行多卡时，若全部失败，报告会刷 N 条 ⚠️（每卡一条重复信息）；超时的卡当前等同失败，可能阻断后续聚合视图的理解。

## Requirements

### R1 分级日志（log level）
- 新增统一 logger（`src/utils/log.ts`），支持 `silly | debug | info | warn | error` 五级。
- CLI 支持 `--log-level <level>`（大小写不敏感，默认 `info`）；无效值降级为 `info` 并打一条 warn。
- 把现有散落的 `console.log` / `console.error` 打点收敛到 logger：至少覆盖 `config.ts` 的配置加载/迁移提示、`providers/retry.ts` 的重试点。
- **不改变现有对外文本的语义**：`[config] 检测到旧格式配置…` 这类用户可见的诊断行仍保留，只是受级别控制（默认 info 下仍可见）。

### R2 调用汇总 typeline
- 每次 `consult_experts` / `brainstorm` 结束后，经 logger 打一条汇总行（默认 info 级别），至少包含：调用类型、卡片数、每卡耗时、失败卡数、（可选）估算 token。
- 汇总行仅用于日志/诊断，**不出现在返回给 MCP 客户端的报告里**（报告内容不变）。

### R3 错误压缩
- `consult_experts`：当**全部**目标卡失败时，报告中的失败项聚合为 **1 条**摘要（说明「N 张卡全部失败」+ 共性原因 + 首个错误详情），而非 N 条重复 ⚠️。
- 部分失败（部分成功）时仍逐卡标注，保持现有行为。
- 超时的卡计入「降级/未完成」标注，不阻断其他卡的总结。

### R4 非功能约束（硬边界）
- ❌ 不新增任何 MCP 工具；❌ 不改变任何工具的输入 schema。
- ❌ 不引入进程状态持久化（内存态留给后续 brainstorm_followup 任务，本任务不做）。
- ✅ 现有 84 用例不得回归；新增用例后总数应在 84 附近增长。
- ✅ `npm run typecheck` / `build` / `test` / `node scripts/smoke-stdio.mjs`（14/14）全绿。

## Acceptance Criteria

- [ ] AC-1：`--log-level=warn` 时，跑一次成功的 consult，测试捕获的 stderr 不再包含 `[config]` / `[retry]` 等低于 warn 级别的行。
- [ ] AC-2：一次成功的 consult/brainstorm 在日志中产出一条汇总 typeline（含卡片数与耗时），且该汇总行不在返回客户端的报告中。
- [ ] AC-3：构造「全部目标卡失败」场景时，报告里失败项为聚合后的 1 条摘要（含失败总数与首错详情），而非逐卡 N 条。
- [ ] AC-4：「部分卡成功」场景仍逐卡标注（不回归）。
- [ ] AC-5：`npm test` 全绿（目标 ≥ 84，预计 ~86）；`npm run typecheck` / `build` 通过；smoke 14/14。
- [ ] AC-6：README 补「日志与诊断」小节（`--log-level` 用法 + 汇总行说明）。

## Out of Scope（本任务明确不做）

- 流式输出（streaming）—— 体积敏感，已决策不做。
- `brainstorm_followup` 等需内存态的体验类工具 —— 归入后续任务。
- 上下文语义截断、结果侧脱敏开关 —— 归入 V2。
- 多租户鉴权、分布式编排 —— 定位不符，不做。

## Notes

- 决策来源：本任务的需求来自一次「头脑风暴 → 收敛」的规划会话，用户就三组产业取舍给出了明确信号：
  - 「保持工具极简」→ 砍掉流式；
  - 「接受内存态 + 重启丢」→ 本任务不引入，但为后续 followup 铺路；
  - 「先做观测 + 错误压缩这种纯加固、再谈体验」→ 锁定本任务范围。
- 本任务为「纯加固」，不触碰任何工具对外契约，对既有用例的破坏面仅限 stderr 提示与报告失败块格式两处，可控。
