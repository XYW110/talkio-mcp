# PRD: brainstorm 议事质量包（互评投票 + 匿名互评 + 裁决者）

## Goal / 用户价值

提升 brainstorm 多专家议事的结论质量：当前 debate 模式的综合阶段由第一张卡凭 transcript 单方面总结，缺乏相互评价与仲裁依据；专家互看发言时能看见卡名/专家名，可能产生对知名模型或特定角色的身份偏置。借鉴 block/mcp-council-of-mine（投票环节）与 llm-council（匿名互评）的验证有效机制，为议事流程加入三个增强。

## Requirements

- R1（互评投票）：brainstorm 新增可选参数 `vote?: boolean`（默认 false，仅 debate 模式生效）。开启时，在全部内容轮结束后、综合之前插入一轮互评投票：每位专家基于完整 transcript 写出"最认同哪位专家（代号）的观点 + 理由"。投票文本作为综合阶段的输入依据之一，并在报告中以独立段落呈现。
- R2（匿名互评）：debate 第 2 轮起的 transcript 注入与投票轮注入，将专家身份替换为代号（专家A/B/C…，按 targets 顺序），并隐藏 icon；但每位专家自己的历史发言需标注"这是你的发言（代号X）"，使其能延续自身立场。
- R3（裁决者）：brainstorm 新增可选参数 `judgeCard?: string`（单张卡 id）。提供且有效时，综合调用改用该卡（替代现状的"第一张卡"）；该卡若同时出现在 targets 中，先从议事 targets 中剔除（避免既下场辩论又仲裁）；judgeCard 无效（不存在/禁用/无 key）时回退到第一张卡并在报告中注明。
- R4（记录与流式）：投票轮写入会话记录（新增 `vote` 事件类型），通知器发出 vote 粒度事件；admin-web RecordsPage 对未知事件类型不崩溃。
- R5（零回归）：`vote`/`judgeCard` 均缺省时，行为与现状完全一致；relay 模式不支持投票（忽略 vote 参数）。

## Acceptance Criteria

- AC1: `vote: true` + debate 模式下，报告含"互评投票"段落，每位专家一条投票，综合前注入投票摘要。
- AC2: 第 2 轮及投票轮的 prompt 中不出现 expertName/icon 原文，出现代号；own turn 标注可识别。
- AC3: `judgeCard` 指向有效卡时，报告标注裁决者卡名，且该卡不参与议事轮；无效时回退第一张卡并注明。
- AC4: records JSONL 出现 `vote` 事件行；RecordsPage 打开含 vote 事件的记录不报错。
- AC5: 两个新参数缺省时，现有测试（consult-brainstorm / orchestrator）全部不变通过。
- AC6: `npm test` 全量通过，新增单测覆盖 VOTE_INSTRUCTION、匿名化、judgeCard 回退。

## Key Decisions（用户已拍板）

- D1: 三个增强打包为同一个任务（改动集中在 src/orchestrator/dialogue.ts + src/tools/brainstorm.ts）。
- D2: 投票为显式 opt-in 参数，不改变默认流程。
- D3: 匿名化应用于所有轮间注入（含 round 1 之后每轮），不只投票轮。

## Out of Scope

- 不做多 run 合并、分歧点结构化输出、服务端会话 sessionId（其他 backlog）。
- 不改 admin-web 交互（除 RecordsPage 对 vote 事件的容错渲染）。
- 不做投票的确定性计票/打分（MVP 只透传文本投票给综合阶段）。
