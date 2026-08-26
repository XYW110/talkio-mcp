# Design — list_experts 标注缺 key

## 1. Boundaries

只改发现层：`list-experts.ts` 的摘要契约与展示。筛选规则不变。consult / brainstorm / 编排层不改。

```
handleListExperts
  → selectListedExperts（现有 enabled 过滤）
  → summarizeExpert(expert, config)  // 注入 ready / missingEnv
  → Markdown + JSON payload（含 readyCount）
```

## 2. Contracts

`ExpertSummary` 新增：

```ts
ready: boolean;
missingEnv?: string; // only when ready === false
```

`ready` 来自 `hasProviderKey(config, expert)`。`missingEnv` 来自导出后的 `missingKeyEnv(config, expert)`。有 key 时省略 `missingEnv`，避免 JSON 噪音。

顶层：

```ts
{
  experts,
  count: experts.length,
  readyCount: experts.filter((e) => e.ready).length,
  enabledCount,
  totalCount,
}
```

`readyCount` 相对**本次返回列表**，不是全局全部专家。默认路径下它表示「启用且有 key」的人数，与 consult 默认池接近（consult 还会再截 3 人）。

Markdown 行：

```
- {icon} **{name}** (`{id}`) · {provider}/{model} · temperature={n}[ · disabled][ · 缺 {missingEnv}]
```

## 3. Reuse

- 导出 `src/tools/select-experts.ts` 的 `missingKeyEnv`
- `summarizeExpert(expert, config)` 增加第二参数；测试与 handler 同步改签名
- 禁止复制 `process.env[...]` 判断

## 4. Compatibility

- 旧字段保留，Agent 多读 `ready` / `missingEnv` / `readyCount`
- smoke 仍只看 architect / product 字符串，mock 下全员 ready，不断
- 不回显 key

## 5. Trade-offs

发现列表保留缺 key 专家，代价是「可用」不再等于「列表里有」。收益是 Agent 能看见角色并知道要配哪个 env。

## 6. Rollback

还原 `list-experts.ts` 摘要字段与 `summarizeExpert` 签名；`missingKeyEnv` 可继续导出无害。
