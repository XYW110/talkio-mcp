import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminApi } from "../src/admin/api.js";
import { KeysStore, setKeysStore } from "../src/keys/store.js";
import { createLogger } from "../src/utils/log.js";
import type { AppConfig } from "../src/types.js";
import { expectNoKeyFragment } from "./helpers/keys.js";

/**
 * admin API /api/keys + PUT /api/config 热生效（任务 09-30-provider-keys-ui）：
 * - GET /api/keys 掩码列表：只有 providerId/hasKey/指纹尾4位/updatedAt，绝无明文；
 * - PUT /api/keys/:pid 写入即热生效（内存 + 落盘），空串清除，未知 pid 404；
 * - 掩码红线：任何 /api/keys 响应 grep 明文片段必须 0 命中；
 * - PUT /api/config 校验通过后原位替换 configRef（热生效）；非法 → 400 且不写盘。
 * 鉴权 401 门禁由 authGate 统一覆盖（/api/* 全拦，见 test/admin-auth.test.ts），
 * 这里直连 handleAdmin 验证路由语义。
 */
const logger = createLogger("error");

/** 带 apiKeyEnv 遗留字段的 provider 桩：验证字段宽容忽略不影响 keys 路由 */
const stubConfig: AppConfig = {
  providers: {
    custom: {
      type: "openai-compatible",
      baseUrl: "https://api.example.invalid/v1",
      apiKeyEnv: "CUSTOM_API_KEY",
    },
    ghost: { type: "openai", baseUrl: "https://ghost.example.invalid" },
  },
  experts: [],
  models: [],
  cards: [],
};

/** 合法三段配置（PUT /api/config 热生效用例的请求体） */
const validConfigBody = JSON.stringify({
  providers: {
    ...stubConfig.providers,
    extra: { type: "openai", baseUrl: "https://extra.example.invalid" },
  },
  experts: [
    {
      id: "e1",
      name: "专家",
      icon: "🤖",
      systemPrompt: "你是测试专家",
      temperature: 0.7,
      maxTokens: 100,
      timeoutMs: 1000,
      enabled: true,
    },
  ],
  models: [
    {
      id: "m1",
      providerId: "custom",
      modelId: "test-model",
      displayName: "M",
      enabled: true,
    },
  ],
  cards: [
    { id: "c1", name: "卡", expertId: "e1", modelId: "m1", enabled: true },
  ],
});

const PLAINTEXT = "sk-secret-1234567890abcd";

/** 最小 req/res 桩：与 admin-records.test.ts 同款。 */
function makeReqRes(
  method: string,
  url: string,
  body?: string,
): {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number;
  bodyText: () => string;
} {
  let statusCode = 0;
  let data = "";
  type Listener = (chunk?: unknown) => void;
  const listeners: Record<string, Listener[]> = {};
  let reqBody = body;
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
  return { req, res, status: () => statusCode, bodyText: () => data };
}

let dir: string;
let keys: KeysStore;
let handleAdmin: ReturnType<typeof createAdminApi>;
const configRef = { config: stubConfig };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-admin-keys-"));
  await writeFile(
    path.join(dir, "experts.json"),
    JSON.stringify(stubConfig),
    "utf-8"
  );
  // 内存模式密钥池；同时挂到进程级单例（对齐 index.ts 装配：凭据解析读同一池）
  keys = new KeysStore();
  setKeysStore(keys);
  configRef.config = stubConfig;
  handleAdmin = createAdminApi({
    configPath: path.join(dir, "experts.json"),
    configRef,
    keys,
    logger,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  setKeysStore(new KeysStore());
});

