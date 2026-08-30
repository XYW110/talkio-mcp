import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
} from "../src/providers/adapter.js";
import type { AppConfig } from "../src/types.js";
import type { ResolvedCard } from "../src/tools/select-cards.js";

// vi.hoisted 创建一个模块级可变 holder，vi.mock 工厂中可安全引用
const { stubHolder } = vi.hoisted(() => ({
  stubHolder: { current: undefined as ProviderAdapter | undefined },
}));

// 统一 mock 掉 registry.getAdapter：让编排器拿到测试注入的 stub adapter
vi.mock("../src/providers/registry.js", () => ({
  getAdapter: () => {
    if (!stubHolder.current)
      throw new Error("test bug: stubHolder.current 未设置就调用了 getAdapter");
    return stubHolder.current;
  },
  isMockProviderEnabled: () => process.env.TALKIO_MOCK_PROVIDER === "1",
}));

import { runConsultation } from "../src/orchestrator/parallel.js";
import { runDialogue } from "../src/orchestrator/dialogue.js";
import type { StreamEvent } from "../src/utils/notify.js";

/**
 * 契约（见 design.md §3/§6 与任务书）：
 *   runConsultation(question, targets: ResolvedCard[], config, options?)
 *     → Promise.allSettled 并行；单个 target 失败不影响整体；
 *       返回 ConsultationItem[]（{ target, ok, content?, error? }）
 *   runDialogue(opts: { targets, ... }, config)
 *     → { turns: DialogueTurn[], summary? }
 */

/** 构造一个可控的 stub adapter */
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
 * Build a minimal AppConfig. Adapter injection via vi.mock.
 * targets carry providerName + modelId; resolveProvider only needs config.providers.
 */
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

function makeTarget(
  id: string,
  overrides: Partial<ResolvedCard> = {}
): ResolvedCard {
  const expertId = overrides.expert?.id ?? id;
  return {
    card: {
      id: `card-${id}`,
      name: id,
      expertId: expertId,
      modelId: "m-test",
      enabled: true,
      ...overrides.card,
    },
    expert: {
      id: expertId,
      name: `专家-${expertId}`,
      icon: "🤖",
      systemPrompt: `你是 ${expertId}`,
      temperature: 0.7,
      maxTokens: 1024,
      timeoutMs: 5000,
      enabled: true,
      builtin: false,
      ...overrides.expert,
    },
    providerName: "openai",
    modelId: "test-model",
    ...overrides,
  };
}

/**
 * 构造一个注入用的 logger spy：info/warn 等全部收集进 infos 数组。
 * 模块级定义，供 observability 与语义截断 describe 共用。
 */
function makeSpyLogger() {
  const infos: string[] = [];
  const logger = {
    infos,
    info: (...args: unknown[]) => {
      infos.push(args.join(" "));
    },
    debug: (..._args: unknown[]) => {},
    silly: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
    isEnabled: () => true,
  };
  return logger;
}

describe("runConsultation 并行编排", () => {
  it("全部成功：每个 target 都有 content，无 error", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];

    const results = await runConsultation(
      "问题?",
      targets,
      makeConfig(adapter)
    );

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(typeof r.content).toBe("string");
      expect((r.content as string).length).toBeGreaterThan(0);
    }
    expect(adapter.calls).toHaveLength(3);
  });

  it("部分失败：失败 target 有 error，其余正常返回（不阻塞整体）", async () => {
    const adapter = makeStubAdapter(async (params) => {
      const sys =
        params.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("b")) {
        throw new Error("provider boom");
      }
      return { content: `OK ${sys}` };
    });
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];

    const results = await runConsultation(
      "问题?",
      targets,
      makeConfig(adapter)
    );

    expect(results).toHaveLength(3);
    const byId = new Map(results.map((r) => [r.target.expert.id, r]));

    expect(byId.get("a")!.error).toBeUndefined();
    expect(byId.get("c")!.error).toBeUndefined();
    expect(byId.get("b")!.error).toBeDefined();
    expect(String(byId.get("b")!.error)).toContain("provider boom");
  });

  it("用 target 的真实 modelId 调 adapter；system prompt 用专家配置", async () => {
    const adapter = makeEchoAdapter();
    const target = makeTarget("x", {
      modelId: "gpt-special",
      expert: { id: "x", name: "x", icon: "🤖", systemPrompt: "定制提示词XYZ", temperature: 0.7, maxTokens: 1024, timeoutMs: 5000, enabled: true, builtin: false },
    });

    await runConsultation("我的问题ABC", [target], makeConfig(adapter));

    const params = adapter.calls[0]!;
    expect(params.model).toBe("gpt-special");
    expect(params.messages[0]).toEqual({
      role: "system",
      content: "定制提示词XYZ",
    });
    const userMsg = params.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("我的问题ABC");
  });

  it("context 存在时并入 user 消息", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("x")];

    await runConsultation("问题", targets, makeConfig(adapter), {
      context: "背景信息CTX",
    });

    const userMsg = adapter.calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("问题");
    expect(userMsg?.content).toContain("背景信息CTX");
  });
});

