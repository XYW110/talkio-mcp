/**
 * 流式增量通知模块 —— 对应 design.md §1（streaming 任务）。
 *
 * 载体：MCP logging notification（`notifications/message`，经
 * `McpServer.sendLoggingMessage` 发送）。卡结算 / 每轮结束等进度事件
 * 以固定 logger 名 + JSON 载荷投递；客户端订阅 logging 即可实时观测。
 *
 * 关键技术点（来自 SDK ^1.17.0 实证）：
 * - `McpServer.sendLoggingMessage(params, sessionId)` 的 params 形如
 *   `{ level, logger?, data }`；data 可为任意 JSON 可序列化对象
 *   （types.js LoggingMessageNotificationParamsSchema, data: z.unknown()）。
 * - 无客户端设置 logging/setLevel 时 `isMessageIgnored` 返回 false（照发，
 *   客户端自行忽略）→ 无需额外探测（AC6 的「无订阅不降级」）。
 * - 底层 `notification()` 在 `!this._transport` 时抛 `Not connected`
 *   （protocol.js:790）。`mcp.js` 高层 `sendLoggingMessage` 未做 isConnected()
 *   守卫（对比 sendToolListChanged 有守卫），故该抛错是真实可达场景 →
 *   本模块统一 catch，保证通知绝不阻塞 / 中断编排（AC6 的兜底点）。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** 流式增量通知的稳定 logger 名（R4：固定、可解析）。 */
export const STREAM_LOGGER = "talkio.stream";

/**
 * 增量事件载荷（R4：JSON）。
 *
 * PII 纪律：只含卡标识 / 状态 / 轮次，**绝不含** content / error 明文
 * （error 文本可能回显用户输入）。与 redactPII（发往 LLM 前）、
 * redactSecrets（retry 层）互不替代、互不触碰。
 */
export type StreamEvent =
  | { type: "consult.card"; card: string; status: "ok" | "failed" }
  | { type: "brainstorm.round"; round: number; total: number }
  | { type: "brainstorm.vote" };

/** 编排器注入的可选增量通知回调。实现不得抛出、不得阻塞业务流。 */
export interface StreamNotifier {
  (event: StreamEvent): void;
}

/**
 * 把 McpServer 包装成一个永不抛错的 StreamNotifier（fire-and-forget）。
 * 调用方（createServer 闭包）构造一次即可注入所有工具。
 */
export function createMcpNotifier(server: McpServer): StreamNotifier {
  return (event: StreamEvent): void => {
    void server
      .sendLoggingMessage({
        level: "info",
        logger: STREAM_LOGGER,
        data: event,
      })
      .catch(() => {
        // 未连接（Not connected）/ 传输写入失败等一律吞掉：
        // 流式通知是附加通道，宁可静默也不破坏工具调用（AC6）。
      });
  };
}