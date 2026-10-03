# implement — 10-02-groupchat-strengths

执行顺序按依赖排列；每步后跑对应验证。分轨提交点用 📦 标注。

## 轨道 A：记忆基础设施（R3 底座，最先落地因为 R2 注入也走同一条 prefix 链）

1. **`src/experts/memory.ts` 新模块** — resolveMemoryDir / loadExpertMemories / appendMemory / buildMemoryBlock / parseMemoryLine（design §3 签名）。
   验证：`npx vitest run test/memory-store.test.ts`（新增，覆盖 design §6 第一行全部用例）。
2. **`.gitignore` 增 `memory/`**、`.env.example` 增 `TALKIO_MEMORY_DIR=`。
   📦 **backend 提交 1**（memory 模块 + 测试）。

## 轨道 B：编排层（R1 通知 + R2 插话 + R3 注入/harvest）

3. **notify.ts** — `StreamEvent` 追加 `brainstorm.turn`（纯类型增量）。
4. **dialogue.ts** —
   a. 常量：`INTERJECTION_HEADER / INTERJECTION_NOTE / MEMORY_HARVEST_INSTRUCTION / MEMORY_BLOCK_HEADER`（不动既有四常量）；
   b. `DialogueOptions` 增 `interjections? / remember? / memories?: Map<expertId, MemoryEntry[]>`（handler 预读注入，避免编排层做 IO）；
   c. 轮循环：userContent 组装链 `memoryPrefix + interjectionPrefix + evidencePrefix + claim0Prefix`；末轮追加 harvest 指令；`parseMemoryLine` 剥离后 push turn；每卡 settle 后发 `brainstorm.turn`；
   d. 轮末：`afterRound === round` 的插话 append JSONL `interjection` 事件；
   e. `DialogueResult` 增 `harvestedMemories?: Array<{ expertId, memory }>`（供 handler 落盘）。
5. **brainstorm.ts handler** — schema 增 `interjections/remember/memory`；校验 afterRound 范围（早退错误）；预读记忆（`memory !== false` 时 Promise.all）；结果落盘 `appendMemory` × harvested；报告传 `interjections`。
6. **parallel.ts + consult-experts.ts** — `buildTargetMessages` 增 memoryPrefix；schema 增 `memory`；handler 预读注入。
7. **brainstorm-followup.ts** — 追问 prompt 组装处增 memoryPrefix；schema 增 `memory`。
8. **format.ts** — `formatBrainstormReport/formatTranscript` 增可选 `interjections` 渲染（零插话零字节）。
9. **store.ts** — `RecordEvent` 追加 `interjection` 变体（additive）。
10. **index.ts / server.ts** — `ServerOptions.memoryDir` 装配 + handler deps 透传。
    验证：`npx vitest run test/orchestrator.test.ts test/server-tools.test.ts`（含 AC1-AC6 新增断言 + 既有零回归）。
    📦 **backend 提交 2**（编排 + 工具 + 通知 + 报告 + 装配 + 测试）。

## 轨道 C：Admin API（R5）

11. **admin/api.ts** — `GET /api/memory` / `DELETE /api/memory/:expertId`（复用鉴权 gate 与 JSON 错误契约；路由风格对齐 records 路由）。
    验证：`npx vitest run test/admin-memory.test.ts`（AC7）+ 既有 admin 测试零回归。
    📦 **backend 提交 3**（admin memory 路由 + 测试）。

## 轨道 D：文档与收尾（R6）

12. **README** — 工具参数表（interjections/remember/memory）、流式事件表补 `brainstorm.turn`、JSONL 事件契约补 `interjection`、memory 目录/env/隐私说明（本地存储 + redactPII + DELETE API）。
13. **全量质量门** — `npm run typecheck && npm test && npm run build && node scripts/smoke-stdio.mjs`（TALKIO_MOCK_PROVIDER=1）。
14. **spec 沉淀 + journal + 归档** — `.trellis/spec/backend/` 更新（dialogue-prompts.md 增插话/记忆注入位次与零改动要求；records-persistence.md 增 interjection 事件；新 memory 沉淀行）+ journal Session + `task.py archive`。

## 风险文件与回滚

- `src/orchestrator/dialogue.ts`（注入链改动核心，回归面最大——AC6 逐字节快照必须先行建立基线）；`src/tools/brainstorm.ts`（schema 兼容：新参数全部 optional，旧调用零影响）。
- 回滚：git revert 分轨提交（模块/编排/admin 三提交独立可回退）。
