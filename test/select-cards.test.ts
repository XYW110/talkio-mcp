import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig, CardConfig, ExpertConfig, ModelConfig } from "../src/types.js";
import {
  DEFAULT_CARD_LIMIT,
  formatSelectionNotes,
  resolveCard,
  selectCardsForTool,
} from "../src/tools/select-cards.js";

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

function makeExpert(id: string, overrides: Partial<ExpertConfig> = {}): ExpertConfig {
  return {
    id,
    name: `专家-${id}`,
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
  modelId = "test-model",
  overrides: Partial<ModelConfig> = {}
): ModelConfig {
  return {
    id,
    providerId,
    modelId,
    displayName: id,
    enabled: true,
    ...overrides,
  };
}

function makeCard(
  id: string,
  expertId: string,
  modelId: string,
  overrides: Partial<CardConfig> = {}
): CardConfig {
  return {
    id,
    name: id,
    expertId,
    modelId,
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

afterEach(() => {
  restoreEnv();
});

describe("resolveCard", () => {
  it("卡解析出专家,provider 名与真实模型名", () => {
    const config = councilConfig();
    const resolved = resolveCard(config.cards[0]!, config);

    expect(resolved).not.toBeNull();
    expect(resolved!.expert.id).toBe("architect");
    expect(resolved!.providerName).toBe("openai");
    expect(resolved!.modelId).toBe("test-model");
  });

  it("引用缺失时返回 null", () => {
    const config = councilConfig();
    const ghost = makeCard("c-ghost", "ghost-expert", "ghost-model");
    expect(resolveCard(ghost, config)).toBeNull();
  });
});

describe("selectCardsForTool 默认路径", () => {
  it("只保留 enabled ∩ 有 key，再按原顺序截到 defaultLimit", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const selection = selectCardsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_CARD_LIMIT,
    });
    expect(selection.selected.map((r) => r.card.id)).toEqual([
      "c-architect",
      "c-reviewer",
    ]);
    expect(selection.skippedMissingKey.map((s) => s.card.id)).toEqual([
      "c-security",
      "c-performance",
      "c-product",
    ]);
    expect(selection.skippedMissingKey.map((s) => s.apiKeyEnv)).toEqual([
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_API_KEY",
    ]);
    expect(selection.truncated).toEqual([]);
    expect(selection.ignored).toEqual([]);
  });

  it("五卡全有 key 时默认只取前 3，truncated 含后 2", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    process.env.DEEPSEEK_API_KEY = "sk-d";
    const selection = selectCardsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_CARD_LIMIT,
    });
    expect(selection.selected.map((r) => r.card.id)).toEqual([
      "c-architect",
      "c-security",
      "c-performance",
    ]);
    expect(selection.truncated.map((r) => r.card.id)).toEqual([
      "c-reviewer",
      "c-product",
    ]);
    expect(selection.skippedMissingKey).toEqual([]);
  });

  it("空数组与省略 ids 走同一默认路径", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const omitted = selectCardsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_CARD_LIMIT,
    });
    const empty = selectCardsForTool(councilConfig(), [], {
      defaultLimit: DEFAULT_CARD_LIMIT,
    });
    expect(empty.selected.map((r) => r.card.id)).toEqual(
      omitted.selected.map((r) => r.card.id)
    );
  });

  it("mock 模式把全部 enabled 视为有 key，再截 3 卡", () => {
    clearKeys();
    process.env.TALKIO_MOCK_PROVIDER = "1";
    const selection = selectCardsForTool(councilConfig(), undefined, {
      defaultLimit: DEFAULT_CARD_LIMIT,
    });
    expect(selection.selected.map((r) => r.card.id)).toEqual([
      "c-architect",
      "c-security",
      "c-performance",
    ]);
    expect(selection.skippedMissingKey).toEqual([]);
    expect(selection.truncated.map((r) => r.card.id)).toEqual([
      "c-reviewer",
      "c-product",
    ]);
  });
});

describe("selectCardsForTool 显式路径", () => {
  it("显式 4 个 id 不截成 3，也不因缺 key 剔除", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const selection = selectCardsForTool(
      councilConfig(),
      ["c-architect", "c-security", "c-performance", "c-reviewer"],
      { defaultLimit: DEFAULT_CARD_LIMIT }
    );
    expect(selection.selected.map((r) => r.card.id)).toEqual([
      "c-architect",
      "c-security",
      "c-performance",
      "c-reviewer",
    ]);
    expect(selection.skippedMissingKey).toEqual([]);
    expect(selection.truncated).toEqual([]);
  });

  it("未知或未启用 id 进入 ignored", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const config = councilConfig();
    config.cards[1] = makeCard("c-security", "security", "m-anthropic", {
      enabled: false,
    });
    const selection = selectCardsForTool(
      config,
      ["c-architect", "c-security", "ghost"],
      {
        defaultLimit: DEFAULT_CARD_LIMIT,
      }
    );
    expect(selection.selected.map((r) => r.card.id)).toEqual(["c-architect"]);
    expect(selection.ignored).toEqual(["c-security", "ghost"]);
  });
});

describe("formatSelectionNotes", () => {
  it("缺 key 与截断注记同时出现（角色卡）", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    // deepseek 缺 key → c-performance/c-product 跳过
    // 有 key: c-architect, c-security, c-reviewer；limit=2 → 截掉 c-reviewer
    const selection = selectCardsForTool(councilConfig(), undefined, {
      defaultLimit: 2,
    });
    const notes = formatSelectionNotes(selection, 2);
    expect(notes).toContain(
      "已跳过 c-performance（缺 DEEPSEEK_API_KEY）、c-product（缺 DEEPSEEK_API_KEY）"
    );
    expect(notes).toContain("默认最多 2 张角色卡，未包含: c-reviewer");
  });
});