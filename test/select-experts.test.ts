import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig, ExpertConfig } from "../src/types.js";
import {
  DEFAULT_EXPERT_LIMIT,
  formatSelectionNotes,
  selectExpertsForTool,
} from "../src/tools/select-experts.js";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "TALKIO_MOCK_PROVIDER",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearKeys(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
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

function councilConfig(): AppConfig {
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

afterEach(() => {
  restoreEnv();
});

describe("selectExpertsForTool 默认路径", () => {
  it("只保留 enabled ∩ 有 key，再按原顺序截到 defaultLimit", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const selection = selectExpertsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_EXPERT_LIMIT,
    });
    expect(selection.selected.map((e) => e.id)).toEqual([
      "architect",
      "reviewer",
    ]);
    expect(selection.skippedMissingKey.map((s) => s.expert.id)).toEqual([
      "security",
      "performance",
      "product",
    ]);
    expect(selection.skippedMissingKey.map((s) => s.apiKeyEnv)).toEqual([
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_API_KEY",
    ]);
    expect(selection.truncated).toEqual([]);
    expect(selection.ignored).toEqual([]);
  });

  it("五人全有 key 时默认只取前 3，truncated 含后 2", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    process.env.DEEPSEEK_API_KEY = "sk-d";
    const selection = selectExpertsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_EXPERT_LIMIT,
    });
    expect(selection.selected.map((e) => e.id)).toEqual([
      "architect",
      "security",
      "performance",
    ]);
    expect(selection.truncated.map((e) => e.id)).toEqual([
      "reviewer",
      "product",
    ]);
    expect(selection.skippedMissingKey).toEqual([]);
  });

  it("空数组与省略 ids 走同一默认路径", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const omitted = selectExpertsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_EXPERT_LIMIT,
    });
    const empty = selectExpertsForTool(councilConfig(), [], {
      defaultLimit: DEFAULT_EXPERT_LIMIT,
    });
    expect(empty.selected.map((e) => e.id)).toEqual(
      omitted.selected.map((e) => e.id)
    );
  });

  it("mock 模式把全部 enabled 视为有 key，再截 3 人", () => {
    clearKeys();
    process.env.TALKIO_MOCK_PROVIDER = "1";
    const selection = selectExpertsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_EXPERT_LIMIT,
    });
    expect(selection.selected.map((e) => e.id)).toEqual([
      "architect",
      "security",
      "performance",
    ]);
    expect(selection.skippedMissingKey).toEqual([]);
    expect(selection.truncated.map((e) => e.id)).toEqual([
      "reviewer",
      "product",
    ]);
  });
});

describe("selectExpertsForTool 显式路径", () => {
  it("显式 4 个 id 不截成 3，也不因缺 key 剔除", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const selection = selectExpertsForTool(
      councilConfig(),
      ["architect", "security", "performance", "reviewer"],
      { defaultLimit: DEFAULT_EXPERT_LIMIT }
    );
    expect(selection.selected.map((e) => e.id)).toEqual([
      "architect",
      "security",
      "performance",
      "reviewer",
    ]);
    expect(selection.skippedMissingKey).toEqual([]);
    expect(selection.truncated).toEqual([]);
  });

  it("未知或未启用 id 进入 ignored", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const config = councilConfig();
    config.experts[1] = makeExpert("security", "anthropic", { enabled: false });
    const selection = selectExpertsForTool(
      config,
      ["architect", "security", "ghost"],
      {
        defaultLimit: DEFAULT_EXPERT_LIMIT,
      }
    );
    expect(selection.selected.map((e) => e.id)).toEqual(["architect"]);
    expect(selection.ignored).toEqual(["security", "ghost"]);
  });
});

describe("formatSelectionNotes", () => {
  it("缺 key 与截断注记同时出现", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    // deepseek 缺 key → performance/product 跳过
    // 有 key: architect, security, reviewer；limit=2 → 截掉 reviewer
    const selection = selectExpertsForTool(councilConfig(), undefined, {
      defaultLimit: 2,
    });
    const notes = formatSelectionNotes(selection, 2);
    expect(notes).toContain(
      "已跳过 performance（缺 DEEPSEEK_API_KEY）、product（缺 DEEPSEEK_API_KEY）"
    );
    expect(notes).toContain("默认最多 2 位专家，未包含: reviewer");
  });
});
