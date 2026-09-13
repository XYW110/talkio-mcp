# 技术设计：P3-A runs 并集 + P3-C Provider 预设

## 1. P3-A 后端改动

### 1.1 参数与校验（src/tools/brainstorm.ts）
- zod raw shape 增 `runs: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional()`。
- `BrainstormArgs` 增 `runs?: 1 | 2 | 3`。
- 描述文案注明「>1 时成本按倍数增长；建议配合 vote+debate 使用」。

### 1.2 多轮执行流（handleBrainstorm）
```
runsTotal = args.runs ?? 1
for run in 1..runsTotal:
    aliasRotation = run === 1 ? identity : rotate/shuffle AliasMap（实现于 dialogue 层注入，
                    保证 run 间「卡↔别名」映射不同——用 rotate(offset = run-1) 确定性轮换，可测）
    { turns, summary, votes, aliases, roundVotes, judgeInfo } = await runDialogue({...opts, aliasRotation})
    收集 runResults.push({ run, turns, summary, roundVotes })
```
- run=1 走**现有单次路径，代码不包循环**（或循环退化为单次且零额外调用），确保逐字节兼容。
- 记录：turn/round_end/vote/summary 事件在 runsTotal>1 时带 `run` 字段；`recordTurns`/vote/summary append 处透传。

### 1.3 合并调用（仅 runsTotal>1 且存在 ≥1 份结论）
- 合并者 = judge（若有）否则第一张 debateTargets 卡（与 summarize 路径总结者选择一致；实现时读 `runDialogue` summarize 分支的模型选择逻辑，保持同一规则）。
- Prompt（新常量，放 dialogue.ts 或独立 merge 模块）：输入 N 份运行摘要（含各自结论/要点），要求输出去重合并结论列表，每条前缀 `[K/N RUNS]`（K=该结论在 N 份中被提及的次数，由 LLM 数，提示词中给出 N 并要求严格格式）。
- 失败兜底：合并调用失败 → 回退为「逐运行结论并列展示 + 报告注明合并失败」，isError 不因此置 true。

### 1.4 报告（formatBrainstormReport 或新 formatRunsSection）
- 报告头 topic 行后注 `（runs=N）`（仅 N>1）。
- 新小节「多轮稳定性」：每运行一行 `Run k：{summary 首行/截断}`；随后合并结论全文。
- N=1 输出与现状完全一致（不渲染该小节）。

### 1.5 records schema（src/records/store.ts + 类型）
- `TurnEvent/RoundEndEvent/VoteEvent/SummaryEvent` 增可选 `run?: number`；append 侧 `run: runsTotal > 1 ? run : undefined`（**缺省不写键**，对齐「缺省字段不落盘」惯例）。
- SessionDetailView 渲染：`event.run` 存在时在轮次/投票标题旁加 `<Pill tone="info">R{run}</Pill>`；旧文件无该字段渲染不变。

### 1.6 usage
- finish.usage = 各 run 全部 turns + votes + 合并调用 的 usage 总和（复用 sumUsage 归并）。

## 2. P3-C 前端 Provider 预设

- 新常量 `admin-web/src/pages/ProvidersPage.tsx` 内（或 `src/providerPresets.ts`，按内聚判断）：
```ts
const PROVIDER_PRESETS = [
  { id: "ollama",    label: "Ollama（本地）",   baseUrl: "http://localhost:11434/v1", apiKeyEnv: "",        hint: "本地通常无需 API key，可留空" },
  { id: "lmstudio",  label: "LM Studio（本地）", baseUrl: "http://localhost:1234/v1",  apiKeyEnv: "",        hint: "本地通常无需 API key" },
  { id: "vllm",      label: "vLLM",             baseUrl: "http://localhost:8000/v1",  apiKeyEnv: "",        hint: "按部署配置 token" },
  { id: "openrouter",label: "OpenRouter",       baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", hint: "" },
  { id: "deepseek",  label: "DeepSeek",         baseUrl: "https://api.deepseek.com",  apiKeyEnv: "DEEPSEEK_API_KEY", hint: "" },
  { id: "moonshot",  label: "Moonshot",         baseUrl: "https://api.moonshot.cn/v1", apiKeyEnv: "MOONSHOT_API_KEY", hint: "" },
  { id: "zhipu",     label: "智谱",              baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY", hint: "" },
];
```
- UI：ProvidersPage 表单顶部一行 `Chip`/`NavTab` 风格预设按钮（用 controls.tsx 现成组件）；点击 → fill 表单 state（name 不动、type 固定 openai-compatible、baseUrl/apiKeyEnv 填入）， hintText 显示。用 Chip 组件，皮肤随主题走。
- 不新增保存路径；不做自动激活（与 PAL 的差异点，见 research）。

## 3. 测试设计

- `test/brainstorm-runs.test.ts`（新增）：mock LLM（沿用现有测试的 mock 方式，参考 test/ 内 P1/P2 用例）：
  - runs 缺省 vs runs=1：报告与事件流逐字节一致（快照断言，含无 run 键）。
  - runs=2：两次 runDialogue 调用、别名映射不同、事件带 run 字段、报告含「多轮稳定性」与 `[1/2 RUNS]`/`[2/2 RUNS]`；合并调用发生在两次运行之后。
  - runs=3 + 合并调用失败：回退并列展示，isError 不翻转。
  - zod：runs=0/4 拒绝。
- `test/admin-records.test.ts` 补：带 run 字段事件解析 + 无 run 字段旧事件回归。
- admin 侧：`npx tsc --noEmit -p admin-web` + `npm run build:web`。

## 4. 兼容与回滚

- 兼容红线 = AC1；实现顺序上先写「runs=1 等价性」测试再实现多轮。
- 回滚：后端改动集中在 brainstorm.ts/dialogue.ts/records 类型；前端 ProvidersPage/SessionDetailView 各自独立，可单独 revert。

## 5. 明确不做

- 不做 runs 与 followup 的组合（followup 不感知 runs）。
- 不做跨会话结论缓存/embedding 去重（合并靠 LLM）。
- 不做 provider 自动激活（.env 探测）、不做原生 gemini adapter。
