# brainstorm_followup 技术设计（草案 v1）

> 本设计聚焦「两种追问粒度」的结构差异（Q2），供用户决策后定稿其余部分。

## 1. 架构边界

- 新增独立工具 `src/tools/brainstorm-followup.ts` + server.ts 注册（`list_cards`/`consult_experts`/`brainstorm` 之外的第 4 个工具）
- 复用 dialogue.ts 的 `askExpert(target, userContent, config)` 与 `formatTranscriptForPrompt(turns)`
- 复用 select-cards.ts 的 `selectCardsForTool` / `ResolvedCard`
- **不触碰** `runDialogue` / `brainstorm` 现有 schema / handler / CallToolResult 语义（R2 约束）

## 2. 核心复用点（evidence，无需决策）

| 复用点 | 来源 | 作用 |
|---|---|---|
| `formatTranscriptForPrompt(turns)` | dialogue.ts:106 | 已有把 turns 序列化为 prompt 注入文本，含 12000 字符 / 每 turn 500 缓存预算 |
| `askExpert(target, userContent, config)` | dialogue.ts:136 | 单卡单次 LLM 调用，含 redactPII 掩码 |
| `selectCardsForTool` | select-cards.ts:155 | 卡选择 + 缺 key 跳过 + 截断注释 |

## 3. 上下文传递：结构化 turns JSON（evidence 决定）

调用方通过 MCP `callTool` 传回**结构化 turns 数组**，而非上轮报告文本：

- 报告（`formatBrainstormReport`）是**不可逆 Markdown**：不含 expertId / round / icon 的可靠结构，无法重建下一轮 prompt
- 服务端无会话状态；调用方作为 MCP 客户端必然持有完整 `DialogueTurn[]`
- 传输 = 标准 JSON（MCP `arguments`），往返无状态，天然适合

**schema（turns 部分，两种粒度共用）**：

```ts
turns: z.array(z.object({
  round: z.number().int().positive(),
  expertId: z.string(),
  expertName: z.string(),
  icon: z.string(),
  content: z.string(),
})).describe("上一轮 brainstorm 的实录 turns（调用方从 brainstorm 返回值保留）"),
```

## 4. 两种追问粒度（Q2 —— 结构差异）

### 方案 A：all —— 全体选定卡共同追问

**schema**：`question + turns + cards? + mode?`

```ts
{
  question: z.string(),          // 追问问题
  turns,                          // 上一轮实录（§3）
  cards: z.array(z.string()).optional(),  // 沿用 brainstorm 语义，缺省=默认卡集
  mode: z.enum(["debate","relay"]).optional(),  // 对话风格，默认给 relay？或复用上一轮？
}
```

**语义**：所有选定卡基于上一轮实录 + 追问，各自作答 → N 条新 turn（round 延续）。

**实现**：for target → `formatTranscriptForPrompt(prevTurns)` + 追问模板 → `askExpert` → 收集新 turns = N 次 LLM 调用，并行化（同 round 内 Promise.allSettled，对齐 brainstorm debate 同一轮并行）。

**成本**：N 次调用。时间/ token 与卡数线性。

### 方案 B：specific —— 指定单张卡深化

**schema**：`question + turns + card`

```ts
{
  question: z.string(),
  turns,
  card: z.string(),              // 必填：单张卡 id
}
```

**语义**：仅该卡专家基于上一轮实录 + 追问，深入展开其既有观点、回应他卡质疑 → 1 条新 turn。

**实现**：单卡 single `askExpert`（一次 LLM 调用）。

**成本**：1 次调用。最快最省。

### 差异对比表

| 维度 | 方案 A（all 全体） | 方案 B（specific 单卡） |
|---|---|---|
| LLM 调用次数 | N（全部选定卡） | 1 |
| 返回新 turns | N 条 | 1 条 |
| 唯一必填 schema 增量 | `cards?`（可选） | `card`（必填单卡） |
| 卡选择语义 | 沿用 brainstorm 默认/显式全选 | 单卡精确定位 |
| 时间/成本 | 高（正比卡数） | 低 |
| 适用场景 | 想看多视角对追问的反应 | 深挖某专家观点 / 反驳其立论 |
| 与 streaming 通知顺承 | 每卡 1 条 bloom 通知（若做） | 单卡 1 条 |
| 实现复杂度 | 中（复用并行循环） | 低（单次调用） |
| round 演进 | 全体推进一轮 | 单卡推进一轮（部分卡缺席本轮） |

