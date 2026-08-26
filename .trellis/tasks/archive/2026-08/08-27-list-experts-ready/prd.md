# list_experts 标注缺 key

## Goal

让 MCP 客户端在调用 `consult_experts` / `brainstorm` 之前，就能从 `list_experts` 看出哪些专家真正能打、哪些缺 API Key。避免 Agent 把 security 写进显式名单后才看到 `missing env var`。

## Background

上一轮已把未传 `experts` 的默认路径改成「enabled ∩ 有 key」。显式名单仍会点到缺 key 的专家并失败。发现层 `list_experts` 只返回 id / provider / model / enabled，不标密钥就绪状态，Agent 仍会猜错。

用户已确认输出形态：JSON 加 `ready` + 缺 key 时的 `missingEnv`；Markdown 行尾写 `· 缺 ANTHROPIC_API_KEY`；payload 加 `readyCount`。缺 key 的专家仍列出，不从发现列表删除。

## Confirmed Facts

- `list_experts` 已注册，参数仅 `includeDisabled`。`src/server.ts:32`，`src/tools/list-experts.ts:12`
- `ExpertSummary` 字段：id / name / icon / provider / model / temperature / enabled，无 key 状态。`src/tools/list-experts.ts:23`
- Markdown 行不标缺 key；JSON payload 为 `{ experts, count, enabledCount, totalCount }`。`src/tools/list-experts.ts:67`
- `hasProviderKey(config, expert)` 已导出：mock 视为有 key；否则读 `process.env[apiKeyEnv]`。`src/tools/select-experts.ts:32`
- `missingKeyEnv` 已存在但未导出。`src/tools/select-experts.ts:40`
- 现有测试只有启用过滤与 `includeDisabled`，无 key 断言。`test/list-experts.test.ts:41`
- README 特性与用法未提密钥就绪。`README.md:7`，`README.md:145`
- 仍不返回 `systemPrompt`。`src/tools/list-experts.ts:33`
- smoke 只断言 list_experts 含 architect / product，不解析 JSON 字段。`scripts/smoke-stdio.mjs:69`

## Requirements

### R1: 复用 hasProviderKey

`list_experts` 必须调用已有 `hasProviderKey`，不得再写一套 env 判断。`TALKIO_MOCK_PROVIDER=1` 时全部 `ready: true`。不调用 `resolveProviderCredentials`。不回显 key 值，只暴露环境变量名。

### R2: JSON 契约

每个 `ExpertSummary` 增加：

- `ready: boolean` — 与 `hasProviderKey` 一致
- `missingEnv?: string` — 仅 `ready === false` 时出现，值为 `apiKeyEnv` 或「未配置 provider "x"」

顶层 payload 增加 `readyCount`：本次返回列表中 `ready === true` 的人数。保留 `experts` / `count` / `enabledCount` / `totalCount`。

### R3: Markdown 标注

专家行在现有格式后追加：缺 key 时 ` · 缺 ANTHROPIC_API_KEY`；未启用仍为 ` · disabled`。两者可同时出现。不因缺 key 删除列表项。默认仍只列 enabled；`includeDisabled=true` 仍含未启用。

### R4: README 对齐

特性条与 `list_experts` 用法写清：返回就绪状态；缺 key 的专家仍列出，并标明缺哪个 env。

## Acceptance Criteria

- [x] AC1（R1）：`list_experts` 通过 `hasProviderKey` 判断就绪；mock 模式下返回的每位专家 `ready: true` 且无 `missingEnv`
- [x] AC2（R2）：只设 `OPENAI_API_KEY` 时，security 的 JSON 为 `ready: false`、`missingEnv: "ANTHROPIC_API_KEY"`；architect `ready: true` 且无 `missingEnv`；payload 含 `readyCount`
- [x] AC3（R3）：同一场景 Markdown 含 `缺 ANTHROPIC_API_KEY`，仍列出 security；默认列表不含 disabled 专家
- [x] AC4（R3）：`includeDisabled=true` 时未启用专家仍出现，可同时有 `disabled` 与缺 key 标注
- [x] AC5（R4）：README 特性与 list_experts 用法说明含就绪/缺 env 行为
- [x] AC6：`npm test`、`npm run typecheck`、`node scripts/smoke-stdio.mjs` 通过；输出不含密钥值

## Out of Scope

- 改 consult / brainstorm 的默认筛选
- brainstorm `context`
- 动态增删专家、reload 配置
- 返回 systemPrompt 或密钥值
- 因缺 key 从 list_experts 默认列表删除专家
