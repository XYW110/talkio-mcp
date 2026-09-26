# Design: 辩论反锚定与论据锚定

## 1. 现状与注入矩阵

### 现状 prompt 组装（2026-09-26 核对）

| 路径 | 组装点 | 现状 |
| --- | --- | --- |
| debate seed（round 1） | `runDialogue` `src/orchestrator/dialogue.ts:544-554` | `topic + "\n\n" + SEED_INSTRUCTION`，并行 |
| debate round ≥2 | `runDialogue` | transcript（匿名 own 标注）+ `DEBATE_INSTRUCTION`；超预算走 `buildInjection`（概要 + 最近轮实录） |
| relay | `runDialogue` relay 分支 | `topic + RELAY_INSTRUCTION + transcript`（顺序发言） |
| 投票轮 | `runDialogue` vote 段 | 匿名实录 + `VOTE_INSTRUCTION` |
| consult | `buildTargetMessages` `src/orchestrator/parallel.ts:45-65` | `背景信息:\n{context}\n\n问题:\n{question}` |
| 总结/合并 | `SUMMARIZER_SYSTEM` / `RUNS_MERGE_SYSTEM` | 中立主持人总结 |

### 目标注入矩阵（context = 发起方初步分析）

| 路径 | context 处理 |
| --- | --- |
| debate round 1 | **不注入**（blind seed，R2） |
| debate round ≥2 | `claim0Block(context)` 前置于 transcript/注入块之前（R3） |
| relay 各轮 | `claim0Block(context)` 前置于 topic 之后（R4，无盲答） |
| 投票轮 | 不额外注入；`VOTE_INSTRUCTION` 明示 claim-0 非候选人（R9/D3） |
| consult | 标签替换为 claim-0 框架（R5） |

## 2. 新常量（`src/orchestrator/dialogue.ts`）

```ts
/** claim-0 块头：发起方初步判断在注入块与报告中的统一标题。 */
export const CLAIM0_HEADER = "【主理 AI 初步判断（claim-0）】";

/** claim-0 说明行：紧跟 context 文本之后。 */
export const CLAIM0_NOTE =
  "以上是发起本次讨论的主理 AI 的初步分析，可能包含错误、片面或过时的假设。它不是专家发言，不参与互评投票；欢迎质疑、修正或推翻。";

/** 组装 claim-0 块（context 去空白后为空则返回空串，调用方按无 context 处理）。 */
export function buildClaim0Block(context: string | undefined): string;
```

- `buildClaim0Block` 返回 `` `${CLAIM0_HEADER}\n${context.trim()}\n\n${CLAIM0_NOTE}` ``。
- 无效输入（undefined / 纯空白）返回 `""`，各调用点以 `claim0 ? claim0 + "\n\n" : ""` 方式拼接，保证无 context 时 prompt 组装形状与现状一致（AC1 红线）。

## 3. 逐路径改动

### 3.1 `DialogueOptions`（dialogue.ts:54）

新增 `context?: string`（JSDoc：发起方初步分析；debate 下 blind seed，round≥2 以 claim-0 注入；relay 下随轮注入）。

### 3.2 debate 分支（runDialogue）

- round 1 seed：**保持现状**（`topic + SEED_INSTRUCTION`），context 不进入 —— blind seed。
- round ≥2：取注入块（现有 `resolveRenderer` 产物）后前插 `claim0 + "\n\n"`。压缩与非压缩两条路径都在此处包裹（即包裹点在 `resolveRenderer` 返回值的使用处，不改 `context-compressor.ts`）。
- 投票轮：不改注入内容。

### 3.3 relay 分支

- 现有组装中 topic 之后插入 `claim0 + "\n\n"`（有 context 时）。relay 历史轮同样保留（首位发言者需要背景，无盲答语义）。

### 3.4 投票与总结指令（R9/R10）

- `VOTE_INSTRUCTION` 重写（保留 150 字限长 + 禁自投 + 立场修正一句话），新增：评判标准为论据质量与可验证性；理由必须引用被投者的一条具体论据；「主理 AI 初步判断（claim-0）」不是候选人。
- `SUMMARIZER_SYSTEM` 末尾增补无共识条款（R10 原文语义）。

### 3.5 `brainstorm` 工具（src/tools/brainstorm.ts）

- `BrainstormArgs` + `brainstormSchema` 增 `context: z.string().optional().describe(...)`（描述写明 claim-0 语义与"首轮盲答不注入"）。
- `opts: DialogueOptions` 透传 `context: args.context`。
- 报告：`formatBrainstormReport` extras 增 `initiatorContext?: string`，传入 `args.context`；runs/合并路径不涉及（mergeRunSummaries 不接 context，不改）。

### 3.6 报告渲染（src/utils/format.ts）

- `BrainstormReportExtras` 增 `initiatorContext?: string`。
- `formatBrainstormReport` 在主题之后、实录之前输出小节：

```
## 发起方初步判断（claim-0）

> {context}

（claim-0 未参与第 1 轮盲答，也不是投票候选人；以上内容仅供检验。）
```

- 无 `initiatorContext` 时完全不输出（字节不变）。

### 3.7 consult 路径（src/orchestrator/parallel.ts + src/tools/consult-experts.ts）

- `buildTargetMessages`（parallel.ts:59-62）：`背景信息:` → `主理 AI 提供的初步分析（可能有误，请独立判断，欢迎质疑）:`；拼接结构不变。
- `consult-experts.ts` schema 的 `context.describe` 同步更新为 claim-0 语义。
- `formatConsultReport` 不改（报告仍展示 context 原文，透明度优先）。

### 3.8 指令常量（R7/R8）

- `SEED_INSTRUCTION` / `DEBATE_INSTRUCTION` 重写，要点见 PRD R7/R8。保持简体中文、无标题格式（与现有一致），单段指令风格。

## 4. 兼容红线

1. 不传 context 时所有 prompt 组装**形状**不变（只是指令文案不同）——无 context 的既有测试只应因文案断言失败，结构断言必须全绿。
2. `parseVotedForAlias`、别名机制、runs 机制、followup、`experts.json` 零改动。
3. claim-0 文本进入 transcript 压缩器时视为普通注入文本（不进 `DialogueTurn`，不参与匿名化——它本来就无专家身份）。
4. PII：context 与其它用户文本一样经 `redactPII` 后才出站（`askExpert` 内已有，无需新增）。

## 5. 测试策略

- `test/orchestrator.test.ts`：
  - mock adapter 捕获 user prompt：debate rounds=2 + context → round1 各 prompt 不含 context 片段、round2 prompt 含 `CLAIM0_HEADER` 与 NOTE 关键句；
  - relay + context → 各轮含 claim-0；
  - 无 context → prompt 不含 claim-0 头；
  - 指令常量文案断言更新（含"论据"/"来源"/"无共识"关键词）。
- `test/consult-brainstorm.test.ts`：`buildTargetMessages` 标签断言替换；consult + context 报告与 prompt 断言。
- `test/brainstorm-runs.test.ts`：确认 runs 路径回归不破（不应有结构断言受影响）。

## 6. 回滚

单 commit 序列（backend 一个 commit）；回滚 = revert 该 commit。无数据迁移、无配置变更、无 admin-web 改动。