describe("runDialogue 多轮对话", () => {
  const topic = "如何设计一个高并发系统";
  let adapter: ReturnType<typeof makeEchoAdapter>;
  const targets = [makeTarget("a"), makeTarget("b")];

  beforeEach(() => {
    adapter = makeEchoAdapter();
  });

  it("debate 模式：轮次结构正确（turns 数 = rounds × targets，round 递增）", async () => {
    const { turns } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 3, summarize: false },
      makeConfig(adapter)
    );

    expect(turns).toHaveLength(3 * 2);
    expect(turns.filter((t) => t.round === 1)).toHaveLength(2);
    expect(turns.filter((t) => t.round === 2)).toHaveLength(2);
    expect(turns.filter((t) => t.round === 3)).toHaveLength(2);
    const ids = turns
      .filter((t) => t.round === 1)
      .map((t) => t.expertId)
      .sort();
    expect(ids).toEqual(["a", "b"]);
    for (const t of turns) {
      expect(t.expertName).toBeTruthy();
      expect(t.icon).toBeTruthy();
      expect(typeof t.content).toBe("string");
    }
  });

  it("relay 模式：串行顺序正确（严格按 targets 顺序逐轮接龙）", async () => {
    const { turns } = await runDialogue(
      { topic, targets, mode: "relay", rounds: 2, summarize: false },
      makeConfig(adapter)
    );

    expect(turns).toHaveLength(2 * 2);
    expect(turns.map((t) => t.expertId)).toEqual(["a", "b", "a", "b"]);
    expect(turns.map((t) => t.round)).toEqual([1, 1, 2, 2]);
  });

  it("relay 模式串行执行：后一位发言开始时前一位已完成", async () => {
    const order: string[] = [];
    const relayAdapter = makeStubAdapter(async (params) => {
      const sys =
        params.messages.find((m) => m.role === "system")?.content ?? "";
      await new Promise((r) => setTimeout(r, 20));
      order.push(sys);
      return { content: `done ${sys}` };
    });

    await runDialogue(
      { topic, targets, mode: "relay", rounds: 1, summarize: false },
      makeConfig(relayAdapter)
    );

    expect(order).toEqual(["你是 a", "你是 b"]);
  });

  it("rounds 生效：rounds=1 只产生种子轮", async () => {
    const { turns } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false },
      makeConfig(adapter)
    );

    expect(turns).toHaveLength(2);
    expect(turns.every((t) => t.round === 1)).toBe(true);
  });

  it("summarize=true 时产生非空 summary；false 时没有", async () => {
    const withSummary = await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: true },
      makeConfig(adapter)
    );
    expect(typeof withSummary.summary).toBe("string");
    expect((withSummary.summary as string).length).toBeGreaterThan(0);

    const withoutSummary = await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(adapter)
    );
    expect(withoutSummary.summary).toBeUndefined();
  });

  it("某位专家失败：turn 以占位内容记录，对话继续", async () => {
    const flakyAdapter = makeStubAdapter(async (params, callIndex) => {
      // 第 2 次调用（round1 的 target b）失败
      if (callIndex === 1) {
        throw new Error("target b exploded");
      }
      return { content: `OK #${callIndex}` };
    });

    const { turns } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(flakyAdapter)
    );

    expect(turns).toHaveLength(2 * 2);
    const failedTurn = turns.find((t) => t.expertId === "b" && t.round === 1);
    expect(failedTurn).toBeDefined();
    expect(failedTurn!.content).toMatch(/⚠️|缺席|失败/);
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
      { topic, targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(transcriptAdapter)
    );

    expect(seenPrompts).toHaveLength(4);
    const round2Prompts = seenPrompts.slice(2);
    expect(
      round2Prompts.some(
        (p) => p.includes("独特观点-1") || p.includes("独特观点-2")
      )
    ).toBe(true);
  });
});

