# Design: SP 二阶聚合 + 证据锚定协议

## 1. 现状锚点（2026-09-27 核对）

| 符号 | 位置 | 现状 |
| --- | --- | --- |
| `VOTE_INSTRUCTION` | `src/orchestrator/dialogue.ts`（常量区） | 单选别名+论据引用理由+禁自投+150 字+立场修正一行 |
| 选票解析 | `collectAliasMentions` / `parseVotedForAlias` / `isSelfVoteBallot`（P3 产物） | 全称优先+裸代号回退；自投三态 |
| `VoteBallot` | `dialogue.ts` | voterCardId/voterAlias/votedForAlias/reason/selfVote? |
| `brainstormSchema` | `src/tools/brainstorm.ts` | topic/context/mode/rounds/cards/summarize/vote/judgeCard/select/runs |
| 报告小节序 | `formatBrainstormReport`（format.ts） | 实录 → 魔鬼代言人轮换 → 互评投票 → 投票明细 → 讨论总结 |
| `DialogueResult` | `dialogue.ts` | turns/summary/votes/aliases/roundVotes/judgeInfo/devilsAdvocates |

## 2. R2 证据锚定（先做：注入块影响后续测试基线）

### 2.1 常量与组装（dialogue.ts）

```ts
export const EVIDENCE_LIBRARY_HEADER = "【可引用证据库（主理 AI 提供，编号 [E1]..[En]）】";
export const EVIDENCE_LIBRARY_NOTE =
  "以上证据是共享的事实材料,不是立场主张;引用其中内容时请标注编号,如 [E1]。证据可能不完整或有误,发现相互矛盾或与你的知识冲突时,请明确指出。";

export const EVIDENCE_ITEM_MAX_CHARS = 2000;   // 单条截断
export const EVIDENCE_LIBRARY_MAX_CHARS = 8000; // 总量截断（截断处加省略号 + "（证据库已截断）"）

/** 组装证据库块；无有效项（缺省/全空白）返回 ""。编号按传入顺序，跳过空白项。 */
export function buildEvidenceLibrary(evidence: string[] | undefined): string;
```

- 块体：`EVIDENCE_LIBRARY_HEADER\n\n[E1] <item1>\n\n[E2] <item2>…\n\nEVIDENCE_LIBRARY_NOTE`。
- 与 claim-0 的认识论区分写在 NOTE 里（"事实材料，不是立场主张" vs claim-0 的"初步判断，可推翻"）。

### 2.2 注入矩阵更新

| 路径 | evidence 处理 |
| --- | --- |
| debate round 1（seed） | **注入**（`buildEvidenceLibrary` 产物前置于 topic 之前？——置于 topic 之后、SEED_INSTRUCTION 之前，与 relay 一致；盲答隔离仅针对 context/claim-0，不针对证据基底） |
| debate round ≥2 | 注入（与 claim-0 块共存：证据库在前、claim-0 在后——证据是基底，claim-0 是被审主张；两者相对顺序固定：`evidenceBlock + topic + transcript + claim0` 中 evidence 与 claim-0 均为前缀段，顺序 = evidence、claim-0、transcript。**实现时以现状模板为基础，把 evidence 块插在现有 claim0Prefix 之前，其余不动**） |
| relay 各轮 | 注入（topic 之后） |
| 投票轮 | 不注入（票文引用的是已陈述论据） |

- 拼接模式沿用 `prefix ? prefix + "\n\n" : ""` 惯例；无 evidence 时逐字节还原现状（AC1）。

### 2.3 报告证据引用统计（format.ts）

- `BrainstormReportExtras` 增 `evidence?: string[]`。
- `formatBrainstormReport` 增「### 证据库」小节（提供 evidence 时，实录之前展示编号条目——透明度）+「### 证据引用统计」小节（实录之后、魔鬼代言人轮换之前）：

```
### 证据引用统计

- 安全专家：[E1]×2、[E3]×1
- 性能专家：（未引用证据）
```

- 扫描规则：`/\[E(\d+)\]/g` 作用于 turns 内容（runs>1 取 first run 的 turns，与 votes 同策略）；编号 > 证据条数 → 忽略；`（未引用证据）` 行仅在该专家被扫描时出现；**无 evidence 参数 → 两个小节都零输出**（引用统计无意义）。
- 新纯函数 `collectEvidenceRefs(turns, evidenceCount): Array<{expertName, cited: Array<{id, count}>}>`（导出可测）。

### 2.4 工具层（brainstorm.ts）

- `brainstormSchema.evidence: z.array(z.string()).optional().describe("调用方提供的证据包(代码片段/数据/文档引文/实测输出),将编号为[E1..En]注入各轮供专家引用;区别于 context(发起方主张)")`。
- extras 透传 `evidence: args.evidence`。
- **consult_experts 不加**（Out of Scope）。

## 3. R1 SP 二阶聚合

### 3.1 VOTE_INSTRUCTION 重写（唯一改动的四常量之一）

