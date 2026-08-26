# Implementation Plan — 默认专家筛选与首次调用成本

## Ordered Checklist

1. 抽出共用选择函数 `src/tools/select-experts.ts`：`hasProviderKey`、`selectExpertsForTool(config, ids, { defaultLimit })`，返回 `selected / ignored / skippedMissingKey / truncated`。consult 与 brainstorm 删除各自拷贝的 `selectExperts` / `selectDialogueExperts`（或改为薄封装）。
2. `handleConsultExperts`：先 trim 校验 `question`；默认路径 `defaultLimit = 3`；报告追加跳过/截断注记；默认筛完无人时返回带原因的 `isError`。
3. `handleBrainstorm`：先 trim 校验 `topic`；`rounds` 默认 1、`summarize` 默认 false；默认路径 `defaultLimit = 3`；同步改 schema `.describe()`；报告注记同 consult。显式名单仍受 `.max(6)`。
4. 测试（新建 `test/select-experts.test.ts` 和/或扩展工具层测试，风格对齐 `test/list-experts.test.ts`）：
   - 空 `question` / 空 `topic`：`isError`，中文错误，可用 mock adapter 断言 `chat` 次数为 0
   - 只有 `OPENAI_API_KEY`：默认 consult 不含 security/performance/product 的 ⚠️，注记含缺 key 原因
   - 5 人全有 key：默认 consult 只选前 3，`truncated` 含后 2
   - 显式 4 个 id：仍选 4 人，不截成 3；显式点到缺 key 专家该项失败
   - brainstorm 未传参：`rounds=1` 且无 summary 调用；显式 `rounds: 2, summarize: true` 仍生效
   - mock 模式：默认仍能选出专家（全部视为有 key）
5. README：consult / brainstorm 参数表对齐新默认；补 `parallel`。
6. 不改 `experts.json`。确认 smoke 仍通过（它已显式传 `architect`）。

## Validation Commands

```bash
npm test
npm run typecheck
npm run build
node scripts/smoke-stdio.mjs
```

## Risky Files / Rollback

| 文件 | 风险 |
| --- | --- |
| `src/tools/consult-experts.ts` | 默认行为变化；显式路径必须原样 |
| `src/tools/brainstorm.ts` | 默认 rounds/summarize/人数；schema describe 易漏 |
| `src/tools/select-experts.ts` | 新共享点，测漏会导致两工具漂移 |
| `README.md` | 文档与 schema 再不一致 |
| `experts.json` | **禁止修改** |
| `src/orchestrator/*`、`src/config.ts` 的 throw 文案 | 本轮不应改契约 |

回滚：删除新文件、还原两个 handler 的选择逻辑与默认值即可。

## Follow-ups (not this task)

- `list_experts` 标注缺 key
- brainstorm `context`
- CI / npm 发布
