# Design — 流式咨询（卡粒度增量通知）

> 基于 PRD（R1-R6 / AC1-AC7）与 2026-08-29 源码/SDK 实证勘察。核心修正：**载体为 logging notification（`notifications/message`）**，经 `McpServer.sendLoggingMessage` 发送；非 progress notification（SDK 1.17 无 `sendProgress` 封装）。

## 0. SDK 实证结论（design 的决定性依据）

实测 `@modelcontextprotocol/sdk ^1.17.0`（node_modules 反编译勘察，非猜测）：

| 事实 | 位置 | 含义 |
|---|---|---|
| `McpServer.sendLoggingMessage(params, sessionId)` | `dist/esm/server/mcp.js:751` | **签名是 `({ level, logger?, data })` 单 params 对象**（更正 PRD 时期假设的三参形式）；`sessionId` 透传，无需关心 |
| 无订阅时静默 | `dist/esm/server/index.js:405-409` | `if (this._capabilities.logging)` 守卫 + `isMessageIgnored`（客户端未设 `logging/setLevel` 时 `_loggingLevels` 为空 → `currentLevel` undefined → **返回 false，照常发送**）。capability 已在 `server.ts:28` 声明 `{ logging: {} }` |
| **未连接时抛 `Not connected`** | `dist/esm/shared/protocol.js:790-792` | `notification()` 首行 `if (!this._transport) throw new Error('Not connected')` → 服务端包装**必须 try/catch**（AC6 的真正兜底点） |
| 协议 schema | `dist/esm/types.js:1400-1420` | `notifications/message` 的 params：`level: LoggingLevel`（7 档枚举）、`logger?: string`、`data: unknown`（任意 JSON 可序列化） |

结论：`sendLoggingMessage` 在「已连接但客户端未订阅」时照发不报错（客户端自会忽略），在「未连接」时抛错——唯一需要我方兜底的是后者。stdio 与 SSE 下 `notifications/message` 走同一条 `transport.send()` 路径，天然满足 R5。

## 1. 分层架构：新增独立通知模块 `src/utils/notify.ts`

```ts
/** 卡粒度增量通知的稳定 logger 名（R4：固定可解析）。 */
export const STREAM_LOGGER = "talkio.stream";

/** 通知载荷（R4：JSON 载荷，绝不携带 content 原文 —— PII 纪律）。 */
export type StreamEvent =
  | { type: "consult.card"; card: string; status: "ok" | "failed" }
  | { type: "brainstorm.round"; round: number; total: number };

/**
 * Optional incremental-notification sink injected into the orchestrators.
 * Implementations must never throw and must never block consultation.
 */
export interface StreamNotifier {
  (event: StreamEvent): void;
}

/** 把 McpServer 包装成永不抛错的 StreamNotifier（工厂，server.ts 闭包内调用）。 */
export function createMcpNotifier(server: McpServer): StreamNotifier;
```

- `createMcpNotifier` 实现：内部 `void server.sendLoggingMessage({ level: "info", logger: STREAM_LOGGER, data: event }).catch(() => {})` —— fire-and-forget，**吞掉 `Not connected`**（AC6），不 await（不阻塞编排）。
- `data` 即整个 `StreamEvent` 对象（SDK 允许 `data: unknown`），客户端按 `logger === "talkio.stream"` 识别后解析 JSON。level 固定 `info`（客户端订阅阈值 ≥info 时可见，行为最保守）。
- PII 纪律：载荷只含卡名/状态/轮次，**无 content、无 error 明文**（error 文本可能回显用户输入；即使卡名/状态也无泄漏面）。与 `redactPII`（发 LLM 前）和 `redactSecrets`（retry 层）互不替代、互不触碰。

## 2. 编排层注入点（options 扩展，非 provider 层）

### 2.1 `src/orchestrator/parallel.ts`（R1：每卡 settle 发一条）

- `runConsultation` 的 options 增加 `notifier?: StreamNotifier`。
- **挂载点选择**：在 `callExpert` 返回处不可行（并行时无 settle 时机句柄）→ 在**两个路径的结果映射之后、`finalize` 之前**逐 item 发：
  - 并行路径：`settled.map(...)` 产出 `items` 后 `items.forEach(it => notifier?.({ type: "consult.card", card: it.target.card.id, status: it.ok ? "ok" : "failed" }))`；
  - 串行路径：`items.push(await callExpert(...))` 后立即发（串行天然逐卡，通知即时性更好）。
- 注：通知发生在 `finalize()` 之前，因此**全失败压缩前每张卡都已各发一条** —— AC5 要求「增量通知逐卡失败」，与聚合后的返回值（压缩为 1 条）语义正好互补，无冲突。
- `card` 字段取 `it.target.card.id`（`CardConfig.id`，唯一标识、供 cards 参数引用，见 `src/types.ts:62-64, src/tools/select-cards.ts:21-28`）。

### 2.2 `src/orchestrator/dialogue.ts`（R2：每轮结束发一条，Q2 决议）

