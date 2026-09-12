# Implement: brainstorm 议事质量包

## 执行清单（顺序）

1. [x] `src/orchestrator/dialogue.ts`：别名映射工具 + `formatTranscriptForPrompt` 匿名化选项（含 own 标注）；导出 `VOTE_INSTRUCTION`。单测先行（orchestrator.test.ts 匿名化 render 用例）。
2. [x] `dialogue.ts`：DialogueOptions/Result 扩展（vote、judgeCard、votes、judgeInfo）；投票轮实现（debate + vote + targets≥2，Promise.allSettled，复用压缩状态与 notifier）。
3. [x] `dialogue.ts`：裁决者选择逻辑（judgeCard → summarizer 替换 + targets 剔除 + fallback），summarizer prompt 追加投票摘要块。
4. [x] `src/records/store.ts`：RecordEvent 增 `vote` 变体；`src/tools/brainstorm.ts`：BrainstormArgs 增 `vote`/`judgeCard`，recordTurns 旁新增 votes 记录，报告字段透传。
5. [x] `src/server.ts`：MCP schema 扩展两个可选参数；`src/utils/format.ts`：报告插入"互评投票"段与裁决者标注。（schema 实际位于 `src/tools/brainstorm.ts` 的 `brainstormSchema`，server.ts 经 import 引用，已同步扩展）
6. [x] `admin-web/src/types.ts` + `RecordsPage.tsx`：vote 事件类型同步与容错渲染。
7. [ ] 测试补齐（见 design §Tests），然后全量验证，最后 `trellis-check`。（测试与全量验证已完成：npm test 176/176、build、smoke、admin-web build 均通过；仅剩 trellis-check 待主会话执行）

## 验证命令

- `npm test`（全量，重点 orchestrator.test.ts / consult-brainstorm.test.ts）
- `npm run build`（tsc）
- `node scripts/smoke-stdio.mjs`（mock 模式回归）
- 手动：`TALKIO_MOCK_PROVIDER=1` 下带 vote=true + judgeCard 调 brainstorm，检查报告与 records JSONL。

## 风险与回滚点

- 高风险：`dialogue.ts` 的轮次循环与压缩状态机（改动集中在轮后新增阶段，勿动 round 循环本体）。
- AC5 回归是硬闸门：每步完成后跑 consult-brainstorm.test.ts 确认缺省行为不变。
- 回滚：单 commit revert；vote 事件类型为 additive，旧消费端兼容。

## start 前检查

- [x] prd.md 收敛（无 open question）
- [x] design.md / implement.md 就绪
- [x] 用户对最终规划摘要的明确批准（2026-09-13，Q1:A / Q2:A）
