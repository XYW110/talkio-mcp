# Implement: 辩论质量 P3

前置：读 `prd.md`（R1-R3 / AC1-AC7 / D1-D4）→ `design.md`（锚点 §1、解析 §2、魔鬼代言人 §3、红线 §4、测试 §5）→ `research.md`。spec 对照：`.trellis/spec/backend/dialogue-prompts.md`（claim-0 三语义/注入矩阵——本任务在其上追加魔鬼代言人条目）。

## Step 1: 票文解析（dialogue.ts）

- [ ] 私有 helper「收集别名提及列表」（全称 + 裸字母，来源标记）。
- [ ] `parseVotedForAlias` 升级为两级匹配（签名不变；design §2 规则）。
- [ ] 新导出 `isSelfVoteBallot(content, voterAlias, knownAliases)`。
- [ ] `VoteBallot` 增 `selfVote?: boolean`；投票段构造点按 design §2 置位并透传 JSONL vote 事件。
- 验证：`npm test -- test/orchestrator.test.ts`

## Step 2: 魔鬼代言人（dialogue.ts）

- [ ] 新常量 `DEVILS_ADVOCATE_INSTRUCTION`（design §3 原文；不含真名/代号）。
- [ ] 纯函数 `devilsAdvocateIndex(round, targetCount)`。
- [ ] runDialogue debate round≥2：对 `i === devilsAdvocateIndex(...)` 的 target 在 DEBATE_INSTRUCTION 后追加指令；round1/relay/投票段零改动。
- [ ] `DialogueResult.devilsAdvocates` 收集。
- 验证：`npm test -- test/orchestrator.test.ts`

## Step 3: 报告与工具层

- [ ] format.ts：投票明细三态（selfVote 分支）；`BrainstormReportExtras.devilsAdvocates`；「魔鬼代言人轮换」小节（缺省零字节）。
- [ ] brainstorm.ts：透传 `devilsAdvocates`。
- 验证：`npm test`

## Step 4: 质量门

- [ ] `npm test` + `npm run typecheck` 全绿。
- [ ] 自查 AC1-AC5、AC7；AC6 真跑由主会话执行。

## Step 5: 真实验证（主会话，best-effort AC6）

- [ ] `npx tsx` direct-handler 真跑 debate rounds=2 + vote；核验报告轮换小节/强质疑形态/裸代号解析（如出现）；证据写 `ac6-after-run.md`。

## 回滚点

- backend/docs 各一笔 commit；回滚 revert。无迁移/配置/admin-web。
