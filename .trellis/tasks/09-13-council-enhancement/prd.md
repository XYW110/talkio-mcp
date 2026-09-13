# PRD: 议事质量与透明度增强 P1（council-enhancement）

## Goal / 用户价值

让 brainstorm 的互评投票可复盘（结构化落盘 + 报告明细 + admin 可视化），并从机制上抑制专家观点同质化（可选推理策略注入 prompt）。范围锁定 P1（投票透明化 + 推理策略）；P2/P3 见 `prd-draft.md`，本轮不做。

## 背景与已确认事实

- 研究依据：`research/competitor-deep-dive.md`（2026-09-13 tavily 深抓 5 个同类项目）。
- 现状基线（已核对代码）：
  - `src/tools/brainstorm.ts`：debate/relay、rounds≤5、匿名互评 vote（仅 debate 生效）、judgeCard 裁决。
  - `src/orchestrator/dialogue.ts`：runDialogue、匿名别名（专家A/B/…）、vote 结果目前仅以文本汇入报告。
  - `src/records/store.ts`：JSONL 事件（cards / card_result / finish），**无 vote 事件**。
  - `src/types.ts` / `src/config.ts`：ExpertConfig 无策略字段。
- 用户已拍板：Q1=A（仅 P1）、Q2=A（vote 事件按轮聚合，每轮一条）。

## Requirements

- R1（投票透明化，来源 council-of-mine）：
  - vote 环节产出结构化结果：每票 `{ voterCardId, votedForAlias, reason }`。
  - records 新增 `vote` 事件：**每轮一条**，`{ type: "vote", round, votes: [...] }`，在 finish 前追加。
  - 报告新增「投票明细」小节（投票者别名 → 被投别名 + 理由摘录）。
  - admin Records 页 SessionDetailView 渲染 vote 事件，且对未知事件类型容错。
- R2（差异化推理策略，来源 agent-review-panel）：
  - `ExpertConfig` 增可选 `reasoningStrategy?: "systematic" | "adversarial" | "backward" | "default"`（缺省 default）。
  - 策略指令文案集中为常量表；consult-experts 与 brainstorm 的 system prompt 构建按策略追加；default 与现路径**逐字节一致**。
  - config zod schema 同步校验（可选枚举）；admin ExpertEditPage 增下拉（默认「不指定」）。
- R3（兼容性红线）：MCP 工具参数不变；experts.json 旧结构不动（新字段全可选、缺省行为不变）；不开 vote 的会话 JSONL 无 vote 行。

## Acceptance Criteria

- AC1: 开 vote 的 brainstorm 会话 JSONL 每轮含一条 vote 事件，字段完整（round/votes[].voterCardId/votedForAlias/reason）。
- AC2: 报告含「投票明细」小节；不开 vote 时报告与改造前一致。
- AC3: admin Records 页能渲染 vote 事件；未知事件类型不报错。
- AC4: strategy=adversarial/systematic/backward 的专家 prompt 含对应指令；缺省专家 prompt 与改造前逐字节一致（快照断言）。
- AC5: ExpertEditPage 可设置/清空策略，保存后 experts.json 落盘正确。
- AC6: `npm test` 全过 + `npm run typecheck` + `npm --prefix admin-web run build` 通过。

## Key Decisions（用户已拍板）

- D1: 范围仅 P1（Q1=A）；P2 信号路由/工具开关、P3 runs 并集/模型分级后续再议。
- D2: vote 事件按轮聚合，每轮一条（Q2=A）。
- D3: 投票匿名性分级——MCP 报告用别名（专家A→专家B）；admin 面向运维者展示真实卡名（经 voterCardId 反查，与 turn/card_result 行的可见级别一致）；JSONL 内 voterCardId 供映射。（2026-09-13 实现后按实际展示层级修订措辞）

## Out of Scope

- MCP 工具入参变更、P2/P3 全部条目、MCP sampling 模式、agent 间协调基础设施。