describe("PII 隐私脱敏（发往 LLM 前掩码）", () => {
  it("consult 的 user 消息在调 adapter 前已掩码手机号/邮箱", async () => {
    const adapter = makeEchoAdapter();
    const target = makeTarget("x");

    await runConsultation(
      "帮我联系 13812345678 或 test@example.com",
      [target],
      makeConfig(adapter)
    );

    const userMsg = adapter.calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("帮我联系 [手机号] 或 [邮箱]");
  });

  it("consult 的 context 与 question 都掩码", async () => {
    const adapter = makeEchoAdapter();
    const target = makeTarget("x");

    await runConsultation("请问怎么处理", [target], makeConfig(adapter), {
      context: "当事人证件号 110101199003074518，手机 13900000000",
    });

    const userMsg = adapter.calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("[身份证号]");
    expect(userMsg?.content).toContain("[手机号]");
    expect(userMsg?.content).not.toContain("110101199003074518");
    expect(userMsg?.content).not.toContain("13900000000");
  });

  it("consult 的 provider 抛错信息不泄露手机号", async () => {
    const adapter = makeStubAdapter(async () => {
      throw new Error("调用失败: 手机 13812345678");
    });
    const target = makeTarget("x");

    const results = await runConsultation("问题", [target], makeConfig(adapter));

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("调用失败: 手机 [手机号]");
    expect(results[0]?.error).not.toContain("13812345678");
  });

  it("dialogue 每轮 user 消息都掩码 topic 中的 PII", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a")];

    await runDialogue(
      { topic: "如何联系 13812345678", targets, mode: "debate", rounds: 1, summarize: false },
      makeConfig(adapter)
    );

    const userMsg = adapter.calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("如何联系 [手机号]\n\n请就以下主题给出你的专业见解,清晰阐述你的核心观点与理由。");
  });

  it("dialogue 专家回复含 PII 时，后续轮次注入前掩码", async () => {
    // 第一轮回复里实验室专家"泄露"了手机号；第二轮 prompt 应含 [手机号]
    const seen: string[] = [];
    const adapter = makeStubAdapter(async (params) => {
      const user = params.messages[params.messages.length - 1]?.content ?? "";
      seen.push(user);
      return { content: "我建议联系 13911112222" };
    });
    const targets = [makeTarget("a")];

    await runDialogue(
      { topic: "讨论安全", targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(adapter)
    );

    expect(seen).toHaveLength(2);
    // 第二轮 prompt 注入的第一轮回复应被掩码
    const round2 = seen[1]!;
    expect(round2).toContain("[手机号]");
    expect(round2).not.toContain("13911112222");
    // 但第一轮的技术回复原样保留在 turn.content 中（客户端可见）
    // 保持只脱敏发往模型的内容，不脱敏返回给用户的内容
  });

  it("summarize 的总结 prompt 也掩码 PII", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a")];

    await runDialogue(
      { topic: "讨论 13812345678 相关", targets, mode: "debate", rounds: 1, summarize: true },
      makeConfig(adapter)
    );

    // 2 次调用：1 轮种子 + 1 次总结
    expect(adapter.calls).toHaveLength(2);
    const summaryCall = adapter.calls[1]!;
    const userMsg = summaryCall.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("[手机号]");
    expect(userMsg?.content).not.toContain("13812345678");
  });
});

