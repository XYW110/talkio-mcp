# Design: brainstorm 议事质量包

## 边界与改动面

| 文件 | 改动 |
|---|---|
| `src/orchestrator/dialogue.ts` | 核心：匿名化、投票轮、裁决者解析 |
| `src/tools/brainstorm.ts` | 新参数 `vote` / `judgeCard` 透传与校验 |
| `src/records/store.ts` | `RecordEvent` 新增 `vote` 变体（additive） |
| `admin-web/src/types.ts` | 同步 `vote` 事件类型 |
| `admin-web/src/pages/RecordsPage.tsx` | vote 事件容错渲染（忽略或简单展示） |
| `test/orchestrator.test.ts` / `test/consult-brainstorm.test.ts` | 新增用例 |

不改动：consult_experts / brainstorm_followup、context-compressor、admin API、MCP server 注册（schema 仅扩字段）。

## 契约

### 新参数（BrainstormArgs）

```ts
vote?: boolean;       // 默认 false；仅 debate 模式生效，relay 下静默忽略
judgeCard?: string;   // 单张卡 id；无效时回退第一张卡
```

MCP zod raw-shape 同步扩展（`src/server.ts` schema 内，仅可选字段，无破坏）。

### DialogueOptions 扩展

```ts
vote?: boolean;
judgeCard?: string;   // 已由工具层解析为 card id，orchestrator 只做 targets 剔除与 summarizer 选择
```

### DialogueResult 扩展

```ts
votes?: DialogueTurn[];   // 投票轮产物；vote=false 或失败时缺省
judgeInfo?: { cardId: string; cardName: string; fallback?: boolean };
```

### RecordEvent 新变体

```ts
| { type: "vote"; expertId: string; expertName: string; icon: string; content: string; usage?: UsageRecord }
```

additive：旧记录无 vote 行，新记录在 RecordsPage 等消费端按未知/新类型容错。

## 核心设计

### 1. 匿名化（R2）

- 代号分配：`const aliases = targets.map((t, i) => `专家${String.fromCharCode(65 + i)}`)`，与 expertId 建立映射（专家A/B/...，超过 26 张用 A1/Z1 后缀；工具层上限 6 张，实际不会触发）。
- `formatTranscriptForPrompt` 增加选项 `{ anonymize?: boolean; viewerExpertId?: string }`：
  - anonymize=true 时，行头 `【专家A · icon】` 变为 `【专家A】`（不再拼接 expertName/icon）。
  - viewerExpertId 匹配的行追加 `（这是你自己的发言）` 标注。
- 应用点：debate round≥2 的 DEBATE_INSTRUCTION 注入块、投票轮 prompt。round 1 无注入，不受影响。relay 模式不匿名（保持现状——relay 是顺序接龙，匿名价值低且改动面大，PRD D3 限定轮间注入指 debate）。

### 2. 投票轮（R1）

- 时机：全部内容轮完成后、综合之前；仅 `mode === "debate" && vote === true` 且 targets.length ≥ 2。
- 新常量 `VOTE_INSTRUCTION`（导出供测试）：`"以上是本次讨论的完整实录（已匿名）。请指出你最认同哪位专家（代号）的观点及理由，并简述你是否修正了自己的立场。"`（措辞实现时可微调，测试断言关键字"代号"与"认同"）。
- 执行：对 targets 并行 `Promise.allSettled`（复用 askExpert + 匿名 transcript + 投票轮上下文压缩，沿用现有 ctxSummary 状态）；单专家投票失败不阻断，成功的进入 votes。
- 通知：`notifier?.({ type: "vote" })`（StreamNotifier 类型扩展可选字段）。
- 报告：`formatBrainstormReport`（src/utils/format.ts）在综合段之前插入 `## 互评投票` 段落（逐条 匿名代号 → 投票文本原文，末尾还原代号↔专家对照表，读者可自行映射）。

### 3. 裁决者（R3）

- 工具层（brainstorm.ts）解析 judgeCard：在 config.cards 中查找 id 匹配、enabled、provider key 存在的卡 → resolve 为 ResolvedCard；否则置 `judgeInfo.fallback = true` 并沿用 targets[0]。
- targets 剔除：judge 卡命中且 targets.length > 1 时从 targets 移除；若剔除后 targets 为空（只有 judge 一张卡），回退为"该卡同时议事并裁决"（不空转）。
- 综合调用：维持现有 SUMMARIZER_SYSTEM 中立主持人提示词不变（裁决者的人格来自卡的 expert systemPrompt，与现状 summarizer 行为一致）；报告综合段标注 `（裁决者：{cardName}）`，fallback 时标注"（裁决者无效，回退第一张卡）"。

### 4. 综合注入

summarizer prompt 在 transcript 之后追加投票摘要块（votes 为空则省略）：

```
以下是各位专家的互评投票，请在总结时参考：
【专家A】认同专家B：……
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| vote=true 且 mode=relay | 忽略 vote，行为同现状 |
| vote=true 且 targets<2 | 跳过投票轮，报告不出现投票段 |
| judgeCard 不存在/禁用/无 key | 回退第一张卡，报告注明 |
| judgeCard 与唯一 target 相同 | 不剔除，正常议事+裁决同一卡 |
| 投票调用全部失败 | votes 为空，继续综合（无投票依据），报告省略投票段 |
| 投票部分失败 | 只采用成功票，报告不注失败明细（stderr 已有日志） |

## Tests Required

- 单测（orchestrator.test.ts）：VOTE_INSTRUCTION 导出存在；匿名化 render（名称/icon 不出现、own 标注存在）；代号映射正确。
- 流程测试（consult-brainstorm.test.ts，mock provider）：vote=true 产生 votes + 报告投票段 + records vote 行；judgeCard 有效/无效两分支；vote/judgeCard 缺省时输出与现状快照一致（AC5 回归）。
- admin-web：类型同步后 tsc 通过；RecordsPage 渲染含 vote 事件记录不抛错（如现有测试基建允许，否则人工验证并在 check 记录）。

## Wrong vs Correct

```ts
// Wrong：投票结果计入 turns（污染 round 语义、round_end 对账破坏）
turns.push(...voteTurns);

// Correct：独立数组，记录事件用独立 vote 类型
result.votes = voteTurns;
record.append({ type: "vote", ... });
```
