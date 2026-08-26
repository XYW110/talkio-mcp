# 默认专家筛选与首次调用成本

## Goal

把「第一次试用」从「5 专家 × 3 家 key × 最多 11 次 LLM」收成「有一把可用 key 就能在少量调用内拿到完整报告」。空问题/空主题立刻拒绝，不发任何 Provider 请求。

用户价值：只配 `OPENAI_API_KEY` 时，默认 `consult_experts` / `brainstorm` 不再刷 `missing env var` 的 ⚠️，也不再默认烧掉 5 ～ 11 次调用。

## Background

当前默认路径打全部 `enabled` 专家。仓库模板 5 人分别绑 openai / anthropic / deepseek，consult 无人数上限，brainstorm 默认 2 轮 + 总结。缺 key 的专家仍会进入编排，在凭据解析时失败并出现在报告里。`question` / `topic` 仅 `z.string()`，空白字符串也会发请求。

用户已确认本轮方向：第一次试用（空参拦截 + 默认只选有 key 的专家 + 控制默认人数/轮数）；默认筛选为 enabled ∩ 有 key，consult 再截最多 3 人；brainstorm 未传参时 3 人 × 1 轮、不总结。显式传入 `experts` 时保持现状。

## Confirmed Facts

- `consult_experts` 未传 `experts`（或缺省空数组）时返回全部 `enabled !== false` 的专家，无人数上限。`src/tools/consult-experts.ts:51`
- `brainstorm` 未传 `experts` 时取 enabled 前 6 人；`rounds` 默认 2，`summarize` 默认 true。`src/tools/brainstorm.ts:62`，`src/tools/brainstorm.ts:88`
- 缺 key 在调用时惰性抛 `Provider X: missing env var Y`，单专家失败不阻断其他专家。`src/config.ts:274`，`src/orchestrator/parallel.ts:120`
- `question` / `topic` 无 min / trim。`src/tools/consult-experts.ts:16`，`src/tools/brainstorm.ts:20`
- 默认模板 5 专家绑定：architect/reviewer → openai，security → anthropic，performance/product → deepseek。`experts.json:26`
- mock 模式 `TALKIO_MOCK_PROVIDER=1` 在凭据解析前短路，视为无需真实 key。`src/providers/registry.ts:40`，`src/orchestrator/parallel.ts:64`
- consult 已有未文档化的 `parallel`。`src/tools/consult-experts.ts:25` vs `README.md:165`
- brainstorm schema 显式名单仍 `.max(6)`。`src/tools/brainstorm.ts:34`
- smoke 显式传 `experts: ["architect"]`，brainstorm 显式 `rounds: 1, summarize: false`。`scripts/smoke-stdio.mjs:75`

## Requirements

### R1: 空问题/主题拦截

`consult_experts.question` 与 `brainstorm.topic` 去空白后必须非空。空串、纯空白立即 `isError: true`，中文说明参数不能为空，不调用任何 Provider。校验放在 handler 最前面，先于专家筛选。

### R2: 默认专家 = enabled ∩ 有 key

未传 `experts`（或缺省空数组）时，只选 `enabled !== false` 且对应 `apiKeyEnv` 已设置的专家。缺 key 的专家不进入默认集、不发请求。发生跳过时，MCP 返回文本必须说明跳过了谁、因为缺哪个环境变量（例如「已跳过 security（缺 ANTHROPIC_API_KEY）」）。「有 key」= `process.env[provider.apiKeyEnv]` 非空；不要调用 `resolveProviderCredentials`（缺 key 会 throw）。`TALKIO_MOCK_PROVIDER=1` 视为所有 provider 都有 key。

### R3: consult 默认人数上限 3

未指定 `experts` 时，在 R2 结果上按 `experts.json` 原顺序取最多 3 位，不按 provider 重排。被上限截掉的专家也要在报告头注明（与缺 key 跳过区分）。

### R4: brainstorm 默认 3 人 × 1 轮、不总结

未指定时 `rounds` 默认 1，`summarize` 默认 false，专家最多 3 人（筛选规则同 R2）。用户显式传 `rounds` / `summarize` / `experts` 时用用户值；`rounds` 仍 1–5，显式 `experts` 数组仍最多 6。schema 的 `.describe()` 与 handler 的 `??` 必须一起改，避免 `tools/list` 仍写旧默认值。

### R5: 显式 `experts` 保持现状

调用方传入非空 `experts` 时：不因缺 key 而从名单剔除；找不到或未启用的 id 仍写入 ignored 注记；点到缺 key 的专家该项 ⚠️，其他专家照常返回。不受「默认最多 3 人」限制（仍受 brainstorm 的 6 人 schema 上限）。

### R6: 默认模板不改 provider

`experts.json` 里 architect / security / performance / reviewer / product 的 provider、model、enabled 保持现状。本轮只改运行时默认筛选。

### R7: README 补默认行为

工具用法表写清：未指定 `experts` 时只选有 key 的启用专家；consult 默认最多 3；brainstorm 默认 3 人 / 1 轮 / 不总结；并补上已存在但未文档化的 `parallel`。

## Acceptance Criteria

- [x] AC1（R1）：`question: "   "` / `topic: ""` 返回中文错误（说明参数不能为空），`isError: true`，网络层 `fetch` 次数为 0
- [x] AC2（R2）：只设 `OPENAI_API_KEY` 时，默认 consult / brainstorm 报告中不出现 `Provider X: missing env var Y` 的 ⚠️；报告头说明跳过了哪些专家及原因
- [x] AC3（R3）：5 个专家都有 key 时，默认 consult 只打前 3 个，LLM 调用次数 ≤ 3；被截掉的专家在报告头可见
- [x] AC4（R4）：`brainstorm({ topic: "x" })` 在 3 把 key 都齐时最多 3 次 LLM；`brainstorm({ topic: "x", rounds: 2, summarize: true })` 仍按用户指定跑
- [x] AC5（R5）：无 Anthropic key 时，`consult_experts({ question: "x", experts: ["security"] })` 对该项失败、全部失败才 `isError`；`experts: ["architect","security","performance","reviewer"]` 会打 4 人，不截成 3
- [x] AC6（R6）：`experts.json` 的 5 个专家绑定与现网一致，本轮 diff 不含该文件
- [x] AC7（R7）：README 的 consult / brainstorm 参数表与代码 schema、新默认值一致，且包含 `parallel`
- [x] AC8：`TALKIO_MOCK_PROVIDER=1` 下默认仍能选出专家；`npm test`、`npm run typecheck`、`node scripts/smoke-stdio.mjs` 通过

## Out of Scope

- `list_experts` 标注缺 key / 就绪状态
- `brainstorm` 增加 `context` 参数
- 会话续聊、进度通知、流式输出
- 发布 npm、GitHub Actions CI
- Streamable HTTP 替换 SSE、Docker 绑定、SSE 鉴权
- 把默认专家全部改绑 OpenAI

## Technical Notes

- 筛选逻辑抽到 tools 层共用，避免 consult 与 brainstorm 各写一份默认规则后漂移。现有重复：`src/tools/consult-experts.ts:47`，`src/tools/brainstorm.ts:57`
- 截取前 3 人按 `experts.json` 数组顺序
- 报告头的跳过说明只在「发生了默认筛选跳过或人数截断」时出现；显式 `experts` 的 ignored 注记保持现有格式
- 密钥仍只走环境变量；错误信息不得回显 key
- 兼容性：显式传参的旧调用契约不变；改变的是未传 `experts` / `rounds` / `summarize` 的默认行为
