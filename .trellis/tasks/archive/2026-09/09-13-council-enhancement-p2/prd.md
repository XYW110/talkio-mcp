# PRD: 议事增强 P2（信号路由选卡 + 工具开关 + 模型分级）（council-enhancement-p2）

## Goal / 用户价值

让选卡从「手动指定 / 固定默认」升级为「按问题内容自动路由」（来源 agent-review-panel 信号机制）；给用户上下文/成本控制权（按工具开关，来源 PAL MCP）；模型分级 tier 仅作 admin 展示排序。P3-A runs 并集与 P3-C provider preset 留 backlog。

## 背景与已确认事实

- 前置：P1 已完成（投票聚合落盘 + reasoningStrategy，commit 98ec22e / 90c97ca / a7bbc40）。
- 现状：`select-cards.ts` 仅支持显式 id 或默认卡；`server.ts` 全量注册 4 个工具；CardConfig 无 signals、ModelConfig 无 tier。

## Requirements

- R1: `CardConfig` 增可选 `signals?: string[]`，值域为内置信号组枚举（zod 校验）；admin CardsPage 可编辑（标签开关）。
- R2: consult_experts 与 brainstorm 增 optional 参数 `select?: "auto"`（zod enum；缺省/缺参数行为与现状完全一致）；followup 本轮不加。
- R3: auto 匹配：topic/question 文本（小写化）对内置中英双语关键词表做子串匹配 → 命中信号组 → 取「enabled 且 signals 有交集」的卡（保持文件序，按 defaultLimit 截断）。
- R4: 零命中回退现有默认卡逻辑，selection notes 注明「信号未命中，已回退默认」；命中时 notes 注明命中的信号组。
- R5: 关键词→信号映射为集中常量（`src/orchestrator/` 同级或 `src/tools/` 内，实现者按内聚判断），中英双语，便于后续外置。
- R6: config 增可选 `disabledTools?: string[]`：仅允许禁用非核心工具（**核心保护名单 = list_cards、consult_experts、brainstorm**，config 加载校验拒绝禁用核心工具并报清晰错误；brainstorm_followup 及未来新增工具可禁用）。禁用的工具不注册（tools/list 不出现）。默认全开。
  - 注：prd-draft 原 R7 写「三个核心议事工具全部不可禁用」，终稿按「开关机制需有即时可用对象」细化为 followup 可禁用（成本控制场景真实存在），与 Q1 A 批准的机制一致。
- R7: `ModelConfig` 增可选 `tier?: number`（正整数，zod 校验）；仅用于 admin ModelsPage/ModelPicker 按 tier 降序展示（无 tier 的保持现有顺序、排在有 tier 之后）；不参与任何选卡/prompt 逻辑。
- R8: 兼容红线：experts.json 旧文件直接加载；缺省字段不写入；显式 cards 传参行为逐字节一致；不传 select 参数时选卡与报告输出与现状完全一致。

## Acceptance Criteria

- AC1: 不传 select 时，consult_experts/brainstorm 的选卡与报告与现状一致（回归断言）。
- AC2: select:"auto" 时，中英文关键词均可命中对应 signals 卡；多命中按 defaultLimit 截断；零命中回退默认卡且 notes 注明；显式 cards + select:"auto" 同时出现时 select 被忽略（或校验拒绝，实现取一并在报告说明）。
- AC3: signals/tier/disabledTools 的 zod 校验：非法值拒绝；缺省不出键；旧文件可加载。
- AC4: disabledTools 禁用 brainstorm_followup 后 tools/list 不含它，调用报「未知工具」；尝试禁用核心工具时 loadConfig 报错；缺省全开。
- AC5: admin CardsPage 可编辑 signals（标签开关）并正确落盘；ModelsPage/ModelPicker tier 排序生效。
- AC6: `npm test` 全过 + `npm run typecheck` + `npm --prefix admin-web run build` 通过。

## Key Decisions（用户已拍板）

- D1: 触发方式 = 新 optional 参数 `select:"auto"`；工具开关载体 = config 字段 `disabledTools`（Q1=A）。
- D2: 本轮范围 = P2 全部 + P3-B tier；P3-A runs 并集、P3-C provider preset 留 backlog（Q2=B）。
- D3: tier 仅展示排序，不参与选卡逻辑（Q3=A）。

## Out of Scope

- followup 的 auto 选卡；关键词表外置/可配置；records 格式变更；provider preset；runs 并集。
