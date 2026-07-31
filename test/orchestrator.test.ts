import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
} from "../src/providers/adapter.js";
import type { ExpertConfig } from "../src/types.js";
import type { AppConfig } from "../src/config.js";

// vi.hoisted 创建一个模块级可变 holder，vi.mock 工厂中可安全引用
// （vi.mock 是 hoisted 的，普通 let 在工厂函数中不可见）
const { stubHolder } = vi.hoisted(() => ({
  stubHolder: { current: undefined as ProviderAdapter | undefined },
}));

// 统一 mock 掉 registry.getAdapter：让编排器拿到测试注入的 stub adapter，
// 而非真实的 OpenAI/Anthropic adapter。parallel.ts 与 dialogue.ts 都引用此模块。
vi.mock("../src/providers/registry.js", () => ({
  getAdapter: () => {
    if (!stubHolder.current)
      throw new Error("test bug: stubHolder.current 未设置就调用了 getAdapter");
    return stubHolder.current;
  },
}));

import { runConsultation } from "../src/orchestrator/parallel.js";
import { runDialogue } from "../src/orchestrator/dialogue.js";

/**
 * 契约（见 design.md §3/§6 与任务书）：
 *   runConsultation(question, experts, config, options?)
 *     → Promise.allSettled 并行；单个 expert 失败不影响整体；
 *       返回 ConsultationItem[]（{ expert, ok, result?, error? }）
 *   runDialogue(opts, config)
 *     → { turns: DialogueTurn[], summary? }
 *     DialogueTurn { round, expertId, expertName, icon, content }
 *     - debate：每轮所有 expert 并行发言，可见此前轮次全部发言
 *     - relay：expert 依序串行发言，可见运行中的 transcript
 *     - rounds 生效：turn 数 = rounds × experts（全部成功时）
 *     - summarize=true 时产生 summary
 *     - 失败 turn 记录为占位（⚠️ name 本轮缺席），对话继续
 */

/** 构造一个可控的 stub adapter：可按 expert/调用次数返回成功或失败 */
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

function makeEchoAdapter(
  prefix = "回答"
): ProviderAdapter & { calls: ChatParams[] } {
  return makeStubAdapter(async (params) => ({
    content: `${prefix}: ${
      params.messages[params.messages.length - 1]?.content?.slice(0, 30) ?? ""
    }`,
  }));
}

/**
 * Build a minimal AppConfig. The real adapter injection happens via
 * vi.mock("../src/providers/registry.js") — makeConfig sets stubHolder.current
 * so that getAdapter() returns the test's stub adapter for all provider types.
 * Also sets TEST_KEY env so resolveProviderCredentials doesn't throw.
 */
function makeConfig(adapter: ProviderAdapter): AppConfig {
  stubHolder.current = adapter;
  process.env.TEST_KEY = "test-key";
  return {
    providers: {
      openai: { type: "openai" as const, baseUrl: "", apiKeyEnv: "TEST_KEY" },
    },
    experts: [],
  } as unknown as AppConfig;
}

function makeExpert(
  id: string,
  overrides: Partial<ExpertConfig> = {}
): ExpertConfig {
  return {
    id,
    name: `专家-${id}`,
    icon: "🤖",
    systemPrompt: `你是 ${id}`,
    provider: "openai",
    model: "test-model",
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    enabled: true,
    ...overrides,
  } as ExpertConfig;
}

describe("runConsultation 并行编排", () => {
  it("全部成功：每个 expert 都有 result，无 error", async () => {
    const adapter = makeEchoAdapter();
    const experts = [makeExpert("a"), makeExpert("b"), makeExpert("c")];

    const results = await runConsultation(
      "问题?",
      experts,
      makeConfig(adapter)
    );

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(typeof r.content).toBe("string");
      expect((r.content as string).length).toBeGreaterThan(0);
    }
    // 并行调用：每个 expert 各 1 次
    expect(adapter.calls).toHaveLength(3);
  });

  it("部分失败：失败 expert 有 error，其余正常返回（不阻塞整体）", async () => {
    const adapter = makeStubAdapter(async (params) => {
      const sys =
        params.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("b")) {
        throw new Error("provider boom");
      }
      return { content: `OK ${sys}` };
    });
    const experts = [makeExpert("a"), makeExpert("b"), makeExpert("c")];

    const results = await runConsultation(
      "问题?",
      experts,
      makeConfig(adapter)
    );

    expect(results).toHaveLength(3);
    const byId = new Map(results.map((r) => [r.expert.id, r]));

    expect(byId.get("a")!.error).toBeUndefined();
    expect(byId.get("c")!.error).toBeUndefined();
    expect(byId.get("b")!.error).toBeDefined();
    expect(String(byId.get("b")!.error)).toContain("provider boom");
  });

  it("system prompt 使用 expert 配置，user 消息包含问题", async () => {
    const adapter = makeEchoAdapter();
    const experts = [makeExpert("x", { systemPrompt: "定制提示词XYZ" })];

    await runConsultation("我的问题ABC", experts, makeConfig(adapter));

    const params = adapter.calls[0];
    expect(params.messages[0]).toEqual({
      role: "system",
      content: "定制提示词XYZ",
    });
    const userMsg = params.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("我的问题ABC");
  });

  it("context 存在时并入 user 消息", async () => {
    const adapter = makeEchoAdapter();
    const experts = [makeExpert("x")];

    await runConsultation("问题", experts, makeConfig(adapter), {
      context: "背景信息CTX",
    });

    const userMsg = adapter.calls[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("问题");
    expect(userMsg?.content).toContain("背景信息CTX");
  });
});

