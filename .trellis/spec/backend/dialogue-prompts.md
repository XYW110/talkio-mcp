# Dialogue Prompts & Claim-0 Convention

辩论/咨询路径的 prompt 组装契约。来源：09-26-debate-evidence-grounding（文献依据见该任务 `research.md`——Debate-or-Vote 鞅定理、MAST 谄媚/锚定失败模式、ReConcile 论据化投票）。

## claim-0 三语义（不可破坏）

凡"发起方（主理 AI/调用方）提供的内容"进入专家 prompt，必须保持三条语义，常量在 `src/orchestrator/dialogue.ts`（`CLAIM0_HEADER` / `CLAIM0_NOTE` / `buildClaim0Block`）：

1. **盲答隔离**：debate 模式第 1 轮（seed round）prompt 绝不含 context——独立首轮是辩论有效性的前提（Du et al. ICML 2024）。relay 模式例外（首位发言者需要背景）。
2. **可推翻标注**：claim-0 注入时必须带"可能有误、欢迎质疑、推翻"语义，置于发言实录之前；它不是专家发言。
3. **不可投票**：claim-0 无 `专家[A-Z]` 别名（`parseVotedForAlias` 天然不可命中），`VOTE_INSTRUCTION` 明示其非候选人。不得给 claim-0 分配别名或构造 `DialogueTurn`。

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


- `buildClaim0Block` 对 undefined/纯空白返回空串；无 context 时所有 prompt 模板**逐字节**还原原串（`claim0Prefix` 空串拼接模式）。
- `formatBrainstormReport` 无 `initiatorContext` 时 claim-0 小节零字节输出。
- 指令常量（`SEED_INSTRUCTION`/`DEBATE_INSTRUCTION`/`VOTE_INSTRUCTION`/`SUMMARIZER_SYSTEM`）是行为的一部分：修改文案 = 行为变更，须同步测试断言并在任务 PRD 记录动机。
- 论据锚定约定（best-effort）：发言要求"主张 + 依据 + 来源"，投票理由要求引用被投者具体论据；总结须在票数分裂时输出「无共识」，不得强行归并多数。
