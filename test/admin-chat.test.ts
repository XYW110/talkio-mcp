import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminApi } from "../src/admin/api.js";
import { createLogger } from "../src/utils/log.js";
import type { AppConfig } from "../src/types.js";

const stubConfig: AppConfig = {
  providers: {},
  experts: [],
  models: [],
  cards: [],
};
const logger = createLogger("error");

/**
 * SSE-capable req/res stub: supports writeHead / write / end / on('close').
 * Collects all written chunks so tests can inspect SSE frames.
 */
function makeSseReqRes(
  method: string,
  url: string,
  body?: string,
): {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number;
  headers: () => Record<string, string>;
  chunks: () => string;
  fireClose: () => void;
} {
  let statusCode = 0;
  const headers: Record<string, string> = {};
  let written = "";
  type Listener = (chunk?: unknown) => void;
  const reqListeners: Record<string, Listener[]> = {};
  const resListeners: Record<string, Listener[]> = {};

  const req = {
    method,
    url,
    on(event: string, cb: Listener) {
      (reqListeners[event] ??= []).push(cb);
      // For POST body: emit data+end right after both are registered.
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
      if (hdrs) Object.assign(headers, hdrs);
    },
    write(chunk: unknown) {
      if (typeof chunk === "string") written += chunk;
      else if (Buffer.isBuffer(chunk)) written += chunk.toString("utf-8");
    },
    end(payload?: unknown) {
      if (typeof payload === "string") written += payload;
    },
    on(event: string, cb: Listener) {
      (resListeners[event] ??= []).push(cb);
    },
    statusCode: 0,
  } as unknown as ServerResponse;

  return {
    req,
    res,
    status: () => statusCode,
    headers: () => headers,
    chunks: () => written,
    fireClose: () => {
      for (const cb of reqListeners["close"] ?? []) cb();
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-admin-chat-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("admin API /api/chat", () => {
  it("POST 缺少 topic 返回 400", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      config: stubConfig,
      logger,
    });
    const r = makeSseReqRes("POST", "/api/chat", JSON.stringify({}));
    await handle(r.req, r.res);
    expect(r.status()).toBe(400);
    const body = JSON.parse(r.chunks());
    expect(body.error).toContain("topic");
  });

  it("POST 有效 topic 返回 {ok, sessionId}", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      config: stubConfig,
      logger,
    });
    const r = makeSseReqRes("POST", "/api/chat", JSON.stringify({ topic: "测试话题" }));
    await handle(r.req, r.res);
    expect(r.status()).toBe(200);
    const body = JSON.parse(r.chunks()) as { ok: boolean; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeTruthy();
  });

  it("GET 缺少 session 参数返回 400", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      config: stubConfig,
      logger,
    });
    const r = makeSseReqRes("GET", "/api/chat");
    await handle(r.req, r.res);
    expect(r.status()).toBe(400);
  });

  it("GET 无效 session id 返回 400", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      config: stubConfig,
      logger,
    });
    const r = makeSseReqRes("GET", "/api/chat?session=bad-id");
    await handle(r.req, r.res);
    expect(r.status()).toBe(400);
  });

  it("GET 有效 session 返回 SSE 流头 + connected 注释行", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      recordsDir: dir,
      config: stubConfig,
      logger,
    });
    // 先 POST 拿到 sessionId
    const post = makeSseReqRes("POST", "/api/chat", JSON.stringify({ topic: "SSE 测试" }));
    await handle(post.req, post.res);
    const { sessionId } = JSON.parse(post.chunks()) as { sessionId: string };

    // GET 订阅 SSE
    const r = makeSseReqRes("GET", `/api/chat?session=${encodeURIComponent(sessionId)}`);
    await handle(r.req, r.res);
    expect(r.status()).toBe(200);
    expect(r.headers()["Content-Type"] ?? r.headers()["content-type"]).toContain(
      "text/event-stream",
    );
    // 第一行是 SSE 注释（: connected）
    expect(r.chunks()).toContain(": connected");
  });
});
