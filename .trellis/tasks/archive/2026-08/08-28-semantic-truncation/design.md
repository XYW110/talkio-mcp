# 语义截断——对话式增量概要压缩（方案 B）技术设计

## 1. 架构边界

- **目标模块**：`src/orchestrator/dialogue.ts`（brainstorm 引擎内部）+ `src/tools/brainstorm-followup.ts`（3 处注入点）——不改任何导出签名、不改任何 MCP 工具 schema/handler 语义（R3 兼容约束）
- **新增模块**：`src/orchestrator/context-compressor.ts`（预算判定 + 概要压缩器，独立可测）
- **概要状态机**：单次 `runDialogue` / `handleBrainstormFollowup` 调用内自建自灭（server 无状态，概要不跨调用）
- **压缩器通道**：复用 `askExpert(target, userContent, config)`（dialogue.ts:136，已导出）→ 自动获得输入侧 redactPII 与 provider 网络栈
- **不触碰**：`consult_experts`（parallel.ts，Q3 已决 Out of Scope）、`list_cards`、工具 schema、`formatTranscriptForPrompt` 导出签名、`summarize` 事后总结路径（dialogue.ts:296-330）

## 2. 核心复用点（evidence，已锁定）

| 复用点 | 来源 | 作用 |
|---|---|---|
| `formatTranscriptForPrompt(turns)` | dialogue.ts:106（已导出） | turns 序列化 + 既有 500/12000 字符硬截断（兜底 + 最新轮完整实录渲染） |
| `askExpert(target, userContent, config)` | dialogue.ts:136（已导出） | 压缩器 LLM 调用通道（输入侧已 redactPII） |
| `redactPII` | src/utils/redact.ts | 压缩输出二次掩码（R5 输出侧） |
| `resolveProvider` | dialogue.ts:83（模块私有） | 压缩前 provider 可用性检查，失败→兜底硬截断 |
| `SUMMARIZER_SYSTEM` 模式 | dialogue.ts:71 + 311-315 | 中性 system prompt + user 拼装模式（Q4 defer 的落点） |
| `ResolvedCard` | src/tools/select-cards.ts:15-22 | 压缩器 target（providerName / modelId / expert） |
| `TRANSCRIPT_BUDGET_CHARS=12000` | dialogue.ts:79 | 预算阈值（沿用，不新增可配置项） |

## 3. 预算判定（R4 已决策：仅超预算才启用）

### 3.1 判定式

```ts
// context-compressor.ts
/** 复刻 formatTranscriptForPrompt 的拼装长度（每 turn 尾 500 + join 分隔），不做整块截断。 */
export function estimateTranscriptChars(turns: DialogueTurn[]): number;

/** 超预算判定：与 TRANSCRIPT_BUDGET_CHARS 同源（12000，char 级，与既有硬截断阈值一致）。 */
export function exceedsBudget(turns: DialogueTurn[]): boolean {
  return estimateTranscriptChars(turns) > TRANSCRIPT_BUDGET_CHARS;
}
```

- **char 级对齐**：既有预算就是字符预算（`TRANSCRIPT_BUDGET_CHARS`），不引入 token 换算/tiktoken 依赖（工程简单性，Q4 defer 精神）
- `estimateTranscriptChars` 复刻 `formatTranscriptForPrompt` 的长度语义（dialogue.ts:110-120：`text.length > 500 → 501 + "【…】(第N轮): "` 前缀；`"\n\n"` join），保证判定与硬截断触发点一致
- 短对话（≤12000 chars）→ 走现状路径，0 新增 LLM 调用、0 行为差异

## 4. 概要状态机（方案 B）

### 4.1 状态

```ts
interface SummaryState {
  summaryText: string;  // 增量概要（redactPII 后），空串=未启用
  lastRound: number;    // 已并入概要的最大轮次
}
```

### 4.2 状态转移

| 当前态 | 事件 | 次态 | 注入文本 |
|---|---|---|---|
| 未启用 | 注入集 ≤ 预算 | 未启用 | `formatTranscriptForPrompt(注入集)`（现状，零差异） |
| 未启用 | 注入集 > 预算 且 压缩成功 | 启用 | `概要前缀(概要) + 最新一轮完整实录` |
| 未启用 | 注入集 > 预算 且 压缩失败 | 未启用（重试标记） | `formatTranscriptForPrompt(注入集)`（硬截断兜底） |
| 启用 | 每轮结束 | 启用（lastRound++） | 下一轮注入 `概要前缀 + 最新一轮完整实录` |
| 启用 | 轮末并入失败 | 启用（概要保持旧值） | 同上（旧概要仍可用，不中断） |

