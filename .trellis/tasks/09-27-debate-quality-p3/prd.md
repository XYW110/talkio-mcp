# PRD: 辩论质量 P3（魔鬼代言人轮换 + 票文解析强化）

## Goal / 用户价值

三项编排级辩论质量增强（用户 Q1=A / Q2=A 拍板）：**(a) 魔鬼代言人轮换**——每轮强制一名专家做最强反驳，零新增 LLM 调用给辩论注入修正偏置（Debate-or-Vote 鞅定理的反面操作）；**(b) 裸代号票文解析**——票文写 "B" 也能识别为 专家B，消除 vote-prompt-fix 遗留缺陷；**(c) 自投显式标记**——只提及本人别名的票文显式标为"自投（无效票）"，不再与"未识别"混同，让自投复发可见。

## 背景与已确认事实

- 文献依据：`research.md`（MAD 对抗角色、Debate-or-Vote 修正偏置、ChatEval 异质角色；裸代号缺陷与自投复发各有真跑证据）。
- 现状基线（2026-09-27 代码核对）：
  - `parseVotedForAlias`（`src/orchestrator/dialogue.ts:234`）只匹配 `/专家[A-Z]/g`，1 个调用点 + 测试。
  - `VoteBallot`（dialogue.ts:124）四字段，无自投信息；投票明细在 `formatBrainstormReport`（`src/utils/format.ts:152+`），未识别显示"（未识别代号）"。
  - vote-prompt-fix 后真跑零自投，但 09-26 真跑自投复发 1 例 → 显示为"未识别代号"，质量问题被掩盖。
  - 魔鬼代言人现状：仅有按专家静态配置的 `reasoningStrategy=adversarial`（P1-B），无按轮动态角色。
- 用户已拍板：Q1=A（三项打包）、Q2=A（轮换魔鬼代言人，非独立查证轮）。

## Requirements

### R1 魔鬼代言人轮换（debate 模式）

- 第 ≥2 内容轮，每轮指定恰一名专家：`targets[(round-2) % targets.length]`（确定性轮换）。
- 该专家当轮 prompt 在 `DEBATE_INSTRUCTION` 之后追加 `DEVILS_ADVOCATE_INSTRUCTION`（新常量）：强制找出前轮最薄弱论据（含 claim-0）做最强质疑/最坏情形分析，即使个人认同；点名具体论据给依据；反驳后照常给出修正立场。指令用"你"称呼，不引入真名（匿名安全）。
- 第 1 轮（盲答 seed）、relay 模式、投票轮：**不注入**。
- `DialogueResult` 增 `devilsAdvocates?: Array<{round, expertId, expertName}>`；`formatBrainstormReport` 据此渲染「魔鬼代言人轮换」小节（缺省零字节）；`handleBrainstorm` 透传。

### R2 裸代号票文解析

- `parseVotedForAlias` 两级匹配：先 `/专家([A-Z])/g`（现状优先）；无命中时回退扫描**独立大写字母**（前后均非 `[A-Za-z0-9]`，lookbehind/ahead），映射 `专家${字母}` 且必须落在 knownAliases 内；同样跳过投票者本人别名。
- 防误报硬性要求：`API`/`QPS`/`OWASP` 等连续拉丁词不误判（邻接字母数字排除）；不在已知别名集合的字母（如 3 卡场景的 "N=10" 的 N）不误判。
- `isSelfVoteBallot(content, voterAlias, knownAliases): boolean`（新导出）：票文提及了本人别名（全称或裸代号）且未提及任何其他已知别名 → true。

### R3 自投显式标记

- `VoteBallot` 增可选 `selfVote?: boolean`（true 时落 JSONL vote 事件与结构化结果，additive；admin 端未知字段容错已有保障）。
- 投票明细渲染三态：正常（字节不变）/ `selfVote` → "⚠️ 自投（无效票）" / 其余空串 → "（未识别代号）"（现状）。
- `VOTE_INSTRUCTION` 文案**不变**（禁自投已明示，复发属模型波动，本任务只做可见性）。

## Acceptance Criteria

- [ ] AC1: 裸代号解析——"我投B"/"投给B。"/"B 的论据最强" 识别为 专家B；"API 网关"/"QPS"/"AB 组合" 不误判；全称匹配优先于裸代号；本人别名跳过逻辑不变。
- [ ] AC2: 自投标记——只提本人别名的票文 `selfVote=true`，报告显示"⚠️ 自投（无效票）"；vote 事件含该字段；正常票文渲染与现状逐字节一致。
- [ ] AC3: 魔鬼代言人——debate rounds=3 两卡：第2轮 prompt（target0）含指令、第3轮 prompt（target1）含指令、其余专家同轮 prompt 不含、第1轮/relay/投票轮均不含；指令常量不含真名。
- [ ] AC4: 报告「魔鬼代言人轮换」小节按轮列出专家名；无 devil 信息时（relay / 旧路径）零输出。
- [ ] AC5: 回归——claim-0 注入矩阵、runs=1 等价、匿名化、投票轮注入等既有结构断言全绿；本任务不改动 SEED/DEBATE/VOTE/SUMMARIZER 四常量文案。
- [ ] AC6: 真实 LLM 验证 best-effort——debate rounds=2 + vote 真跑：报告含轮换小节、当轮指定专家发言呈强质疑形态、无崩溃；票文若出现裸代号则解析生效（不强制出现）；证据存 `ac6-after-run.md`。
- [ ] AC7: `npm test` + `npm run typecheck` 全绿。

## Key Decisions

- D1: 魔鬼代言人默认开启（debate 模式 rounds≥2 恒生效）——与指令文案升级同类：行为变更即任务目的；round 1 / relay 字节红线不变。
- D2: 角色按 targets 索引轮换（实名概念，实录本就实名；runs>1 时每轮同一 targets 位次，确定性）。
- D3: 解析层只做**可见性**（标记/识别），不改计票口径——vote 本就无计票逻辑，赢家由报告呈现。
- D4: 加权投票 / MADRA 检索明确排除（缺校准信号/证据源，见 research.md）。

## Out of Scope

- 投票加权、检索证据、relay 魔鬼代言人、独立查证轮、admin-web 渲染改造（字段 additive 即可）、四指令常量文案改动、followup。
