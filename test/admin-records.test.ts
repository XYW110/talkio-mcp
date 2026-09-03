import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminApi } from "../src/admin/api.js";
import { startSession } from "../src/records/store.js";

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
  const req = { method, url } as unknown as IncomingMessage;
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
  it("GET /api/records 返回会话列表；GET /api/records/:id 返回事件流", async () => {
    const sess = (await startSession(
      { tool: "brainstorm", prompt: "主题A" },
      dir,
    ))!;
    sess.finish({ status: "ok", report: "R" });
    await sess.flush();

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir });

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
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir });
    const res = makeReqRes("GET", "/api/records/20260101-000000-ffff");
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(404);
  });

  it("路径穿越 id 返回 404，不读文件", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir });
    const res = makeReqRes("GET", "/api/records/..%2F..%2Fexperts.json");
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(404);
  });

  it("recordsDir 未配置时列表返回空数组、详情 404", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json") });

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

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir });
    const res = makeReqRes("GET", "/api/records?limit=1");
    await handle(res.req, res.res);
    const list = JSON.parse(res.body()) as unknown[];
    expect(list).toHaveLength(1);
  });
});