describe("TALKIO_MOCK_PROVIDER 凭据短路", () => {
  it("无 API Key 时 consult 仍成功（不抛 missing env var）", async () => {
    const original = process.env.TALKIO_MOCK_PROVIDER;
    const originalKey = process.env.TEST_KEY;
    process.env.TALKIO_MOCK_PROVIDER = "1";
    delete process.env.TEST_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const adapter = makeEchoAdapter("mock-ok");
      const targets = [makeTarget("a")];
      const results = await runConsultation(
        "测试问题",
        targets,
        makeConfig(adapter)
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.ok).toBe(true);
      expect(results[0]?.error).toBeUndefined();
      expect(results[0]?.content).toContain("mock-ok");
    } finally {
      if (original === undefined) delete process.env.TALKIO_MOCK_PROVIDER;
      else process.env.TALKIO_MOCK_PROVIDER = original;
      if (originalKey === undefined) delete process.env.TEST_KEY;
      else process.env.TEST_KEY = originalKey;
    }
  });
});

describe("可观测性汇总与错误压缩（observability）", () => {

  it("全部目标卡失败 → 报告聚合为 1 条失败摘要（含总数与首错详情）", async () => {
    const adapter = makeStubAdapter(async () => {
      throw new Error("provider 拒绝请求: 认证失败");
    });
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];

    const results = await runConsultation("问题", targets, makeConfig(adapter));

    expect(results).toHaveLength(1);
    const item = results[0]!;
    expect(item.ok).toBe(false);
    expect(item.target.card.name).toBe("a"); // 保留 target 供渲染
    expect(item.error).toContain("全部 3 张卡咨询失败");
    expect(item.error).toContain("均为 provider 调用失败");
    expect(item.error).toContain("认证失败"); // 首错详情
  });

  it("全部失败且首个错误含「超时」→ 摘要标注（含超时）", async () => {
    const adapter = makeStubAdapter(async () => {
      throw new Error("Request timed out after 5000ms");
    });
    const targets = [makeTarget("a"), makeTarget("b")];

    const results = await runConsultation("问题", targets, makeConfig(adapter));

    expect(results).toHaveLength(1);
    expect(results[0]?.error).toContain("（含超时）");
    expect(results[0]?.error).toContain("全部 2 张卡咨询失败");
  });

  it("部分失败保持不变：不聚合、逐卡保留", async () => {
    const adapter = makeStubAdapter(async (params) => {
      const sys = params.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("b")) throw new Error("b 挂了");
      return { content: `OK ${sys}` };
    });
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];

    const results = await runConsultation("问题", targets, makeConfig(adapter));

    expect(results).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(results.find((r) => r.target.expert.id === "b")?.error).toContain(
      "b 挂了"
    );
  });

  it("咨询后 logger.info 收到 [summary] consult typeline，返回报告不含 summary", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    const logger = makeSpyLogger();

    const results = await runConsultation("问题", targets, makeConfig(adapter), {
      logger,
    });

    // 汇总只进 logger，绝不进入返回的 items 报告。
    expect(logger.infos.some((l) => l.includes("[summary] consult cards=3"))).toBe(true);
    expect(logger.infos.some((l) => l.includes("ok=3") && l.includes("failed=0"))).toBe(true);
    expect(logger.infos.some((l) => /avg_ms=\d+ total_ms=\d+/.test(l))).toBe(true);
    // 返回的 items 是 ConsultationItem[]，不含 [summary] 文本。
    const reportText = JSON.stringify(results);
    expect(reportText).not.toContain("[summary]");
  });

  it("brainstorm 后 logger.info 收到 [summary] brainstorm typeline（rounds/turns/summary/ok/failed）", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b")];
    const logger = makeSpyLogger();

    await runDialogue(
      { topic: "如何设计一个高并发系统", targets, mode: "debate", rounds: 2, summarize: true, logger },
      makeConfig(adapter)
    );

expect(
      logger.infos.some((l) =>
        /\[summary\] brainstorm rounds=2 turns=4 summary=yes compressed=(on|off|failed) ok=4 failed=0 total_ms=\d+/.test(l)
      )
    ).toBe(true);
  });
});

