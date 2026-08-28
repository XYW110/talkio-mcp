# brainstorm 追问——followup 新工具

## Goal

新增 `brainstorm_followup` 工具：调用方携带既有 `brainstorm` 讨论实录（turns）+ 追问问题，复用上下文继续深化，避免重建完整讨论。全后端 MCP 工具，无前端改动。

## Confirmed Facts（代码调研）

- `DialogueTurn = { round, expertId, expertName, icon, content }`（dialogue.ts:29）
- `runDialogue(opts, config)` 返回 `{ turns, summary? }`；服务端无会话状态，调用方必须回传 turns
- 报告 `formatBrainstormReport` 为不可逆 Markdown → 传回结构化 turns JSON，不传报告文本
- 复用点：`askExpert(target, userContent, config)`（dialogue.ts:136）、`formatTranscriptForPrompt(turns)`（dialogue.ts:106）、`selectCardsForTool`（select-cards.ts:155）
- `runDialogue` 从 round=1、seed 指令固定，不适合复用为追问引擎 → 新建独立单轮引擎
- 前端 admin-web 无 brainstorm 引用 → 纯后端改动

## Requirements

- R1 新增 `brainstorm_followup` 工具：`question`（必填）+ `turns`（上一轮实录 JSON 数组）+ `cards?`（缺省=默认卡集）+ `card?`（可选单卡，传则仅该卡深化）+ `mode?`（debate/relay，缺省 relay）
- R2 追问粒度（Q2 → 方案 C 组合）：不传 `card` → 全体选定卡共同追问；传 `card` → 仅该卡深化，1 次 LLM 调用
- R3 新 turn 的 `round = max(prevTurns.round) + 1`；上一轮实录经 `formatTranscriptForPrompt` 注入追问 prompt（含 12000 字符缓存预算）
- R4 `turns` 为空数组 / 非法 JSON：**降级为无上下文追问**（退化为一次普通 brainstorm 首轮），报告标注「⚠️ 未使用历史上下文（turns 格式无效/为空）」
- R5 **不**改动 `brainstorm` / `consult_experts` / `list_cards` 现有 schema / handler / CallToolResult 语义
- R6 全员失败 → 聚合 1 条错误摘要（对齐 consult 全失败压缩语义）；单卡 specific 对不存在的卡 → isError + 列出可用卡（`noSelectedCardsResult`）

## Acceptance Criteria

- [ ] AC1 传 `turns`+`question` 返回追问报告，含延续 round 的新 turns（round=max+1）
- [ ] AC2 不传 `card` → 全体卡各作答；传 `card` → 仅单卡 1 次 LLM 调用、仅 1 条新 turn
- [ ] AC3 `turns` 为空/非法 → 降级无上下文追问，报告中标注降级，isError=false
- [ ] AC4 `brainstorm` 既有 94 用例零改动不回归；新工具独立测试 + smoke 断言
- [ ] AC5 PII 纪律：追问 prompt 中上一轮实录与 question 经 redactPII 掩码（复用 askExpert）

## Out of Scope

- 不新增多轮对话会话状态（无 stateful server session）
- 不改 `runDialogue` 引擎 / `brainstorm` 报告结构
- 不做前端 UI / admin-web 集成
- 不做 turns 去重 / 记忆压缩之外的增量优化

## Open Questions（已收敛）

- ~~Q2 追问粒度~~ → **方案 C 组合**（缺省全体、可选 card 单卡深化）
- ~~Q3 turns 非法边界~~ → **降级无上下文 + 标注**

## Notes

- 复杂任务，已建 design.md + implement.md
- 流式通知可选顺承（streaming 任务提供 notifier，本项目暂不强制）
