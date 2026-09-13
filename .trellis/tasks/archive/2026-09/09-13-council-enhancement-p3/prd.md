# 议事增强 P3：多轮 runs 并集 + Provider 预设

## Goal

P3-A：brainstorm 增 `runs?: 1|2|3` 多轮运行——轮换匿名别名重跑 N 次、结论去重合并、以 `[K/N RUNS]` 标注稳定性（来源 agent-review-panel）。P3-C：admin ProvidersPage 增内置 provider 预设一键填充（来源 PAL MCP 轻量化）。**runs 缺省 1 时行为与现状逐字节一致。**

## Background

- 机制来源：`research/p3-mechanism-source.md`（P3-A=agent-review-panel `--runs 3`；P3-C=PAL MCP 轻量化）；全档见归档任务 `09-13-council-enhancement/research/competitor-deep-dive.md`。
- 前置已落地：P1（vote 事件/投票明细/reasoningStrategy）、P2（signals 自动选卡/disabledTools/tier）、vote-prompt-fix（零自投+票文限长）。
- 现状基线（已核对代码）：`src/tools/brainstorm.ts` handler 237 行——zod 参数 `mode/rounds/summarize/vote/judgeCard/cards/select`；`runDialogue` 一次产出 `{turns, summary, votes, aliases, roundVotes, judgeInfo}`；records 事件 `cards/turn/round_end/vote/summary/finish`。
- P3-B 的 tier 已随 P2 落地，本任务不含。

## Requirements

### R1（P3-A）brainstorm 多轮 runs
- `runs?: 1 | 2 | 3`（zod 整数枚举；缺省 1）。>1 时：完整重跑 N 次对话，每次轮换「卡 ↔ 匿名别名」映射；每次运行独立产出 turns/votes/summary。
- **并集合并**：N 次运行结束后做一次合并调用（有 judge 用 judge，否则用 summarize 路径的总结者），输入 N 份结论，输出去重后的合并结论，每条结论附稳定性 `[K/N RUNS]`（K=提到该结论的运行次数）。
- **报告**：runs>1 时报告新增「多轮稳定性」小节（每运行一行摘要 + 合并结论含 `[K/N RUNS]` 标注）；报告头注明 `runs=N`。
- **records**：turn/round_end/vote/summary 事件增可选 `run?: number` 字段（从 1 开始）；每次运行的 `cards` 事件不重复发（整会话一条 cards 不变）。
- **兼容红线**：不传 runs 或 runs=1 时——不新增合并调用、事件不带 run 字段、报告与现状逐字节一致、usage 统计口径不变。

### R2（P3-C）Provider 预设
- ProvidersPage 新增预设区：内置 ≥6 个预设（Ollama `http://localhost:11434/v1`、LM Studio `http://localhost:1234/v1`、vLLM `http://localhost:8000/v1`、OpenRouter `https://openrouter.ai/api/v1`、DeepSeek `https://api.deepseek.com`、Moonshot `https://api.moonshot.cn/v1`、智谱 `https://open.bigmodel.cn/api/paas/v4`，可增删），一键填充 baseUrl（type 固定 openai-compatible）+ apiKeyEnv 建议值提示（如 Ollama 本地可留空提示）。
- 只填充表单不直接写盘（用户仍走保存流程）；编辑已有 provider 时点预设=覆盖表单当前值（有确认或即覆盖即可，不弹保存）。

### R3（配套前端，最小改动）
- admin 会话记录 SessionDetailView 对带 `run` 字段的 turn/vote/summary 事件渲染 run 徽标（如 `R2`）；无 run 字段渲染与现状一致。对未知字段保持容错。

## Acceptance Criteria

- [ ] AC1 `runs=1`（或缺省）：报告、事件流、usage 与改造前逐字节一致（用现有测试断言 + 快照对比）。
- [ ] AC2 `runs=2|3`（mock LLM 测试）：产生 N 次对话、合并结论、报告含 `[K/N RUNS]` 标注与「多轮稳定性」小节；事件带 run 字段且轮次编号可区分。
- [ ] AC3 zod 校验：runs 传 0/4/"2" 等非法值被拒；tools/list 输入 schema 含 runs 枚举。
- [ ] AC4 ProvidersPage 预设 ≥6 个，点击后表单正确填充、保存流程不变；不点预设时页面行为与现状一致。
- [ ] AC5 SessionDetailView 对带 run 字段事件正常渲染徽标，无 run 字段渲染不变；旧 JSONL 会话文件加载不报错。
- [ ] AC6 `npm run typecheck`、`npm test` 全过；`npm run build:web` 通过。

## Constraints

- 兼容红线见 R1；experts.json 旧文件直接加载、缺省字段不写入。
- 不改 MCP 核心三工具签名（brainstorm 只增可选参数）。
- Provider 预设为纯前端常量，不引入配置文件/后端字段。
- 真实 LLM 验证可选（.env CUSTOM_API_KEY 存在时做一次 runs=2 冒烟；无 key 则 mock 覆盖即可）。