describe("runDialogue 多轮对话", () => {
  const topic = "如何设计一个高并发系统";
  let adapter: ReturnType<typeof makeEchoAdapter>;
  const experts = [makeExpert("a"), makeExpert("b")];

  beforeEach(() => {
    adapter = makeEchoAdapter();
  });

  it("debate 模式：轮次结构正确（turns 数 = rounds × experts，round 递增）", async () => {
    const { turns } = await runDialogue(
      { topic, experts, mode: "debate", rounds: 3, summarize: false },
      makeConfig(adapter)
    );

    expect(turns).toHaveLength(3 * 2);
    // 每轮两位 expert 都发言，且 round 字段正确
    expect(turns.filter((t) => t.round === 1)).toHaveLength(2);
    expect(turns.filter((t) => t.round === 2)).toHaveLength(2);
    expect(turns.filter((t) => t.round === 3)).toHaveLength(2);
    const ids = turns
      .filter((t) => t.round === 1)
      .map((t) => t.expertId)
      .sort();
    expect(ids).toEqual(["a", "b"]);
    // DialogueTurn 契约字段
    for (const t of turns) {
      expect(t.expertName).toBeTruthy();
      expect(t.icon).toBeTruthy();
      expect(typeof t.content).toBe("string");
    }
  });

  it("relay 模式：串行顺序正确（严格按 experts 顺序逐轮接龙）", async () => {
    const { turns } = await runDialogue(
      { topic, experts, mode: "relay", rounds: 2, summarize: false },
      makeConfig(adapter)
    );

    expect(turns).toHaveLength(2 * 2);
    // relay：每轮内顺序 = experts 配置顺序
    expect(turns.map((t) => t.expertId)).toEqual(["a", "b", "a", "b"]);
    expect(turns.map((t) => t.round)).toEqual([1, 1, 2, 2]);
  });

  it("relay 模式串行执行：后一位发言开始时前一位已完成", async () => {
    // 用完成时间戳验证串行性：若并行，两个 resolve 的间隔会重叠
    const order: string[] = [];
    const relayAdapter = makeStubAdapter(async (params) => {
      const sys =
        params.messages.find((m) => m.role === "system")?.content ?? "";
      await new Promise((r) => setTimeout(r, 20));
      order.push(sys);
      return { content: `done ${sys}` };
    });

    await runDialogue(
      { topic, experts, mode: "relay", rounds: 1, summarize: false },
      makeConfig(relayAdapter)
    );

    // 串行下 order 严格等于 experts 顺序
    expect(order).toEqual(["你是 a", "你是 b"]);
  });

  it("rounds 生效：rounds=1 只产生种子轮", async () => {
    const { turns } = await runDialogue(
      { topic, experts, mode: "debate", rounds: 1, summarize: false },
      makeConfig(adapter)
    );

    expect(turns).toHaveLength(2);
    expect(turns.every((t) => t.round === 1)).toBe(true);
  });

  it("summarize=true 时产生非空 summary；false 时没有", async () => {
    const withSummary = await runDialogue(
      { topic, experts, mode: "debate", rounds: 2, summarize: true },
      makeConfig(adapter)
    );
    expect(typeof withSummary.summary).toBe("string");
    expect((withSummary.summary as string).length).toBeGreaterThan(0);

    const withoutSummary = await runDialogue(
      { topic, experts, mode: "debate", rounds: 2, summarize: false },
      makeConfig(adapter)
    );
    expect(withoutSummary.summary).toBeUndefined();
  });

  it("某位 expert 失败：turn 以占位内容记录，对话继续", async () => {
    const flakyAdapter = makeStubAdapter(async (params, callIndex) => {
      // 第 2 次调用（round1 的 expert b）失败
      if (callIndex === 1) {
        throw new Error("expert b exploded");
      }
      return { content: `OK #${callIndex}` };
    });

    const { turns } = await runDialogue(
      { topic, experts, mode: "debate", rounds: 2, summarize: false },
      makeConfig(flakyAdapter)
    );

    // 总 turn 数不变，失败位有占位标记
    expect(turns).toHaveLength(2 * 2);
    const failedTurn = turns.find((t) => t.expertId === "b" && t.round === 1);
    expect(failedTurn).toBeDefined();
    expect(failedTurn!.content).toMatch(/⚠️|缺席|失败/);
    // 后续轮次继续
    expect(turns.some((t) => t.round === 2)).toBe(true);
  });

  it("debate 第 2 轮 prompt 包含第 1 轮的发言内容", async () => {
    const seenPrompts: string[] = [];
    const transcriptAdapter = makeStubAdapter(async (params) => {
      const user = params.messages[params.messages.length - 1]?.content ?? "";
      seenPrompts.push(user);
      const n = seenPrompts.length;
      return { content: `独特观点-${n}` };
    });

    await runDialogue(
      { topic, experts, mode: "debate", rounds: 2, summarize: false },
      makeConfig(transcriptAdapter)
    );

    // 第 2 轮的 prompt（第 3、4 次调用）应包含第 1 轮内容
    expect(seenPrompts).toHaveLength(4);
    const round2Prompts = seenPrompts.slice(2);
    expect(
      round2Prompts.some(
        (p) => p.includes("独特观点-1") || p.includes("独特观点-2")
      )
    ).toBe(true);
  });
});
