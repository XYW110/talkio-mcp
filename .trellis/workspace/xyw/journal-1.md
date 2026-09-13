# Journal - xyw (Part 1)

> AI development session journal
> Started: 2026-07-31

---



## Session 1: Complete tests and merge teammate branches

**Date**: 2026-08-01
**Task**: Complete tests and merge teammate branches
**Branch**: `master`

### Summary

Resolved vitest and typecheck errors, merged all teammate branches (tests-docs-docker, test-fixer, build-smoke), and cleaned up the agent team environment. The project builds and passes tests successfully.

### Git Commits

| Hash | Message |
|------|---------|
| `0b8ba57` | (see git log) |
| `415d5bb` | (see git log) |
| `f66c407` | (see git log) |
| `320b10b` | (see git log) |
| `bbcaa73` | (see git log) |

### Status

[OK] **Completed**


## Session 2: Populate backend and frontend Trellis spec guidelines

**Date**: 2026-08-01
**Task**: Populate backend and frontend Trellis spec guidelines
**Branch**: `master`

### Summary

Completed the 00-bootstrap-guidelines task by filling 12 backend and frontend spec files with accurate codebase examples (using src/ and temp/ respectively). Setup Trellis conventions for future AI assistance. Merged teammate branches and archived the bootstrap task.

### Git Commits

| Hash | Message |
|------|---------|
| `9cbe5fc` | (see git log) |
| `1f88087` | (see git log) |
| `93251e3` | (see git log) |

### Status

[OK] **Completed**


## Session 3: 添加 list_experts 并修复 mock 凭据短路

**Date**: 2026-08-21
**Task**: 添加 list_experts 并修复 mock 凭据短路
**Branch**: `master`

### Summary

新增 list_experts 只读发现工具，修复 TALKIO_MOCK_PROVIDER 仍解析真实 API Key 导致 smoke 失败，补齐 Cursor 文档与三工具冒烟覆盖。

### Main Changes

- 新增 list_experts MCP 工具并在 server 注册
- 编排层 mock 模式在凭据解析前短路
- README 增加 Cursor 配置与工具用法

### Git Commits

| Hash | Message |
|------|---------|
| `4500240` | (see git log) |

### Testing

- [OK] npm test 42 passed
- [OK] node scripts/smoke-stdio.mjs PASS

### Status

[OK] **Completed**

### Next Steps

- Streamable HTTP 替换/并存旧 SSE
- Docker 默认回环或加简单 token
- brainstorm 进度通知


## Session 4: 默认专家筛选与首次调用成本

**Date**: 2026-08-27
**Task**: 默认专家筛选与首次调用成本
**Branch**: `master`

### Summary

规划并实现 consult/brainstorm 默认只选有 key 的启用专家（最多 3 人），brainstorm 默认 1 轮不总结；空参拦截。随后提交 Trellis 0.6.15 升级与 AGENTS.md 提问规则。

### Main Changes

- 抽出 src/tools/select-experts.ts，默认路径 enabled ∩ 有 key 再截 3 人
- consult/brainstorm 空参拦截；brainstorm 默认 rounds=1 summarize=false
- README 对齐新默认并补 parallel

### Git Commits

| Hash | Message |
|------|---------|
| `4c9afb0` | (see git log) |
| `653c705` | (see git log) |
| `d60fb65` | (see git log) |

### Testing

- [OK] npm test 57 passed；npm run typecheck 通过；node scripts/smoke-stdio.mjs PASS

### Status

[OK] **Completed**

### Next Steps

- list_experts 标注缺 key
- brainstorm 增加 context
- LICENSE / CI / npm 元数据


## Session 5: list_experts 标注缺 key

**Date**: 2026-08-27
**Task**: list_experts 标注缺 key
**Branch**: `master`

### Summary

实现 list_experts 的 ready/missingEnv/readyCount 契约，缺密钥专家仍列出。质量门补齐 README 特性条与用法区说明后归档。

### Main Changes

- ExpertSummary 增加 ready 与可选 missingEnv，复用 hasProviderKey
- Markdown 标注缺 env，payload 增加 readyCount
- README 特性条与用法区对齐就绪状态

### Git Commits

| Hash | Message |
|------|---------|
| `0d5147d` | (see git log) |
| `f4f1cc7` | (see git log) |

### Testing

- [OK] npm test 60 passed；npm run typecheck 通过；node scripts/smoke-stdio.mjs PASS

### Status

[OK] **Completed**

### Next Steps

- brainstorm 增加 context
- LICENSE / CI / npm 元数据


## Session 6: 会话记录落盘（session-records）
<!-- trellis-session: v=2 fp=a9f2177f3de5c52b -->

**Date**: 2026-09-04
**Task**: 会话记录落盘（session-records）
**Branch**: `master`

### Summary

为 consult_experts/brainstorm/brainstorm_followup 三个 MCP 工具新增 JSONL 会话持久化：src/records/store.ts（startSession/append/finish/flush 单 tail-promise 串行化写入）、三工具 deps.record 接线、server/index 装配 recordsDir、admin API GET /api/records(+/:id)。修复 brainstorm-followup 中 askExpert 返回 {content,usage} 的两处损坏调用点。修复同秒创建会话排序断言偶发失败（改为文件名倒序断言）。spec 新增 records-persistence.md（7 节完整契约）。147 测试全通过。

### Git Commits

| Hash | Message |
|------|---------|
| `7d480e5` | feat(records): add JSONL session persistence for consult/brainstorm/followup + admin API |
| `a57f266` | docs(spec): 记录会话记录落盘契约（records-persistence） |

