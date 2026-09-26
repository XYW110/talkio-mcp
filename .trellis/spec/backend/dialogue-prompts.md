# Dialogue Prompts & Claim-0 Convention

辩论/咨询路径的 prompt 组装契约。来源：09-26-debate-evidence-grounding（文献依据见该任务 `research.md`——Debate-or-Vote 鞅定理、MAST 谄媚/锚定失败模式、ReConcile 论据化投票）。

## claim-0 三语义（不可破坏）

凡"发起方（主理 AI/调用方）提供的内容"进入专家 prompt，必须保持三条语义，常量在 `src/orchestrator/dialogue.ts`（`CLAIM0_HEADER` / `CLAIM0_NOTE` / `buildClaim0Block`）：

1. **盲答隔离**：debate 模式第 1 轮（seed round）prompt 绝不含 context——独立首轮是辩论有效性的前提（Du et al. ICML 2024）。relay 模式例外（首位发言者需要背景）。
2. **可推翻标注**：claim-0 注入时必须带"可能有误、欢迎质疑、推翻"语义，置于发言实录之前；它不是专家发言。
3. **不可投票**：claim-0 无 `专家[A-Z]` 别名（`parseVotedForAlias` 天然不可命中）。09-27 起 `VOTE_INSTRUCTION` 重写（SP 预测行）后不再显式点名 claim-0——排除依靠结构保证（块头无别名 + 解析白名单），故 **claim-0 块头/证据库块头禁止使用「专家X」或独立大写字母形态**。不得给 claim-0 分配别名或构造 `DialogueTurn`。

## 注入矩阵（prompt 组装形状）

| 路径 | context 处理 | 组装点 |
| --- | --- | --- |
| debate round 1 | 不注入（盲答） | `runDialogue` seed 分支 |
| debate round ≥2 | claim-0 前置于注入块（压缩/非压缩同一包裹点，`resolveRenderer` 返回值使用处） | `runDialogue` |
| relay 各轮 | claim-0 随 topic 注入（无盲答） | `runDialogue` relay 分支 |
| 投票轮 | 注入内容不变 | `runDialogue` vote 段 |
| consult | 标签固定为"主理 AI 提供的初步分析（可能有误，请独立判断，欢迎质疑）:" | `buildTargetMessages` |

## 魔鬼代言人轮换（P3）

- debate 模式第 ≥2 内容轮，每轮**恰一名**专家在 `DEBATE_INSTRUCTION` 之后追加 `DEVILS_ADVOCATE_INSTRUCTION`：轮换公式 `targets[(round-2) % targets.length]`（纯函数 `devilsAdvocateIndex`，可测）。
- 指令用「你」称呼、不含真名/代号——匿名安全，anonymize 路径无需触碰该常量。
- 语义：强制最强反驳（即使个人认同），点名具体论据给依据，反驳后照常给出修正立场——编排层的"修正偏置"（Debate-or-Vote 鞅定理的对策）。
- round 1（盲答）、relay、投票轮：**零注入**。`DialogueResult.devilsAdvocates` → 报告「### 魔鬼代言人轮换」小节（缺省零字节）。

## 票文解析契约（P3）

- 两级匹配（共享 helper `collectAliasMentions`，单一正则来源，禁止两套实现漂移）：
  1. 全称优先：`/专家([A-Z])/g`；
  2. 回退：独立大写字母 `/(?<![A-Za-z0-9])([A-Z])(?![A-Za-z0-9])/g`，映射 `专家${字母}` 且必须 ∈ knownAliases；两级均跳过投票者本人。
- 误报防护 = 邻接字母数字排除（API/QPS/AB/OWASP 不命中）+ 别名白名单（3 卡时 "N=10" 的 N 不命中）。已知限制："A/B 测试" 这类斜杠单字母在 2 卡场景会命中（PRD 未要求防护）。
- 自投可见性：`isSelfVoteBallot`（提及本人别名且无其他别名）→ `VoteBallot.selfVote: true` → 报告 "⚠️ 自投（无效票）" + JSONL vote 事件 additive 字段（仅 true 写键）。解析层只做可见性，不做计票。
- 预测段分割（09-27 SP）：`splitBallotPrediction` 只发生在 ballot 组装层——优先 `预测[：:]`（全半角容错），回退行首「预测」；`parseVotedForAlias`/`isSelfVoteBallot` 只消费投票段，签名与语义不变。预测段复用 `collectAliasMentions`，排除本人、去重保序 → `VoteBallot.predictions`（仅非空写键，JSONL additive）。已知限制：句中「预测：」会被误分割（指令为软约束、按标记容错，接受）；预测段为**去重集合**而非加权分布——份额 = 1/列表长度，对 ≤3 专家精确，≥4 专家丢失多重性。**09-27 真跑实际发生**：模型复述投票指令时含「预测：」字样触发提前分割 → 真实投票语句落入预测段 → 票面"未识别"（解析层如实暴露、未静默误归）。改进候选：取**最后一个**预测标记（指令规定预测行为最后一行）或强制行首匹配。

## 证据库与 SP 二阶聚合（09-27-sp-evidence-aggregation）

- **证据库块**（`buildEvidenceLibrary`/`EVIDENCE_LIBRARY_HEADER`/`EVIDENCE_LIBRARY_NOTE`）：`evidence: z.array(z.string()).optional()`，编号 `[E1]..[En]` 按传入顺序、纯空白项跳过（不占编号）；单条截断 2000、条目区总量截断 8000（省略号 +「（证据库已截断）」）；无有效项返回空串。块内自带引用纪律与「可能有误」语义——`SEED/DEBATE/SUMMARIZER` 文案不得为证据改动。
- **认识论区分（D3）**：证据库 = 共享事实基底（debate seed/≥2、relay 各轮均注入，置于 claim-0 之前）；claim-0 = 可推翻主张（debate seed 盲答不注入）。投票轮两者都不注入。无 evidence 时所有模板逐字节还原（`evidencePrefix` 空串拼接模式）。
- **SP 聚合**（`surprisinglyPopular(votes, predictions, knownAliases)`）：margin(c) = actual(c)（分母 = 非空且已知的有效票数）− predicted(c)（分母 = 有非空预测的票数，Q2=A 缺预测降级）；唯一 argmax 才返回，预测 <2 份/并列/无有效票 → null。`spWinner` 仅成功时写 `DialogueResult`/JSONL vote 事件顶层（additive）。报告「### 聚合结果」双轨三态（投票明细后、讨论总结前），分歧态必须保留趋同警报文案。
- **证据引用统计**（`collectEvidenceRefs`）：报告侧客观正则扫描 `/\[E(\d+)\]/g`，越界编号忽略；无 evidence 或零引用 → 零输出。不做语义级论据↔证据抽取（D4）。


- `buildClaim0Block` 对 undefined/纯空白返回空串；无 context 时所有 prompt 模板**逐字节**还原原串（`claim0Prefix` 空串拼接模式）。
- `formatBrainstormReport` 无 `initiatorContext` 时 claim-0 小节零字节输出。
- 指令常量（`SEED_INSTRUCTION`/`DEBATE_INSTRUCTION`/`VOTE_INSTRUCTION`/`SUMMARIZER_SYSTEM`）是行为的一部分：修改文案 = 行为变更，须同步测试断言并在任务 PRD 记录动机。
- 论据锚定约定（best-effort）：发言要求"主张 + 依据 + 来源"，投票理由要求引用被投者具体论据；总结须在票数分裂时输出「无共识」，不得强行归并多数。
