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
import {
  runDialogue,
  SEED_INSTRUCTION,
  DEBATE_INSTRUCTION,
  VOTE_INSTRUCTION,
  SUMMARIZER_SYSTEM,
  CLAIM0_HEADER,
  CLAIM0_NOTE,
  buildClaim0Block,
  buildAliases,
  formatTranscriptForPrompt,
  parseVotedForAlias,
  isSelfVoteBallot,
  devilsAdvocateIndex,
  DEVILS_ADVOCATE_INSTRUCTION,
  type DialogueTurn,
} from "../src/orchestrator/dialogue.js";
import { formatBrainstormReport } from "../src/utils/format.js";
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

  it("context 存在时并入 user 消息（claim-0 框架，R5/AC4）", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("x")];

    await runConsultation("问题", targets, makeConfig(adapter), {
      context: "背景信息CTX",
    });

    const userMsg = adapter.calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("问题");
    expect(userMsg?.content).toContain("背景信息CTX");
    // claim-0 框架文案；不再出现旧的「背景信息:」权威背书标签
    expect(userMsg?.content).toContain("主理 AI 提供的初步分析");
    expect(userMsg?.content).toContain("可能有误，请独立判断，欢迎质疑");
    expect(userMsg?.content).not.toContain("背景信息:");
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
    expect(userMsg?.content).toBe(`如何联系 [手机号]\n\n${SEED_INSTRUCTION}`);
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
describe("互评投票与匿名化（task 09-13-peer-review-judge）", () => {
  const topic = "如何设计一个高并发系统";
  const targets = [makeTarget("a"), makeTarget("b")];

  function makeFakeNotifier() {
    const events: StreamEvent[] = [];
    return { events, notifier: (e: StreamEvent) => void events.push(e) };
  }

  it("VOTE_INSTRUCTION 含禁自投与限长约束（vote-prompt-fix）+ 论据化投票标准（R9）", () => {
    expect(typeof VOTE_INSTRUCTION).toBe("string");
    expect(VOTE_INSTRUCTION).toContain("不得投给你自己");
    expect(VOTE_INSTRUCTION).toContain("150 字以内");
    expect(VOTE_INSTRUCTION).toContain("你的发言");
    // R9：评判标准论据化 + 理由必须引用被投者具体论据 + claim-0 非候选人
    expect(VOTE_INSTRUCTION).toContain("论据质量");
    expect(VOTE_INSTRUCTION).toContain("具体论据");
    expect(VOTE_INSTRUCTION).toContain("claim-0");
    expect(VOTE_INSTRUCTION).toContain("不是候选人");
  });

  it("buildAliases：按 targets 顺序分配 专家A/B/…", () => {
    const aliases = buildAliases([
      makeTarget("a"),
      makeTarget("b"),
      makeTarget("c"),
    ]);
    expect(aliases.map((a) => a.alias)).toEqual(["专家A", "专家B", "专家C"]);
    expect(aliases.map((a) => a.expertId)).toEqual(["a", "b", "c"]);
    expect(aliases.map((a) => a.expertName)).toEqual([
      "专家-a",
      "专家-b",
      "专家-c",
    ]);
  });

  it("formatTranscriptForPrompt 匿名化：隐藏名称/图标，代号呈现，own 行标注", () => {
    const aliases = buildAliases(targets);
    const turns: DialogueTurn[] = [
      { round: 1, expertId: "a", expertName: "专家-a", icon: "🤖", content: "甲的观点" },
      { round: 1, expertId: "b", expertName: "专家-b", icon: "🤖", content: "乙的观点" },
    ];
    const block = formatTranscriptForPrompt(turns, {
      anonymize: true,
      aliases,
      viewerExpertId: "a",
    });
    expect(block).not.toContain("专家-a");
    expect(block).not.toContain("专家-b");
    expect(block).not.toContain("🤖");
    expect(block).toContain("【专家A · 你的发言】(第1轮): 甲的观点");
    expect(block).toContain("【专家B】(第1轮): 乙的观点");
    // 匿名关闭时保持旧行为（名称+图标行头，无 own 标注）
    const plain = formatTranscriptForPrompt(turns);
    expect(plain).toContain("【🤖 专家-a】(第1轮): 甲的观点");
    expect(plain).not.toContain("这是你自己的发言");
  });

  it("缺席占位符中的专家名在匿名渲染时一并替换为代号", () => {
    const aliases = buildAliases([makeTarget("a")]);
    const turns: DialogueTurn[] = [
      {
        round: 1,
        expertId: "a",
        expertName: "专家-a",
        icon: "🤖",
        content: "⚠️ (专家-a 本轮缺席: boom)",
      },
    ];
    const block = formatTranscriptForPrompt(turns, {
      anonymize: true,
      aliases,
    });
    expect(block).not.toContain("专家-a");
    expect(block).toContain("【专家A】");
  });

  it("debate 第 2 轮注入匿名实录：无专家名/icon，own 标注可识别", async () => {
    const seen: string[] = [];
    const adapter = makeStubAdapter(async (params) => {
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      return { content: "观点" };
    });

    await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(adapter)
    );

    const round2 = seen.slice(2);
    expect(round2).toHaveLength(2);
    for (const p of round2) {
      expect(p).not.toContain("专家-a");
      expect(p).not.toContain("专家-b");
      expect(p).not.toContain("🤖");
      // 自己的行带 own 标注，他人的行为普通代号
      expect(p).toMatch(/【专家[AB] · 你的发言】/);
      expect(p).toMatch(/【专家[AB]】/);
    }
    // own 标注逐阅读者生效：两个 prompt 各自恰好有一行带自己的 own 标注
    expect(round2.filter((p) => p.includes("【专家A · 你的发言】"))).toHaveLength(1);
    expect(round2.filter((p) => p.includes("【专家B · 你的发言】"))).toHaveLength(1);
  });

  it("压缩路径注入同样匿名：概要输入与最新轮实录均为代号，无专家名/icon", async () => {
    // 序列：n=1/2 种子（超长触发压缩）→ n=3 压缩器 → n=4/5 第 2 轮作答
    let n = 0;
    const seen: string[] = [];
    const seqAdapter = makeStubAdapter(async (params) => {
      n += 1;
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      if (n <= 2) return { content: "长".repeat(13000) };
      if (n === 3) return { content: "第1轮概要内容XYZ" };
      return { content: "第二轮发言" };
    });

    const { turns } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(seqAdapter)
    );

    expect(turns).toHaveLength(4);
    // 压缩器的输入（匿名副本）也必须无专家名
    const compressorInput = seen[2]!;
    expect(compressorInput).toContain("【专家A】");
    expect(compressorInput).toContain("【专家B】");
    expect(compressorInput).not.toContain("专家-a");
    expect(compressorInput).not.toContain("专家-b");
    expect(compressorInput).not.toContain("🤖");
    // 第 2 轮注入（概要 + 最新轮完整实录）同样匿名，own 标注逐阅读者生效
    const round2 = seen.slice(3, 5);
    expect(round2).toHaveLength(2);
    for (const p of round2) {
      expect(p).toContain("【对话概要");
      expect(p).toContain("第1轮概要内容XYZ");
      expect(p).toContain("最近发言完整实录:");
      expect(p).not.toContain("专家-a");
      expect(p).not.toContain("专家-b");
      expect(p).not.toContain("🤖");
      // 自己的行带 own 标注，他人的行为普通代号
      expect(p).toMatch(/【专家[AB] · 你的发言】/);
      expect(p).toMatch(/【专家[AB]】/);
    }
    expect(round2.filter((p) => p.includes("【专家A · 你的发言】"))).toHaveLength(1);
    expect(round2.filter((p) => p.includes("【专家B · 你的发言】"))).toHaveLength(1);
  });

  it("vote=true + debate：独立 votes（round=0），投票 prompt 匿名，发 brainstorm.vote 通知", async () => {
    const seen: string[] = [];
    const adapter = makeStubAdapter(async (params) => {
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      return { content: `回复#${seen.length}` };
    });
    const { events, notifier } = makeFakeNotifier();

    const { turns, votes, aliases } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false, vote: true, notifier },
      makeConfig(adapter)
    );

    // 投票不污染内容轮次：turns 仍只有 2 条种子
    expect(turns).toHaveLength(2);
    expect(votes).toHaveLength(2);
    expect(votes!.every((v) => v.round === 0)).toBe(true);
    expect(aliases!.map((a) => a.alias)).toEqual(["专家A", "专家B"]);
    // 调用序列：2 种子 + 2 投票
    expect(adapter.calls).toHaveLength(4);
    const votePrompts = seen.slice(2);
    for (const p of votePrompts) {
      expect(p).toContain("讨论实录（已匿名）");
      expect(p).toContain(VOTE_INSTRUCTION);
      expect(p).not.toContain("专家-a");
      expect(p).not.toContain("专家-b");
    }
    expect(votePrompts[0]).toContain("【专家A · 你的发言】");
    expect(votePrompts[0]).not.toContain("【专家B · 你的发言】");
    expect(events.some((e) => e.type === "brainstorm.vote")).toBe(true);
  });

  it("vote=true + summarize：综合 prompt 在实录后追加投票摘要块", async () => {
    const adapter = makeEchoAdapter();
    const res = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: true, vote: true },
      makeConfig(adapter)
    );
    // 2 种子 + 2 投票 + 1 总结
    expect(adapter.calls).toHaveLength(5);
    const userMsg = String(adapter.calls[4]!.messages.at(-1)?.content ?? "");
    expect(userMsg).toContain("互评投票");
    expect(userMsg).toContain("请在总结时参考");
    expect(userMsg).toContain("【专家A】");
    expect(res.summary).toBeTruthy();
  });

  it("vote=true + relay：忽略投票（无 votes、调用数不变、无 vote 通知）", async () => {
    const adapter = makeEchoAdapter();
    const { events, notifier } = makeFakeNotifier();

    const { votes } = await runDialogue(
      { topic, targets, mode: "relay", rounds: 1, summarize: false, vote: true, notifier },
      makeConfig(adapter)
    );

    expect(votes).toBeUndefined();
    expect(adapter.calls).toHaveLength(2);
    expect(events.some((e) => e.type === "brainstorm.vote")).toBe(false);
  });

  it("vote=true 且 targets<2：跳过投票轮", async () => {
    const adapter = makeEchoAdapter();

    const { votes } = await runDialogue(
      {
        topic,
        targets: [makeTarget("a")],
        mode: "debate",
        rounds: 1,
        summarize: false,
        vote: true,
      },
      makeConfig(adapter)
    );

    expect(votes).toBeUndefined();
    expect(adapter.calls).toHaveLength(1);
  });

  it("投票部分失败：只保留成功票，不阻断后续综合", async () => {
    // 调用序列：seed a(0)、seed b(1)、vote a(2)、vote b(3)——第 4 次失败
    const adapter = makeStubAdapter(async (_params, callIndex) => {
      if (callIndex === 3) throw new Error("vote boom");
      return { content: `回复#${callIndex}` };
    });

    const { votes } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false, vote: true },
      makeConfig(adapter)
    );

    expect(votes).toHaveLength(1);
    expect(votes![0]!.expertId).toBe("a");
  });

  it("judge：综合改用裁决者卡并返回 judgeInfo；fallback 标注回退；缺省无 judgeInfo", async () => {
    const a = makeTarget("a");
    const b = makeTarget("b");

    const adapter = makeEchoAdapter();
    const res = await runDialogue(
      { topic, targets: [a, b], mode: "debate", rounds: 1, summarize: true, judge: b },
      makeConfig(adapter)
    );
    // 2 种子 + 1 综合
    expect(adapter.calls).toHaveLength(3);
    expect(res.judgeInfo).toEqual({ cardId: "card-b", cardName: "b" });

    const res2 = await runDialogue(
      {
        topic,
        targets: [a, b],
        mode: "debate",
        rounds: 1,
        summarize: true,
        judgeFallbackInfo: { cardId: "nope", cardName: "无效卡" },
      },
      makeConfig(adapter)
    );
    expect(res2.judgeInfo).toEqual({
      cardId: "nope",
      cardName: "无效卡",
      fallback: true,
    });

    // AC5：缺省（无 judgeCard）不产生 judgeInfo
    const res3 = await runDialogue(
      { topic, targets: [a, b], mode: "debate", rounds: 1, summarize: true },
      makeConfig(adapter)
    );
    expect(res3.judgeInfo).toBeUndefined();
  });
});

