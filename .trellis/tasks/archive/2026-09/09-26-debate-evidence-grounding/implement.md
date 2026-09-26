# Implement: 辩论反锚定与论据锚定

前置：读 `prd.md`（R1-R10 / AC1-AC9 / D1-D5）→ `design.md`（注入矩阵 §1、常量 §2、逐路径 §3、红线 §4、测试 §5）→ `research.md`（why）。

## Step 1: 常量与 claim-0 组装（dialogue.ts）

- [ ] `DialogueOptions` 增 `context?: string`（JSDoc 注明 debate 盲答 / relay 随轮语义）。
- [ ] 新增 `CLAIM0_HEADER` / `CLAIM0_NOTE` 常量与 `buildClaim0Block()`（design §2；空白 context 返回 `""`）。
- [ ] 重写 `SEED_INSTRUCTION`（R7：主张+依据+来源+不确定点+防锚定句）。
- [ ] 重写 `DEBATE_INSTRUCTION`（R8：点名对方论据、来源、推测标注）。
- [ ] 重写 `VOTE_INSTRUCTION`（R9：论据质量标准、引用被投者具体论据、claim-0 非候选人；保留禁自投/150 字/立场修正）。
- [ ] `SUMMARIZER_SYSTEM` 增补无共识条款（R10）。
- 验证：`npm run typecheck`

## Step 2: runDialogue 接线（debate / relay）

- [ ] debate round 1 seed：确认不注入 context（现状即满足，补注释 + 测试锁定）。
- [ ] debate round ≥2：注入块前插 `buildClaim0Block` 产物（压缩与非压缩路径同一包裹点）。
- [ ] relay 各轮：topic 后插入 claim-0 块（有 context 时）。
- [ ] 投票轮不改注入内容。
- 验证：`npm test -- test/orchestrator.test.ts`（新断言 + 旧结构断言全绿）

## Step 3: brainstorm 工具与报告

- [ ] `BrainstormArgs` + schema 增可选 `context`（describe 写 claim-0 语义）；`opts` 透传。
- [ ] `formatBrainstormReport` extras 增 `initiatorContext`；渲染 claim-0 小节（design §3.6；无该字段字节不变）。
- [ ] `handleBrainstorm` 传 `initiatorContext: args.context`。
- 验证：`npm test -- test/consult-brainstorm.test.ts test/brainstorm-runs.test.ts`

## Step 4: consult 路径 claim-0 框架

- [ ] `buildTargetMessages` 标签替换（design §3.7）。
- [ ] `consult-experts.ts` schema `context.describe` 更新。
- 验证：`npm test`

## Step 5: 全量质量门

- [ ] `npm test` 全绿；`npm run typecheck` 全绿。
- [ ] 自查 AC1-AC7 逐条对照（AC8 真实验证由主会话执行）。

## Step 6: 真实验证（主会话，best-effort AC8）

- [ ] `npx tsx` direct-handler 真实跑 brainstorm：context 含明显倾向性初步判断 + vote + rounds=2；核验盲答 / claim-0 质疑 / 论据票文；证据写 `ac8-after-run.md`。

## 回滚点

- 每步可独立 `git checkout -- <file>`；整体回滚 = revert 单个 backend commit（design §6）。