describe("流式增量通知（streaming）", () => {
  /** fake notifier：收集所有增量事件，供断言。 */
  function makeFakeNotifier() {
    const events: StreamEvent[] = [];
    return { events, notifier: (e: StreamEvent) => void events.push(e) };
  }

  it("consult 并行：3 卡结算后发 3 条 consult.card（card id 匹配 card-<id>、全 ok）", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    const { events, notifier } = makeFakeNotifier();

    const results = await runConsultation("问题", targets, makeConfig(adapter), {
      notifier,
    });

    expect(events).toHaveLength(3);
    expect(
      events.map((e) => (e.type === "consult.card" ? e.card : "")).sort()
    ).toEqual(["card-a", "card-b", "card-c"]);
    expect(
      events.every((e) => e.type === "consult.card" && e.status === "ok")
    ).toBe(true);
    // 通知在 finalize 之前发，返回值不受影响
    expect(results).toHaveLength(3);
  });

  it("consult 全失败：逐卡通知 3 条 failed，但返回聚合 1 条（互补语义）", async () => {
    const adapter = makeStubAdapter(async () => {
      throw new Error("provider 拒绝请求: 认证失败");
    });
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    const { events, notifier } = makeFakeNotifier();

    const results = await runConsultation("问题", targets, makeConfig(adapter), {
      notifier,
    });

    expect(events).toHaveLength(3);
    expect(
      events.every((e) => e.type === "consult.card" && e.status === "failed")
    ).toBe(true);
    // 返回值仍是聚合后的 1 条错误摘要（全卡失败压缩）
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("全部 3 张卡咨询失败");
  });

  it("brainstorm 2 轮：每轮结束 1 条 brainstorm.round（round/total 正确，总结不发通知）", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b")];
    const { events, notifier } = makeFakeNotifier();

    await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: true, notifier },
      makeConfig(adapter)
    );

    const roundEvents = events.filter((e) => e.type === "brainstorm.round");
    expect(roundEvents).toHaveLength(2);
    expect(roundEvents.map((e) => (e.type === "brainstorm.round" ? e.round : 0))).toEqual([1, 2]);
    expect(
      roundEvents.every((e) => e.type === "brainstorm.round" && e.total === 2)
    ).toBe(true);
    // Q2 粒度=轮：总结调用不算一轮，不产生事件
    expect(events).toHaveLength(2);
  });
});

