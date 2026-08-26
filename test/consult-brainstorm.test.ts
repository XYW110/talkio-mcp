import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
} from "../src/providers/adapter.js";
import type { AppConfig, ExpertConfig } from "../src/types.js";

const { stubHolder } = vi.hoisted(() => ({
  stubHolder: { current: undefined as ProviderAdapter | undefined },
}));

vi.mock("../src/providers/registry.js", () => ({
  getAdapter: () => {
    if (!stubHolder.current) {
      throw new Error("test bug: stubHolder.current 未设置就调用了 getAdapter");
    }
    return stubHolder.current;
  },
  isMockProviderEnabled: () => process.env.TALKIO_MOCK_PROVIDER === "1",
}));

import { handleConsultExperts } from "../src/tools/consult-experts.js";
import { handleBrainstorm } from "../src/tools/brainstorm.js";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "TALKIO_MOCK_PROVIDER",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearKeys(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function makeStubAdapter(
  behavior: (params: ChatParams, callIndex: number) => Promise<ChatResult>
): ProviderAdapter & { calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResult> {
      calls.push(params);
      return behavior(params, calls.length - 1);
    },
  };
}

function makeEchoAdapter(): ProviderAdapter & { calls: ChatParams[] } {
  return makeStubAdapter(async (params) => ({
    content: `echo:${params.messages.at(-1)?.content ?? ""}`,
  }));
}

function makeExpert(
  id: string,
  provider: string,
  overrides: Partial<ExpertConfig> = {}
): ExpertConfig {
  return {
    id,
    name: id,
    icon: "🤖",
    systemPrompt: `你是 ${id}`,
    provider,
    model: "test-model",
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    enabled: true,
    ...overrides,
  };
}

function councilConfig(adapter: ProviderAdapter): AppConfig {
  stubHolder.current = adapter;
  return {
    providers: {
      openai: {
        type: "openai",
        baseUrl: "https://example.invalid/openai",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      anthropic: {
        type: "anthropic",
        baseUrl: "https://example.invalid/anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      deepseek: {
        type: "openai-compatible",
        baseUrl: "https://example.invalid/deepseek",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
    },
    experts: [
      makeExpert("architect", "openai"),
      makeExpert("security", "anthropic"),
      makeExpert("performance", "deepseek"),
      makeExpert("reviewer", "openai"),
      makeExpert("product", "deepseek"),
    ],
  };
}

snapshotEnv();

beforeEach(() => {
  stubHolder.current = undefined;
});

afterEach(() => {
  restoreEnv();
});

describe("handleConsultExperts", () => {
  it("空 question 立即 isError，不调用 adapter", async () => {
    const adapter = makeEchoAdapter();
    const result = await handleConsultExperts(
      { question: "   " },
      councilConfig(adapter)
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("question 不能为空");
    expect(adapter.calls).toHaveLength(0);
  });

  it("只有 OPENAI_API_KEY 时默认不打缺 key 专家，报告含跳过说明", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const result = await handleConsultExperts(
      { question: "如何扩展？" },
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("architect");
    expect(text).toContain("reviewer");
    expect(text).not.toMatch(/missing env var/);
    expect(text).toContain("已跳过 security（缺 ANTHROPIC_API_KEY）");
    expect(text).toContain("performance（缺 DEEPSEEK_API_KEY）");
    expect(adapter.calls).toHaveLength(2);
  });

  it("五人全有 key 时默认只打前 3 人", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    process.env.DEEPSEEK_API_KEY = "sk-d";
    const adapter = makeEchoAdapter();
    const result = await handleConsultExperts(
      { question: "x" },
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    expect(adapter.calls).toHaveLength(3);
    expect(textOf(result)).toContain(
      "默认最多 3 位专家，未包含: reviewer, product"
    );
  });

  it("显式 4 个 id 仍打 4 人；点到缺 key 的专家该项失败且全部失败才 isError", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const config = councilConfig(adapter);

    const partial = await handleConsultExperts(
      {
        question: "x",
        experts: ["architect", "security", "performance", "reviewer"],
      },
      config
    );
    // architect + reviewer 有 key 会打 adapter；security/performance 在凭据解析失败，不进 chat
    expect(adapter.calls).toHaveLength(2);
    expect(partial.isError).not.toBe(true);
    const partialText = textOf(partial);
    expect(partialText).toContain("architect");
    expect(partialText).toContain("security");
    expect(partialText).toContain("performance");
    expect(partialText).toContain("reviewer");
    expect(partialText).not.toContain("默认最多 3 位专家");
    expect(partialText).toMatch(/missing env var ANTHROPIC_API_KEY/);
    expect(partialText).toMatch(/missing env var DEEPSEEK_API_KEY/);

    adapter.calls.length = 0;
    const onlyMissing = await handleConsultExperts(
      { question: "x", experts: ["security"] },
      config
    );
    expect(onlyMissing.isError).toBe(true);
    expect(adapter.calls).toHaveLength(0);
  });

  it("默认无人可调用时 isError 并说明缺 key，不打 adapter", async () => {
    clearKeys();
    const adapter = makeEchoAdapter();
    const result = await handleConsultExperts(
      { question: "x" },
      councilConfig(adapter)
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("没有可调用的专家");
    expect(textOf(result)).toContain("缺 OPENAI_API_KEY");
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("handleBrainstorm", () => {
  it("空 topic 立即 isError，不调用 adapter", async () => {
    const adapter = makeEchoAdapter();
    const result = await handleBrainstorm(
      { topic: "" },
      councilConfig(adapter)
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("topic 不能为空");
    expect(adapter.calls).toHaveLength(0);
  });

  it("未传参时 rounds=1 且不总结：三把 key 齐时最多 3 次 LLM", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    process.env.DEEPSEEK_API_KEY = "sk-d";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstorm(
      { topic: "落地路径" },
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    expect(adapter.calls).toHaveLength(3);
    expect(textOf(result)).toContain("**轮数:** 1");
    expect(textOf(result)).not.toContain("### 讨论总结");
  });

  it("显式 rounds=2 summarize=true 仍按用户指定跑", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstorm(
      {
        topic: "落地路径",
        experts: ["architect", "reviewer"],
        rounds: 2,
        summarize: true,
      },
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    // 2 experts × 2 rounds + 1 summary
    expect(adapter.calls).toHaveLength(5);
    expect(textOf(result)).toContain("**轮数:** 2");
    expect(textOf(result)).toContain("### 讨论总结");
  });
});