```
"以上是本次讨论的完整实录（已匿名，标注【你的发言】的行是你本人的观点）。请投票：
第一行给出投票——选出你最认同的一位其他专家（代号）与其核心理由（必须引用该专家的具体论据；论据若基于证据库请标注证据编号），150 字以内，不要标题；
最后一行以「预测：」开头——预测其他专家会各投给谁（列出代号，不含你自己）。
不得投给你自己；一句话说明你是否修正了自己的立场。"
```

- 结构要求（第一行/最后一行）为软约束，解析按标记容错（3.2）。

### 3.2 选票解析升级（dialogue.ts）

- `VoteBallot` 增 `predictions?: string[]`（已知别名、排除本人、按出现序；仅非空数组时写键——JSONL additive）。
- 解析规则：
  1. 定位预测段：文本中 `预测` 标记（`预测：`/`预测:`/行首"预测"）首次出现处分割；无标记 → 全文为投票段，predictions 空。
  2. 投票段：沿用 `collectAliasMentions`（全称优先+裸代号回退+本人跳过）→ votedForAlias/selfVote 语义不变。
  3. 预测段：`collectAliasMentions` 收集全部已知别名提及，**排除本人**（预测自己的条目丢弃），保留顺序去重 → predictions。
- 构造点（投票段 ballots 组装处）：ballot 增 predictions；JSONL vote 事件透传（仅非空写键）。

### 3.3 SP 纯函数（dialogue.ts，导出可测）

```ts
/** Surprisingly Popular 聚合（Prelec 2017；多 LLM 版见任务 research.md）。
 * votes: 有效票的被投者别名（空串/未识别不计入）；predictions: 每票的预测别名数组（可空）。
 * 返回 SP 赢家别名；预测份数 <2 或边际并列最大 → null（Q2=A 降级）。 */
export function surprisinglyPopular(
  votes: string[],
  predictions: string[][],
  knownAliases: string[]
): string | null;
```

- 计算：对每个候选 c ∈ knownAliases：
  - `actual(c)` = votes 中 c 的占比（分母 = votes 非空串个数）；
  - `predicted(c)` = 各预测份（非空数组）中 c 的平均占比（分母 = 有预测的票数；预测份内条目为该预测者眼中的分布，即其预测到的别名列表）；
  - `margin(c) = actual(c) − predicted(c)`；SP = 唯一 argmax；并列或预测份 <2 → null。
- 边界：无有效票 → null；knownAliases 外提及忽略。
- 经典测试例（AC4）：3 专家 A/B/C， votes=[A,A,B]，predictions 反映 B 会误判多数（预测 A 得票被高估）→ SP 选中 B 的用例按公式构造。

### 3.4 结果与报告

- `DialogueResult` 增 `spWinner?: string`（别名；null/未计算 → 不写键）。
- 计算输入：roundVotes.ballots 的 votedForAlias（过滤空串）+ predictions。
- 报告：在「投票明细」之后、「讨论总结」之前增「### 聚合结果」小节（仅 vote 开启且有票时输出）：
  - 一致：`多数赢家与 SP 赢家一致：专家B（聚合信号稳健）`
  - 分歧：`多数赢家：专家A；SP 赢家：专家B —— ⚠️ 多数可能被预期锁定（趋同警报），请阅读双方论据后再裁决`
  - 未计算（SP null）：`多数赢家：专家A（预测不足，未计算 SP）`
- JSONL vote 事件顶层 `spWinner`（仅成功时写键）。

## 4. 兼容红线

1. 无 evidence 时所有 prompt 模板逐字节还原现状；证据块只在有参数时出现。
2. SEED/DEBATE/SUMMARIZER 文案零改动；VOTE_INSTRUCTION 是本任务唯一允许变更的四常量成员。
3. 投票明细三态渲染不变；「互评投票」文本段不变；新增小节均缺省零字节或受 vote 开关控制。
4. JSONL 全部新增字段 additive（predictions 仅非空写键、spWinner 仅成功写键）。
5. `parseVotedForAlias`/`isSelfVoteBallot` 既有语义与签名不变（预测分割只发生在 ballot 组装层，不回改这两个导出函数）。
6. 魔鬼代言人/claim-0/runs 机制零改动。

## 5. 测试策略

- evidence：buildEvidenceLibrary（编号/截断/空白跳过/无参空串）；注入矩阵（debate seed/≥2、relay 有块；无参逐字节）；报告两小节缺省零字节；collectEvidenceRefs 扫描（多专家/越界编号/重复计数）。
- 解析：预测标记分割（有/无标记、全半角冒号）；预测段排除本人；predictions 仅非空写键。
- surprisinglyPopular：经典例、并列→null、预测<2→null、全空→null、n=2 退化。
- 报告聚合三态渲染 + spWinner JSONL 键缺省。
- 回归：P3 既有断言（devil 矩阵/自投/裸代号/claim-0）全绿——注意 P3 的 VOTE_INSTRUCTION 相关测试文案断言需按新指令更新。

## 6. 回滚

backend + docs 各一笔 commit；revert 即回滚。无迁移/配置/admin-web。