describe("语义截断（task 08-28-semantic-truncation，方案 B 增量概要）", () => {
  // 2 张角色卡（均走 openai provider，makeConfig 提供 TEST_KEY）
  const targets = [makeTarget("a"), makeTarget("b")];

  it("debate 第 2 轮：注入概要前缀 + 压缩结果（替代硬截断）", async () => {
    // 序列 adapter：n=1/2 种子轮，n=3 压缩器，n=4/5 第 2 轮作答，
    // n=6 轮末增量并入（debate 第 2 轮结束后 absorbRound 触发）。
    let n = 0;
    const systems: string[] = [];
    const seen: string[] = [];
    const seqAdapter = makeStubAdapter(async (params) => {
      n += 1;
      systems.push(String(params.messages[0]?.content ?? ""));
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      if (n === 1) return { content: "长".repeat(13000) };
      if (n === 2) return { content: "第一轮正常发言" };
      if (n === 3) return { content: "第1轮概要内容XYZ" };
      return { content: "第二轮发言" };
    });

    const { turns } = await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(seqAdapter)
    );

    expect(turns).toHaveLength(4);
    // 调用 1/2 = 种子；调用 3 = 压缩器（system 覆盖）；调用 4/5 = 第 2 轮
    expect(systems[2]).toContain("对话记录压缩器");
    // 第 2 轮 prompt 注入概要前缀 + 压缩结果 + 最新轮完整实录
    // （n=6 轮末并入只影响增量概要回调，不是第 2 轮作答 prompt，故只取 4/5）
    const round2Prompts = seen.slice(3, 5);
    expect(round2Prompts.length).toBe(2);
    for (const p of round2Prompts) {
      expect(p).toContain("【对话概要·第1轮】");
      expect(p).toContain("第1轮概要内容XYZ");
      expect(p).toContain("最近发言完整实录:");
      // 最新一轮（第 1 轮）完整实录可见（正常那条），不因超长条目被整体截断
      expect(p).toContain("第一轮正常发言");
      // 概要注入路径不出现硬截断标记
      expect(p).not.toContain("（较早的发言已省略）");
    }
  });

  it("debate 未超预算：不触发压缩（调用序列无压缩器 system）", async () => {
    let n = 0;
    const systems: string[] = [];
    const seqAdapter = makeStubAdapter(async (params) => {
      n += 1;
      systems.push(String(params.messages[0]?.content ?? ""));
      if (n <= 2) return { content: `第一轮-${n}` };
      return { content: "第二轮发言" };
    });

    await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(seqAdapter)
    );

    // 4 次调用全部是专家作答，无压缩器
    expect(n).toBe(4);
    expect(systems.some((s) => s.includes("对话记录压缩器"))).toBe(false);
  });

  it("relay 第 2 轮：运行集超预算 → 概要注入", async () => {
    let n = 0;
    const seen: string[] = [];
    const systems: string[] = [];
    const seqAdapter = makeStubAdapter(async (params) => {
      n += 1;
      systems.push(String(params.messages[0]?.content ?? ""));
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      if (n === 1) return { content: "长".repeat(13000) }; // 第 1 位专家超长
      if (n === 2) return { content: "第一轮第二位发言" };
      if (n === 3) return { content: "relay概要内容ABC" }; // 压缩器
      return { content: "第二轮发言" };
    });

    const { turns } = await runDialogue(
      { topic: "主题", targets, mode: "relay", rounds: 2, summarize: false },
      makeConfig(seqAdapter)
    );

    expect(turns).toHaveLength(4);
    // 调用 3 = 压缩器（relay 第 2 位专家注入前，运行集已超预算）
    expect(systems[2]).toContain("对话记录压缩器");
    // relay 第 2 轮作答（calls 4/5，n=6 是轮末增量并入的压缩器 user，不含概要 header）
    for (const p of seen.slice(3, 5)) {
      expect(p).toContain("【对话概要·第1轮】");
      expect(p).toContain("relay概要内容ABC");
      expect(p).toContain("最近发言完整实录:");
    }
  });
 
  it("压缩失败：硬截断兜底，[summary] typeline 标记 compressed=failed", async () => {
    let n = 0;
    const seen: string[] = [];
    const seqAdapter = makeStubAdapter(async (params) => {
      n += 1;
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      if (n === 1) return { content: "长".repeat(13000) };
      if (n === 2) return { content: "第一轮正常发言" };
      if (n === 3) throw new Error("compressor down"); // 压缩失败
      return { content: "第二轮发言" };
    });
    const logger = makeSpyLogger();

    const { turns } = await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: false, logger },
      makeConfig(seqAdapter)
    );

    expect(turns).toHaveLength(4);
    // 第 2 轮 prompt 走硬截断兜底：含截断标记、无概要前缀
    for (const p of seen.slice(3)) {
      expect(p).toContain("（较早的发言已省略）");
      expect(p).not.toContain("【对话概要");
    }
    // typeline 记录 compressed=failed（stderr 纪律：进 logger，不进报告）
    expect(
      logger.infos.some((l) => l.includes("compressed=failed"))
    ).toBe(true);
  });

  it("超预算启用后：轮末增量并入概要（+1 压缩调用）", async () => {
    let n = 0;
    const systems: string[] = [];
    const seqAdapter = makeStubAdapter(async (params) => {
      n += 1;
      systems.push(String(params.messages[0]?.content ?? ""));
      if (n === 1) return { content: "长".repeat(13000) };
      if (n === 2) return { content: "第一轮正常发言" };
      if (n === 3) return { content: "第1轮概要" };   // 启用压缩
      if (n === 4) return { content: "第二轮发言" };
      if (n === 5) return { content: "第二轮发言" };
      return { content: "轮末并入后的概要" };            // 增量并入
    });

    await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(seqAdapter)
    );

    // 种子 2 + 启用 1 + 第2轮 2 + 轮末并入 1 = 6 次调用
    expect(n).toBe(6);
    // 最后一次调用是增量并入（压缩器 system）
    expect(systems[5]).toContain("对话记录压缩器");
  });
});