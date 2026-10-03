/**
 * admin API /api/memory 路由测试（groupchat-strengths R5 / AC7）。
 * 覆盖：GET 总览（有记忆专家 + 配置内空态专家 + 名称解析回退）、
 * DELETE 单专家（成功 / 404 / 路径穿越拒绝）、memoryDir 未注入 404、
 * 目录不存在 → 空列表。
 * 鉴权 401 由 authGate 统一覆盖（/api/* 全量，见 09-30 auth 任务测试），
 * 本文件只测路由逻辑（与 admin-usage.test.ts 同款 req/res 桩）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminApi } from "../src/admin/api.js";
import { createLogger } from "../src/utils/log.js";
import { appendMemory } from "../src/experts/memory.js";
import type { AppConfig, ExpertConfig } from "../src/types.js";

const logger = createLogger("error");

/** 与 admin-usage.test.ts 同款的最小 req/res 桩。 */
function makeReqRes(
  method: string,
  url: string
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

function makeExpert(id: string, name: string, icon: string): ExpertConfig {
  return {
    id,
    name,
    icon,
    systemPrompt: `你是 ${name}`,
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    enabled: true,
    builtin: false,
  };
}

const config: AppConfig = {
  providers: {},
  experts: [makeExpert("architect", "架构师", "🏛️"), makeExpert("security", "安全官", "🔒")],
  models: [],
  cards: [],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-admin-mem-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeHandle(memoryDir?: string) {
  return createAdminApi({
    configPath: path.join(dir, "experts.json"),
    memoryDir,
    config,
    logger,
  });
}

describe("GET /api/memory", () => {
  it("有记忆的专家返回条目（名称/图标从配置解析），无记忆的配置专家列出空态", async () => {
    appendMemory(dir, "architect", "上次结论：选 B 方案");
    appendMemory(dir, "architect", "这个团队成本敏感");

    const handle = makeHandle(dir);
    const res = makeReqRes("GET", "/api/memory");
    const handled = await handle(res.req, res.res);

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    const payload = JSON.parse(res.body()) as Array<{
      expertId: string;
      expertName: string;
      icon: string;
      count: number;
      entries: Array<{ ts: string; text: string }>;
    }>;
    const arch = payload.find((p) => p.expertId === "architect");
    expect(arch).toMatchObject({
      expertId: "architect",
      expertName: "架构师",
      icon: "🏛️",
      count: 2,
    });
    expect(arch?.entries).toHaveLength(2);
    expect(arch?.entries[1]?.text).toBe("这个团队成本敏感");
    // security 无记忆但仍在配置中 → 空态条目
    const sec = payload.find((p) => p.expertId === "security");
    expect(sec).toMatchObject({ count: 0, entries: [] });
  });

  it("记忆属于已删除的专家：id 回退为名称，不因配置缺失而丢条目", async () => {
    appendMemory(dir, "ghost-expert", "遗留经验");

    const handle = makeHandle(dir);
    const res = makeReqRes("GET", "/api/memory");
    await handle(res.req, res.res);

    expect(res.status()).toBe(200);
    const payload = JSON.parse(res.body()) as Array<{ expertId: string; expertName: string }>;
    const ghost = payload.find((p) => p.expertId === "ghost-expert");
    expect(ghost?.expertName).toBe("ghost-expert");
    expect(ghost?.count).toBe(1);
  });

  it("memoryDir 未注入 → 404 记忆未启用", async () => {
    const handle = makeHandle(undefined);
    const res = makeReqRes("GET", "/api/memory");
    await handle(res.req, res.res);
    expect(res.status()).toBe(404);
    expect(res.body()).toContain("记忆未启用");
  });

  it("目录不存在（从未写过记忆）→ 200 + 配置内专家空态", async () => {
    const handle = makeHandle(path.join(dir, "no-such-memory"));
    const res = makeReqRes("GET", "/api/memory");
    await handle(res.req, res.res);
    expect(res.status()).toBe(200);
    const payload = JSON.parse(res.body()) as Array<{ expertId: string; count: number }>;
    // ENOENT 视为空列表：配置内专家仍列空态（与目录存在时形状一致）
    expect(payload).toHaveLength(2);
    expect(payload.every((p) => p.count === 0)).toBe(true);
    expect(payload.map((p) => p.expertId).sort()).toEqual(["architect", "security"]);
  });
});

describe("DELETE /api/memory/:expertId", () => {
  it("清空成功返回 { ok, expertId }，文件删除", async () => {
    appendMemory(dir, "architect", "x");
    const handle = makeHandle(dir);
    const res = makeReqRes("DELETE", "/api/memory/architect");
    const handled = await handle(res.req, res.res);

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({ ok: true, expertId: "architect" });
    // 再 GET：count=0
    const list = makeReqRes("GET", "/api/memory");
    await handle(list.req, list.res);
    const payload = JSON.parse(list.body()) as Array<{ expertId: string; count: number }>;
    expect(payload.find((p) => p.expertId === "architect")?.count).toBe(0);
  });

  it("该专家暂无记忆 → 404", async () => {
    const handle = makeHandle(dir);
    const res = makeReqRes("DELETE", "/api/memory/architect");
    await handle(res.req, res.res);
    expect(res.status()).toBe(404);
    expect(res.body()).toContain("暂无记忆");
  });

  it("路径穿越形态的 expertId 直接 404（不触碰文件系统）", async () => {
    // 先放一个会被误删的目标（若实现有穿越漏洞，experts.json 会被删掉）
    const victim = path.join(dir, "experts.json");
    await writeFile(victim, "{}");

    const handle = makeHandle(dir);
    const res = makeReqRes("DELETE", "/api/memory/..%2Fexperts.json");
    await handle(res.req, res.res);
    expect(res.status()).toBe(404);

    const victim2 = makeReqRes("DELETE", "/api/memory/..%2F..%2Fetc%2Fpasswd");
    await handle(victim2.req, victim2.res);
    expect(victim2.status()).toBe(404);

    // victims 未被触碰
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(victim, "utf-8")).toBe("{}");
  });
});

describe("杂项：非 .jsonl 文件与坏行不进入列表", () => {
  it("README.md / 坏行被跳过", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "README.md"), "not memory");
    await writeFile(path.join(dir, "bad.jsonl"), "not json\n");
    appendMemory(dir, "architect", "good");

    const handle = makeHandle(dir);
    const res = makeReqRes("GET", "/api/memory");
    await handle(res.req, res.res);

    const payload = JSON.parse(res.body()) as Array<{ expertId: string; count: number }>;
    expect(payload.find((p) => p.expertId === "README")).toBeUndefined();
    expect(payload.find((p) => p.expertId === "bad")).toBeUndefined();
    expect(payload.find((p) => p.expertId === "architect")?.count).toBe(1);
  });
});
