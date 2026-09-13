# PRD Draft: 议事质量与透明度增强（council-enhancement）

> 状态：**草案**（研究已收敛，待用户批准后转正式任务并细化验收标准）。
> 研究依据：`research/competitor-deep-dive.md`（2026-09-13 tavily 深抓）。
> 原则：全部新增参数均为 optional，MCP 工具向后兼容；不破坏 experts.json 现有结构（新字段全部可选）；功能零回归。

## Goal

把 5 个同类项目验证过的机制吸收进本项目的议事链路：让投票可复盘（透明落盘）、让专家观点差异化（推理策略）、让选卡自动化（信号路由），并在成本与上下文上给用户控制权。

## 现状基线（写方案前已核对代码）

- `src/tools/brainstorm.ts`：debate/relay、rounds≤5、匿名互评 vote（仅 debate）、judgeCard 裁决。
- `src/orchestrator/dialogue.ts`：runDialogue、匿名别名（专家A/B/…）、vote 汇总进报告。
- `src/records/store.ts`：JSONL 事件（cards / card_result / finish），**无 vote 事件**。
- `src/tools/select-cards.ts`：显式卡列表或 enabled 默认卡，无内容感知。
- `src/providers/adapter.ts`：chat 非流式 + thinkingLevel；registry 有 openai/anthropic/openai-compatible/mock。
- admin-web：7 页管理台 + Records 查看 + Chat。

## 改造项

### P1-A 投票透明化：投票理由落盘 + 报告结构化（来源：council-of-mine）

- **现状**：vote 环节结果只以文本汇入综合报告；records 无投票痕迹，Records 页无法复盘「谁投了谁、为什么」。
- **改动**：
  1. `dialogue.ts` vote 环节产出结构化结果：`{ alias, votedFor, reason }[]`（匿名别名保持，落盘时同时记录 cardId 映射供 admin 内部显示）。
  2. `records/store.ts` 新增事件类型 `vote`：`{ type: "vote", round, votes: { voterCardId, votedForAlias, reason }[] }`，在 brainstorm 主流程 finish 前追加。
  3. 报告新增「投票明细」小节：每票一行（投票者别名 → 被投别名 + 理由摘录）。
  4. admin Records 页（SessionDetailView）渲染 vote 事件。
- **涉及**：`src/orchestrator/dialogue.ts`、`src/records/store.ts`、`src/tools/brainstorm.ts`、`admin-web/src/pages/RecordsPage.tsx`、`test/consult-brainstorm.test.ts`。
- **验收**：开 vote 的 brainstorm 会话 JSONL 含 vote 行；Records 页可见票与理由；不开 vote 时无 vote 行（零行为变化）。

### P1-B 差异化推理策略（来源：agent-review-panel）

- **现状**：所有专家用同一套 prompt 模板，观点同质化无机制约束。
- **改动**：
  1. `src/types.ts` `ExpertConfig` 增可选字段 `reasoningStrategy?: "systematic" | "adversarial" | "backward" | "default"`（缺省 default，旧行为不变）。
  2. `dialogue.ts` / `consult-experts.ts` 构建 system prompt 时按策略追加一段固定指令（策略文案表集中在常量，便于测试与后续扩展）。
  3. admin ExpertEditPage 增下拉选择（默认「不指定」）。
- **涉及**：`src/types.ts`、`src/config.ts`（zod schema 同步可选校验）、`src/orchestrator/dialogue.ts`、`src/tools/consult-experts.ts`、`admin-web/src/pages/ExpertEditPage.tsx`。
- **验收**：strategy=adversarial 的专家 prompt 含对抗指令；缺省专家 prompt 与改造前逐字节一致（快照断言）。

### P2-A 信号路由自动选卡（来源：agent-review-panel）

- **现状**：选卡只能显式传 id 或落回默认卡，与「问题内容」无关。
- **改动**：
  1. `CardConfig` 增可选 `signals?: string[]`（标签，如 sql / security / frontend / cost / infra）。
  2. `select-cards.ts` 增 `auto` 语义：工具参数 `cards` 传 `["auto"]`（或新增 `select?: "auto"`）时，按 topic 关键词匹配信号组选卡（关键词→信号映射表内置常量，可后续外置）。
  3. 匹配不到时回退现有默认卡逻辑并在报告注明。
  4. admin CardsPage 支持编辑 signals 标签。
- **涉及**：`src/types.ts`、`src/tools/select-cards.ts`、`src/tools/consult-experts.ts`、`src/tools/brainstorm.ts`、`admin-web/src/pages/CardsPage.tsx`。
- **验收**：topic 含技术关键词时 auto 命中对应卡；无命中回退默认；显式 cards 传参行为不变。

### P2-B 按工具开关（来源：PAL MCP）

- **改动**：config（或 env `TALKIO_TOOLS`）支持禁用非核心工具；`list_cards` 与三个核心工具不可禁用。默认全开。
- **涉及**：`src/config.ts`、`src/server.ts`。
- **验收**：禁用后 tools/list 不含目标工具；默认行为不变。

### P3-A 多轮运行取并集 + 稳定性标注（来源：agent-review-panel，可选高成本）

- **改动**：brainstorm 增 optional `runs?: 1|2|3`（默认 1）：轮换匿名别名重跑 N 次，结论去重合并，报告标注 `[K/N RUNS]` 稳定性。仅在 vote+debate 下有意义。
- **验收**：runs>1 时报告含 N 次聚合与稳定标注；默认 1 时零开销。

### P3-B Provider 广度与模型分级（来源：PAL MCP / mcp-ai-hub）

- **改动**（按需子项，做前再细化）：
  1. ModelConfig 增可选 `tier?: number`（智力分级），CardsPage/ModelPicker 按 tier 排序展示与默认推荐。
  2. 视需求增加 provider preset（如 ollama 本地端点一键配置）或原生 gemini adapter。
- **验收**：tier 仅影响展示排序；现有 provider 测试全过。

## 路线图与依赖

- **P1（P1-A + P1-B）**：纯增量、低风险，records/类型层小改，先行。
- **P2（P2-A + P2-B）**：依赖 P1-B 的类型扩展先行合入（signals 同为可选字段）。
- **P3**：独立可选项，按使用反馈决定是否做。

## Out of Scope（本轮确认不做）

- MCP sampling 模式（客户端持模型架构，与服务端持 key 的定位冲突）。
- agent 间协调基础设施（brainstorm-mcp 赛道，已归档）。
- 多 Provider 运行时热切换 / LiteLLM 式全量接入。

## 风险

- vote 事件落盘改变 JSONL schema：admin Records 需容忍未知事件类型（现有渲染按 type 分支，需确认对未知 type 的容错）。
- reasoningStrategy 注入 prompt 会改变 LLM 输出（预期内），但缺省路径必须逐字节不变，防止隐性行为回归。
- auto 选卡关键词匹配中文/英文混合语料命中率需用真实 topic 样本验证。
