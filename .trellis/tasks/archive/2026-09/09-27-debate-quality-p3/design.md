# Design: 辩论质量 P3

## 1. 现状锚点（2026-09-27 核对）

| 符号 | 位置 | 现状 |
| --- | --- | --- |
| `parseVotedForAlias` | `src/orchestrator/dialogue.ts:234-245` | 仅 `/专家[A-Z]/g`，跳过本人，无命中返回 "" |
| `VoteBallot` | `dialogue.ts:124-133` | voterCardId / voterAlias / votedForAlias / reason |
| 投票明细渲染 | `src/utils/format.ts`（`formatBrainstormReport` 内，约 :170 起） | `votedForAlias` 空串 → "（未识别代号）" |
| debate round≥2 prompt | `runDialogue` 轮循环（claim-0 任务后包裹点在 `resolveRenderer` 产物使用处） | 实录注入块 + `DEBATE_INSTRUCTION` |
| `DialogueResult` / `BrainstormReportExtras` | `dialogue.ts:110` / `format.ts:98` | 现有字段，均向后兼容扩展 |

## 2. R2/R3 票文解析（dialogue.ts）

### parseVotedForAlias 升级（保持签名不变）

```
步骤1（优先）：content.match(/专家([A-Z])/g) —— 现状逻辑，第一个非本人已知别名。
步骤2（回退）：content.match(/(?<![A-Za-z0-9])([A-Z])(?![A-Za-z0-9])/g)
  —— 独立大写字母；映射 专家${letter}；仅接受 ∈ knownAliases；
  同样跳过本人；返回第一个命中。
两级都无 → ""。
```

- lookbehind Node 18+ 支持（本项目 engines 无顾虑；vitest 运行时同）。
- 误报防护由两个条件共同保证：邻接字母数字排除（API/QPS/AB/OWASP 不命中）+ knownAliases 白名单（3 卡时 "N=10" 的 N 不命中）。
- "专家AB" 命中 专家A：步骤1 正则既有行为，不新增处理。

### isSelfVoteBallot（新导出）

```
isSelfVoteBallot(content, voterAlias, knownAliases): boolean
= 票文提及 voterAlias（全称或其裸字母，同 R2 匹配规则）
  且 未提及任何其他已知别名（全称或裸字母）。
```

实现上与 parseVotedForAlias 共享一个私有的「收集所有别名提及」helper（返回按序提及列表，元素含来源 full/bare），两个导出函数分别消费，避免两套正则漂移。

### VoteBallot / 构造点 / 渲染

- `VoteBallot` 增 `selfVote?: boolean`（仅 true 时置位；JSONL vote 事件 ballots 透传，additive）。
- 构造点（runDialogue 投票段，遍历成功票文处）：`votedForAlias === "" && isSelfVoteBallot(...) → selfVote: true`。
- 投票明细（format.ts）：三元分支——
  - `votedForAlias` 非空 → 现状渲染（字节不变）；
  - 空 + `selfVote` → `- **${voterAlias}** → ⚠️ 自投（无效票）：${reason}`；
  - 空 + 非 selfVote → 现状 "（未识别代号）" 渲染。
- 「互评投票」文本段（`votes: DialogueTurn[]` 渲染路径）不动。

## 3. R1 魔鬼代言人（dialogue.ts + format.ts + brainstorm.ts）

### 常量

```ts
/** 魔鬼代言人轮指令（P3）：注入于该专家当轮 prompt 的 DEBATE_INSTRUCTION 之后。
 * 用「你」称呼，不含任何专家名/代号 → 匿名安全（anonymize 路径不触碰本常量）。 */
export const DEVILS_ADVOCATE_INSTRUCTION =
  "【魔鬼代言人指令】本轮你担任魔鬼代言人:请优先找出前轮发言(包括主理 AI 初步判断)中最薄弱的论据,给出你能构造的最强质疑或最坏情形分析,即使你个人认同该观点也要执行;质疑必须点名具体论据并给依据;完成反驳后,照常给出你自己修正后的立场。";
```

### 轮换函数（可测纯函数）

```ts
/** 第 round 轮（≥2）的魔鬼代言人下标：targets[(round-2) % n]；round<2 或空数组返回 -1。 */
export function devilsAdvocateIndex(round: number, targetCount: number): number
```

### runDialogue 接线（debate 分支）

- round ≥2 组装 prompt 时：`const daIdx = devilsAdvocateIndex(round, targets.length)`；对 `i === daIdx` 的 target，userContent 在 DEBATE_INSTRUCTION（及其后既有片段）之后追加 `"\n\n" + DEVILS_ADVOCATE_INSTRUCTION`。
- 注入点在**该专家的 userContent 拼接处**（与 claim-0 包裹点同层），不改 transcript 渲染、不构造 DialogueTurn、不进压缩器。
- round 1 seed、relay 分支、投票段：零改动。
- 收集：`devilsAdvocates: Array<{round, expertId, expertName}>`（每轮一条）挂到 `DialogueResult`（仅 debate 模式且有 round≥2 时非空）。

### 报告（format.ts + brainstorm.ts）

- `BrainstormReportExtras` 增 `devilsAdvocates?: Array<{round: number; expertName: string}>`（报告只需实名+轮次）。
- 渲染：位于实录之后、「互评投票」之前，仅非空时输出：

```
### 魔鬼代言人轮换

- 第 2 轮：安全专家
- 第 3 轮：性能专家
```

- `handleBrainstorm` 透传 `first.devilsAdvocates`（runs>1 时取 first，与 votes/aliases 同策略）。

## 4. 兼容红线

1. round 1 / relay / 投票轮 prompt **逐字节**不变（devil 与 claim-0 一样只挂 debate round≥2）。
2. 四指令常量（SEED/DEBATE/VOTE/SUMMARIZER）文案零改动。
3. 正常票与未识别票的报告渲染字节不变；仅新增 selfVote 分支。
4. vote 事件 JSONL 字段 additive；`parseVotedForAlias` 签名不变（既有测试兼容，新增用例覆盖裸代号）。
5. PII：DEVILS_ADVOCATE_INSTRUCTION 为静态常量，经 askExpert 统一 redactPII 路径出站，无新增风险。

## 5. 测试策略（test/orchestrator.test.ts 为主）

- parseVotedForAlias：裸代号正向（"我投B"/"投给B。"/"B 的论据最强"）；误报负向（"API 网关"/"QPS 提升"/"AB"）；全称优先（"专家A 与 B"→专家A 当 voter=专家C…按序语义锁定）；本人跳过。
- isSelfVoteBallot：仅本人全称 / 仅本人裸字母 → true；提及他人 → false；无提及 → false。
- 魔鬼代言人：mock adapter 捕获 prompt——rounds=3 两卡断言 AC3 矩阵；`devilsAdvocateIndex` 纯函数边界（round<2、单卡、rounds>n）；报告小节渲染 + 缺省零字节。
- 端到端：mock vote 流程中自投票 → 报告三态渲染断言。
- 回归：runs=1 等价、claim-0、匿名化既有断言全绿。

## 6. 回滚

backend 单 commit + docs 单 commit；回滚 revert 对应 commit。无迁移、无配置、无 admin-web。
