import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig, ExpertConfig } from "../src/types.js";
import {
  handleListExperts,
  selectListedExperts,
  summarizeExpert,
} from "../src/tools/list-experts.js";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TALKIO_MOCK_PROVIDER",
  "TEST_KEY",
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

function makeExpert(
  id: string,
  overrides: Partial<ExpertConfig> = {}
): ExpertConfig {
  return {
    id,
    name: `专家-${id}`,
    icon: "🤖",
    systemPrompt: `你是 ${id}，这段提示词不应出现在 list_experts 输出里。`,
    provider: "openai",
    model: "test-model",
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    enabled: true,
    ...overrides,
  };
}

function makeConfig(experts: ExpertConfig[]): AppConfig {
  return {
    providers: {
      openai: {
        type: "openai",
        baseUrl: "https://example.invalid",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      anthropic: {
        type: "anthropic",
        baseUrl: "https://example.invalid/anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
    },
    experts,
  };
}

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function parsePayload(text: string): {
  experts: Array<{
    id: string;
    ready: boolean;
    missingEnv?: string;
    enabled: boolean;
  }>;
  readyCount: number;
  count: number;
  enabledCount: number;
  totalCount: number;
} {
  const start = text.indexOf('{\n  "experts"');
  return JSON.parse(text.slice(start)) as ReturnType<typeof parsePayload>;
}

snapshotEnv();

afterEach(() => {
  restoreEnv();
});

describe("list_experts 发现工具", () => {
  it("默认只返回启用专家，且不含 systemPrompt", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const config = makeConfig([
      makeExpert("architect"),
      makeExpert("legacy", { enabled: false }),
    ]);
    const selected = selectListedExperts(config);
    expect(selected.map((e) => e.id)).toEqual(["architect"]);

    const result = await handleListExperts({}, config);
    const text = textOf(result);
    expect(text).toContain("architect");
    expect(text).not.toContain("legacy");
    expect(text).not.toContain("这段提示词不应出现");
    expect(summarizeExpert(config.experts[0]!, config).id).toBe("architect");
  });

  it("includeDisabled=true 时包含未启用专家", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const config = makeConfig([
      makeExpert("architect"),
      makeExpert("legacy", { enabled: false }),
    ]);
    const result = await handleListExperts({ includeDisabled: true }, config);
    const text = textOf(result);
    expect(text).toContain("legacy");
    expect(text).toContain("disabled");
  });

  it("只设 OPENAI_API_KEY 时标注缺 key 的专家，不从列表删除", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-secret-should-not-leak";
    const config = makeConfig([
      makeExpert("architect"),
      makeExpert("security", { provider: "anthropic" }),
      makeExpert("legacy", { enabled: false, provider: "anthropic" }),
    ]);
    const result = await handleListExperts({}, config);
    const text = textOf(result);
    const payload = parsePayload(text);

    expect(payload.experts.map((e) => e.id)).toEqual(["architect", "security"]);
    expect(payload.readyCount).toBe(1);
    expect(payload.experts.find((e) => e.id === "architect")).toMatchObject({
      ready: true,
    });
    expect(
      payload.experts.find((e) => e.id === "architect")?.missingEnv
    ).toBeUndefined();
    expect(payload.experts.find((e) => e.id === "security")).toMatchObject({
      ready: false,
      missingEnv: "ANTHROPIC_API_KEY",
    });
    expect(text).toContain("缺 ANTHROPIC_API_KEY");
    expect(text).toContain("security");
    expect(text).not.toContain("legacy");
    expect(text).not.toContain("sk-secret-should-not-leak");
  });

  it("includeDisabled=true 时可同时有 disabled 与缺 key 标注", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const config = makeConfig([
      makeExpert("architect"),
      makeExpert("legacy", { enabled: false, provider: "anthropic" }),
    ]);
    const result = await handleListExperts({ includeDisabled: true }, config);
    const text = textOf(result);
    const payload = parsePayload(text);
    const legacy = payload.experts.find((e) => e.id === "legacy");
    expect(legacy).toMatchObject({
      enabled: false,
      ready: false,
      missingEnv: "ANTHROPIC_API_KEY",
    });
    expect(text).toContain("disabled");
    expect(text).toContain("缺 ANTHROPIC_API_KEY");
  });

  it("mock 模式下全部 ready 且无 missingEnv", async () => {
    clearKeys();
    process.env.TALKIO_MOCK_PROVIDER = "1";
    const config = makeConfig([
      makeExpert("architect"),
      makeExpert("security", { provider: "anthropic" }),
    ]);
    const result = await handleListExperts({}, config);
    const payload = parsePayload(textOf(result));
    expect(payload.readyCount).toBe(2);
    expect(payload.experts.every((e) => e.ready)).toBe(true);
    expect(payload.experts.every((e) => e.missingEnv === undefined)).toBe(true);
    expect(textOf(result)).not.toContain(" · 缺 ");
  });
});
