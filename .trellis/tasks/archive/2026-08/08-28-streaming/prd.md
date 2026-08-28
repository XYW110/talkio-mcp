# 流式咨询——结果逐步返回

## Goal

consult_experts / brainstorm 结果以流式方式逐步返回（SSE token 流 / stdio 分块），减少长咨询的首字节等待。V2 方向，需评估 MCP 协议流式约束、provider 适配、与现有编排器的集成点。

## Background（仓库勘察 · 已确认事实）

以下均来自源码勘察（2026-08-28，HEAD d7a73fa），非猜测：

### F1 · Provider 层无任何流式能力
- `src/providers/adapter.ts`：`ProviderAdapter` 只定义**非流式** `chat(params): Promise<ChatResult>`，`ChatResult { content, usage? }` 一次性返回
- `src/providers/openai-compatible.ts`：请求体无 `stream: true`；`await res.json()` 整体解析
- `src/providers/anthropic.ts`：同上，整体 `res.json()`
- 两个 adapter 均走 `fetchWithRetry`（`src/utils/retry.ts`），重试与流式读取存在张力：流式响应中途断连是否重试需要单独设计
- 三个 provider 类型（openai / anthropic / openai-compatible）上游 API 都支持 SSE 流式（`stream: true` / `stream: true`+events），但本项目未使用

### F2 · MCP 协议层：工具结果本身不流式
- `@modelcontextprotocol/sdk ^1.17.0`（package.json:27）
- 所有工具经 `server.registerTool`（src/server.ts:32,47,63）注册，handler 返回**完整** `CallToolResult`
- MCP 标准的 `tools/call` 是一次性请求-响应；协议层原生的「流式」只有 **progress notification**（`notifications/progress`，需请求方传 `_meta.progressToken`），用于进度上报，不是 token 级内容流
- SSE 传输（`SSEServerTransport`，src/index.ts:154）是长连接，但承载的仍是 JSON-RPC 消息，不改变工具结果的完整性语义

### F5 · MCP SDK 1.17 的增量通知载体（决定性技术事实）

- `ProgressSchema` / `ProgressNotificationSchema`（`notifications/progress`）**存在于 types.js**（协议层知晓），但底层 `Server` proto **没有任何 `sendProgress` / `sendNotification` 封装**（实测 `Object.getOwnPropertyNames(Server.prototype)` 仅有 `sendLoggingMessage` / `sendResourceUpdated` / `sendToolListChanged` / `sendPromptListChanged`）
- 高层 `McpServer` 同样没有 progress 发送方法；但**`sendLoggingMessage` 开箱可用**且 `server.ts` 已声明 `capabilities: { logging: {} }`
- 结论：**方案 A（卡粒度增量）的最稳妥载体是 logging notification（`notifications/message`），而非 progress notification**。logging 由 `McpServer.sendLoggingMessage(level, data, loggerName?)` 发出、客户端订阅 `logging/setLevel` + 监听 `notifications/message` 即可收到；零手动 JSON-RPC 构造，stdio / SSE 传输下同协议均可用
- progress notification 仍可作后续增强（需手动 `server.server` 底层构造投递），但 MVP 不必

### F6 · 完整返回语义保留（A 方案不破坏现有行为）
- 流式通知是**附加**通道：每张卡 settle 时发一条增量通知；全部完成后 handler 仍返回完整 `CallToolResult`（Markdown 报告），与当前 `consult_experts` / `brainstorm` 行为完全兼容
- 不新增/不修改任何工具 schema，不改变 `isError` 语义

### F3 · 编排层是「全完成才返回」
- `runConsultation`（src/orchestrator/parallel.ts）：`Promise.allSettled` 并行所有卡，全部 settle 后统一 `finalize()`（聚合 + `[summary]` 日志）→ 返回 `ConsultationItem[]`
- `runDialogue`（src/orchestrator/dialogue.ts）：逐轮 `Promise.allSettled`，全部轮次完成后返回 turns
- 工具 handler（src/tools/consult-experts.ts:69-82）：等编排完成 → `formatConsultReport` 拼完整 Markdown → 单个 text content 返回

### F4 · 现有可复用资产
- `[summary]` typeline 与分级 logger（上一任务产出）可作为流式场景的观测底座
- `admin-web` 管理界面已有 HTTP 通道（SSE 模式），如需自定义流式端点有现成挂载点

## Requirements

（Q1 已定：方案 A —— 卡粒度增量通知，载体为 logging notification）

- **R1** `consult_experts`：每张角色卡 settle（成功或失败）时，通过 `McpServer.sendLoggingMessage` 发一条 logging notification（`notifications/message`），携带卡名与成功/失败结果；全部卡完成后返回完整 Markdown 报告（行为不变）
- **R2** `brainstorm`：按**每轮结束**发一条增量通知（该轮完成后可见一轮产出边界），载体同 R1
- **R3** 通知为**附加**通道，不阻塞、不取代工具结果；不改变 `isError`、{content} 语义，不修改任何工具 schema
- **R4** loggerName / 消息体格式需稳定可解析（如固定 `talkio.stream` loggerName + JSON 载荷），供客户端可识别
- **R5** stdio 与 SSE 两种传输下通知均可达（同协议通知，不依赖 HTTP 专属通道）
- **R6** 无客户端订阅时不降级（发不出/无人收时静默，不影响返回）

## Acceptance Criteria

- [ ] AC1 调用 `consult_experts`（≥2 卡）时，客户端监听 `notifications/message` 能收到 N 条增量通知（N=卡数，成功/失败各带卡名）
- [ ] AC2 通知的 loggerName 与载荷格式符合 R4（固定可解析格式）
- [ ] AC3 完整返回的 `CallToolResult` 与未加流式时**逐字节一致**（回归不破坏）
- [ ] AC4 stdio 传输下 mock provider 冒烟（smoke-stdio）能观测到增量通知
- [ ] AC5 全部失败时：增量通知逐卡失败 + 最终 `isError` 语义不变
- [ ] AC6 无客户端订阅 logging 时，服务端照常完成咨询（不发/发但无人收，不抛错）
- [ ] AC7 typecheck/build/test 全绿；既有 89 用例不回归

## Out of Scope（初步）

- token 级真流式（方案 B，Q1 已排）
- 仅 admin-web 网页端流式（方案 C，Q1 已排）
- 多租户 / 分布式
- 脱敏开关、时间戳前缀（V1 已定不做）

## Open Questions（阻塞规划）

> Q1 已决议：方案 A —— 卡粒度增量通知，载体用 logging notification（F5 技术修正），进度通知 protocol 仍可用但 MVP 采用 zero-cost 的 logging。

> Q2 已决议：brainstorm 增量粒度为**每轮结束发一条**（非每张卡每次发言），见 R2。

## Notes

- Lightweight tasks can remain PRD-only；本任务为 complex（跨 provider/编排/协议三层），收敛后需补 `design.md` 与 `implement.md`。
