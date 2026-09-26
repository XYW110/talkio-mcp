# PRD: SP 二阶聚合 + 证据锚定协议（brainstorm）

## Goal / 用户价值

两项编排级增强（用户 Q1=A / Q2=A 拍板），分别对症"少数服从多数=回声"与"论据无据可查"：

- **方案 A（SP 聚合）**：投票轮引入二阶信息——每位专家投票时同时预测其他专家的票分布，用 Surprisingly Popular 算法（实际得票率 − 预测得票率的 argmax）选出 SP 赢家。从众多数是"被预期到的多数"（超额支持≈0），被低估的知情少数派候选者会被 SP 选中——报告双轨呈现多数赢家与 SP 赢家，**两者分歧本身即趋同警报**。零新增 LLM 调用。
- **方案 B（证据锚定）**：`brainstorm` 新增 `evidence` 参数（调用方提供的证据包，编号 E1..En），每轮以「可引用证据库」块注入，专家引用须标注 `[E1]`；报告输出证据引用统计（per-expert [En] 扫描）。MCP 场景中调用方 AI 就是检索层；本地检索/向量库明确排除（文件访问安全边界需单独评审）。

## 背景与已确认事实

- 文献依据：`research.md`（SP/Prelec 2017、多 LLM 版 ISP/OW、CISC/MARGIN 置信度加权作对照、PROClaim/DebateCV/FC-MAD 证据辩论、"why crowd wisdom fails" 的有限选项前提——恰好被互评投票满足）。
- 现状基线（2026-09-27 代码核对）：
  - `VOTE_INSTRUCTION`（dialogue.ts）要求单选别名 + 理由引用论据 + 禁自投 + 150 字限长；`parseVotedForAlias`/`isSelfVoteBallot`/`collectAliasMentions` 已就位（P3）。
  - 报告链：`formatBrainstormReport` 已有 claim-0 小节、魔鬼代言人轮换小节、投票明细三态（P1/P3 产物）。
  - `brainstormSchema` 已有 `context`（claim-0），**无 evidence 参数**。
- 用户已拍板：Q1=A（两方案一个任务）、Q2=A（缺预测票优雅降级）。

## Requirements

### R1 SP 二阶聚合

- R1.1: `VOTE_INSTRUCTION` 增二阶预测行要求（预测其他专家各投给谁，不含自己；保留既有禁自投/150 字/论据引用/立场修正约束）。
- R1.2: 选票解析析出 `predictions: string[]`（按"预测"标记分割投票段与预测段；预测段内收集已知别名、排除本人；无标记 → predictions 为空）。
- R1.3: `VoteBallot` 增可选 `predictions?: string[]`；JSONL vote 事件透传（additive）。
- R1.4: 纯函数 `surprisinglyPopular(votes, predictionsPerVoter, knownAliases)`：对每个候选者计算 实际得票率 − 跨预测者平均预测得票率，取最大者；**Q2=A 降级规则**——缺预测的票计入实际得票但不参与预测均值；可解析预测 <2 份 → 返回 null（不输出 SP）；并列最大 → null。
- R1.5: 报告「聚合结果」双轨三态：SP 与多数一致 / 分歧（标注趋同警报语义）/ 未计算（预测不足）；`DialogueResult` 增 `spWinner?: string`，JSONL vote 事件顶层 additive 字段（仅计算成功时写键）。

### R2 证据锚定

- R2.1: `brainstormSchema` 增 `evidence: z.array(z.string()).optional()`（每项为一条证据：代码片段/数据/文档引文/实测输出）。
- R2.2: 注入块 `buildEvidenceLibrary(evidence)`：编号 `[E1]`..`[En]`，含引用纪律行（"引用证据请标注编号如 [E1]；证据可能不完整或有误，发现矛盾请明确指出"）；单条截断 2000 字符、总量截断 8000 字符（超限加省略）；空/纯空白项跳过；无 evidence → 零字节。
- R2.3: 注入范围：debate 第 1 轮（seed）+ 第 ≥2 轮、relay 各轮（证据是共享事实基底，区别于 claim-0 的"可推翻主张"，从首轮可见）；投票轮不注入。
- R2.4: `formatBrainstormReport` 增「证据引用统计」小节：正则扫描首轮实流 turns（runs>1 取 first）中的 `[En]` 引用，按专家列出引用的 E 编号与计数；无 evidence 或零引用 → 零输出。
- R2.5: `SEED_INSTRUCTION` / `DEBATE_INSTRUCTION` / `SUMMARIZER_SYSTEM` 文案**不变**（引用纪律由证据块自带）；`VOTE_INSTRUCTION` 本任务允许变更（R1.1 + 增"论据若基于证据库请标注编号"一句）。

## Acceptance Criteria

- [ ] AC1: `evidence` 参数解析正确（zod；字符串数组；可缺省）；提供时 debate seed/debate ≥2/relay 各轮 prompt 含证据库块与编号；无 evidence 时所有 prompt 组装逐字节不变。
- [ ] AC2: 证据块纪律——编号格式 `[E1]`、单条/总量截断、空项跳过、块内含引用纪律行与"可能有误"语义；证据块不进 `DialogueTurn`、不参与匿名化；经 redactPII 出站。
- [ ] AC3: 选票预测解析——"预测"标记分割正确；预测段排除本人别名；无标记票 predictions 为空；`predictions` 落 JSONL（additive，仅非空写键）。
- [ ] AC4: SP 纯函数——经典例子（知情少数派被多数低估 → SP 选中少数派）通过；n=2 / 并列 / 预测 <2 → null；`devilsAdvocate` 式确定性。
- [ ] AC5: 报告聚合三态渲染正确（一致/分歧含警报语义/未计算）；`spWinner` 仅计算成功时落 JSONL。
- [ ] AC6: 报告证据引用统计——多专家引用不同编号时 per-expert 列表正确；无 evidence/零引用零输出。
- [ ] AC7: 回归——claim-0/魔鬼代言人/自投/裸代号/runs=1 等既有断言全绿；SEED/DEBATE/SUMMARIZER 文案零改动。
- [ ] AC8: 真实 LLM 验证 best-effort——evidence 包 + vote 真跑：证据库渲染、turns 中 [En] 引用出现、预测行出现、SP 计算或降级路径正确；证据存 `ac8-after-run.md`。
- [ ] AC9: `npm test` + `npm run typecheck` 全绿。

## Key Decisions

- D1: SP 仅在互评投票（有限选项集）上使用——文献前提（crowd-wisdom 方法需有限选项）恰好满足；不做开放题 SP。
- D2: Q2=A 降级语义固化：多数赢家恒有定义；SP 赢家是附加信号而非替代——共识判断仍以报告综合呈现。
- D3: 证据库 ≠ claim-0：证据是共享事实基底（首轮可见、非立场），claim-0 仍是"可推翻主张"（debate ≥2 轮、不可投票）——两者的认识论地位在块内文案中显式区分。
- D4: 证据引用统计是客观正则扫描（[En]），不做语义级"论据↔证据"抽取（不可靠且超编排层职责）。
- D5: 本地文件检索/向量库/RAG 明确排除，待独立安全评审。

## Out of Scope

- consult_experts 的 evidence 参数、本地检索/向量库、语义论据抽取、admin-web 渲染、experts.json 结构、置信度加权（CISC/MARGIN 路线——口头置信度校准性差，SP 二阶信息优先）、followup。
