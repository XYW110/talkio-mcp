# Implementation Plan — list_experts 标注缺 key

## Ordered Checklist

1. 导出 `missingKeyEnv`（`src/tools/select-experts.ts`）。
2. 扩展 `ExpertSummary`：`ready`、可选 `missingEnv`。`summarizeExpert(expert, config)` 调用 `hasProviderKey` / `missingKeyEnv`。
3. `handleListExperts`：payload 加 `readyCount`；Markdown 行在 disabled 后追加 ` · 缺 {missingEnv}`。
4. 测试（扩展 `test/list-experts.test.ts`）：
   - 只设一把 OpenAI key：architect `ready: true`；绑 anthropic 的专家 `ready: false` 且 Markdown/JSON 含 env 名
   - mock 模式：全部 `ready: true`，无 `missingEnv`
   - `includeDisabled=true` 仍含未启用；缺 key 不删项
   - 输出不含密钥明文
5. README：特性条与 list_experts 用法写清就绪/缺 env。
6. 不改 consult / brainstorm / `experts.json`。确认 smoke 仍过。

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
| `src/tools/list-experts.ts` | 摘要契约变化；`summarizeExpert` 签名变化 |
| `src/tools/select-experts.ts` | 仅导出已有函数，行为应不变 |
| `test/list-experts.test.ts` | 现有调用需补 `config` 参数 |
| `README.md` | 文档与输出再漂移 |

## Follow-ups

- brainstorm `context`
- LICENSE / CI / npm 元数据
