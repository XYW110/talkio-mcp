/**
 * /api/chat → handleBrainstorm 接线测试（groupchat-p4 R1）。
 * 用 vi.mock 捕获 handleBrainstorm 的 (args, deps)，验证：
 * - memoryDir 透传（网页群聊与 MCP 面同享记忆）；
 * - interjections 校验（非数组 400 / afterRound 越界 400 / rounds=1 无间隙 400）
 *   与合法值透传（args.interjections 原样到达工具层）。
 * 后台 brainstorm 是 fire-and-forget：POST 返回 200 后轮询等待 mock 被调用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../src/utils/log.js";
import type { AppConfig } from "../src/types.js";

const captured = vi.hoisted(() => [] as Array<{ args: unknown; deps: unknown }>);

vi.mock("../src/tools/brainstorm.js", () => ({
  handleBrainstorm: vi.fn(
    async (args: unknown, _config: unknown, deps: unknown) => {
      captured.push({ args, deps });
      return {
        content: [{ type: "text", text: "mock 报告" }],
        isError: false,
      };
    },
  ),
}));

// createAdminApi 在 mock 生效后导入。
const { createAdminApi } = await import("../src/admin/api.js");

const stubConfig: AppConfig = {
  providers: {},
  experts: [],
  models: [],
  cards: [],
};
const logger = createLogger("error");

/** 与 admin-chat.test.ts 同款 SSE-capable req/res 桩（支持 POST body）。 */
function makeSseReqRes(method: string, url: string, body?: string) {
  let statusCode = 0;
  let written = "";
  type Listener = (chunk?: unknown) => void;
  const reqListeners: Record<string, Listener[]> = {};
  const req = {
    method,
    url,
    on(event: string, cb: Listener) {
      (reqListeners[event] ??= []).push(cb);
      if (event === "end") {
        if (body !== undefined && body !== "") {
          const buf = Buffer.from(body, "utf-8");
          for (const cb of reqListeners["data"] ?? []) cb(buf);
        }
        for (const cb of reqListeners["end"] ?? []) cb();
      }
    },
  } as unknown as IncomingMessage;
  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      void hdrs;
    },
    write(chunk: unknown) {
      if (typeof chunk === "string") written += chunk;
      else if (Buffer.isBuffer(chunk)) written += chunk.toString("utf-8");
    },
    end(payload?: unknown) {
      if (typeof payload === "string") written += payload;
    },
    on() {},
    statusCode: 0,
  } as unknown as ServerResponse;
  return { req, res, status: () => statusCode, chunks: () => written };
}

/** 等待后台 handleBrainstorm 被（第 n 次）调用，超时 2s。 */
async function waitForCall(n: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (captured.length < n) {
    if (Date.now() > deadline) throw new Error("handleBrainstorm 未被调用（超时）");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir: string;
let memoryDir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-admin-wire-"));
  memoryDir = await mkdtemp(path.join(tmpdir(), "talkio-admin-wire-mem-"));
  captured.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(memoryDir, { recursive: true, force: true });
});

describe("/api/chat → handleBrainstorm 接线（groupchat-p4 R1）", () => {
  it("合法请求：memoryDir 与 interjections 原样透传到工具层", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      memoryDir,
      config: stubConfig,
      logger,
    });

    const res = makeSseReqRes(
      "POST",
      "/api/chat",
      JSON.stringify({
        topic: "主题",
        rounds: 2,
        interjections: [{ afterRound: 1, message: "聚焦成本" }],
      }),
    );
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);

    await waitForCall(1);
    const { args, deps } = captured[0]!;
    expect(args).toMatchObject({
      topic: "主题",
      rounds: 2,
      interjections: [{ afterRound: 1, message: "聚焦成本" }],
    });
    expect((deps as { memoryDir?: string }).memoryDir).toBe(memoryDir);
  });

  it("interjections 非数组 → 400，且不触发后台调用", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      memoryDir,
      config: stubConfig,
      logger,
    });
    const res = makeSseReqRes(
      "POST",
      "/api/chat",
      JSON.stringify({ topic: "主题", interjections: "oops" }),
    );
    await handle(res.req, res.res);
    expect(res.status()).toBe(400);
    expect(res.chunks()).toContain("interjections 必须是数组");
    expect(captured).toHaveLength(0);
  });

  it("afterRound 越界（rounds=2 时取 2）→ 400 并指出合法区间", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      memoryDir,
      config: stubConfig,
      logger,
    });
    const res = makeSseReqRes(
      "POST",
      "/api/chat",
      JSON.stringify({
        topic: "主题",
        rounds: 2,
        interjections: [{ afterRound: 2, message: "越界" }],
      }),
    );
    await handle(res.req, res.res);
    expect(res.status()).toBe(400);
    expect(res.chunks()).toContain("[1, 1]");
    expect(captured).toHaveLength(0);
  });

  it("rounds=1 带插话 → 400（无轮间隙），文案与工具层一致", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      memoryDir,
      config: stubConfig,
      logger,
    });
    const res = makeSseReqRes(
      "POST",
      "/api/chat",
      JSON.stringify({
        topic: "主题",
        interjections: [{ afterRound: 1, message: "x" }],
      }),
    );
    await handle(res.req, res.res);
    expect(res.status()).toBe(400);
    expect(res.chunks()).toContain("没有可插话的轮间隙");
    expect(captured).toHaveLength(0);
  });

  it("空 message / 形态不符 → 400", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      memoryDir,
      config: stubConfig,
      logger,
    });
    const res = makeSseReqRes(
      "POST",
      "/api/chat",
      JSON.stringify({
        topic: "主题",
        rounds: 2,
        interjections: [{ afterRound: 1, message: "   " }],
      }),
    );
    await handle(res.req, res.res);
    expect(res.status()).toBe(400);
    expect(res.chunks()).toContain("message 非空");
  });
});