- **粘性启用**：一旦启用，后续轮次不再重判预算（避免 0/1 抖动）；压缩失败仅影响该次并入，不回退会话
- **首轮启用特殊性**：启用那轮的「注入集」（debate=上一轮 turns / relay=全部历史 turns）整体被压缩为概要，同轮注入即用新概要

### 4.3 概要前缀格式（5.2 注入模板）

```
【对话概要·第1-N轮】
{summaryText}

最近发言完整实录:
【{icon} {expertName}】(第{round}轮): {完整 content，不截 500}
…
```

- 最新一轮实录 = 对 `最新轮 turns` 逐条渲染（**跳过 per-turn 500 截断**，仅用标题格式），保证 R1「最新一轮完整实录」
- 标题「第1-N轮」的 N = `summaryState.lastRound`

## 5. 压缩器（context-compressor.ts）

```ts
export const COMPRESSOR_SYSTEM =
  "你是对话记录压缩器。请把以下讨论实录压缩为简洁的要点概要，保留：核心观点、各方立场与分歧、关键论据与结论。直接输出概要正文，不要额外说明。";

/** 把一批 turns 压缩为概要（单次 LLM 调用，走 askExpert 通道）。 */
export async function compressTurns(
  topic: string,
  turns: DialogueTurn[],
  target: ResolvedCard,
  config: AppConfig,
  existingSummary?: string,   // 增量并入：旧概要 + 新轮实录 → 新概要
  logger?: Logger
): Promise<SummaryState>;
```

- **调用路径**：`compressTurns` → `askExpert(target, userContent, config)`（userContent = `讨论主题 + 旧概要? + 实录（formatTranscriptForPrompt 渲染）`）
- **PII 双侧**：输入侧由 `askExpert` 内部 redactPII（dialogue.ts:151）覆盖；输出侧 `compressTurns` 返回前 `redactPII(content)`（R5）
- **失败语义**：askExpert 抛错 → `compressTurns` 原样上抛，调用方（dialogue/followup）catch 后落硬截断兜底
- **压缩器选择**：`targets[0]`（与 summarize 一致，dialogue.ts:299；Q4 defer 定稿为工程常量）
- **压缩器 maxTokens**：沿用 target.expert.maxTokens（概要天然短于实录，无需专门上限）

## 6. brainstorm 接线（runDialogue 内部，签名不变）

```
runDialogue(opts, config):
  summary: SummaryState = { "", 0 }; summarizerFailed = false
  for round in 1..rounds:
    round === 1: seed（现状不动）
    round > 1:
      injected = debate ? turns.filter(r => r.round === round-1) : turns
      if (!exceedsBudget(injected) && summary.summaryText === ""):
        transcript = formatTranscriptForPrompt(injected)            // 现状路径
      else if (summary.summaryText === "" && !summarizerFailed):     // 首次超预算
        try:
          summary = await compressTurns(topic, injected, targets[0], config)
          transcript = buildInjection(summary, latestRoundTurns)     // 概要 + 最新轮完整实录
        catch:
          summarizerFailed = true                                    // 本会话不再重试压缩
          transcript = formatTranscriptForPrompt(injected)           // 硬截断兜底
      else:                                                          // 已启用
        transcript = buildInjection(summary, latestRoundTurns)
      … askExpert 循环（现状不动）
    轮末（rounds 完成后）: if (summary.summaryText !== ""):
      try: summary = await compressTurns(topic, 本轮新 turns, targets[0], config, 旧概要)  // 增量并入 +1 调用
      catch: 概要保持旧值（吞错，logger.warn）
  summarize 事后总结：现状不动（不启用概要）
  [summary] 观测行追加 summary=on/off/off-failed
```

- debate 的 `latestRoundTurns` = 上一轮 turns；relay 的 = 刚并入的上一轮（relay 逐专家注入时 running 集超预算才启用，启用后每次注入 `概要 + 上一轮完整实录`）
- **relay 逐专家注入**（dialogue.ts:264-269 的 for 循环）在启用态下每个专家看到相同 `概要 + 最新完整轮`（与本轮已产生的新 turn 无关——保持「概要代表历史、实录代表最近轮」的简单模型）

## 7. brainstorm_followup 接线（Q2 已采纳：流入 followup，仅超预算）

