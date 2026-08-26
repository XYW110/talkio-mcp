# Design — 默认专家筛选与首次调用成本

## 1. Architecture and Boundaries

本轮只改 **tools 层默认选择与参数默认值**，以及报告头注记。编排层（`runConsultation` / `runDialogue`）、Provider adapter、凭据解析契约保持不变。

```
MCP tool handler
  → 空参校验（R1）
  → selectDefaultOrExplicitExperts（R2–R5）
  → orchestrator（现有）
  → format report + 跳过/截断注记
```

不改：`experts.json`、stdio/SSE、Docker、`list_experts` 输出形状。

## 2. Shared Selection Contract

新增共用模块（建议 `src/tools/select-experts.ts`），consult 与 brainstorm 都走同一函数，避免两套默认规则漂移。

输入：`config`、可选 `ids`、`{ defaultLimit: number }`。

输出：

| 字段 | 含义 |
| --- | --- |
| `selected` | 实际要调用的专家 |
| `ignored` | 显式名单里找不到或未启用的 id（现有语义） |
| `skippedMissingKey` | 默认路径因缺 key 跳过的专家（含 `apiKeyEnv`） |
| `truncated` | 默认路径因 `defaultLimit` 截掉的专家 |

规则：

1. **显式非空 `ids`**：与现在相同。只从 enabled 里按请求顺序挑选；未知/未启用进 `ignored`；**不**按 key 过滤、**不**按 `defaultLimit` 截断。缺 key 仍由编排层变成该项 ⚠️。
2. **默认路径**（`ids` 省略或空数组）：
   - 先取 `enabled !== false`
   - 再留下 `hasProviderKey(config, expert)` 为 true 的
   - 其余写入 `skippedMissingKey`
   - 再按原顺序 `slice(0, defaultLimit)`，余下写入 `truncated`
3. consult 的 `defaultLimit = 3`；brainstorm 默认路径 `defaultLimit = 3`。显式名单不受此限（brainstorm schema 仍 `.max(6)`）。

`hasProviderKey`：

- `TALKIO_MOCK_PROVIDER=1` → true
- 否则读 `config.providers[expert.provider]`；无 provider 或 `process.env[apiKeyEnv]` 为空 → false
- **禁止**调用 `resolveProviderCredentials`（缺 key 会 throw，会把默认筛选打成失败项）

## 3. Empty Input Gate

handler 入口：

- consult：`args.question.trim() === ""` → `{ isError: true, content: [{ type: "text", text: "question 不能为空" }] }`，return，不筛选、不调用编排
- brainstorm：对 `args.topic` 同样处理

文案用中文，点名参数。不要用 zod `.min(1)` 单独扛：它拦不住纯空白。schema `.describe()` 可注明「去空白后不能为空」。

## 4. Default Value Changes

| 参数 | 现在 | 改为 |
| --- | --- | --- |
| consult 默认专家 | 全部 enabled | enabled ∩ 有 key，最多 3 |
| brainstorm 默认专家 | enabled 前 6 | enabled ∩ 有 key，最多 3 |
| `rounds` | 2 | 1 |
| `summarize` | true | false |

必须同时改 schema `.describe()` 和 handler `??`，否则 `tools/list` 仍宣传旧默认。

显式传值：`rounds: 2, summarize: true, experts: [...]` 行为与现在一致。

## 5. Report Notes

追加在现有 Markdown 报告末尾（与当前 ignored 注记同一位置）：

- 缺 key：`> 已跳过 security（缺 ANTHROPIC_API_KEY）、performance（缺 DEEPSEEK_API_KEY）`
- 人数截断：`> 默认最多 3 位专家，未包含: reviewer, product`
- 显式 ignored：保持 `> 注: 以下请求的专家 id 未找到或未启用,已忽略: ...`

只在对应数组非空时输出。注记必须出现在 MCP `content` 文本里，不能只打 stderr。

默认路径筛完 `selected.length === 0`（例如一把 key 都没有、且非 mock）：`isError: true`，说明没有可调用专家，并列出 `skippedMissingKey`，`fetch` 次数为 0。不要用现在那句「没有匹配到任何可用的专家」假装配置里没人。

## 6. Compatibility

- 显式 `experts`：部分失败 / 全失败 `isError` 规则不变（consult：全部失败才 `isError`；brainstorm：零 turn 才 `isError`）
- mock 模式：默认筛选把所有 enabled 专家视为有 key，再截 3 人。smoke 显式传 `architect`，不受默认截断影响
- `experts.json` 不改，避免动用户已有模板和三家 provider 绑定

## 7. Trade-offs

- **默认不再保证五视角齐全**：第一次调用变便宜、变干净。要全员或跨 provider，调用方显式传 `experts` 并配齐 key。
- **截取按文件顺序，不按「先有 key 的 openai」重排**：行为可预测，与配置文件所见即所得。代价是若前 3 个碰巧都缺 key，会继续往后找有 key 的（因为先过滤再截断），这是正确的。
- **不在 `list_experts` 标就绪**：本轮范围外。Agent 仍可能猜 id；但默认路径不再惩罚猜错/不传。

## 8. Rollback

回滚点集中在 `src/tools/select-experts.ts`（新文件）以及 `consult-experts.ts` / `brainstorm.ts` 的默认值与 handler 注记。编排层无行为变更，回滚不触及 provider。
