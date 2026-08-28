# Implement — 流式咨询（卡粒度增量通知）

> 按 `design.md` 逐项实施。**每个步骤完成后立即验证**（typecheck 为最速反馈），全部完成后全量回归。

## 0. 前置确认（实现前必做）

1. 卡 id 取 `target.card.id`（`CardConfig.id` 唯一标识，见 `src/types.ts:62-64` 与 select-cards.ts 的 `ResolvedCard.card`）；展示名 `target.card.name`。
2. 确认 `McpServer` 从 `@modelcontextprotocol/sdk/server/mcp.js` 导出 import 路径（server.ts 已用）——`createMcpNotifier` 的依赖类型取自该模块。
3. 工作区基线：`git status` 干净（除 .trellis 规划产物），`npm run build && npm test` 全绿再动工。

## 1. 新增 `src/utils/notify.ts`（design §1）

```ts
export const STREAM_LOGGER = "talkio.stream";
export type StreamEvent =
  | { type: "consult.card"; card: string; status: "ok" | "failed" }
  | { type: "brainstorm.round"; round: number; total: number };
export interface StreamNotifier { (event: StreamEvent): void; }
export function createMcpNotifier(server: McpServer): StreamNotifier
```

- `createMcpNotifier` 返回 `(event) => void`，内部 `void server.sendLoggingMessage({ level: "info", logger: STREAM_LOGGER, data: event }).catch(() => {})`。
- 文件用 **LF 无 BOM**（filesystem-create 默认 UTF-8 LF；勿用 Windows 编辑器改）。

**验证**：`npm run typecheck` → 无类型错误。

## 2. 编排层扩展

### 2.1 `src/orchestrator/parallel.ts`（design §2.1）

- `runConsultation` options 增加 `notifier?: StreamNotifier`（从 `../utils/notify.js` import）。
  - 并行路径：`settled.map(...)` 产出 `items` 后、`finalize(items)` 前：
  `items.forEach(it => notifier?.({ type: "consult.card", card: it.target.card.id, status: it.ok ? "ok" : "failed" }))`。
- 串行路径：`items.push(await callExpert(...))` 后立即发同结构通知。
- **不触碰** `callExpert` / `resolveProvider` / `finalize` 内部逻辑。

**验证**：typecheck 绿；既有 orchestrator 用例绿（不传 notifier 时行为不变）。

### 2.2 `src/orchestrator/dialogue.ts`（design §2.2）

- `DialogueOptions` 增加 `notifier?: StreamNotifier`。
- 主循环三个分支（seed「continue 前」/ debate「allSettled forEach 后」/ relay「串行 for 后」）的**轮末**各插一条 `notifier?.({ type: "brainstorm.round", round, total: rounds })`。
- **不触碰** `askExpert` / `formatTranscriptForPrompt` / summary 逻辑。

**验证**：typecheck 绿；既有 dialogue 用例绿。

## 3. 接线层（design §3）

### 3.1 `src/tools/consult-experts.ts` / `src/tools/brainstorm.ts`

- handler 增加可选第三参 `deps?: { notifier?: StreamNotifier }`（import 类型）。
- `runConsultation(..., { context, parallel, notifier: deps?.notifier })` / `runDialogue(opts, config)` 中 `opts.notifier = deps?.notifier`。

### 3.2 `src/server.ts`

- `createServer` 闭包内 `const notifier = createMcpNotifier(server)`。
- 两个工具 handler 调用处传 `handleConsultExperts(args, config, { notifier })` / `handleBrainstorm(args, config, { notifier })`。
- `list_cards` 不动。

**验证**：`npm run typecheck && npm run build` 绿。

## 4. 测试

### 4.1 `test/orchestrator.test.ts` 扩展（design §5）

- fake notifier 收集 `StreamEvent[]`：
  - consult 3 卡（mock）→ 断言 3 条 `consult.card`、status 正确、card id 匹配；
  - 全失败 → 断言 3 条 failed 事件 **且** 返回聚合为 1 条（`items.length === 1`）；
  - brainstorm 2 轮 → 断言 2 条 `brainstorm.round`、round/total 正确；
  - 既有不传 notifier 用例**零改动**。

### 4.2 新增 `test/notify.test.ts`

- `createMcpNotifier` 包装**未连接**的 McpServer → 调用返回的 notifier 不抛异常（同步返回，内部 catch）；
- 载荷结构断言（类型 / STREAM_LOGGER 常量值）。

### 4.3 `scripts/smoke-stdio.mjs`（AC4）

- client `new Client(..., { capabilities: { logging: {} } })`；
- `await client.setLoggingLevel("info")` + `client.onNotification`/`onmessage` 收集 logger=STREAM_LOGGER 的通知；
- 新增断言：consult 调用后通知数 ≥ 卡数件、brainstorm 2 轮后 `brainstorm.round` 事件 total=2；
- 既有 14 项断言不动。

**验证**：`npm test`（预期 89 → ~95 用例）+ `node scripts/smoke-stdio.mjs`（预期 14 → 17-18 断言）全绿。

## 5. 全量收尾

1. `npm run typecheck && npm run build && npm test && node scripts/smoke-stdio.mjs` 全绿；
2. `npm run dev`（或既有 SSE 服务重启）手工联通验证一次 `notifications/message`（可选，stdio 已覆盖协议层）；
3. 回归确认：`git diff --stat` 仅含预期文件（`src/utils/notify.ts` 新增 + `parallel.ts`/`dialogue.ts`/`consult-experts.ts`/`brainstorm.ts`/`server.ts`/`test/*`/`scripts/smoke-stdio.mjs` 修改）；
4. 提交流程（**任何 git 操作先经用户确认**）：提交信息 `feat(mcp): 卡粒度流式增量通知（logging notifications）`；
5. `python .trellis/scripts/task.py finish` + 中文完成报告。

## 回滚点

- 若回归：`git stash` 暂存工作区改动即可回到基线（当前 HEAD d7a73fa 干净可用）；单体文件改坏了用 `git checkout -- <file>` 还原（某文件改动只在允许范围内）。
- `notify.ts` 独立新增、零依赖反向，删除即完全回归 R3 语义。

## 风险文件清单

| 文件 | 改动性质 | 风险 |
|---|---|---|
| `src/utils/notify.ts` | 新增 | 低（独立） |
| `src/orchestrator/parallel.ts` | 加 notifier 透传 + 2 处挂载 | 中（挂载点误插破坏 settle/finalize 时序） |
| `src/orchestrator/dialogue.ts` | 加 notifier 透传 + 3 处轮末挂载 | 中（relay 串行轮末最易漏） |
| `src/tools/consult-experts.ts` / `brainstorm.ts` | 第三参透传 | 低 |
| `src/server.ts` | 闭包构造 notifier + 传参 | 低 |
| `test/orchestrator.test.ts` / `test/notify.test.ts` / `scripts/smoke-stdio.mjs` | 新增/扩展 | 低 |