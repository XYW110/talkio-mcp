import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminApi } from "../src/admin/api.js";
import { startSession } from "../src/records/store.js";
import { createLogger } from "../src/utils/log.js";
import type { AppConfig } from "../src/types.js";

/** createAdminApi 需要的配置桩（records 路由只用 recordsDir，config 仅为满足签名）。 */
const stubConfig: AppConfig = {
  providers: {},
  experts: [],
  models: [],
  cards: [],
};
const logger = createLogger("error");

/** 最小 req/res 桩：仅覆盖 createAdminApi 用到的 surface。 */
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
  // readBody 注册完 data/end 监听后派发，让它的 Promise 落定。
  // body 在 handle 之前注入（测试里 req.body = ...）或未注入（空 body）都成立。
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
      // "end" 在 "data" 之后注册（readBody 固定顺序），此时派发即可。
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
  return {
    req,
    res,
    status: () => statusCode,
    body: () => data,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-admin-records-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("admin API /api/records", () => {

  it("带 run 字段的事件可正常读取；旧 JSONL（无 run 字段）回归不变", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });

    // 新版（P3-A runs=2）：turn/round_end/vote/summary 事件带 run 字段
    const sess = (await startSession({ tool: "brainstorm", prompt: "多轮" }, dir))!;
    sess.append({ type: "turn", round: 1, expertId: "e1", expertName: "A", icon: "🤖", content: "c1", run: 1 });
    sess.append({ type: "round_end", round: 1, total: 1, run: 1 });
    sess.append({ type: "vote", round: 1, votes: [{ voterCardId: "c1", votedForAlias: "专家B", reason: "r" }], run: 1 });
    sess.append({ type: "summary", content: "s1", run: 1 });
    sess.append({ type: "turn", round: 1, expertId: "e1", expertName: "A", icon: "🤖", content: "c2", run: 2 });
    sess.append({ type: "round_end", round: 1, total: 1, run: 2 });
    sess.append({ type: "summary", content: "s2", run: 2 });
    sess.finish({ status: "ok" });
    await sess.flush();

    const detRes = makeReqRes("GET", `/api/records/${sess.id}`);
    expect(await handle(detRes.req, detRes.res)).toBe(true);
    expect(detRes.status()).toBe(200);
    const det = JSON.parse(detRes.body()) as { events: Array<Record<string, unknown>> };
    const runEvents = det.events.filter((e) => typeof e.run === "number");
    expect(runEvents.map((e) => e.run)).toEqual([1, 1, 1, 1, 2, 2, 2]);

    // 旧版 JSONL：事件无 run 字段，原样透传（不报错、不新增键）
    const legacyId = "20260101-000000-abcd";
    const legacyLines = [
      JSON.stringify({ type: "meta", id: legacyId, tool: "brainstorm", startedAt: "2026-01-01T00:00:00.000Z", prompt: "旧会话" }),
      JSON.stringify({ type: "turn", round: 1, expertId: "e1", expertName: "A", icon: "🤖", content: "old" }),
      JSON.stringify({ type: "round_end", round: 1, total: 1 }),
      JSON.stringify({ type: "summary", content: "old-sum" }),
      JSON.stringify({ type: "done", status: "ok" }),
    ].join("\n") + "\n";
    await writeFile(path.join(dir, `${legacyId}.jsonl`), legacyLines, "utf-8");
    const legacyRes = makeReqRes("GET", `/api/records/${legacyId}`);
    expect(await handle(legacyRes.req, legacyRes.res)).toBe(true);
    expect(legacyRes.status()).toBe(200);
    const legacy = JSON.parse(legacyRes.body()) as { events: Array<Record<string, unknown>> };
    expect(legacy.events.map((e) => e.type)).toEqual(["meta", "turn", "round_end", "summary", "done"]);
    for (const e of legacy.events) expect(e).not.toHaveProperty("run");
  });
  it("GET /api/records 返回会话列表；GET /api/records/:id 返回事件流", async () => {
    const sess = (await startSession(
      { tool: "brainstorm", prompt: "主题A" },
      dir,
    ))!;
    sess.finish({ status: "ok", report: "R" });
    await sess.flush();

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });

    // 列表
    const listRes = makeReqRes("GET", "/api/records");
    const listHandled = await handle(listRes.req, listRes.res);
    expect(listHandled).toBe(true);
    expect(listRes.status()).toBe(200);
    const list = JSON.parse(listRes.body()) as Array<{ id: string; tool: string; prompt: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(sess.id);
    expect(list[0]!.tool).toBe("brainstorm");
    expect(list[0]!.prompt).toBe("主题A");

    // 详情
    const detRes = makeReqRes("GET", `/api/records/${sess.id}`);
    const detHandled = await handle(detRes.req, detRes.res);
    expect(detHandled).toBe(true);
    expect(detRes.status()).toBe(200);
    const det = JSON.parse(detRes.body()) as { id: string; events: Array<{ type: string }> };
    expect(det.id).toBe(sess.id);
    expect(det.events.map((e) => e.type)).toEqual(["meta", "done"]);
  });

  it("未知 id 返回 404", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });
    const res = makeReqRes("GET", "/api/records/20260101-000000-ffff");
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(404);
  });

  it("路径穿越 id 返回 404，不读文件", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });
    const res = makeReqRes("GET", "/api/records/..%2F..%2Fexperts.json");
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(404);
  });

  it("recordsDir 未配置时列表返回空数组、详情 404", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), config: stubConfig, logger });

    const listRes = makeReqRes("GET", "/api/records");
    await handle(listRes.req, listRes.res);
    expect(listRes.status()).toBe(200);
    expect(JSON.parse(listRes.body())).toEqual([]);

    const detRes = makeReqRes("GET", "/api/records/20260101-000000-ffff");
    await handle(detRes.req, detRes.res);
    expect(detRes.status()).toBe(404);
  });

  it("limit 参数生效", async () => {
    const a = (await startSession({ tool: "brainstorm", prompt: "A" }, dir))!;
    const b = (await startSession({ tool: "brainstorm", prompt: "B" }, dir))!;
    a.finish({ status: "ok" });
    b.finish({ status: "ok" });
    await a.flush();
    await b.flush();

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });
    const res = makeReqRes("GET", "/api/records?limit=1");
    await handle(res.req, res.res);
    const list = JSON.parse(res.body()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it("DELETE /api/records 批量删除指定会话；未知 id 静默跳过", async () => {
    const a = (await startSession({ tool: "brainstorm", prompt: "A" }, dir))!;
    const b = (await startSession({ tool: "brainstorm", prompt: "B" }, dir))!;
    a.finish({ status: "ok" });
    b.finish({ status: "ok" });
    await a.flush();
    await b.flush();

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });
    const res = makeReqRes("DELETE", "/api/records");
    (res.req as { body?: unknown }).body = JSON.stringify({
      ids: [a.id, "20260101-000000-ffff", "..%2F..%2Fexperts.json"],
    });
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({ ok: true, deleted: 1 });

    // 只删掉了 a
    const listRes = makeReqRes("GET", "/api/records");
    await handle(listRes.req, listRes.res);
    const list = JSON.parse(listRes.body()) as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toEqual([b.id]);
  });

  it("DELETE /api/records 不带 ids 时清空全部", async () => {
    const a = (await startSession({ tool: "brainstorm", prompt: "A" }, dir))!;
    const b = (await startSession({ tool: "brainstorm", prompt: "B" }, dir))!;
    a.finish({ status: "ok" });
    b.finish({ status: "ok" });
    await a.flush();
    await b.flush();

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });
    const res = makeReqRes("DELETE", "/api/records");
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({ ok: true, deleted: 2 });

    const listRes = makeReqRes("GET", "/api/records");
    await handle(listRes.req, listRes.res);
    expect(JSON.parse(listRes.body())).toEqual([]);
  });

  it("DELETE /api/records 空 ids 数组视为清空；recordsDir 未配置返回 404", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, config: stubConfig, logger });
    const res = makeReqRes("DELETE", "/api/records");
    (res.req as { body?: unknown }).body = JSON.stringify({ ids: [] });
    await handle(res.req, res.res);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({ ok: true, deleted: 0 });

    const noDir = createAdminApi({ configPath: path.join(dir, "experts.json"), config: stubConfig, logger });
    const res404 = makeReqRes("DELETE", "/api/records");
    await noDir(res404.req, res404.res);
    expect(res404.status()).toBe(404);
  });
});
