# 语义截断——长上下文自动摘要压缩

## Goal

当 question/context/对话历史超长时，自动做语义级摘要压缩以贴合模型上下文窗口（区别于硬截断）。本任务聚焦 **brainstorm 多轮对话**的输入侧压缩：对话式增量概要（方案 B），**仅累计历史超预算才启用**（短对话零开销），保留硬截断兜底。需保持 brainstorm / consult_experts / list_cards / brainstorm_followup 的工具 schema 与既有行为零改动（R5 兼容）。

## Confirmed Facts（代码勘察）

### 现有截断机制（纯字符级硬截断）
- `formatTranscriptForPrompt`（`src/orchestrator/dialogue.ts:106`）：
  - 每 turn 截断为最后 500 字符（`PER_TURN_TRUNCATE_CHARS = 500`, `dialogue.ts:77`）
  - 总截断块上限 12,000 字符（`TRANSCRIPT_BUDGET_CHARS = 12000`, `dialogue.ts:79`）
  - 超出时丢弃最旧 turn，至少保留 1 条；截断标记「较早的发言已省略」（`dialogue.ts:129`）
  - 纯字符级硬截断，无语义理解

### 注入 / 调用链
- `formatTranscriptForPrompt` 的 **src 生产调用点（共 6 处）**：
  - `dialogue.ts:231` — debate 模式每轮注入「上一轮 turns」
  - `dialogue.ts:265` — relay 模式每轮注入「运行中全量 turns」
  - `dialogue.ts:302` — summarize 事后总结（`summarize=true`）用全量 turns
  - `brainstorm-followup.ts:162` — specific（单卡）路径注入 prevTurns
  - `brainstorm-followup.ts:235` — all+debate 路径注入 prevTurns
  - `brainstorm-followup.ts:241` — all+relay 路径注入 `[...prevTurns, ...newTurns]`
- `consult_experts` 的 `buildTargetMessages`（`src/orchestrator/parallel.ts:44`）**不调用**该函数——question + context 直接拼接发送，无截断。
- 顺序：`userContent` 拼装 → `redactPII(userContent)`（`dialogue.ts:151` / `parallel.ts:57`）→ 发往 LLM。即硬截断发生在 PII 掩码**之前**。
- server 无状态：brainstorm_followup 的 prevTurns 由调用方回传；R5 schema 冻结 → 调用方**不能**附带概要字段（Q2 机制约束已确定）。

### 已有摘要能力
- `runDialogue` 的 `summarize` 参数：用**第一位专家**（`targets[0]`）对全部 turns 做**事后**总结（`dialogue.ts:296-330`，system=`SUMMARIZER_SYSTEM` 中性主持人 prompt）。
- 这是**结果后处理**，不是**输入预处理压缩**；其 prompt 拼装模式（system=`SUMMARIZER_SYSTEM` + user=`redactPII(主题+实录)`，`dialogue.ts:311-315`）可复用为压缩器模板。

### 既有测试覆盖
- 任何测试**均未断言**「较早的发言已省略」/ `PER_TURN_TRUNCATE_CHARS` / `TRANSCRIPT_BUDGET_CHARS`（test 目录零命中）→ `formatTranscriptForPrompt` 内部实现可安全调整，不破坏既有 100 用例。

## Requirements

- R1 对话式增量概要：brainstorm 每轮结束把新内容并入增量概要（不是事后一次性总结）；round N+1 注入「对话概要 + 第 N 轮完整实录」替代「全部历史硬截断」
- R2 概要注入点：发往 LLM 前（同 `formatTranscriptForPrompt` 被注入的位置）；PII 纪律为「压缩器调用输入/输出双侧掩码」+「注入方既有 redactPII」
- R3 工具 schema 零改动（对调用方透明）；brainstorm_followup 的 schema/既有行为不变
- R4 触发条件（**已决策，用户批准推荐项**）：**仅累计历史超预算才启用概要**；短对话保持现有注入（零额外成本）；保留硬截断兜底（压缩/概要调用失败时降级，主流程不中断）
- R5 概要压缩器的 LLM 调用须遵守双侧 PII 纪律：压缩输入 `redactPII(旧概要 + 第N轮实录)`，压缩输出 `redactPII` 后再存入概要状态
- R6 概要压缩器实现复用 `SUMMARIZER_SYSTEM` 模式 + `targets[0]`（与现有 summarize 一致的专家/模型选择，成本最小化）
- R7 brainstorm 流水线 `[summary]` 观测行（`dialogue.ts:333-337`）含概要启用/失败计数；不发生 schema/既有 100 用例回归

## Acceptance Criteria

- AC1 `runDialogue`（debate + relay）在超预算场景下 round>1 的注入块含「概要前缀 + 最近一轮完整实录」，不再以「较早的发言已省略」硬丢最旧 turn 内容
- AC2 短对话不启用：历史未超预算时输出与现状一致（无额外 LLM 压缩调用、无概要前缀注入）
- AC3 压缩器双侧 PII 掩码：含手机号/身份证等 PII 的实录进入压缩器前已掩码、压缩输出再掩码（断言无明文 PII 进出压缩器）
- AC4 压缩器失败降级：压缩调用抛错 → 走既有硬截断路径，主流程不中断、报告可读
- AC5 既有 100 用例零改动全绿；`npm run typecheck` / `npm run build` / `npm test` / `node scripts/smoke-stdio.mjs` 全绿
- AC6 （Q2 已决策）brainstorm_followup 超预算 prevTurns 时内部启用概要（question/turns/cards/card/mode schema 零改动、降级路径不触发压缩），未超预算与现状一致

## Out of Scope

- consult_experts 的长 context 压缩（单轮咨询；调用方自行控制 context 长度）——Q3 已决
- 概要跨调用方持久化（server 无状态 + schema 冻结，调用方无法回传概要字段）
- 阈值参数化 / 配置化（保持常量 500 / 12,000 语义，本轮不改）

## Notes

- (resolved) Q1（概要启用时机）已决策：**仅超预算才启用**——短对话零开销，长对话才付压缩成本；保留硬截断兜底。
- (resolved) Q2 已决策：**概要流入 brainstorm_followup，仅超预算触发**（followup 内部压缩，schema 零改动；relay 路径 handler 级缓存压缩结果控成本）。
- (resolved) Q3 已决策：consult_experts 不纳入本任务（Out of Scope）。
- (deferred) Q4 概要压缩器模型：复用 `SUMMARIZER_SYSTEM` 模式 + `targets[0]`（工程常量，design §5 已定稿）。
- redactPII 顺序已确认：硬截断在 PII 掩码前；语义压缩器须双侧掩码后再进注入侧既有掩码。
- 无测试断言硬截断标记 → `formatTranscriptForPrompt` 内部实现有调整余量。