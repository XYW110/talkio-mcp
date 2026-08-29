# 语义截断——实现计划（方案 B：对话式增量概要压缩）

## 范围

- **改**：`src/orchestrator/dialogue.ts`（brainstorm 注入点改造，签名不变）、`src/tools/brainstorm-followup.ts`（3 处注入点）
- **新增**：`src/orchestrator/context-compressor.ts`（预算判定 + 压缩器）、`test/context-compressor.test.ts`
- **不触碰**：consult_experts / list_cards / 工具 schema / `formatTranscriptForPrompt` 导出签名 / summarize 事后总结路径

## 分步清单（顺序执行，每步验证）

### Step 1 — context-compressor.ts（新模块，纯函数 + 压缩器）
- `estimateTranscriptChars(turns)`：复刻 `formatTranscriptForPrompt` 长度语义（每 turn `501+前缀`、`"\n\n"` join，不做截断）
- `exceedsBudget(turns)`：`> 12000`（与 dialogue.ts:79 同源常量）
- `SummaryState` / `buildInjection(summary, latestTurns)`：概要前缀 + 最新轮完整实录（跳过 500 截断）
- `COMPRESSOR_SYSTEM` + `compressTurns(topic, turns, target, config, existingSummary?, logger?)`
  - userContent = 主题 + 旧概要? + formatTranscriptForPrompt 渲染
  - 走 `askExpert`（输入侧掩码）；返回前 `redactPII(content)`（输出侧掩码）
  - askExpert 抛错原样上抛
- **验证**：`npm run typecheck`

### Step 2 — dialogue.ts brainstorm 接线（内部，签名不变）
- `runDialogue` 内：`summary: SummaryState`、`summarizerFailed` 布尔
- round>1 三分支（现状 / 首启压缩 / 已启用注入），见 design §6
- 轮末增量并入（吞错 + logger.warn）；summarize 事后路径与 `[summary]` 观测行微调（追加 `summary=on/off`）
- **验证**：`npm run typecheck` + `npm test`（既有零回归）

### Step 3 — brainstorm-followup.ts 接线（schema 不动）
- 新增内部辅助 `buildFollowupTranscript` + handler 级压缩缓存（relay 复用）
- 替换 3 处调用点（specific:162 / all+debate:235 / all+relay:241）；降级路径旁路
- **验证**：`npm run typecheck`

### Step 4 — 测试
- 新增 `test/context-compressor.test.ts`（design §10 用例：预算边界 11999/12000/12001、注入模板、压缩失败兜底、增量并入、双侧 PII）
- 扩展 `test/consult-brainstorm.test.ts` 或新增 `test/dialogue-summary.test.ts`：runDialogue 超预算 debate/relay 注入断言（echo adapter）
- 扩展 brainstorm-followup.test.ts：超预算 prevTurns → 报告/注入含概要，schema 不变
- **验证**：`npm test` 全绿（既有 100 零改动 + 新增）

### Step 5 — smoke 扩展
- `scripts/smoke-stdio.mjs` 加超预算 turns 的 brainstorm_followup 断言（概要注入、不 isError）
- **验证**：`node scripts/smoke-stdio.mjs` 全绿（依赖先 build）

### Step 6 — 全量验证 + 交付
- `npm run build` / `npm run typecheck` / `npm test` / `node scripts/smoke-stdio.mjs` 全绿
- `task.py validate`；向用户呈现 AC1-AC6 证据 → 取提交确认 → 提交 → `task.py finish` → 中文完成报告

## 验证命令

| 命令 | 预期 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0（smoke 依赖 dist） |
| `npm test` | 既有 100 用例零改动全绿 + 新增用例全绿 |
| `node scripts/smoke-stdio.mjs` | 既有 21 断言 + 新增概要断言全部 PASS |

## 风险文件表

| 文件 | 风险 | 缓解 |
|---|---|---|
| `src/orchestrator/dialogue.ts` | 注入分支改动影响 3 调用点 + 观测行 | step2 小步验证；签名不变；既有测试涵盖 |
| `src/tools/brainstorm-followup.ts` | 3 注入点 + relay 缓存 | handler 级缓存单例；降级旁路保持现状 |
| `src/orchestrator/context-compressor.ts` | 新模块（估计复刻偏差、PII 双侧遗漏）| 独立测试覆盖边界 + 双侧 PII 断言 |
| `scripts/smoke-stdio.mjs` | 依赖 dist 新注入行为 | smoke 在 build 后执行；短对话路径零改动 |

## 回滚点

- Review 点：Step 2/3 各自完成后 `npm test` 立即回归；任一步红 → 修或回退该步
- 全量回退 = revert dialogue.ts / brainstorm-followup.ts 内部分支 + 删除 context-compressor.ts 与对应测试（schema/handler 零触碰，安全）

## task.py start 前置检查（follow-up checks）

- [ ] `design.md` §3-8 已精确定稿（预算判定 / 状态机 / 注入模板 / 压缩器 / 双侧 PII）
- [ ] PRD 收敛 pass：无阻塞 Open Questions（Q1/Q2/Q3 resolved，Q4 defer）
- [ ] `git status` 干净或仅含 .trellis 未提交改动（规划产物）
- [ ] 既有 100 用例当前全绿（基线确认，先跑 npm test）
- [ ] 模型/契约确认：schema 零改动；PII 纪律双侧；budget 与现状常量同源