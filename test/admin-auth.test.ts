import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createServer as createHttpServer,
  type Server,
} from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuthGate, classifyPath, resolveCredential } from "../src/auth/middleware.js";
import { McpTokenStore, sha256Hex } from "../src/auth/tokens.js";
import { createAdminApi } from "../src/admin/api.js";
import { createLogger } from "../src/utils/log.js";
import type { AppConfig } from "../src/types.js";

const logger = createLogger("error");
const stubConfig: AppConfig = { providers: {}, experts: [], models: [], cards: [] };

const ADMIN_TOKEN = "admin-test-token";
const MCP_PLAINTEXT = "mtok_test-mcp-token-plaintext";

let dir: string;
let store: McpTokenStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-admin-auth-"));
  // 预置一个明文已知的 MCP 令牌（直接落盘哈希，绕过 generate 的随机性）
  const fixtureFile = path.join(dir, "mcp-tokens.json");
  await writeFile(
    fixtureFile,
    JSON.stringify({
      version: 1,
      tokens: [
        {
          id: "mtok_fixture0000",
          name: "fixture",
          tokenHash: sha256Hex(MCP_PLAINTEXT),
          createdAt: "2026-09-30T00:00:00.000Z",
          lastUsedAt: null,
        },
      ],
    }),
    "utf8",
  );
  store = new McpTokenStore(fixtureFile, logger);
  await store.load();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── gate 专用 req/res 桩 ──

function makeGateReqRes(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number;
  resHeaders: () => Record<string, string>;
  body: () => string;
} {
  let statusCode = 0;
  const resHeaders: Record<string, string> = {};
  let data = "";
  const req = { method, url, headers } as unknown as IncomingMessage;
  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.assign(resHeaders, hdrs);
    },
    end(payload?: unknown) {
      if (typeof payload === "string") data += payload;
      else if (payload) data += String(payload);
    },
    statusCode: 0,
  } as unknown as ServerResponse;
  return {
    req,
    res,
    status: () => statusCode,
    resHeaders: () => resHeaders,
    body: () => data,
  };
}

function gateUrl(url: string): URL {
  return new URL(url, "http://localhost");
}

// ── 真实 listener 集成基座（gate + 简单 handler；gate 放行即 200）──