- `DialogueOptions` 增加 `notifier?: StreamNotifier`。
- **挂载点**：主循环 `for (let round = 1; round <= rounds; round++)` 的**每轮末尾**（三种分支——seed / debate / relay——各自 `Promise.allSettled` / 串行 for 收敛后），即每个分支块结束处发一条：
  `{ type: "brainstorm.round", round, total: rounds }`。
- relay 串行分支同样**每轮末**一条（轮内逐专家不发，遵守 Q2 决议）。

## 3. 接线层（server.ts 闭包 + 工具 handler 透传）

```
createServer(config)
  └─ const notifier = createMcpNotifier(server)          // server.ts 闭包内构造一次
       ├─ handleConsultExperts(args, config, { notifier })  // 新增可选第三参
       │    └─ runConsultation(..., { ..., notifier })
       └─ handleBrainstorm(args, config, { notifier })       // 新增可选第三参
            └─ runDialogue(opts, config)  // opts.notifier = notifier
```

- `handleConsultExperts` / `handleBrainstorm` 增加可选第三参数 `deps?: { notifier?: StreamNotifier }`（不传 = 行为与现状完全一致，既有测试零改动即可通过）。
- Provider 层（adapter/openai-compatible/anthropic/retry）**零改动**（约束）。
- 工具 schema、`CallToolResult`、`isError` 语义**零改动**（R3）。

## 4. 通知时机与可见性语义

| 场景 | 通知序列 | 最终返回（不变） |
|---|---|---|
| consult 并行 3 卡 2 成 1 败 | 3 条 `consult.card`（顺序 = settle 顺序，不保证与卡配置顺序一致） | 完整 Markdown 报告 |
| consult 串行 | 3 条逐卡（发一条→调下一张，天然进度条） | 同上 |
| consult 全败 | 3 条 failed 通知（**逐卡**，压缩前） | 压缩为 1 条的 isError 报告 |
| brainstorm debate 2 轮 | 2 条 `brainstorm.round`（round=1/total=2, round=2/total=2） | 实录 + 总结 |
| brainstorm relay 2 轮 3 卡 | 2 条（每轮末一条，非每专家一条） | 同上 |
| summarize 调用 | **不发**（总结不是一轮专家发言；Q2 粒度即轮） | 同上 |

## 5. 测试设计

- 单元（`test/orchestrator.test.ts` 扩展）：
  - 注入 fake `notifier`（数组收集事件），mock provider 下断言 consult 3 卡收到 3 条 `consult.card` 事件、字段齐全（AC1/AC2 协议层之下的编排层断言）；
  - 全失败用例断言 3 条 failed 事件且返回聚合为 1 条（AC5）；
  - 不传 notifier 的既有用例零改动（回归证明 R3/AC6 编排层）。
- 单元（新增 `test/notify.test.ts` 或并入 server 相关用例）：
  - `createMcpNotifier` 包装未连接 server 时 `sendLoggingMessage` reject → 不抛、不阻塞（AC6 单元层）；
  - 载荷不含 content/明文（AC2/PII）。
- 冒烟（`scripts/smoke-stdio.mjs`，AC4）：
  - client capabilities 增加 `logging: {}`（声明即接收 `notifications/message`）；
  - 注册 `onmessage`/`setLoggingLevel("info")` 收集通知；调用 consult（多卡）与 brainstorm 后断言：收到 ≥N 条 logger=`talkio.stream` 的 `notifications/message`，`data.type` 符合 AC2 格式；
  - 既有 14 项断言不动，新增 3-4 项。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `sendLoggingMessage` 未连接时抛 `Not connected` 污染编排 | 工厂内 `.catch(() => {})` + 不 await（§1，唯一兜底点） |
| 通知乱序/双通道（stdio 与 SSE 各自会话） | 不做去重/排序承诺（PRD 已明示顺序无保证）；单进程单会话语义 |
| 通知携带 PII | 载荷白名单字段（card/status/round/total），类型层面杜绝 content |
| 既有测试 stderr/stdout 断言破坏 | 通知走 MCP 协议通道，不经 console；handler 第三参可选，既有测试不传即旧行为 |
| `ResolvedCard` 字段名错误引用 | 已实证：卡 id = `it.target.card.id`（稳定唯一），展示名 = `it.target.card.name`，用 id |
| smoke client 未声明 logging capability 收不到通知 | smoke 脚本 client 加 `logging: {}` capability + `setLoggingLevel` |

## 7. AC 对照

- AC1（N 条增量）→ §2.1 + §5 orchestrator 用例 + smoke 计数
- AC2（格式）→ §1 `StreamEvent` 类型 + `STREAM_LOGGER` 常量
- AC3（返回逐字节一致）→ handler 层不改返回路径；既有测试零改动 + 新增用例锁定
- AC4（stdio 冒烟可观测）→ §5 smoke 扩展
- AC5（全失败 isError 不变）→ §4 通知在压缩前 + 既有聚合用例不动
- AC6（无订阅静默）→ §0 实证（未设 level 照发无害）+ §1 未连接兜底
- AC7（回归全绿）→ §5 既有 89 用例 + 新增 ~5-6 用例
