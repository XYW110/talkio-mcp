# PRD Draft: 议事增强 P2/P3（council-enhancement-p2）

> 状态：**草案**。前置：P1 已完成并提交（投票聚合落盘 + reasoningStrategy，commit 98ec22e/90c97ca）。
> 研究依据：`../09-13-council-enhancement/research/competitor-deep-dive.md`（agent-review-panel / PAL MCP）。

## Goal

让选卡从「手动指定 / 固定默认」升级为「按问题内容自动路由」，并给用户上下文/成本控制权（按工具开关）。P3 两项（runs 并集、模型分级、provider preset）是否纳入本轮待拍板。

## 现状基线（P1 完成后）

- `src/tools/select-cards.ts`：`selectCardsForTool(config, cards)` —— 显式 id 列表或 enabled 默认卡（isDefault 优先，上限 DEFAULT_CARD_LIMIT / brainstorm 6 张）。
- `src/server.ts`：5 个工具全量注册（list_cards / consult_experts / brainstorm / brainstorm_followup）。
- `src/types.ts`：CardConfig 无 signals；ModelConfig 无 tier。
- zod 校验在 `src/config.ts`。

## Requirements

### P2-A 信号路由自动选卡（来源 agent-review-panel）

- R1: `CardConfig` 增可选 `signals?: string[]`（受限枚举标签，初版内置信号组：sql/data、security、infra、ml、api、frontend、cost、pipeline、writing、general）。
- R2: 选卡触发方式 **[待 Q1 拍板]**：新增 optional 工具参数 vs cards 魔法值。
- R3: 匹配逻辑：topic/question 关键词 → 信号组 → 含该信号且 enabled 的卡；命中多张按 DEFAULT_CARD_LIMIT 截断；**零命中回退现有默认卡逻辑并在报告 selection notes 注明**；显式 cards 传参行为完全不变。
- R4: 关键词→信号映射表为内置常量（中英双语词表），集中一处便于后续外置。
- R5: admin CardsPage 支持编辑 signals（多选标签）。
- R6: 适用工具 **[待 Q1 拍板一并确认]**：consult_experts + brainstorm（followup 暂不动，其选卡继承入参习惯）。

### P2-B 按工具开关（来源 PAL MCP）

- R7: config 增可选 `disabledTools?: string[]`（或 env `TALKIO_TOOLS`，**[待 Q1 一并确认载体]**）；`list_cards` 与三个核心议事工具不可禁用（校验拒绝并报清晰错误）；默认全开。
- R8: 禁用的工具不注册（tools/list 不出现），MCP 行为等同于不存在。

### P3（可选，**[待 Q2/Q3 拍板]**）

- P3-A runs 并集（agent-review-panel）：brainstorm `runs?: 1|2|3`，轮换别名重跑、去重合并、`[K/N RUNS]` 稳定性标注；仅 vote+debate 有意义；成本 ×N。
- P3-B 模型分级（PAL MCP）：ModelConfig 增可选 `tier?: number`；admin 排序展示 **[待 Q3：是否参与 auto 兜底推荐]**。
- P3-C provider preset（如 ollama 本地一键配置）：独立小项。

## Acceptance Criteria（P2 部分，P3 视拍板补充）

- AC1: 显式 cards 传参行为与现状逐字节一致；不传参数行为与现状一致（默认卡回退）。
- AC2: 触发 auto 后，含信号关键词的 topic 命中对应卡；中英文词表均可命中；零命中回退默认卡且报告注明。
- AC3: signals 校验：非法标签值被 zod 拒绝；缺省不出键；旧 experts.json 直接加载。
- AC4: 禁用工具后 tools/list 不含该工具；核心工具禁用请求被拒绝；默认行为不变。
- AC5: admin CardsPage 可编辑 signals 并正确落盘。
- AC6: `npm test` 全过 + typecheck + admin-web build 通过。

## Out of Scope

- reasoningStrategy 之外的 prompt 结构变更；records 格式变更；followup 的 auto 选卡（本轮）。

## 待拍板问题

- Q1: auto 选卡触发方式（新参数 `select:"auto"` vs cards 魔法值）+ 工具开关载体（config 字段 vs env）。
- Q2: P3 范围：仅 P2 / +P3-B tier / P3 全做。
- Q3: tier 是否参与 auto 选卡兜底排序（仅展示 vs 展示+兜底加权）。