async function startTestServer(
  gate: ReturnType<typeof createAuthGate>,
  fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server: Server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await gate(req, res, url)) return;
    if (fallback) {
      await fallback(req, res);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── createAdminApi 专用 req/res 桩（沿 admin-records.test.ts 模式，支持 body）──

function makeReqRes(
  method: string,
  url: string,
): {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number;
  body: () => string;
} {
  let statusCode = 0;
  let data = "";
  type Listener = (chunk?: unknown) => void;
  const listeners: Record<string, Listener[]> = {};
  let reqBody: string | undefined;
  let emitted = false;
  const emit = () => {
    if (emitted) return;
    emitted = true;
    if (reqBody !== undefined && reqBody !== "") {
      const buf = Buffer.from(reqBody, "utf-8");
      for (const cb of listeners["data"] ?? []) cb(buf);
    }
    for (const cb of listeners["end"] ?? []) cb();
  };
  const req = {
    method,
    url,
    get body() {
      return reqBody;
    },
    set body(v: string | undefined) {
      reqBody = v;
    },
    on(event: string, cb: Listener) {
      (listeners[event] ??= []).push(cb);
      if (event === "end") emit();
    },
  } as unknown as IncomingMessage;
  const res = {
    writeHead(code: number, _headers?: unknown) {
      statusCode = code;
    },
    end(payload?: unknown) {
      if (typeof payload === "string") data += payload;
      else if (payload) data += String(payload);
    },
    statusCode: 0,
  } as unknown as ServerResponse;
  return { req, res, status: () => statusCode, body: () => data };
}

describe("路径分类与凭证解析", () => {
  it("classifyPath：/sse 与 /messages → mcp；/api* → api；其余 → static", () => {
    expect(classifyPath("/sse")).toBe("mcp");
    expect(classifyPath("/messages")).toBe("mcp");
    expect(classifyPath("/api")).toBe("api");
    expect(classifyPath("/api/config")).toBe("api");
    expect(classifyPath("/api/auth/check")).toBe("api");
    expect(classifyPath("/")).toBe("static");
    expect(classifyPath("/index.html")).toBe("static");
    expect(classifyPath("/assets/app.js")).toBe("static");
    expect(classifyPath("/apis")).toBe("static"); // 前缀不误判
  });

  it("resolveCredential：Bearer 头优先（大小写不敏感）→ ?token= 兜底 → null", () => {
    const req = (auth?: string) =>
      ({ headers: auth ? { authorization: auth } : {} }) as unknown as IncomingMessage;
    expect(resolveCredential(req("Bearer abc"), gateUrl("/x"))).toBe("abc");
    expect(resolveCredential(req("bearer abc"), gateUrl("/x"))).toBe("abc");
    expect(resolveCredential(req(), gateUrl("/x?token=qry"))).toBe("qry");
    // 头优先于 query
    expect(resolveCredential(req("Bearer hdr"), gateUrl("/x?token=qry"))).toBe("hdr");
    expect(resolveCredential(req(), gateUrl("/x"))).toBeNull();
    expect(resolveCredential(req("Basic abc"), gateUrl("/x"))).toBeNull();
  });
});

describe("鉴权门（真实 listener 集成）", () => {
  it("401：无凭证/错凭证 ×（/sse、/messages、/api/config）；含 WWW-Authenticate", async () => {
    const gate = createAuthGate({ adminToken: ADMIN_TOKEN, mcpTokens: store, logger });
    const { port, close } = await startTestServer(gate);
    try {
      const base = `http://127.0.0.1:${port}`;
      for (const path of ["/sse", "/messages?sessionId=x", "/api/config"]) {
        const noAuth = await fetch(`${base}${path}`);
        expect(noAuth.status).toBe(401);
        expect(noAuth.headers.get("www-authenticate")).toBe("Bearer");

        const bad = await fetch(`${base}${path}`, {
          headers: { Authorization: "Bearer totally-wrong" },
        });
        expect(bad.status).toBe(401);
        if (path.startsWith("/api")) {
          const body = (await bad.json()) as { error: string };
          expect(body.error).toBe("unauthorized");
        }
      }
    } finally {
      await close();
    }
  });

  it("放行：Bearer 头与 ?token= 兜底 ×（admin 面与 MCP 面）", async () => {
    const gate = createAuthGate({ adminToken: ADMIN_TOKEN, mcpTokens: store, logger });
    const { port, close } = await startTestServer(gate);
    try {
      const base = `http://127.0.0.1:${port}`;
      // admin 面
      const apiHdr = await fetch(`${base}/api/config`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(apiHdr.status).toBe(200);
      const apiQuery = await fetch(`${base}/api/config?token=${encodeURIComponent(ADMIN_TOKEN)}`);
      expect(apiQuery.status).toBe(200);
      // MCP 面
      const sseHdr = await fetch(`${base}/sse`, {
        headers: { Authorization: `Bearer ${MCP_PLAINTEXT}` },
      });
      expect(sseHdr.status).toBe(200);
      const sseQuery = await fetch(`${base}/sse?token=${encodeURIComponent(MCP_PLAINTEXT)}`);
      expect(sseQuery.status).toBe(200);
      const msgQuery = await fetch(`${base}/messages?sessionId=x&token=${encodeURIComponent(MCP_PLAINTEXT)}`, {
        method: "POST",
      });
      expect(msgQuery.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("两池隔离：admin token 打 /sse 401；MCP token 打 /api/config 401", async () => {
    const gate = createAuthGate({ adminToken: ADMIN_TOKEN, mcpTokens: store, logger });
    const { port, close } = await startTestServer(gate);
    try {
      const base = `http://127.0.0.1:${port}`;
      const adminOnMcp = await fetch(`${base}/sse`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(adminOnMcp.status).toBe(401);
      const mcpOnApi = await fetch(`${base}/api/config`, {
        headers: { Authorization: `Bearer ${MCP_PLAINTEXT}` },
      });
      expect(mcpOnApi.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("静态壳豁免：无凭证访问 / 与 /index.html 200（登录页可达）", async () => {
    const gate = createAuthGate({ adminToken: ADMIN_TOKEN, mcpTokens: store, logger });
    const { port, close } = await startTestServer(gate);
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/`)).status).toBe(200);
      expect((await fetch(`${base}/index.html`)).status).toBe(200);
      expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("fail-closed：admin env 未设置 → /api/* 与 /sse 全 401（含合法 MCP token 也拒），静态壳 200", async () => {
    const gate = createAuthGate({ adminToken: undefined, mcpTokens: store, logger });
    const { port, close } = await startTestServer(gate);
    try {
      const base = `http://127.0.0.1:${port}`;
      const api = await fetch(`${base}/api/config`);
      expect(api.status).toBe(401);
      const apiBody = (await api.json()) as { error: string; reason?: string };
      expect(apiBody.error).toBe("unauthorized");
      expect(apiBody.reason).toBe("admin_token_not_configured");

      expect((await fetch(`${base}/sse`)).status).toBe(401);
      expect(
        (
          await fetch(`${base}/sse`, {
            headers: { Authorization: `Bearer ${MCP_PLAINTEXT}` },
          })
        ).status,
      ).toBe(401);
      expect((await fetch(`${base}/`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("/api/auth/check：admin token 200 {role:admin}；无/错凭证 401", async () => {
    const gate = createAuthGate({ adminToken: ADMIN_TOKEN, mcpTokens: store, logger });
    // 接入真实 admin API，验证 gate 放行后的完整链路
    const handleAdmin = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      config: stubConfig,
      logger,
      mcpTokens: store,
    });
    const { port, close } = await startTestServer(gate, async (req, res) => {
      await handleAdmin(req, res);
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const ok = await fetch(`${base}/api/auth/check`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()) as { role: string }).toEqual({ role: "admin" });
      expect((await fetch(`${base}/api/auth/check`)).status).toBe(401);
      expect(
        (
          await fetch(`${base}/api/auth/check`, {
            headers: { Authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
    } finally {
      await close();
    }
  });
});

describe("鉴权门（stub req/res 单元级）", () => {
  it("gate 拒绝时返回 true 并写出 401；放行返回 false 不写响应", async () => {
    const gate = createAuthGate({ adminToken: ADMIN_TOKEN, mcpTokens: store, logger });

    const denied = makeGateReqRes("GET", "/api/config");
    expect(await gate(denied.req, denied.res, gateUrl("/api/config"))).toBe(true);
    expect(denied.status()).toBe(401);
    expect(denied.resHeaders()["WWW-Authenticate"]).toBe("Bearer");
    expect(JSON.parse(denied.body())).toEqual({ error: "unauthorized" });

    const allowed = makeGateReqRes("GET", "/api/config", {
      authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect(
      await gate(allowed.req, allowed.res, gateUrl("/api/config")),
    ).toBe(false);
    expect(allowed.status()).toBe(0);
  });
});

describe("admin API tokens CRUD + auth/check", () => {
  it("GET /api/auth/check 返回 {role:admin}", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      config: stubConfig,
      logger,
      mcpTokens: store,
    });
    const r = makeReqRes("GET", "/api/auth/check");
    expect(await handle(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(200);
    expect(JSON.parse(r.body())).toEqual({ role: "admin" });
  });

  it("POST 生成返回明文一次；GET 列表不含明文/哈希；DELETE 后立即失效", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      config: stubConfig,
      logger,
      mcpTokens: store,
    });

    // 生成
    const post = makeReqRes("POST", "/api/tokens");
    (post.req as { body?: unknown }).body = JSON.stringify({ name: "cursor-桌面" });
    expect(await handle(post.req, post.res)).toBe(true);
    expect(post.status()).toBe(200);
    const created = JSON.parse(post.body()) as {
      id: string;
      name: string;
      createdAt: string;
      plaintext: string;
    };
    expect(created.plaintext.startsWith("mtok_")).toBe(true);
    expect(created.name).toBe("cursor-桌面");
    expect(created.id.startsWith("mtok_")).toBe(true);

    // 列表：含指纹后 4 位，不含明文与哈希；未使用过 → lastUsedAt 为 null
    const list = makeReqRes("GET", "/api/tokens");
    expect(await handle(list.req, list.res)).toBe(true);
    expect(list.status()).toBe(200);
    const rawList = list.body();
    expect(rawList).not.toContain(created.plaintext);
    const tokens = JSON.parse(rawList) as Array<{
      id: string;
      name: string;
      createdAt: string;
      lastUsedAt: string | null;
      fingerprint: string;
    }>;
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    const createdRow = tokens.find((t) => t.id === created.id)!;
    expect(createdRow.fingerprint).toHaveLength(4);
    expect(createdRow.lastUsedAt).toBeNull();
    expect(Object.keys(createdRow).sort()).toEqual([
      "createdAt",
      "fingerprint",
      "id",
      "lastUsedAt",
      "name",
    ]);

    // 新明文可驱动 MCP 面；verify 后最近使用时间被更新
    expect(await store.verify(created.plaintext)).toBe(true);
    expect(store.list().find((t) => t.id === created.id)!.lastUsedAt).not.toBeNull();

    // 删除 → 立即失效
    const del = makeReqRes("DELETE", `/api/tokens/${encodeURIComponent(created.id)}`);
    expect(await handle(del.req, del.res)).toBe(true);
    expect(del.status()).toBe(200);
    expect(JSON.parse(del.body())).toEqual({ ok: true });
    expect(await store.verify(created.plaintext)).toBe(false);

    // 再删同一 id → 404
    const delAgain = makeReqRes("DELETE", `/api/tokens/${encodeURIComponent(created.id)}`);
    expect(await handle(delAgain.req, delAgain.res)).toBe(true);
    expect(delAgain.status()).toBe(404);
  });

  it("POST name 缺失/过长 → 400", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      config: stubConfig,
      logger,
      mcpTokens: store,
    });
    const empty = makeReqRes("POST", "/api/tokens");
    (empty.req as { body?: unknown }).body = JSON.stringify({ name: "  " });
    expect(await handle(empty.req, empty.res)).toBe(true);
    expect(empty.status()).toBe(400);

    const long = makeReqRes("POST", "/api/tokens");
    (long.req as { body?: unknown }).body = JSON.stringify({ name: "x".repeat(51) });
    expect(await handle(long.req, long.res)).toBe(true);
    expect(long.status()).toBe(400);
  });

  it("mcpTokens 未注入 → tokens 路由 404", async () => {
    const handle = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      config: stubConfig,
      logger,
    });
    const list = makeReqRes("GET", "/api/tokens");
    expect(await handle(list.req, list.res)).toBe(true);
    expect(list.status()).toBe(404);
  });
});