describe("claim-0 反锚定与论据锚定（task 09-26-debate-evidence-grounding）", () => {
  const topic = "如何设计一个高并发系统";
  const targets = [makeTarget("a"), makeTarget("b")];
  const context = "我初步判断用单体架构就够了";

  /** 捕获每条 user prompt 的 stub adapter（回复带序号便于构造差异）。 */
  function makeCaptureAdapter() {
    const seen: string[] = [];
    const adapter = makeStubAdapter(async (params) => {
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      return { content: `观点#${seen.length}` };
    });
    return { adapter, seen };
  }

  it("buildClaim0Block：undefined/纯空白返回空串；有效 context 组装 header+原文+note（design §2）", () => {
    expect(buildClaim0Block(undefined)).toBe("");
    expect(buildClaim0Block("   \n\t ")).toBe("");
    const block = buildClaim0Block(`  ${context}  `);
    expect(block).toBe(`${CLAIM0_HEADER}\n${context}\n\n${CLAIM0_NOTE}`);
  });

  it("debate + context：第 1 轮盲答不含 context，第 2 轮起 claim-0 块前置于实录（R2/R3/AC2）", async () => {
    const { adapter, seen } = makeCaptureAdapter();

    await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false, context },
      makeConfig(adapter)
    );

    expect(seen).toHaveLength(4);
    // 种子轮盲答：prompt 只有 topic + SEED_INSTRUCTION，无任何 context 痕迹
    for (const p of seen.slice(0, 2)) {
      expect(p).not.toContain("单体架构");
      expect(p).not.toContain(CLAIM0_HEADER);
      expect(p).not.toContain(CLAIM0_NOTE);
    }
    // 第 2 轮：claim-0 块出现，且块内含「可推翻 / 不参与投票」语义
    for (const p of seen.slice(2)) {
      expect(p).toContain(CLAIM0_HEADER);
      expect(p).toContain("单体架构");
      expect(p).toContain("不参与互评投票");
      expect(p).toContain("欢迎质疑");
      expect(p).toContain("推翻");
      // claim-0 前置于上一轮发言实录段
      expect(p.indexOf(CLAIM0_HEADER)).toBeLessThan(p.indexOf("上一轮发言:"));
    }
  });

  it("relay + context：各轮 prompt（含种子轮）均含 claim-0 块（R4/AC3）", async () => {
    const { adapter, seen } = makeCaptureAdapter();

    await runDialogue(
      { topic, targets, mode: "relay", rounds: 2, summarize: false, context },
      makeConfig(adapter)
    );

    expect(seen).toHaveLength(4);
    for (const p of seen) {
      expect(p).toContain(CLAIM0_HEADER);
      expect(p).toContain("单体架构");
      expect(p).toContain("不参与互评投票");
    }
    // 种子轮（无实录分支）也在 topic 之后、SEED_INSTRUCTION 之前附 claim-0
    expect(seen[0]!.indexOf(CLAIM0_HEADER)).toBeLessThan(
      seen[0]!.indexOf(SEED_INSTRUCTION)
    );
  });

  it("无 context：所有轮次 prompt 不含 claim-0 头（组装形状不变，AC1 红线）", async () => {
    const { adapter, seen } = makeCaptureAdapter();

    await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(adapter)
    );

    expect(seen).toHaveLength(4);
    for (const p of seen) {
      expect(p).not.toContain(CLAIM0_HEADER);
      // P3 魔鬼代言人（D1 默认开启）：DEVILS_ADVOCATE_INSTRUCTION 提及
      // 「主理 AI 初步判断」属指令文案引用而非 claim-0 块注入，故以块标记
      // （header/note）判定，不再用宽泛的「主理 AI」作代理断言。
      expect(p).not.toContain(CLAIM0_NOTE);
    }
  });

  it("指令常量升级：SEED/DEBATE 论据与防锚定要求，SUMMARIZER 无共识条款（R7/R8/R10）", () => {
    // R7：核心主张 + 可验证依据 + 不确定点 + 防锚定句
    expect(SEED_INSTRUCTION).toContain("核心主张");
    expect(SEED_INSTRUCTION).toContain("依据");
    expect(SEED_INSTRUCTION).toContain("不确定");
    expect(SEED_INSTRUCTION).toContain("独立判断");
    // R8：点名对方具体论据 + 己方论据给来源 + 推测标注
    expect(DEBATE_INSTRUCTION).toContain("具体论据");
    expect(DEBATE_INSTRUCTION).toContain("来源");
    expect(DEBATE_INSTRUCTION).toContain("推测");
    // R10：无共识条款，禁止强行归并少数意见
    expect(SUMMARIZER_SYSTEM).toContain("无共识");
    expect(SUMMARIZER_SYSTEM).toContain("不得强行");
  });
});

