# implement — 会话记录落盘

## 执行步骤

1. **`src/records/store.ts`**：实现 `resolveRecordsDir` / `isRecordingEnabled` / `startSession` / `listSessions` / `readSession`（design §2）。全部 IO 吞错 + warn。
2. **usage 扩展**：`dialogue.ts` 的 `askExpert` 返回 `{content, usage}`；`DialogueTurn` 加可选 `usage`；dialogue 引擎 / followup 调用点同步取 `.content` 并透传 usage。
3. **handlers 接线**（consult-experts.ts / brainstorm.ts / brainstorm-followup.ts）：`deps.record?: RecordSession`，按 design §3.2–3.4 写 meta / 事件 / done。report 全文进 done 行。
4. **server.ts**：`createServer(config, {recordsDir?})`，闭包内 `startSession`，writer 注入 handlers；`list_cards` 不记录。
5. **index.ts / admin api.ts**：recordsDir 解析与注入；新增 `GET /api/records`、`GET /api/records/:id`。
6. **`.gitignore`**：加 `/records/`。
7. **测试**：新增 `test/records.test.ts` + admin API 路由测试；`consult-brainstorm.test.ts` 增补记录断言。
8. **验证**：`npm run typecheck` + `npm test` → mock 冒烟 → 真实端点（v4-flash 卡）跑一轮 consult 确认真实记录落盘。

## 边界

- 不动 MCP 工具对外契约；`list_cards` 不产生记录。
- 记录失败只 warn（logging-guidelines：stderr、结构化前缀 `[records]`）。
