# PRD: 辩论反锚定与论据锚定（blind seed + claim-0 + 论据化投票）

## Goal / 用户价值

抑制 brainstorm 辩论的两大失败模式：**(a) 趋同退化**——多数票变成回声而非独立判断；**(b) 发起方锚定**——专家把调用方（主理 AI）的内容当权威上下文复述。落地 2026-09-26 文献调研结论（`research.md`）：给信念更新注入修正信号（论据/来源），发起方内容降级为可推翻的 claim-0，投票标准论据化。

## 背景与已确认事实

- 研究依据：`research.md`（核心：Debate-or-Vote 鞅定理——无论据修正信号的辩论不提升期望正确率；MAST 收录谄媚附和与初始锚定；ReConcile 论据化投票显著更优）。
- 现状基线（2026-09-26 代码核对）：
  - `src/tools/brainstorm.ts:88`：`BrainstormArgs` 只有单一 `topic`，**无 context 参数**——调用方的初步分析只能混进 topic，专家天然把它当背景事实。
  - `src/orchestrator/parallel.ts:45`：`buildTargetMessages` 把 `consult_experts.context` 渲染成 **"背景信息:\n…"**（权威背书框架）。
  - `src/orchestrator/dialogue.ts:138-157`：`SEED_INSTRUCTION`（只要"观点与理由"）、`DEBATE_INSTRUCTION`（未要求点名对方论据）、`VOTE_INSTRUCTION`（只要求"最认同"+理由，≤150 字、禁自投）。
  - 首轮为并行独立盲答结构（seed round），别名制 + aliasRotation + 禁自投已就位。
  - 用户已拍板：Q1=A（建任务，P1→P2 范围；P3 不做）。

## Requirements

### P1 反锚定（blind seed + claim-0）

- R1：`brainstorm` 新增可选 `context` 参数（发起方初步分析/背景）。缺省时行为与现状一致（指令文案升级除外，见 D4）。
- R2：debate 模式下 **blind seed**——第 1 轮各专家 prompt 只含 topic，**不含 context**（独立盲答）。
- R3：debate 模式第 ≥2 轮，context 以 **claim-0 块**注入（标注：主理 AI 初步判断、可能有误、欢迎推翻、不是专家、不参与投票）；置于发言实录之前。语义压缩路径（buildInjection）同样包裹。
- R4：relay 模式下 context 以 claim-0 块随每轮 prompt 注入（无盲答——relay 首位发言者需要背景）。
- R5：`consult_experts` 的 context 注入文案从"背景信息:"改为 claim-0 框架（"主理 AI 提供的初步分析（可能有误，请独立判断，欢迎质疑）"）。
- R6：报告展示——`formatBrainstormReport` 新增「发起方初步判断（claim-0）」小节，仅在提供 context 时出现；标注其未参与盲答轮与投票。

### P2 论据锚定（指令层）

- R7：`SEED_INSTRUCTION` 升级：要求"核心主张 + 依据（尽量给可验证来源：代码位置/文档/数据/实测/案例）+ 明确不确定点"；附防锚定句（topic 可能含发起方倾向，须独立判断）。
- R8：`DEBATE_INSTRUCTION` 升级：质疑/反驳必须点名对方的具体论据；新增己方论据须给来源；无依据观点须标注为推测。
- R9：`VOTE_INSTRUCTION` 升级：评判标准 = 论据质量与可验证性；理由必须引用被投者的一条具体论据；保留禁自投、150 字限长、一句话说明立场是否修正。
- R10：`SUMMARIZER_SYSTEM` 增补无共识条款：票数分裂或论据冲突未解时，明确输出「无共识」并列分歧点与各方论据强度，**不得强行归并多数意见**。

## Acceptance Criteria

- [ ] AC1: `brainstorm` schema 含可选 `context`（zod + describe 说明 claim-0 语义）；不传时工具输出结构与现状一致（指令文案升级除外）。
- [ ] AC2: debate + context 时，第 1 轮各专家 prompt 不含 context 文本；第 2 轮起 prompt 含 claim-0 块且块内含"可推翻/不参与投票"语义（mock adapter 捕获 prompt 断言）。
- [ ] AC3: relay + context 时各轮 prompt 含 claim-0 块。
- [ ] AC4: `consult_experts` 带 context 时，user prompt 使用新 claim-0 框架文案（断言不再出现"背景信息:"标签）。
- [ ] AC5: claim-0 不可被投票：`parseVotedForAlias` 不变（claim-0 无 专家[A-Z] 别名）；VOTE_INSTRUCTION 明示非候选人。
- [ ] AC6: 报告含 claim-0 小节（仅 context 存在时）；vote 明细照旧。
- [ ] AC7: 指令常量（SEED/DEBATE/VOTE/SUMMARIZER）文案按 R7-R10 落地，相关快照/断言测试同步更新。
- [ ] AC8（best-effort）: 真实 LLM 跑一次 brainstorm（context 含明显倾向性初步判断 + vote），核验：首轮盲答未见 context、第二轮出现质疑 claim-0、票文引用具体论据；证据存 `ac8-after-run.md`。
- [ ] AC9: `npm test` + `npm run typecheck` 全绿；admin-web 无改动则不强制 build。

## Key Decisions

- D1: 范围 = P1 + R7-R10（用户 Q1=A）；**不做**：投票加权/校准（ReConcile 式）、检索证据接入（MADRA）、查证轮/强制魔鬼代言人（P3）、rounds 默认值调整、followup 接 context。
- D2: 盲答仅 debate 模式；relay 保持首发言者可见 context。
- D3: claim-0 无别名、不可被投——解析层零改动，只靠 VOTE_INSTRUCTION 明示。
- D4: 指令文案升级对所有会话生效（这正是任务目的，同 vote-prompt-fix 先例）；"缺省行为一致"红线指**结构**（prompt 组装形状）不变，不含文案字节。
- D5: 依据来源标注为"尽力而为"（best-effort），不做程序化论据校验（MCP 工具调用式证据属 P3+）。

## Out of Scope

- 投票权重/历史校准、检索工具接入、查证轮、强制 devil's advocate、admin-web、experts.json 结构、followup/relay 语义变更（claim-0 注入除外）。