describe("裸代号票文解析与自投标记（task 09-27-debate-quality-p3）", () => {
  const known3 = ["专家A", "专家B", "专家C"];

  describe("parseVotedForAlias 两级匹配（签名不变）", () => {
    it("裸代号正向：『我投B』『投给B。』『B 的论据最强』识别为专家B（AC1）", () => {
      expect(parseVotedForAlias("我投B", "专家A", known3)).toBe("专家B");
      expect(parseVotedForAlias("投给B。", "专家A", known3)).toBe("专家B");
      expect(parseVotedForAlias("B 的论据最强", "专家A", known3)).toBe("专家B");
      expect(parseVotedForAlias("我投B", "专家A", ["专家A", "专家B"])).toBe(
        "专家B"
      );
    });

    it("误报负向：API/QPS/OWASP/AB 等连续拉丁词与未知字母不命中（AC1）", () => {
      expect(parseVotedForAlias("API 网关是瓶颈", "专家A", known3)).toBe("");
      // voter≠A 的同型票文：邻接排除缺失时 "API" 的 A 会被误判为专家A（区分度增强）
      expect(parseVotedForAlias("API 网关是瓶颈", "专家B", known3)).toBe("");
      expect(parseVotedForAlias("QPS 提升一倍", "专家A", known3)).toBe("");
      expect(parseVotedForAlias("OWASP 十大风险", "专家B", known3)).toBe("");
      expect(parseVotedForAlias("AB 组合方案", "专家C", known3)).toBe("");
      // 3 卡场景：N / X 不在已知别名集合
      expect(parseVotedForAlias("N=10 的压测样本", "专家A", known3)).toBe("");
      expect(parseVotedForAlias("方案 X 待定", "专家A", known3)).toBe("");
    });

    it("全称优先于裸代号；全称全为本人时回退裸代号（AC1）", () => {
      // 全称优先：第一个非本人全称命中，即使同票文还有裸代号
      expect(parseVotedForAlias("专家A 与 B", "专家C", known3)).toBe("专家A");
      // 全称命中但均为本人 → 裸代号回退
      expect(parseVotedForAlias("专家A 与 B", "专家A", known3)).toBe("专家B");
      expect(
        parseVotedForAlias("我坚持专家A 的立场，也部分认同 C", "专家A", known3)
      ).toBe("专家C");
    });

    it("本人别名跳过逻辑不变：全称与裸代号均跳过本人（现状语义保持）", () => {
      expect(parseVotedForAlias("我投专家A 和 B", "专家A", known3)).toBe(
        "专家B"
      );
      expect(parseVotedForAlias("我投A 和 B", "专家A", known3)).toBe("专家B");
      // 只提及本人 → 无命中
      expect(parseVotedForAlias("我投B", "专家B", known3)).toBe("");
      // 既有行为回归：全称匹配、按序取首个非本人
      expect(parseVotedForAlias("专家C 说得对，B 也不错", "专家A", known3)).toBe(
        "专家C"
      );
    });
  });

  describe("isSelfVoteBallot", () => {
    it("仅提及本人（全称/裸代号）→ true（AC2）", () => {
      expect(
        isSelfVoteBallot("我投专家A，我的论据最完整", "专家A", known3)
      ).toBe(true);
      expect(isSelfVoteBallot("我投B，我的方案最稳", "专家B", known3)).toBe(
        true
      );
    });

    it("提及他人 / 无任何提及 → false", () => {
      expect(isSelfVoteBallot("专家A 和 B 都不错", "专家A", known3)).toBe(
        false
      );
      expect(isSelfVoteBallot("投给B", "专家A", known3)).toBe(false);
      expect(isSelfVoteBallot("没有明确指向的票文", "专家A", known3)).toBe(
        false
      );
    });
  });
});

