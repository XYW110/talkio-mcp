import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig, CardConfig, ExpertConfig, ModelConfig } from "../src/types.js";
import type { KeysStore } from "../src/keys/store.js";
import { MISSING_KEY_HINT } from "../src/tools/select-cards.js";
import {
  handleListCards,
  selectListedCards,
  summarizeCard,
} from "../src/tools/list-cards.js";
import { installKeysStore } from "./helpers/keys.js";

/** 渠道密钥 fixture：进程级 keys store（内存模式），替代旧 env 方案 */
let keys: KeysStore;

beforeEach(() => {
  keys = installKeysStore();
});

// mock 开关仍走 env（registry 读取）；用完即清，避免影响同 worker 后续文件
afterEach(() => {
  delete process.env.TALKIO_MOCK_PROVIDER;
});

function makeExpert(id: string, overrides: Partial<ExpertConfig> = {}): ExpertConfig {
  return {
    id,
    name: `专家-${id}`,
    icon: "🤖",
    systemPrompt: `你是 ${id}，这段提示词不应出现在 list_cards 输出里。`,
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
  displayName = id,
  overrides: Partial<ModelConfig> = {}
): ModelConfig {
  return {
    id,
    providerId,
    modelId,
    displayName,
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

function makeConfig(
  cards: CardConfig[],
  experts: ExpertConfig[],
  models: ModelConfig[]
): AppConfig {
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
    models,
    cards,
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
  cards: Array<{
    id: string;
    ready: boolean;
    missingReason?: string;
    enabled: boolean;
    provider: string;
    model: string;
  }>;
  readyCount: number;
  count: number;
  enabledCount: number;
  totalCount: number;
} {
  const start = text.indexOf('{\n  "cards"');
  return JSON.parse(text.slice(start)) as ReturnType<typeof parsePayload>;
}

/** 标准 fixture：architect→openai/model-test，legacy 卡 disabled，security→anthropic */
function standardConfig(): AppConfig {
  const experts = [
    makeExpert("architect"),
    makeExpert("security"),
    makeExpert("legacy", { enabled: false }),
  ];
  const models = [
    makeModel("m-openai", "openai", "gpt-4o", "GPT-4o"),
    makeModel("m-anthropic", "anthropic", "claude-sonnet-4", "Claude Sonnet"),
    makeModel("m-openai-legacy", "openai"),
  ];
  const cards = [
    makeCard("architect-m-openai", "architect", "m-openai"),
    makeCard("security-m-anthropic", "security", "m-anthropic"),
makeCard("legacy-m-openai-legacy", "legacy", "m-anthropic", {
      enabled: false,
    }),
  ];
  return makeConfig(cards, experts, models);
}

describe("list_cards 发现工具", () => {
  it("默认只返回启用角色卡，且不含 systemPrompt，展示专家名与模型名", async () => {
    await keys.set("openai", "sk-test");
    const config = standardConfig();
    const selected = selectListedCards(config);
    expect(selected.map((c) => c.id)).toEqual([
      "architect-m-openai",
      "security-m-anthropic",
    ]);

    const result = await handleListCards({}, config);
    const text = textOf(result);
    expect(text).toContain("architect-m-openai");
    expect(text).not.toContain("legacy-m-openai-legacy");
    expect(text).not.toContain("这段提示词不应出现");

    const summary = summarizeCard(
      config.cards[0]!,
      config
    );
    expect(summary).toMatchObject({
      id: "architect-m-openai",
      expertName: "专家-architect",
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("includeDisabled=true 时包含未启用角色卡", async () => {
    await keys.set("openai", "sk-test");
    const config = standardConfig();
    const result = await handleListCards({ includeDisabled: true }, config);
    const text = textOf(result);
    expect(text).toContain("legacy-m-openai-legacy");
    expect(text).toContain("disabled");
  });

  it("只给 openai 配 key 时标注缺 key 的卡，不从列表删除", async () => {
    await keys.set("openai", "sk-**********************");
    const config = standardConfig();
    const result = await handleListCards({}, config);
    const text = textOf(result);
    const payload = parsePayload(text);

    expect(payload.cards.map((c) => c.id)).toEqual([
      "architect-m-openai",
      "security-m-anthropic",
    ]);
    expect(payload.readyCount).toBe(1);
    expect(
      payload.cards.find((c) => c.id === "architect-m-openai")
    ).toMatchObject({
      ready: true,
      provider: "openai",
      model: "gpt-4o",
    });
    expect(payload.cards.find((c) => c.id === "security-m-anthropic")).toMatchObject({
      ready: false,
      missingReason: MISSING_KEY_HINT,
    });
    expect(text).toContain(MISSING_KEY_HINT);
    expect(text).not.toContain("legacy-m-openai-legacy");
    expect(text).not.toContain("sk-**********************");
  });

  it("includeDisabled=true 时可同时有 disabled 与缺 key 标注", async () => {
    await keys.set("openai", "sk-test");
    const config = standardConfig();
    const result = await handleListCards({ includeDisabled: true }, config);
    const text = textOf(result);
    const payload = parsePayload(text);
const legacy = payload.cards.find((c) => c.id === "legacy-m-openai-legacy");
    expect(legacy).toMatchObject({
      enabled: false,
      ready: false,
      missingReason: MISSING_KEY_HINT,
    });
    expect(text).toContain("disabled");
    expect(text).toContain(MISSING_KEY_HINT);
  });

  it("mock 模式下全部 ready 且无 missingReason", async () => {
    process.env.TALKIO_MOCK_PROVIDER = "1";
    const config = standardConfig();
    const result = await handleListCards({}, config);
    const payload = parsePayload(textOf(result));
    expect(payload.readyCount).toBe(2);
    expect(payload.cards.every((c) => c.ready)).toBe(true);
    expect(payload.cards.every((c) => c.missingReason === undefined)).toBe(true);
    expect(textOf(result)).not.toContain(" · 未配置 API Key");
  });
});