### 方案 C（组合，推荐给用户参考，不代选）

`card?` 可选字段：
- 不传 → all（全体追问，默认）
- 传单卡 id → specific（仅该卡）

一份 schema 覆盖两种场景，字段增量最小（一个可选 `card`）；缺省行为 = 现有 brainstorm 的最自然延伸（全体），指定卡则聚焦深化。

## 5. round 语义

新 turn 的 `round = max(prevTurns.round) + 1`；报告标题显示「第 X 轮追问」。
上一轮实录注入：`formatTranscriptForPrompt(prevTurns)`（沿用缓存预算）。
侧重「深化某一观点」时，追问模板在对话 prompt 中强调「基于此前讨论，仅回应以下追问」。

## 5a. 方案 C 定稿 schema（Q2 已决策）

```ts
{
  question: z.string().describe("追问问题(去空白后不能为空)"),
  turns: z.array(z.object({
    round: z.number().int().positive(),
    expertId: z.string(),
    expertName: z.string(),
    icon: z.string(),
    content: z.string(),
  })).describe("上一轮 brainstorm 实录 turns(调用方从 brainstorm 返回值保留)"),
  cards: z.array(z.string()).optional().describe("参与追问的卡 id 列表(缺省=已启用且有 key 的卡,最多 3 张)"),
  card: z.string().optional().describe("指定单张卡 id 深化(传则仅该卡作答 1 条 turn;省略则全体选定卡各作答)"),
  mode: z.enum(["debate","relay"]).optional().describe("对话风格(仅全体追问时有效,缺省 relay)"),
}
```

- `card` 与 `cards` 互斥：传 `card` 时忽略 `cards`（specific 路径）；不传 `card` 走 `sendCards`/缺省（all 路径）
- 追问 prompt（all）：`话题 + 新 question + 上一轮实录 + FOLLOWUP_INSTRUCTION`；specific 额外强调单卡领域深化
- 新 turn 的 `round = max(prevTurns.round, 0) + 1`（empty 时即 1），`icon`/`expertName` 取自 ResolvedCard

## 6. 降级语义（Q3 已决策）

- turns 为空数组 / 非法 JSON / 元素缺字段：**降级为无上下文追问**，照常跑（等同 brainstorm 首轮），
  返回报告中追加一行 `> ⚠️ 未使用历史上下文（turns 格式无效/为空）`，`isError=false`
- 检测：`Array.isArray(turns) && turns.length > 0 && turns.every(t => t && typeof t.round === "number" && typeof t.expertId === "string" && typeof t.content === "string")`，不满足 → 降级
- 全员失败 → 聚合 1 条错误摘要（对齐 consult 全失败压缩）；specific 卡不存在/未启用 → `noSelectedCardsResult`（isError + 列出可用卡）

## 7. 兼容性与回归

- `brainstorm` / `consult_experts` / `list_cards` 零改动 → 既有 94 测试用例不回归
- 新工具独立注册，prettier / tsc 全绿

## 8. 测试策略（定稿）

- `test/brainstorm-followup.test.ts`（新增）：
  - all：传 turns+question → N 条新 turn、round=max+1、LLM 调用 N 次
  - specific：传 card → 1 次 LLM 调用、1 条新 turn、仅该卡 expert 字段
  - 降级：turns=[] / 非法 → 报告含降级标注、isError=false、退化为首轮
  - PII：追问 prompt 中旧实录 + question 被掩码（复用 askExpert 的 redactPII）
  - 全员失败 → 聚合 1 条；无卡 → noSelectedCardsResult
- smoke-stdio.mjs：加 brainstorm_followup 断言（mock provider，验证报告含追问标记 + 不 isError）
- 既有 94 用例零改动不回归（R5）
- `npm run build` / `npm run typecheck` / `npm test` / smoke 全绿

## 9. 已决决策（Q2/Q3）

- **Q2 追问粒度** → **方案 C 组合**：`card?` 可选字段，缺省全体追问、传则单卡深化
- **Q3 turns 非法边界** → **降级无上下文 + 报告中标注**（§5a/§6）