describe("魔鬼代言人轮换（task 09-27-debate-quality-p3）", () => {
  const topic = "如何设计一个高并发系统";
  const targets = [makeTarget("a"), makeTarget("b")];

  function makeCaptureAdapter() {
    const seen: string[] = [];
    const adapter = makeStubAdapter(async (params) => {
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      return { content: `观点#${seen.length}` };
    });
    return { adapter, seen };
  }

  it("devilsAdvocateIndex：targets[(round-2)%n]；round<2 或空数组返回 -1", () => {
    expect(devilsAdvocateIndex(2, 2)).toBe(0);
    expect(devilsAdvocateIndex(3, 2)).toBe(1);
    expect(devilsAdvocateIndex(4, 2)).toBe(0);
    expect(devilsAdvocateIndex(2, 3)).toBe(0);
    expect(devilsAdvocateIndex(4, 3)).toBe(2);
    expect(devilsAdvocateIndex(5, 3)).toBe(0);
    expect(devilsAdvocateIndex(1, 2)).toBe(-1);
    expect(devilsAdvocateIndex(0, 2)).toBe(-1);
    expect(devilsAdvocateIndex(2, 0)).toBe(-1);
  });

  it("AC3 矩阵：rounds=3 两卡——第2轮 target0、第3轮 target1 含指令，同轮其余专家不含；第1轮不含", async () => {
    const { adapter, seen } = makeCaptureAdapter();

    const res = await runDialogue(
      { topic, targets, mode: "debate", rounds: 3, summarize: false },
      makeConfig(adapter)
    );

    expect(seen).toHaveLength(6);
    const round1 = seen.slice(0, 2);
    const round2 = seen.slice(2, 4);
    const round3 = seen.slice(4, 6);
    // 第 1 轮盲答：不含魔鬼代言人指令
    for (const p of round1) {
      expect(p).not.toContain("【魔鬼代言人指令】");
    }
    // 第 2 轮：target0（专家-a）含指令，target1 不含
    expect(round2[0]).toContain(DEVILS_ADVOCATE_INSTRUCTION);
    expect(round2[1]).not.toContain("【魔鬼代言人指令】");
    // 第 3 轮：target1（专家-b）含指令，target0 不含
    expect(round3[1]).toContain(DEVILS_ADVOCATE_INSTRUCTION);
    expect(round3[0]).not.toContain("【魔鬼代言人指令】");
    // DialogueResult 收集：每轮一条（轮次 + expertId + 实名）
    expect(res.devilsAdvocates).toEqual([
      { round: 2, expertId: "a", expertName: "专家-a" },
      { round: 3, expertId: "b", expertName: "专家-b" },
    ]);
  });

  it("注入点：追加在该专家 userContent 末尾（DEBATE_INSTRUCTION 及其后既有片段之后），常量匿名安全", async () => {
    // 常量不含真名/代号（anonymize 路径不触碰本常量）
    expect(DEVILS_ADVOCATE_INSTRUCTION).not.toContain("专家-a");
    expect(DEVILS_ADVOCATE_INSTRUCTION).not.toContain("专家-b");
    expect(DEVILS_ADVOCATE_INSTRUCTION).toContain("你");

    const { adapter, seen } = makeCaptureAdapter();
    await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false },
      makeConfig(adapter)
    );
    const devilPrompt = seen[2]!;
    expect(devilPrompt.endsWith(`\n\n${DEVILS_ADVOCATE_INSTRUCTION}`)).toBe(
      true
    );
    // 既有片段保持：DEBATE_INSTRUCTION 与匿名实录结构原样在前
    expect(devilPrompt).toContain(DEBATE_INSTRUCTION);
    expect(devilPrompt).toContain("上一轮发言:");
    // 非指定专家 prompt 末尾不带指令
    expect(seen[3]!.endsWith(`\n\n${DEVILS_ADVOCATE_INSTRUCTION}`)).toBe(false);
  });

  it("relay / 投票轮不注入：prompt 无指令、结果无 devilsAdvocates（design §4 红线）", async () => {
    const { adapter, seen } = makeCaptureAdapter();
    await runDialogue(
      { topic, targets, mode: "relay", rounds: 2, summarize: false },
      makeConfig(adapter)
    );
    expect(seen).toHaveLength(4);
    for (const p of seen) {
      expect(p).not.toContain("【魔鬼代言人指令】");
    }

    const seen2: string[] = [];
    const voteAdapter = makeStubAdapter(async (params) => {
      seen2.push(String(params.messages.at(-1)?.content ?? ""));
      return { content: `回复#${seen2.length}` };
    });
    const res = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false, vote: true },
      makeConfig(voteAdapter)
    );
    expect(seen2).toHaveLength(4); // 2 种子 + 2 投票
    for (const p of seen2) {
      expect(p).not.toContain("【魔鬼代言人指令】");
    }
    expect(res.devilsAdvocates).toBeUndefined();
  });

  it("rounds=1：无魔鬼代言人（结果无 devilsAdvocates，prompt 无指令）", async () => {
    const { adapter, seen } = makeCaptureAdapter();
    const res = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false },
      makeConfig(adapter)
    );
    expect(seen).toHaveLength(2);
    for (const p of seen) {
      expect(p).not.toContain("【魔鬼代言人指令】");
    }
    expect(res.devilsAdvocates).toBeUndefined();
  });

  it("自投票文端到端：ballot 标记 selfVote=true 且 votedForAlias 为空（AC2）", async () => {
    // 调用序列：seed a(0)、seed b(1)、vote a(2)、vote b(3)——投票票文只提及本人
    const adapter = makeStubAdapter(async (params) => {
      const sys = String(params.messages[0]?.content ?? "");
      const user = String(params.messages.at(-1)?.content ?? "");
      if (user.includes(VOTE_INSTRUCTION)) {
        return {
          content: sys.includes("你是 a")
            ? "我投专家A，我的论据最完整。"
            : "我投B，我的方案最稳。",
        };
      }
      return { content: "第一轮观点陈述。" };
    });

    const { roundVotes } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false, vote: true },
      makeConfig(adapter)
    );

    expect(roundVotes).toBeDefined();
    const ballots = roundVotes!.ballots;
    expect(ballots).toHaveLength(2);
    for (const b of ballots) {
      expect(b.votedForAlias).toBe("");
      expect(b.selfVote).toBe(true);
    }
  });
});

