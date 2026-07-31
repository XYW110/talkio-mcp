import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, TimeoutError } from "../src/utils/retry.js";
import { getAdapter } from "../src/providers/registry.js";
import type { ChatParams } from "../src/providers/adapter.js";

/**
 * 契约（见 design.md §5/§7 与任务书）：
 *   fetchWithRetry(url, init, { timeoutMs, retries })
 *     - 429 / 5xx / 网络错误：指数退避重试（最多 retries 次，任务书要求支持到 3 次）
 *     - 400 / 401 / 403：不重试，直接抛错
 *     - AbortController 超时抛 TimeoutError
 *   getAdapter("openai" | "openai-compatible" | "anthropic"): ProviderAdapter
 *     - openai-compatible: POST {baseUrl}/chat/completions, Authorization: Bearer <key>
 *     - anthropic: POST {baseUrl}/v1/messages, x-api-key + anthropic-version, system 拆分
 */

const CREDS = { apiKey: "sk-test-key", baseUrl: "https://api.example.com/v1" };

function makeChatParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    model: "test-model",
    messages: [
      { role: "system", content: "你是专家" },
      { role: "user", content: "你好" },
    ],
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    ...overrides,
  };
}

/** 构造一个最小可用的 fetch Response 替身 */
function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

describe("fetchWithRetry 重试策略", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("首次 429 → 重试后成功返回", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(429, { error: "rate limited" }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const res = await fetchWithRetry("https://api.example.com/x", {}, { timeoutMs: 5000, retries: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("5xx 也会重试", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(502, "bad gateway"))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const res = await fetchWithRetry("https://api.example.com/x", {}, { timeoutMs: 5000, retries: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("401 → 不重试，直接抛错", async () => {
    fetchMock.mockResolvedValue(makeResponse(401, { error: "unauthorized" }));

    await expect(
      fetchWithRetry("https://api.example.com/x", {}, { timeoutMs: 5000, retries: 3 }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400 / 403 → 不重试，直接抛错", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(400, { error: "bad request" }));
    await expect(
      fetchWithRetry("https://api.example.com/x", {}, { timeoutMs: 5000, retries: 3 }),
    ).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(makeResponse(403, { error: "forbidden" }));
    await expect(
      fetchWithRetry("https://api.example.com/x", {}, { timeoutMs: 5000, retries: 3 }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(2); // 各 1 次，无重试
  });

  it("429 连续超过重试上限后抛错（调用次数 = 1 + retries）", async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { error: "rate limited" }));

    await expect(
      fetchWithRetry("https://api.example.com/x", {}, { timeoutMs: 5000, retries: 3 }),
    ).rejects.toThrow();
    // 首次 + 3 次重试 = 4 次
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("网络错误（TypeError）会重试", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const res = await fetchWithRetry("https://api.example.com/x", {}, { timeoutMs: 5000, retries: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("AbortSignal 超时 → 抛 TimeoutError", async () => {
    // fetch 永远挂起，直到被 abort
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    await expect(
      fetchWithRetry("https://api.example.com/slow", {}, { timeoutMs: 50, retries: 0 }),
    ).rejects.toThrow(TimeoutError);
  });

  it("抛出的错误不泄露 Authorization 头（密钥脱敏）", async () => {
    fetchMock.mockResolvedValue(makeResponse(401, { error: "unauthorized" }));

    const err = await fetchWithRetry(
      "https://api.example.com/x",
      { headers: { Authorization: "Bearer sk-secret-should-not-leak" } },
      { timeoutMs: 5000, retries: 0 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("sk-secret-should-not-leak");
  });
});

describe("openai-compatible adapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["openai", "openai-compatible"])("getAdapter(%s) 返回带 chat 方法的 adapter", (type) => {
    const adapter = getAdapter(type);
    expect(adapter).toBeDefined();
    expect(typeof adapter.chat).toBe("function");
  });

  it("请求：POST {baseUrl}/chat/completions，带 Bearer 头与正确请求体", async () => {
    fetchMock.mockResolvedValue(
      makeResponse(200, {
        choices: [{ message: { role: "assistant", content: "回答内容" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );

    const adapter = getAdapter("openai-compatible");
    await adapter.chat(makeChatParams(), CREDS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");

    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer sk-test-key");
    expect(headers.get("Content-Type")).toMatch(/application\/json/);

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([
      { role: "system", content: "你是专家" },
      { role: "user", content: "你好" },
    ]);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1024);
  });

  it("响应映射：content + usage 正确解析为 ChatResult", async () => {
    fetchMock.mockResolvedValue(
      makeResponse(200, {
        choices: [{ message: { role: "assistant", content: "专家回答" } }],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      }),
    );

    const adapter = getAdapter("openai");
    const result = await adapter.chat(makeChatParams(), CREDS);

    expect(result.content).toBe("专家回答");
    expect(result.usage?.promptTokens).toBe(11);
    expect(result.usage?.completionTokens).toBe(22);
  });
});

describe("anthropic adapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const anthropicCreds = { apiKey: "sk-ant-test", baseUrl: "https://api.anthropic.com" };

  function mockAnthropicOk(): void {
    fetchMock.mockResolvedValue(
      makeResponse(200, {
        content: [{ type: "text", text: "Claude 回答" }],
        usage: { input_tokens: 7, output_tokens: 13 },
      }),
    );
  }

  it("system 消息拆分为顶层 system 字段，messages 只含非 system 消息", async () => {
    mockAnthropicOk();

    const adapter = getAdapter("anthropic");
    await adapter.chat(makeChatParams(), anthropicCreds);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    const body = JSON.parse(String(init.body));
    expect(body.system).toBe("你是专家");
    expect(body.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(body.model).toBe("test-model");
    expect(body.max_tokens).toBe(1024);
  });

  it("请求头：x-api-key + anthropic-version，无 Authorization", async () => {
    mockAnthropicOk();

    const adapter = getAdapter("anthropic");
    await adapter.chat(makeChatParams(), anthropicCreds);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("响应映射：content[0].text + usage 正确解析", async () => {
    mockAnthropicOk();

    const adapter = getAdapter("anthropic");
    const result = await adapter.chat(makeChatParams(), anthropicCreds);

    expect(result.content).toBe("Claude 回答");
    expect(result.usage?.promptTokens).toBe(7);
    expect(result.usage?.completionTokens).toBe(13);
  });
});

describe("registry 边界行为", () => {
  it("未知 provider type 抛错", () => {
    expect(() => getAdapter("not-a-provider")).toThrow();
  });

  it("TALKIO_MOCK_PROVIDER=1 时返回 mock echo adapter", async () => {
    const original = process.env.TALKIO_MOCK_PROVIDER;
    process.env.TALKIO_MOCK_PROVIDER = "1";
    try {
      // mock 开关在模块加载时读取，需重新 import registry 才能生效
      vi.resetModules();
      const { getAdapter: freshGetAdapter } = await import("../src/providers/registry.js");
      const adapter = freshGetAdapter("openai");

      const result = await adapter.chat(makeChatParams(), CREDS);
      // echo mock：返回非空内容，且不发起真实 fetch（无需 stub fetch）
      expect(typeof result.content).toBe("string");
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      if (original === undefined) {
        delete process.env.TALKIO_MOCK_PROVIDER;
      } else {
        process.env.TALKIO_MOCK_PROVIDER = original;
      }
      vi.resetModules();
    }
  });
});