### Status

[OK] **Completed**

## Backlog 决议：竞品对比后的改进方向（2026-09-13）

基于竞品对比（block/mcp-council-of-mine、llm-council MCP 版、spranab/brainstorm-mcp、wan-huiyan/agent-review-panel、feiskyer/mcp-ai-hub）头脑风暴后，用户选定两个方向，**待当前 snow-ui-restyle 任务收尾后再开新 Trellis 任务**：

1. **议事质量包**：debate 模式第 2 轮前插入互评投票轮（每人写"最认同谁的观点+理由"，借鉴 Council of Mine）+ 互看 transcript 时匿名化卡名（A/B/C 代号，借鉴 llm-council）+ 可选 `judgeCard` 参数指定裁决者卡替代"第一张卡当 summarizer"。三者改动集中在 `src/orchestrator/dialogue.ts`，可打包为一个任务。
2. **Token 用量聚合页**：admin-web 新增聚合视图，数据源为 records JSONL 中已有的 per-call/per-session usage（`src/records/store.ts` sumUsage），按卡片/模型/日期聚合，可选价格表换算成本。

备选未选：服务端会话 sessionId 续写（brainstorm_followup 免传 turns）、Admin API 鉴权 + per-provider 并发限流。另注：theodorstorm/brainstorm-mcp 已归档（agent 协调原型），真正对标 brainstorm 的是 spranab/brainstorm-mcp。


## Session 7: 议事增强 P1——投票透明化与推理策略（council-enhancement）

**Date**: 2026-09-13
**Task**: council-enhancement（P1：投票聚合落盘 + reasoningStrategy）
**Branch**: `master`

### Summary

基于竞品深抓研究（tavily 5 项目，沉淀于任务 research/competitor-deep-dive.md）落地 P1：brainstorm 互评投票改为每会话一条聚合 vote 事件（voterCardId/votedForAlias/reason，理由截断 200 字），报告新增「投票明细」小节，admin Records 兼容新旧两种 vote shape 渲染；ExpertConfig 增可选 reasoningStrategy（systematic/adversarial/backward），经 strategy.ts 的 applyReasoningStrategy 统一注入 system prompt，缺省路径逐字节不变（toBe 引用断言）。实现中发现并替换了 HEAD 1378969 遗留的旧版逐专家 vote 事件，顺带修复 vote-prompt-fix 会话 2 处坏断言。190 测试通过后检查（pass-with-notes，仅 P3），按 PRD 实际展示层级修订 D3 措辞（报告用别名、admin 用真实卡名）。

### Git Commits

| Hash | Message |
|------|---------|
| `98ec22e` | feat(council): 投票聚合落盘、投票明细报告与推理策略注入 |
| `90c97ca` | feat(admin-web): 投票明细渲染与专家推理策略编辑 |
| `a7bbc40` | chore(task): council-enhancement 任务文档与竞品研究沉淀 |
| `dd21081` | docs(spec): 前后端共享值域常量约定与 admin 保存无校验已知限制 |

### Testing

- [OK] npm test 190 passed（14 文件）；npm run typecheck 通过；npm --prefix admin-web run build 通过

### Status

[OK] **Completed**（已归档 archive/2026-09/）

### Next Steps

- 真实模型跑一次 vote 开启的 brainstorm，观察 votedForAlias 文本解析命中率
- P2/P3 方向见 Session 8 与 prd-draft.md


## Session 8: 议事增强 P2——信号路由选卡、工具开关与模型分级（council-enhancement-p2）

**Date**: 2026-09-13
**Task**: council-enhancement-p2（P2-A/B + P3-B tier；Q1=A/Q2=B/Q3=A 已拍板）
**Branch**: `master`

### Summary

新增 src/tools/signal-routing.ts（10 个内置信号组 + 中英双语关键词表 + matchSignals/selectCardsBySignals，general 卡永远可候选）；consult_experts/brainstorm 增 optional `select:"auto"` 参数（显式 cards 优先并注明忽略、零命中回退默认卡并在 notes 注明、缺省路径逐字节不变）；config.disabledTools 支持禁用非核心工具（核心 list_cards/consult_experts/brainstorm 禁用即 loadConfig 报错，followup 可禁用不注册，server.ts 另有注册守卫兜底）；ModelConfig.tier（1-100 可选正整数）仅用于 admin ModelsPage/ModelPicker 稳定排序展示。admin CardsPage 增信号标签 chip 编辑（SIGNAL_GROUPS 前端副本与后端互指注释）。216 测试通过，检查 pass-with-notes（3 条 P3：general-only notes 措辞、admin 保存无 zod 校验的预先存在限制、server.ts 缩进）。runs 并集与 provider preset 留 backlog。

### Git Commits

| Hash | Message |
|------|---------|
| `0527411` | feat(council): 信号路由自动选卡、工具开关与模型分级 |
| `8bc0680` | feat(admin-web): 信号标签编辑与模型分级排序 |
| `000cdfb` | chore(task): council-enhancement-p2 任务文档（信号路由选卡/工具开关/tier） |

### Testing

- [OK] npm test 216 passed（16 文件）；npm run typecheck 通过；npm --prefix admin-web run build 通过

### Status

[OK] **Completed**（已归档 archive/2026-09/）

### Next Steps

- backlog：P3-A runs 并集+稳定性标注（建议等 P1 投票真实使用反馈）、P3-C provider preset
- admin API 保存配置无 zod 校验的即时反馈（spec 已记录该限制）