describe("报告渲染：魔鬼代言人小节与投票明细三态（task 09-27-debate-quality-p3）", () => {
  const turns: DialogueTurn[] = [
    { round: 1, expertId: "a", expertName: "专家-a", icon: "🤖", content: "甲观点" },
  ];

  it("devilsAdvocates 非空：实录后、互评投票前渲染小节；空缺省零字节（AC4）", () => {
    const withDevils = formatBrainstormReport(
      "主题",
      "debate",
      2,
      turns,
      undefined,
      {
        votes: [
          {
            round: 0,
            expertId: "a",
            expertName: "专家-a",
            icon: "🤖",
            content: "我投专家B",
          },
        ],
        aliases: [
          { alias: "专家A", expertId: "a", expertName: "专家-a" },
          { alias: "专家B", expertId: "b", expertName: "专家-b" },
        ],
        devilsAdvocates: [
          { round: 2, expertName: "专家-a" },
          { round: 3, expertName: "专家-b" },
        ],
      }
    );
    expect(withDevils).toContain("### 魔鬼代言人轮换");
    expect(withDevils).toContain("- 第 2 轮：专家-a");
    expect(withDevils).toContain("- 第 3 轮：专家-b");
    // 位置：实录之后、「互评投票」之前
    const devilIdx = withDevils.indexOf("### 魔鬼代言人轮换");
    expect(devilIdx).toBeGreaterThan(withDevils.indexOf("### 第 1 轮"));
    expect(devilIdx).toBeLessThan(withDevils.indexOf("### 互评投票"));

    // 缺省：relay / 旧路径零输出
    const without = formatBrainstormReport("主题", "debate", 2, turns);
    expect(without).not.toContain("魔鬼代言人");
  });

  it("投票明细三态：正常（字节不变）/ 自投显式标记 / 未识别占位符（AC2）", () => {
    const report = formatBrainstormReport("主题", "debate", 1, turns, undefined, {
      // 投票明细渲染在互评投票小节内：需 votes 非空（现状结构）
      votes: [
        {
          round: 0,
          expertId: "a",
          expertName: "专家-a",
          icon: "🤖",
          content: "我投专家B",
        },
      ],
      aliases: [{ alias: "专家A", expertId: "a", expertName: "专家-a" }],
      roundVotes: {
        round: 1,
        ballots: [
          {
            voterCardId: "card-a",
            voterAlias: "专家A",
            votedForAlias: "专家B",
            reason: "理由甲",
          },
          {
            voterCardId: "card-b",
            voterAlias: "专家B",
            votedForAlias: "",
            selfVote: true,
            reason: "我投B，我的论据最完整",
          },
          {
            voterCardId: "card-c",
            voterAlias: "专家C",
            votedForAlias: "",
            reason: "看不太懂",
          },
        ],
      },
    });
    expect(report).toContain("### 投票明细");
    expect(report).toContain("- 专家A → 专家B：理由甲");
    expect(report).toContain(
      "- **专家B** → ⚠️ 自投（无效票）：我投B，我的论据最完整"
    );
    expect(report).toContain("- 专家C → （未识别代号）：看不太懂");
  });
});
