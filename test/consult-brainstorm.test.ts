import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
} from "../src/providers/adapter.js";
import type { AppConfig, CardConfig, ExpertConfig, ModelConfig } from "../src/types.js";
import { startSession, type RecordSession } from "../src/records/store.js";

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
  overrides: Partial<ExpertConfig> = {}
): ExpertConfig {
  return {
    id,
    name: id,
    icon: "🤖",
    systemPrompt: `你是 ${id}`,
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    enabled: true,
    builtin: false,
    ...overrides,
  };
}

function makeModel(
  id: string,
  providerId: string,
  modelId = "test-model"
): ModelConfig {
  return { id, providerId, modelId, displayName: id, enabled: true };
}

function makeCard(
  id: string,
  expertId: string,
  modelId: string
): CardConfig {
  return { id, name: id, expertId, modelId, enabled: true };
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
      makeExpert("architect"),
      makeExpert("security"),
      makeExpert("performance"),
      makeExpert("reviewer"),
      makeExpert("product"),
    ],
    models: [
      makeModel("m-openai", "openai"),
      makeModel("m-anthropic", "anthropic"),
      makeModel("m-deepseek", "deepseek"),
      makeModel("m-openai-2", "openai"),
      makeModel("m-deepseek-2", "deepseek"),
    ],
    cards: [
      makeCard("c-architect", "architect", "m-openai"),
      makeCard("c-security", "security", "m-anthropic"),
      makeCard("c-performance", "performance", "m-deepseek"),
      makeCard("c-reviewer", "reviewer", "m-openai-2"),
      makeCard("c-product", "product", "m-deepseek-2"),
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

  it("只有 OPENAI_API_KEY 时默认不打缺 key 卡，报告含跳过说明", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const result = await handleConsultExperts(
      { question: "如何扩展？" },
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("c-architect");
    expect(text).toContain("c-reviewer");
    expect(text).not.toMatch(/missing env var/);
    expect(text).toContain("已跳过 c-security（缺 ANTHROPIC_API_KEY）");
    expect(text).toContain("c-performance（缺 DEEPSEEK_API_KEY）");
    expect(adapter.calls).toHaveLength(2);
  });

  it("五卡全有 key 时默认只打前 3 卡", async () => {
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
      "默认最多 3 张角色卡，未包含: c-reviewer, c-product"
    );
  });

  it("显式 4 个 id 仍打 4 卡；点到缺 key 的卡该项失败且全部失败才 isError", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const config = councilConfig(adapter);

    const partial = await handleConsultExperts(
      {
        question: "x",
        cards: ["c-architect", "c-security", "c-performance", "c-reviewer"],
      },
      config
    );
    // architect + reviewer 有 key 会打 adapter；security/performance 在凭据解析失败，不进 chat
    expect(adapter.calls).toHaveLength(2);
    expect(partial.isError).not.toBe(true);
    const partialText = textOf(partial);
    expect(partialText).toContain("c-architect");
    expect(partialText).toContain("c-security");
    expect(partialText).toContain("c-performance");
    expect(partialText).toContain("c-reviewer");
    expect(partialText).not.toContain("默认最多 3 张角色卡");
    expect(partialText).toMatch(/missing env var ANTHROPIC_API_KEY/);
    expect(partialText).toMatch(/missing env var DEEPSEEK_API_KEY/);

    adapter.calls.length = 0;
    const onlyMissing = await handleConsultExperts(
      { question: "x", cards: ["c-security"] },
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
    expect(textOf(result)).toContain("没有可调用的角色卡");
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

  it("未传参时 rounds=1 且默认总结：三把 key 齐时 3 次作答 + 1 次总结", async () => {
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
    expect(adapter.calls).toHaveLength(4);
    expect(textOf(result)).toContain("**轮数:** 1");
    expect(textOf(result)).toContain("### 讨论总结");
  });

it("显式 rounds=2 summarize=true 仍按用户指定跑", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstorm(
      {
        topic: "落地路径",
        cards: ["c-architect", "c-reviewer"],
        rounds: 2,
        summarize: true,
      },
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    // 2 cards × 2 rounds + 1 summary
    expect(adapter.calls).toHaveLength(5);
    expect(textOf(result)).toContain("**轮数:** 2");
    expect(textOf(result)).toContain("### 讨论总结");
  });
});

describe("会话记录落盘（record wiring）", () => {
  let recDir: string;
  beforeEach(async () => {
    recDir = await mkdtemp(path.join(tmpdir(), "talkio-recordwire-"));
    process.env.TALKIO_RECORDS = "1";
  });
  afterEach(async () => {
    delete process.env.TALKIO_RECORDS;
    await rm(recDir, { recursive: true, force: true });
  });

  async function readEvents(id: string): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(path.join(recDir, `${id}.jsonl`), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("consult 生成的记录含 meta/cards/card_result/done，且 done 带 usage", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const sess = (await startSession(
      { tool: "consult_experts", prompt: "如何扩展？" },
      recDir,
    ))!;
    const result = await handleConsultExperts(
      { question: "如何扩展？" },
      councilConfig(adapter),
      { record: sess }
    );
expect(result.isError).not.toBe(true);
    sess.finish({ status: "ok" });
    await sess.flush();

    const events = await readEvents(sess.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("meta");
    expect(types).toContain("cards");
    expect(types).toContain("card_result");
    expect(types).toContain("done");
    expect(events[0]!.type).toBe("meta");
    expect(events.at(-1)!.type).toBe("done");
  });

  it("brainstorm 记录含全轮次 turn/round_end 与可选 summary", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeEchoAdapter();
    const sess = (await createSession("brainstorm", recDir))!;
    const result = await handleBrainstorm(
      {
        topic: "落地路径",
        cards: ["c-architect", "c-reviewer"],
        rounds: 2,
        summarize: true,
      },
      councilConfig(adapter),
      { record: sess }
    );
expect(result.isError).not.toBe(true);
    sess.finish({ status: "ok" });
    await sess.flush();

    const events = await readEvents(sess.id);
    const types = events.map((e) => e.type);
    // 2 cards × 2 轮 = 4 条 turn + 2 条 round_end + 1 summary
    expect(types.filter((t) => t === "turn")).toHaveLength(4);
    expect(types.filter((t) => t === "round_end")).toHaveLength(2);
    expect(types).toContain("summary");
    expect(events.at(-1)!.type).toBe("done");
  });
});

// 小工具：便捷创建会话（meta 由 startSession 写入，done 由 finish 写入）
async function createSession(
  tool: "consult_experts" | "brainstorm" | "brainstorm_followup",
  recDir: string
): Promise<RecordSession | null> {
  return startSession({ tool, prompt: "x" }, recDir);
}