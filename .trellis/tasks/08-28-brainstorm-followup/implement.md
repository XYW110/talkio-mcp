# brainstorm_followup 实现计划

## 前置

- 当前任务已激活（`task.py current` = 08-28-brainstorm-followup）
- 依赖证据：`askExpert` / `formatTranscriptForPrompt`（dialogue.ts）、`selectCardsForTool`（select-cards.ts）、`formatBrainstormReport`（format.ts）均为现成导出
- PRD：R1-R6 / AC1-AC5；design.md §5a 定稿 schema、§6 降级语义

## 分步清单

### Step 1: 新建 `src/tools/brainstorm-followup.ts`

- zod raw shape：`question`（必填）+ `turns`（数组对象，round/expertId/expertName/icon/content）+ `cards?` + `card?` + `mode?`
- handler `handleBrainstormFollowup(args, config, deps?)`：
  1. `question.trim() === ""` → `blankInputError("question")`
  2. turns 合法性检测（design §6 判定式）→ 不合法：`prevTurns=[]` + 标记 `degraded=true`
  3. `nextRound = prevTurns.reduce((m,t)=>Math.max(m,t.round),0) + 1`
  4. 卡选择：`card` 传 → 显式单卡（resolveCard 失败 → noSelectedCardsResult 语义）；否则 `selectCardsForTool(config, cards, { defaultLimit: DEFAULT_CARD_LIMIT })`
  5. all 路径：`Promise.allSettled` 对全部选定卡调 `askExpert(target, followupPrompt, config)`；specific：单卡单次
  6. 收集新 turns（round=nextRound，失败卡 → `⚠️ (...)` turn，与 brainstorm 缺席语义一致）
  7. 全员失败 → 聚合 1 条 ⚠️ 摘要 turn + isError=true（对齐 consult 压缩语义）
  8. 报告 = `formatBrainstormReport` 变体（标题「追问实录」+ 主题=question + 第 nextRound 轮 + 降级标注行）
- FOLLOWUP_INSTRUCTION 常量（export 供测试）：「以下是基于此前讨论的追问。请基于此前讨论，仅回应以下追问，可深化、补充或修正你之前的观点。」

### Step 2: server.ts 注册 brainstorm_followup

- import `brainstormFollowupSchema, handleBrainstormFollowup`
- `server.registerTool("brainstorm_followup", {...}, handler)`（title「追问深化」，description 含隐私约定 + 「先调用 brainstorm 获取实录再传入 turns」提示）
- handler 调用 `handleBrainstormFollowup(args, config, { notifier })`（流式通知可选，本次**不接** notifier——PRD Notes 暂不强制）

### Step 3: 测试 `test/brainstorm-followup.test.ts`

- 复用 orchestrator.test.ts 的 vi.mock registry 模式（stubHolder + makeStubAdapter/makeTarget/makeConfig）
- 用例：
  1. all：turns(2轮4条) + question → 新 turn round=3、N 次 LLM 调用、expert 字段取自 ResolvedCard
  2. specific：card 传 → 1 次调用、1 条 turn
  3. 降级：turns=[] → 报告含「未使用历史上下文」、isError=false、round=1
  4. PII：question 与旧实录含手机号 → prompt 被掩码为 [手机号]
  5. 全员失败 → 聚合 1 条 ⚠️ 摘要 turn + isError
  6. blank question → blankInputError

### Step 4: smoke-stdio.mjs 扩展

- listTools 断言含 brainstorm_followup
- 先调 brainstorm 得报告，再调 brainstorm_followup（turns 传构造数组 + question）→ 断言不 isError、报告含「追问」标记
- 断言计数 18 → ~21

### Step 5: 全量验证

- `npm run typecheck && npm run build && npm test`（预期 94 → ~100）+ `node scripts/smoke-stdio.mjs`（预期 18 → ~21 断言）

## 验证命令

```bash
npm run typecheck
npm run build
npm test
node scripts/smoke-stdio.mjs
```

## 回滚点

- Step 1-2 全部为新文件 + server.ts 少量追加 → 回滚 = 删除新文件 + git checkout server.ts
- 无既有文件结构性修改（R5 兼容约束），风险低

## 风险文件表

| 文件 | 操作 | 风险 |
|---|---|---|
| src/tools/brainstorm-followup.ts | 新建 | 低（纯新增） |
| src/server.ts | 追加注册 | 低（registerTool 模式已验证 3 次） |
| test/brainstorm-followup.test.ts | 新建 | 低 |
| scripts/smoke-stdio.mjs | 追加断言 | 低（追加不改既有） |

## task.py start 前检查

- implement.jsonl / check.jsonl 已填真实条目（非 _example）
- prd.md 无 TBD / 未决 Open Questions
- design.md §9 已记录 Q2/Q3 决策
