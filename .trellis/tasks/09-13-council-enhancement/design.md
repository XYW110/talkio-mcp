# Design: council-enhancement P1

研究依据见 `research/competitor-deep-dive.md`；需求见 `prd.md`。本设计只覆盖 P1-A（投票透明化）与 P1-B（推理策略）。

## P1-A 投票透明化

### 数据结构

vote 环节（`src/orchestrator/dialogue.ts`）现状产出文本汇总。改造为结构化中间结果，不改变对外报告的现有小节，只**新增**「投票明细」小节：

```ts
/** 单张选票（dialogue 内部结构） */
interface VoteBallot {
  voterCardId: string;      // 投票者真实卡 id（仅落盘用）
  voterAlias: string;       // 匿名别名，如 "专家A"（报告用）
  votedForAlias: string;    // 被投者别名
  reason: string;           // 投票理由原文（截断到 ~200 字符，超长加省略号）
}

/** 每轮投票结果 */
interface RoundVotes {
  round: number;
  ballots: VoteBallot[];
}
```

### records 事件（Q2=A：每轮一条）

`src/records/store.ts` `RecordEvent` 联合新增：

```ts
| { type: "vote"; round: number; votes: {
    voterCardId: string; votedForAlias: string; reason: string;
  }[] }
```

- 追加时机：每轮 vote 完成立即 `record.append(...)`（在 brainstorm 主流程内，finish 之前）。
- 兼容：旧 JSONL 无 vote 行，读侧（admin）按 type 分支渲染，未知 type 一律忽略不报错（**读侧容错是硬要求**）。

### 报告

`formatConsultReport`（或 brainstorm 报告组装处）在投票汇总小节后新增「投票明细」：每票一行 `专家A → 专家B：理由摘录`。不开 vote 时输出与现状一致。

### admin 渲染

`admin-web/src/pages/RecordsPage.tsx` SessionDetailView：vote 事件渲染为按轮分组的列表（轮次标题 + 每票一行）；事件类型映射表增补 vote；未知 type 走现有默认分支。

## P1-B 推理策略

### 类型与校验

- `src/types.ts` `ExpertConfig` 增 `reasoningStrategy?: "systematic" | "adversarial" | "backward" | "default"`。
- `src/config.ts` zod：可选枚举，非法值报校验错误；序列化时缺省字段不写入 experts.json（保持文件干净）。

### 指令常量表（集中、可测）

新增于 `src/orchestrator/dialogue.ts`（或独立 `src/orchestrator/strategy.ts`，实现者按现有文件规模判断，倾向独立小文件）：

```ts
export const REASONING_STRATEGY_INSTRUCTIONS: Record<NonNullable<ExpertConfig["reasoningStrategy"]>, string> = {
  default: "", // 空：缺省路径不追加任何内容（逐字节一致红线）
  systematic: "请采用系统化枚举的推理方式：先列出问题的所有关键维度，再逐一给出判断与依据。",
  adversarial: "请采用对抗式视角：主动寻找当前主流观点的漏洞、反例与被忽略的风险，并给出你的反驳。",
  backward: "请采用反向推理：从问题的理想结论/目标状态倒推，检验各方案能否支撑该结论。",
};

export function applyReasoningStrategy(systemPrompt: string, strategy?: string): string
```

- `applyReasoningStrategy`：strategy 缺省/default 返回原串（同一字符串引用，确保逐字节一致）；否则在 system prompt 末尾追加 `\n\n` + 指令。
- 注入点：`askExpert`（dialogue.ts，brainstorm 与 followup 共用）、`consult-experts.ts` 的单卡咨询 prompt 构建处。所有注入统一走该函数，禁止散落字符串拼接。

### admin

`ExpertEditPage.tsx` 专家表单增下拉「推理策略」：不指定(空)/default/systematic/adversarial/backward；映射到 types.ts 同名字段；清空 = 从落盘 JSON 删除该字段。

## 测试设计

- `test/consult-brainstorm.test.ts` 增补：
  - vote 开启：mock adapter 场景下断言 records JSONL 含 `{type:"vote",round:1,...}` 且字段完整；报告含「投票明细」；不开 vote 无 vote 行。
  - 策略：strategy=adversarial 时捕获发给 adapter 的 system prompt 含指令文案；缺省时 prompt 与基线快照逐字节一致。
- `test/context-compressor.test.ts` 不受影响（compressor prompt 不注入策略——压缩是内部指令，非专家人设）。
- admin：`admin-web` build 过即可（RecordsPage 渲染为展示层，逻辑简单）。

## 风险与对策

- **缺省行为回归**：default 策略返回原串引用 + 快照断言兜底。
- **JSONL 读侧兼容**：admin 未知 type 忽略；vite build + 手动打开一条旧记录验证。
- **alias 映射**：ballots 在 dialogue 内生成，voterCardId 从 ResolvedCard 直接可得；注意 judge 卡被剔除后不参与投票（维持现状）。
