# Implement: SP 二阶聚合 + 证据锚定协议

前置：读 `prd.md`（R1-R2 / AC1-AC9 / D1-D5）→ `design.md`（锚点 §1、证据 §2、SP §3、红线 §4、测试 §5）→ `research.md`。spec 对照：`.trellis/spec/backend/dialogue-prompts.md`（claim-0/魔鬼代言人/票文解析契约——本任务新增证据库与 SP 条目）。

## Step 1: 证据库（dialogue.ts + brainstorm.ts + format.ts）

- [ ] 常量 `EVIDENCE_LIBRARY_HEADER`/`EVIDENCE_LIBRARY_NOTE` + 截断上限；`buildEvidenceLibrary()`。
- [ ] `brainstormSchema.evidence`（string 数组可缺省）+ extras 透传。
- [ ] 注入矩阵接线：debate seed / debate ≥2（证据库前置于 claim-0 前缀）/ relay 各轮；投票轮不注入。
- [ ] format.ts：「### 证据库」小节（实录前）+ `collectEvidenceRefs()` + 「### 证据引用统计」小节（实录后、魔鬼代言人前）。
- 验证：`npm test -- test/orchestrator.test.ts test/consult-brainstorm.test.ts`

## Step 2: SP 聚合（dialogue.ts）

- [ ] `VOTE_INSTRUCTION` 重写（design §3.1 原文；唯一变更的四常量）。
- [ ] 选票解析：预测段分割 + predictions 收集（排除本人、去重保序）；`VoteBallot.predictions?`；JSONL vote 事件透传（仅非空写键）。
- [ ] `surprisinglyPopular()` 纯函数（design §3.3 契约）。
- [ ] `DialogueResult.spWinner?` 计算（votedForAlias 过滤空串 + predictions）。
- 验证：`npm test -- test/orchestrator.test.ts`

## Step 3: 报告与 JSONL

- [ ] format.ts：「### 聚合结果」三态小节（投票明细后、讨论总结前；受 vote 有票控制）。
- [ ] brainstorm.ts：JSONL vote 事件顶层 `spWinner`（仅成功时写键）。
- [ ] P3 的 VOTE_INSTRUCTION 相关测试断言按新指令更新。
- 验证：`npm test`

## Step 4: 质量门

- [ ] `npm test` + `npm run typecheck` 全绿。
- [ ] 自查 AC1-AC7、AC9；AC8 真跑由主会话执行。

## Step 5: 真实验证（主会话，best-effort AC8）

- [ ] `npx tsx` direct-handler 真跑：evidence 包（3 条，含一条可疑数据）+ vote + rounds=2；核验证据库渲染/[En] 引用/预测行/SP 或降级路径；证据写 `ac8-after-run.md`。

## 回滚点

- backend/docs 各一笔 commit；revert 即回滚。