`handleBrainstormFollowup` 内 3 处 `formatTranscriptForPrompt` 调用点统一替换为共用辅助：

```ts
// brainstorm-followup.ts 内部辅助（不导出）
async function buildFollowupTranscript(
  topicless: string,                 // 追问 question（用于压缩 prompt）
  history: DialogueTurn[],           // 待注入的历史（prevTurns / running）
  latestRound: number,               // 最新轮号（完整实录层）
  targets: ResolvedCard[],           // 压缩器 targets[0]
  config: AppConfig
): Promise<string>
// 内部：未超预算 → formatTranscriptForPrompt(history)（现状）
//       超预算   → compressTurns(question, history, targets[0], config) → 概要前缀 + 最新轮完整实录
//       压缩失败 → formatTranscriptForPrompt(history)（硬截断兜底）
```

- **specific**（brainstorm-followup.ts:162）：`buildFollowupTranscript(question, prevTurns, nextRound-1, [target], config)`
- **all+debate**（:235）：同上（targets = 全体）
- **all+relay**（:241）：`history = running`（prevTurns + 本轮已产生 newTurns）——relay 内多次注入可能各自触发压缩；为控成本，**handler 级缓存一次压缩结果**（handler 内 summary 变量，首启后复用）
- **降级路径旁路**：`isValidTurns` 失败 → prevTurns=[] → 永不触发压缩（现状）
- **schema 不动**（R3）：question/turns/cards/card/mode 原样

## 8. PII 纪律（R5 双侧掩码）

| 侧 | 掩码位置 | 保证 |
|---|---|---|
| 压缩输入 | `askExpert` 内部 redactPII（dialogue.ts:151，已有） | 实录/旧概要不含明文 PII 进压缩 LLM |
| 压缩输出 | `compressTurns` 返回前 `redactPII(content)` | summaryText 存储态无明文 PII |
| 注入侧 | 拼装后经 `askExpert`（内部 redactPII） | 概要+实录二次保证 |

- 顺序保持 PRD R2「压缩 → 掩码」：压缩调用本身是 LLM 调用，输入已被掩码；其输出再掩码后入库
- 失败回显路径不变（`⚠️ (…缺席: redactPII(msg))`）

## 9. 成本模型（Q1 已决策：仅超预算触发）

| 场景 | 额外 LLM 调用 |
|---|---|
| 短对话（注入集 ≤12000 chars） | 0（与现状完全一致） |
| 长对话首次超预算（启用轮） | +1（compressTurns 全量） |
| 启用后每轮末（brainstorm） | +1/轮（增量并入） |
| followup 超预算 | +1（handler 级缓存，单次调用至多 1 次） |
| 压缩失败 | 0（硬截断兜底，本会话不再重试） |

## 10. 兼容性与回归

- schema 零改动（4 工具）；`runDialogue` / `formatTranscriptForPrompt` / `askExpert` 导出签名不变
- 既有 100 测试零改动全绿（关键前提：test 目录无「较早的发言已省略」/ 预算常量断言，grep 已验证零命中）
- smoke mock provider 短对话路径 = 现状（不触发压缩）→ smoke 断言零改动通过；新增压缩路径断言（新用例注入超长 turns）
- 新增 `test/context-compressor.test.ts`：预算判定边界（11999/12000/12001）、压缩成功注入模板、压缩失败兜底、增量并入、双侧 PII
- 新增 `test/dialogue-summary.test.ts`（或并入 orchestrator.test.ts）：runDialogue 超预算 debate/relay 注入断言（echo adapter 回显可断言注入文本）

## 11. 取舍记录

- **粘性启用 vs 每轮重判**：粘性避免抖动与重复压缩成本；代价是短轮次后仍维持概要（可接受——概要质量 ≥ 丢弃历史）
- **char 级预算 vs token 估算**：与既有常量同源最简；代价是中英混排下非最优（defer）
- **followup relay 单次压缩缓存**：避免逐专家重复压缩；代价是 relay 后段专家看到的概要不含本轮前几位专家发言（可接受——完整实录层仍在本轮）
- **压缩失败不重试（会话级）**：避免每轮 +1 失败调用延迟；代价是该会话退化硬截断（兜底保可用）

## 12. 回滚点

- 改动集中在 dialogue.ts 内部分支 + brainstorm-followup.ts 辅助函数 + 新模块 context-compressor.ts
- revert 三处即回现状（formatTranscriptForPrompt 硬截断路径原样保留；schema/handler 零触碰）