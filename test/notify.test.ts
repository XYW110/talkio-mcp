/**
 * notify.ts 单元测试 —— 流式增量通知模块。
 *
 * 覆盖点（对应 design.md §5）：
 * - STREAM_LOGGER 常量值稳定（R4：固定、可解析的 logger 名）。
 * - createMcpNotifier 包装未连接的 McpServer：同步不抛、不产生
 *   unhandled rejection（AC6 兜底：通知绝不阻塞/中断业务流）。
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { STREAM_LOGGER, createMcpNotifier } from "../src/utils/notify.js";

describe("notify — createMcpNotifier", () => {
  it("STREAM_LOGGER 常量为 talkio.stream", () => {
    expect(STREAM_LOGGER).toBe("talkio.stream");
  });

  it("包装未连接的 McpServer：调用不抛错（fire-and-forget 兜底 Not connected）", async () => {
    // 不 connect 任何 transport → 底层 notification() 会抛 "Not connected"
    const server = new McpServer(
      { name: "notify-test", version: "0.0.1" },
      { capabilities: { logging: {} } }
    );
    const notifier = createMcpNotifier(server);

    // 同步调用必须无异常返回（undefined）
    const ret = notifier({ type: "consult.card", card: "card-x", status: "ok" });
    expect(ret).toBeUndefined();

    // 等一拍，让内部的被 catch 的 rejection 结算完成（无 unhandled rejection 即通过）
    await new Promise((r) => setTimeout(r, 50));

    // brainst.orm.round 事件同样不抛
    expect(() =>
      notifier({ type: "brainstorm.round", round: 1, total: 2 })
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});