describe("admin API /api/keys", () => {
  it("keys 未注入 → 404（与 mcpTokens 缺省同语义）", async () => {
    const noKeys = createAdminApi({
      configPath: path.join(dir, "experts.json"),
      configRef,
      logger,
    });
    const r = makeReqRes("GET", "/api/keys");
    expect(await noKeys(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(404);
  });

  it("GET 返回掩码列表：hasKey/指纹尾4位/updatedAt，未配置渠道无指纹字段", async () => {
    await keys.set("custom", PLAINTEXT);
    const r = makeReqRes("GET", "/api/keys");
    expect(await handleAdmin(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(200);
    const payload = JSON.parse(r.bodyText()) as Array<{
      providerId: string;
      hasKey: boolean;
      fingerprint?: string;
      updatedAt?: string;
    }>;
    expect(payload.map((p) => p.providerId)).toEqual(["custom", "ghost"]);
    expect(payload[0]).toMatchObject({
      providerId: "custom",
      hasKey: true,
      fingerprint: PLAINTEXT.slice(-4),
    });
    expect(typeof payload[0]!.updatedAt).toBe("string");
    expect(payload[1]).toEqual({ providerId: "ghost", hasKey: false });
    // 掩码红线：响应不含明文，也不含尾 4 位指纹之外的任何片段
    expect(r.bodyText()).not.toContain(PLAINTEXT);
    expectNoKeyFragment(r.bodyText(), PLAINTEXT);
  });

  it("PUT 写入即热生效：同实例 get 立即可见，GET 列表反映，响应无明文", async () => {
    const r = makeReqRes(
      "PUT",
      "/api/keys/custom",
      JSON.stringify({ apiKey: PLAINTEXT })
    );
    expect(await handleAdmin(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(200);
    const body = JSON.parse(r.bodyText()) as {
      ok: boolean;
      providerId: string;
      hasKey: boolean;
      fingerprint: string;
    };
    expect(body).toMatchObject({
      ok: true,
      providerId: "custom",
      hasKey: true,
      fingerprint: PLAINTEXT.slice(-4),
    });
    expect(r.bodyText()).not.toContain(PLAINTEXT);
    expectNoKeyFragment(r.bodyText(), PLAINTEXT);
    // 热生效：凭据解析用的同一单例立即可读到新 key
    expect(keys.get("custom")).toBe(PLAINTEXT);
  });

  it("PUT 空串清除该渠道密钥", async () => {
    await keys.set("custom", PLAINTEXT);
    const r = makeReqRes("PUT", "/api/keys/custom", JSON.stringify({ apiKey: "" }));
    expect(await handleAdmin(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(200);
    const body = JSON.parse(r.bodyText()) as { hasKey: boolean };
    expect(body.hasKey).toBe(false);
    expect(keys.get("custom")).toBeUndefined();
  });

  it("PUT 未知 providerId → 404", async () => {
    const r = makeReqRes(
      "PUT",
      "/api/keys/no-such-provider",
      JSON.stringify({ apiKey: PLAINTEXT })
    );
    expect(await handleAdmin(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(404);
  });

  it("PUT apiKey 非字符串 → 400", async () => {
    const r = makeReqRes("PUT", "/api/keys/custom", JSON.stringify({ apiKey: 123 }));
    expect(await handleAdmin(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(400);
  });
});

describe("admin API PUT /api/config 热生效（R4）", () => {
  it("合法配置写盘后原位替换 configRef，GET /api/keys 立即列出新增渠道", async () => {
    const r = makeReqRes("PUT", "/api/config", validConfigBody);
    expect(await handleAdmin(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(200);
    expect(JSON.parse(r.bodyText())).toEqual({ ok: true });

    // 内存持有者已替换（新增 provider "extra"）
    expect(Object.keys(configRef.config.providers)).toContain("extra");
    // 磁盘 ≈ 内存
    const onDisk = JSON.parse(
      await readFile(path.join(dir, "experts.json"), "utf-8")
    ) as { providers: Record<string, unknown> };
    expect(Object.keys(onDisk.providers)).toContain("extra");

    const kr = makeReqRes("GET", "/api/keys");
    expect(await handleAdmin(kr.req, kr.res)).toBe(true);
    const payload = JSON.parse(kr.bodyText()) as Array<{ providerId: string }>;
    expect(payload.map((p) => p.providerId)).toContain("extra");
  });

  it("非法配置（cards 为空）→ 400 且不写盘，configRef 保持旧值", async () => {
    const before = await readFile(path.join(dir, "experts.json"), "utf-8");
    const bad = JSON.parse(validConfigBody) as { cards: unknown };
    bad.cards = [];
    const r = makeReqRes("PUT", "/api/config", JSON.stringify(bad));
    expect(await handleAdmin(r.req, r.res)).toBe(true);
    expect(r.status()).toBe(400);
    expect(r.bodyText()).toContain("配置校验失败");

    expect(await readFile(path.join(dir, "experts.json"), "utf-8")).toBe(before);
    expect(Object.keys(configRef.config.providers)).not.toContain("extra");
  });
});
