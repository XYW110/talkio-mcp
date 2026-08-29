/**
 * context-compressor 单测（任务 08-28-semantic-truncation，design §10）。
 *
 * 覆盖：
 *  - 预算边界：11999 / 12000 / 12001（estimateTranscriptChars 与 exceedsBudget）
 *  - 注入模板：buildInjection 含概要前缀 + 最近发言完整实录（最新轮不截断）
 *  - 压缩失败上抛：adapter throw → compressTurns rejects
 *  - 增量并入：existingSummary 出现在 userContent 的「先前概要:」段
 *  - 双侧 PII：入参掩码进 adapter；adapter 返回的 PII 在 summaryText 中被掩码
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
} from "../src/providers/adapter.js";
import type { AppConfig } from "../src/types.js";
import type { ResolvedCard } from "../src/tools/select-cards.js";

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

import {
  COMPRESSOR_SYSTEM,
  CONTEXT_COMPRESSOR_BUDGET_CHARS,
  buildInjection,
  compressTurns,
  emptySummaryState,
  estimateTranscriptChars,
  exceedsBudget,
} from "../src/orchestrator/context-compressor.js";
import type { DialogueTurn } from "../src/orchestrator/dialogue.js";

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

function makeConfig(adapter: ProviderAdapter): AppConfig {
  stubHolder.current = adapter;
  process.env.TEST_KEY = "test-key";
  return {
    providers: {
      openai: { type: "openai" as const, baseUrl: "", apiKeyEnv: "TEST_KEY" },
    },
    experts: [],
    models: [],
    cards: [],
  };
}

function makeTarget(overrides: Partial<ResolvedCard> = {}): ResolvedCard {
  return {
    card: {
      id: "card-a",
      name: "a",
      expertId: "a",
      modelId: "m-test",
      enabled: true,
    },
    expert: {
      id: "a",
      name: "专家-a",
      icon: "🤖",
      systemPrompt: "你是 a",
      temperature: 0.7,
      maxTokens: 1024,
      timeoutMs: 5000,
      enabled: true,
    },
    providerName: "openai",
    modelId: "test-model",
    ...overrides,
  };
}

function makeTurn(
  round: number,
  content: string,
  expertName = "专家-a",
  icon = "🤖"
): DialogueTurn {
  return { round, expertId: "a", expertName, icon, content };
}

beforeEach(() => {
  stubHolder.current = undefined;
});

describe("预算判定（estimateTranscriptChars / exceedsBudget）", () => {
  // 单 turn 时 estimate = title.length + content.length（无分隔符）。
  // title 复刻 context-compressor 的拼装：`【${icon} ${expertName}】(第${round}轮): `
  const title = `【🤖 专家-a】(第1轮): `;

  it(`边界 11999（< ${CONTEXT_COMPRESSOR_BUDGET_CHARS}）：不超预算`, () => {
    const contentLen = 11999 - title.length;
    const turns = [makeTurn(1, "a".repeat(contentLen))];
    expect(estimateTranscriptChars(turns)).toBe(11999);
    expect(exceedsBudget(turns)).toBe(false);
  });

  it(`边界 12000（== ${CONTEXT_COMPRESSOR_BUDGET_CHARS}）：不超预算（严格大于才触发）`, () => {
    const contentLen = 12000 - title.length;
    const turns = [makeTurn(1, "a".repeat(contentLen))];
    expect(estimateTranscriptChars(turns)).toBe(12000);
    expect(exceedsBudget(turns)).toBe(false);
  });

  it(`边界 12001（> ${CONTEXT_COMPRESSOR_BUDGET_CHARS}）：超预算`, () => {
    const contentLen = 12001 - title.length;
    const turns = [makeTurn(1, "a".repeat(contentLen))];
    expect(estimateTranscriptChars(turns)).toBe(12001);
    expect(exceedsBudget(turns)).toBe(true);
  });

  it("多 turn 计入 \\n\\n 分隔符（2 turn = +2）", () => {
    const c1 = "第一轮发言";
    const c2 = "第二轮发言";
    const turns = [makeTurn(1, c1), makeTurn(2, c2)];
    const expected =
      (title.length + c1.length) + (title.length + c2.length) + 2;
    expect(estimateTranscriptChars(turns)).toBe(expected);
  });

  it("空 turns：estimate=0 且不超预算（降级路径天然旁路）", () => {
    expect(estimateTranscriptChars([])).toBe(0);
    expect(exceedsBudget([])).toBe(false);
  });
});

describe("注入模板（buildInjection）", () => {
  it("输出含概要前缀与「最近发言完整实录:」，最新轮完整内容不被 500 截断", () => {
    const longContent = "长".repeat(800); // > 500：硬截断会加省略号
    const turns = [
      makeTurn(1, "第一轮旧发言"),
      makeTurn(2, longContent),
    ];
    const summary = { summaryText: "这是概要正文", lastRound: 2 };
    const injection = buildInjection(summary, turns);

    expect(injection).toContain("【对话概要·第1-2轮】");
    expect(injection).toContain("这是概要正文");
    expect(injection).toContain("最近发言完整实录:");
    // 最新轮完整实录：完整 800 字，无省略号前缀
    expect(injection).toContain(longContent);
    expect(injection).not.toContain("…");
    // 旧轮（第 1 轮）不出现在实录层（由概要代表）
    expect(injection).not.toContain("第一轮旧发言");
  });

  it("lastRound=1 时前缀为「【对话概要·第1轮】」（无区间写法）", () => {
    const turns = [makeTurn(1, "唯一一轮发言")];
    const injection = buildInjection(emptySummaryState(), turns);
    expect(injection).toContain("【对话概要·第1轮】");
  });
});

describe("compressTurns 压缩调用", () => {
  it("成功：system=COMPRESSOR_SYSTEM 覆盖，user 含讨论主题与实录，返回 SummaryState", async () => {
    const adapter = makeStubAdapter(async () => ({ content: "概要结果" }));
    const turns = [makeTurn(1, "发言内容ABC")];

    const state = await compressTurns(
      "测试主题",
      turns,
      makeTarget(),
      makeConfig(adapter)
    );

    expect(adapter.calls).toHaveLength(1);
    const params = adapter.calls[0]!;
    expect(params.messages[0]).toEqual({
      role: "system",
      content: COMPRESSOR_SYSTEM,
    });
    const userMsg = params.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("讨论主题: 测试主题");
    expect(userMsg?.content).toContain("发言内容ABC");
    expect(state).toEqual({ summaryText: "概要结果", lastRound: 1 });
  });

  it("失败上抛：adapter throw → compressTurns rejects（调用方决定兜底）", async () => {
    const adapter = makeStubAdapter(async () => {
      throw new Error("provider down");
    });
    await expect(
      compressTurns("主题", [makeTurn(1, "内容")], makeTarget(), makeConfig(adapter))
    ).rejects.toThrow("provider down");
  });

  it("增量并入：existingSummary 出现在 userContent 的「先前概要:」段", async () => {
    const adapter = makeStubAdapter(async () => ({ content: "更新后概要" }));
    const turns = [makeTurn(3, "第三轮新发言")];

    const state = await compressTurns(
      "主题",
      turns,
      makeTarget(),
      makeConfig(adapter),
      "旧概要XYZ"
    );

    const userMsg = adapter.calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("先前概要:");
    expect(userMsg?.content).toContain("旧概要XYZ");
    expect(userMsg?.content).toContain("第三轮新发言");
    expect(state.lastRound).toBe(3);
    expect(state.summaryText).toBe("更新后概要");
  });

it("双侧 PII：入参手机号进 adapter 前已掩码；返回概要中的 PII 已掩码", async () => {
    // adapter 返回的"概要"里复述了手机号 → 输出侧必须掩码
    const adapter = makeStubAdapter(async () => ({
      content: "这个讨论可能涉及 13812345678 这个号码的隐私，不过没有关系",
    }));
    // 用真实 11 位手机号（139+8 位数字），redactPII 会识别并掩码
    const turns = [makeTurn(1, "当事人电话 13912345678，请联系他")];

    const state = await compressTurns("主题", turns, makeTarget(), makeConfig(adapter));

    // 输入侧：user content 已掩码为 [手机号]
    const userMsg = adapter.calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).not.toContain("13912345678");
    expect(userMsg?.content).toContain("[手机号]");
    // 输出侧：summaryText 也掩码
    expect(state.summaryText).not.toContain("13812345678");
    expect(state.summaryText).toContain("[手机号]");
  });

  it("provider 配置缺失：抛「未找到 provider 配置」", async () => {
    const adapter = makeStubAdapter(async () => ({ content: "x" }));
    const config = makeConfig(adapter);
    const orphan = makeTarget({ providerName: "no-such-provider" });
    await expect(
      compressTurns("主题", [makeTurn(1, "内容")], orphan, config)
    ).rejects.toThrow("未找到 provider 配置");
  });
});
