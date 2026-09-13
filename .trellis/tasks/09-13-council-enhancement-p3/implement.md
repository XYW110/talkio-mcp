# 执行计划：P3-A runs 并集 + P3-C Provider 预设

> 前置阅读：prd.md → design.md → research/p3-mechanism-source.md。兼容红线（AC1）贯穿始终。

## Step 1 P3-A 后端：runs=1 等价性护栏

- [ ] 1.1 写 `test/brainstorm-runs.test.ts` 首个用例：runs 缺省与 runs=1 的报告/事件流快照（记录当前基线，改造后必须逐字节一致）。
- 验证：`npx vitest run test/brainstorm-runs.test.ts`（此时仅基线用例）。

## Step 2 P3-A 后端：多轮执行 + 合并

- [ ] 2.1 brainstorm.ts：zod `runs` 参数 + `BrainstormArgs` 类型 + handler 循环执行（run=1 零开销路径）。
- [ ] 2.2 dialogue.ts：`DialogueOptions` 增别名轮换注入（确定性 rotate(run-1)，可测）；确认 run=1 路径别名映射与现状一致。
- [ ] 2.3 合并调用模块（judge 优先/总结者回退 + 失败兜底并列展示）。
- [ ] 2.4 报告：runs 头标注 + 「多轮稳定性」小节（N=1 不渲染）。
- [ ] 2.5 records：四类事件可选 `run` 字段（N>1 才写键）+ finish.usage 全量归并。
- 验证：补齐 AC2/AC3 用例（mock LLM：两次 runDialogue、别名轮换、[K/N RUNS] 标注、合并失败回退、zod 拒绝）。
- 全量：`npm run typecheck && npm test`。

## Step 3 配套前端（最小）

- [ ] 3.1 SessionDetailView：run 徽标（Pill R{n}），无 run 字段渲染不变；旧 JSONL 回归用例补进 test/admin-records.test.ts。
- [ ] 3.2 ProvidersPage：预设区（Chip 按钮 ≥6 预设，一键填充表单 + apiKeyEnv 提示），不动保存流程。
- 验证：`npm run typecheck && npm --prefix admin-web run build`。

## Step 4 全量验证（对照 AC）

- [ ] AC1 快照等价（Step 1 用例通过即证）
- [ ] AC2/AC3 mock 用例过
- [ ] AC4 dev server 手测预设填充（可选，起后端+前端）
- [ ] AC5 旧会话文件回归 + run 徽标
- [ ] AC6 typecheck/test/build:web 全绿
- [ ] （可选）.env 有 CUSTOM_API_KEY 时真实 runs=2 冒烟一次，留档截图/报告片段

## Step 5 收尾

- [ ] 5.1 spec 更新：brainstorm runs 契约 + records run 字段进 backend spec。
- [ ] 5.2 提交计划（Phase 3.4 流程，后端/admin-web/docs 分组提交，等用户确认）。

## 回滚点

- Step 1 独立提交可先行；Step 2/3 分属后端/前端，可各自 revert。

## 验证命令汇总

```bash
npm run typecheck && npm test          # 后端
npm --prefix admin-web run build       # 前端
npx tsx src/index.ts --transport sse --port 3100   # 手测时起后端
```
