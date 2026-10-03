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

import type { KeysStore } from "../src/keys/store.js";
import { installKeysStore } from "./helpers/keys.js";

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
  buildEvidenceLibrary,
  EVIDENCE_LIBRARY_HEADER,
  EVIDENCE_LIBRARY_NOTE,
  EVIDENCE_ITEM_MAX_CHARS,
  EVIDENCE_LIBRARY_MAX_CHARS,
  formatTranscriptForPrompt,
  parseVotedForAlias,
  isSelfVoteBallot,
  surprisinglyPopular,
  devilsAdvocateIndex,
  DEVILS_ADVOCATE_INSTRUCTION,
  type DialogueTurn,
} from "../src/orchestrator/dialogue.js";
import {
  collectEvidenceRefs,
  formatBrainstormReport,
} from "../src/utils/format.js";
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

/** 渠道密钥 fixture：进程级 keys store（内存模式），替代旧 env 方案 */
let keys: KeysStore;

beforeEach(async () => {
  keys = installKeysStore();
  await keys.set("openai", "test-key");
});

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
  it("无 API Key 时 consult 仍成功（mock 短路凭据解析，不抛 missing key）", async () => {
    installKeysStore(); // 覆盖为空密钥池：无任何渠道 key
    process.env.TALKIO_MOCK_PROVIDER = "1";
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
      delete process.env.TALKIO_MOCK_PROVIDER;
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
    // Q2 粒度=轮：总结调用不算一轮，不产生 round 事件
    // （groupchat-strengths R1：轮内另有 brainstorm.turn 卡粒度事件，故总数 >2）
    expect(events).toHaveLength(6);
  });
});

describe("语义截断（task 08-28-semantic-truncation，方案 B 增量概要）", () => {
  // 2 张角色卡（均走 openai provider，beforeEach 已在 keys store 预置 openai key）
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

  it("VOTE_INSTRUCTION 含禁自投/限长/论据引用约束 + 二阶预测行（SP 聚合 R1.1）", () => {
    expect(typeof VOTE_INSTRUCTION).toBe("string");
    expect(VOTE_INSTRUCTION).toContain("不得投给你自己");
    expect(VOTE_INSTRUCTION).toContain("150 字以内");
    expect(VOTE_INSTRUCTION).toContain("你的发言");
    // 论据化投票标准保留：理由必须引用被投者的具体论据
    expect(VOTE_INSTRUCTION).toContain("具体论据");
    // R2.5：论据若基于证据库，须标注证据编号
    expect(VOTE_INSTRUCTION).toContain("证据编号");
    // R1.1（SP 聚合）：最后一行「预测：」开头，预测其他专家的票、不含自己
    expect(VOTE_INSTRUCTION).toContain("「预测：」开头");
    expect(VOTE_INSTRUCTION).toContain("预测其他专家会各投给谁");
    expect(VOTE_INSTRUCTION).toContain("不含你自己");
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

describe("SP 二阶聚合（task 09-27-sp-evidence-aggregation）", () => {
  const topic = "如何设计一个高并发系统";
  const K3 = ["专家A", "专家B", "专家C"];

  describe("surprisinglyPopular 纯函数（AC4）", () => {
    it("经典例：被多数低估的知情少数派被 SP 选中", () => {
      // votes=[A,A,B]（A 为多数赢家）；预测者普遍预计 A 压倒性获胜（B 被系统性低估）
      expect(
        surprisinglyPopular(
          ["专家A", "专家A", "专家B"],
          [["专家A"], ["专家A"], ["专家A", "专家B"]],
          K3
        )
      ).toBe("专家B");
    });

    it("并列最大 → null（design §3.3）", () => {
      // 预测与实际完全一致 → 边际全零并列
      expect(
        surprisinglyPopular(
          ["专家A", "专家A", "专家B"],
          [["专家A"], ["专家A"], ["专家B"]],
          K3
        )
      ).toBeNull();
      // n=2 退化：互投且互相预测对 → 并列
      expect(
        surprisinglyPopular(
          ["专家B", "专家A"],
          [["专家A"], ["专家B"]],
          ["专家A", "专家B"]
        )
      ).toBeNull();
    });

    it("可解析预测 <2 份 → null（Q2=A 降级）", () => {
      expect(
        surprisinglyPopular(["专家A", "专家B"], [[], ["专家A"]], K3)
      ).toBeNull();
      expect(surprisinglyPopular(["专家A", "专家B"], [[], []], K3)).toBeNull();
    });

    it("无有效票 → null；knownAliases 外提及忽略", () => {
      expect(
        surprisinglyPopular(["", ""], [["专家A"], ["专家A"]], K3)
      ).toBeNull();
      expect(
        surprisinglyPopular(["专家Z"], [["专家A"], ["专家A"]], K3)
      ).toBeNull();
    });
  });

  it("选票预测解析：全/半角冒号分割、排除本人、去重保序；无标记无 predictions 键（AC3）", async () => {
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    const adapter = makeStubAdapter(async (params) => {
      const sys = String(params.messages[0]?.content ?? "");
      const user = String(params.messages.at(-1)?.content ?? "");
      if (user.includes(VOTE_INSTRUCTION)) {
        if (sys.includes("你是 a")) {
          // 全角冒号：预测段提及 B/A/C/B → 排除本人 A、去重保序
          return {
            content:
              "我投专家B，其容灾论据最扎实；预测：专家B 会投专家A，专家C 会投专家B。",
          };
        }
        if (sys.includes("你是 b")) {
          // 半角冒号变体
          return {
            content: "我投C 的方案。\n预测:专家A 会投专家B，专家C 会投专家A。",
          };
        }
        // 无任何预测标记 → 全文为投票段、predictions 不写键
        return { content: "我投专家B，其容量估算有实测数据。" };
      }
      return { content: "观点陈述。" };
    });

    const { roundVotes } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false, vote: true },
      makeConfig(adapter)
    );

    const ballots = roundVotes!.ballots;
    expect(ballots[0]!.votedForAlias).toBe("专家B");
    expect(ballots[0]!.predictions).toEqual(["专家B", "专家C"]);
    expect(ballots[1]!.votedForAlias).toBe("专家C");
    expect(ballots[1]!.predictions).toEqual(["专家A", "专家C"]);
    expect(ballots[2]!.votedForAlias).toBe("专家B");
    expect(ballots[2]!.predictions).toBeUndefined();
  });

  it("选票预测解析：行首「预测」（无冒号）同样分割（R1.2 容错）", async () => {
    const adapter = makeStubAdapter(async (params) => {
      const user = String(params.messages.at(-1)?.content ?? "");
      if (user.includes(VOTE_INSTRUCTION)) {
        return {
          content: "我投专家B 的方案。\n预测 专家B 与 专家C 会各投专家A。",
        };
      }
      return { content: "观点陈述。" };
    });

    // 顺序 [b, c, a] → 代号：b=专家A、c=专家B、a=专家C；投票者 b（专家A）
    const { roundVotes } = await runDialogue(
      {
        topic,
        targets: [makeTarget("b"), makeTarget("c"), makeTarget("a")],
        mode: "debate",
        rounds: 1,
        summarize: false,
        vote: true,
      },
      makeConfig(adapter)
    );
    // 投票段「我投专家B 的方案。」→ 专家B；预测段提及 B/C/A（本人 A 丢弃）→ [B, C]
    expect(roundVotes!.ballots[0]!.votedForAlias).toBe("专家B");
    expect(roundVotes!.ballots[0]!.predictions).toEqual(["专家B", "专家C"]);
  });

  it("spWinner 端到端：唯一 argmax 写键；预测不足时不写键（AC5）", async () => {
    // 3 卡：A→B、B→C、C→B（多数=B）；预测 A:[B,C] B:[A,C] C:[A,B]
    // actual: A=0, B=2/3, C=1/3；predicted: 各 1/3 → margin: A=-1/3, B=1/3, C=0
    // → SP=专家B = 多数赢家
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    const adapter = makeStubAdapter(async (params) => {
      const sys = String(params.messages[0]?.content ?? "");
      const user = String(params.messages.at(-1)?.content ?? "");
      if (user.includes(VOTE_INSTRUCTION)) {
        if (sys.includes("你是 a")) {
          return {
            content:
              "我投专家B，其容灾论据最扎实；预测：专家B 会投专家A，专家C 会投专家B。",
          };
        }
        if (sys.includes("你是 b")) {
          return {
            content:
              "我投专家C，其灰度发布方案最稳；预测：专家A 会投专家B，专家C 会投专家A。",
          };
        }
        return {
          content:
            "我投专家B，其容量估算有实测数据；预测：专家A 会投专家B，专家B 会投专家B。",
        };
      }
      return { content: "观点陈述。" };
    });

    const { roundVotes, spWinner } = await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false, vote: true },
      makeConfig(adapter)
    );
    expect(spWinner).toBe("专家B");
    expect(roundVotes!.ballots.map((b) => b.predictions)).toEqual([
      ["专家B", "专家C"],
      ["专家A", "专家C"],
      ["专家A", "专家B"],
    ]);

    // 2 卡 echo（互投、预测段无别名）→ 可解析预测 0 份 → 不写 spWinner 键
    const { spWinner: sp2 } = await runDialogue(
      {
        topic,
        targets: [makeTarget("a"), makeTarget("b")],
        mode: "debate",
        rounds: 1,
        summarize: false,
        vote: true,
      },
      makeConfig(makeEchoAdapter())
    );
    expect(sp2).toBeUndefined();
  });
});

describe("报告聚合结果三态（task 09-27-sp-evidence-aggregation，AC5）", () => {
  const turns: DialogueTurn[] = [
    { round: 1, expertId: "a", expertName: "专家-a", icon: "🤖", content: "甲观点" },
  ];
  const votes = [
    { round: 0, expertId: "a", expertName: "专家-a", icon: "🤖", content: "我投专家B" },
  ];
  const aliases = [
    { alias: "专家A", expertId: "a", expertName: "专家-a" },
    { alias: "专家B", expertId: "b", expertName: "专家-b" },
    { alias: "专家C", expertId: "c", expertName: "专家-c" },
  ];
  // A→B、B→C、C→B：多数赢家 = 专家B
  const ballots = [
    { voterCardId: "card-a", voterAlias: "专家A", votedForAlias: "专家B", reason: "r1" },
    { voterCardId: "card-b", voterAlias: "专家B", votedForAlias: "专家C", reason: "r2" },
    { voterCardId: "card-c", voterAlias: "专家C", votedForAlias: "专家B", reason: "r3" },
  ];

  it("一致：多数赢家与 SP 赢家一致（位置在投票明细后、讨论总结前）", () => {
    const report = formatBrainstormReport("主题", "debate", 1, turns, "总结内容", {
      votes,
      aliases,
      roundVotes: { round: 1, ballots },
      spWinner: "专家B",
    });
    expect(report).toContain("### 聚合结果");
    expect(report).toContain("- 多数赢家与 SP 赢家一致：专家B（聚合信号稳健）");
    const aggIdx = report.indexOf("### 聚合结果");
    expect(aggIdx).toBeGreaterThan(report.indexOf("### 投票明细"));
    expect(aggIdx).toBeLessThan(report.indexOf("### 讨论总结"));
  });

  it("分歧：双轨呈现 + 趋同警报语义", () => {
    const report = formatBrainstormReport("主题", "debate", 1, turns, undefined, {
      roundVotes: { round: 1, ballots },
      spWinner: "专家A",
    });
    expect(report).toContain(
      "- 多数赢家：专家B；SP 赢家：专家A —— ⚠️ 多数可能被预期锁定（趋同警报），请阅读双方论据后再裁决"
    );
  });

  it("未计算：spWinner 缺省（预测不足）", () => {
    const report = formatBrainstormReport("主题", "debate", 1, turns, undefined, {
      roundVotes: { round: 1, ballots },
    });
    expect(report).toContain("- 多数赢家：专家B（预测不足，未计算 SP）");
  });

  it("票数并列：无单一多数的缺省行；无票 → 零字节", () => {
    const tieReport = formatBrainstormReport("主题", "debate", 1, turns, undefined, {
      roundVotes: {
        round: 1,
        ballots: [
          { voterCardId: "card-a", voterAlias: "专家A", votedForAlias: "专家B", reason: "r1" },
          { voterCardId: "card-b", voterAlias: "专家B", votedForAlias: "专家A", reason: "r2" },
        ],
      },
    });
    expect(tieReport).toContain("- 多数赢家：（票数并列，预测不足，未计算 SP）");

    const noVotes = formatBrainstormReport("主题", "debate", 1, turns);
    expect(noVotes).not.toContain("聚合结果");
  });
});

describe("证据锚定协议（task 09-27-sp-evidence-aggregation）", () => {
  const topic = "如何设计一个高并发系统";
  const targets = [makeTarget("a"), makeTarget("b")];
  const context = "我初步判断用单体架构就够了";

  function makeCaptureAdapter() {
    const seen: string[] = [];
    const adapter = makeStubAdapter(async (params) => {
      seen.push(String(params.messages.at(-1)?.content ?? ""));
      return { content: `观点#${seen.length}` };
    });
    return { adapter, seen };
  }

  describe("buildEvidenceLibrary 纯函数（AC2）", () => {
    it("无参/全空白 → 空串；编号 [E1]..[En] 跳过空白项；块内含引用纪律与可能有误语义", () => {
      expect(buildEvidenceLibrary(undefined)).toBe("");
      expect(buildEvidenceLibrary([])).toBe("");
      expect(buildEvidenceLibrary(["  ", "\n\t ", ""])).toBe("");
      const block = buildEvidenceLibrary(["证据甲", "  ", "证据乙"]);
      expect(block).toBe(
        `${EVIDENCE_LIBRARY_HEADER}\n\n[E1] 证据甲\n\n[E2] 证据乙\n\n${EVIDENCE_LIBRARY_NOTE}`
      );
      // 认识论区分（D3）：事实材料非立场 + 可能有误 + 引用标注编号
      expect(EVIDENCE_LIBRARY_NOTE).toContain("不是立场主张");
      expect(EVIDENCE_LIBRARY_NOTE).toContain("可能不完整或有误");
      expect(EVIDENCE_LIBRARY_NOTE).toContain("标注编号");
    });

    it("单条 2000 截断加省略号；总量 8000 截断加「（证据库已截断）」", () => {
      const perItem = buildEvidenceLibrary([
        "x".repeat(EVIDENCE_ITEM_MAX_CHARS + 500),
      ]);
      expect(perItem).toContain("x".repeat(EVIDENCE_ITEM_MAX_CHARS) + "…");
      expect(perItem).not.toContain("x".repeat(EVIDENCE_ITEM_MAX_CHARS + 1));

      // 4 条各 2000（不触发单条截断）→ 条目区 4×(5+2000)+3×2 = 8026 > 8000
      const four = buildEvidenceLibrary([
        "y".repeat(2000),
        "y".repeat(2000),
        "y".repeat(2000),
        "y".repeat(2000),
      ]);
      expect(four).toContain("（证据库已截断）");
      // 注意 header 自身含 "[E1]..[En]" 字样，定位条目区需用条目前缀 "[E1] y"
      const body = four.slice(
        four.indexOf("[E1] y"),
        four.indexOf(EVIDENCE_LIBRARY_NOTE)
      );
      // 条目区总量被钳制在 8000 + 省略标记内
      expect(body.length).toBeLessThanOrEqual(
        EVIDENCE_LIBRARY_MAX_CHARS + "…（证据库已截断）".length + 2
      );
    });
  });

  it("evidence 注入矩阵：debate 种子/≥2 注入，种子盲答仍不含 context；投票轮不注入（AC1/R2.3）", async () => {
    const evidence = ["基准压测：QPS 1000 时 P99 200ms"];
    const { adapter, seen } = makeCaptureAdapter();

    await runDialogue(
      {
        topic,
        targets,
        mode: "debate",
        rounds: 2,
        summarize: false,
        vote: true,
        context,
        evidence,
      },
      makeConfig(adapter)
    );

    // seen: 2 种子 + 2 第二轮 + 2 投票
    expect(seen).toHaveLength(6);
    // 种子轮：证据库注入（盲答隔离仅针对 context/claim-0，不针对证据基底）
    for (const p of seen.slice(0, 2)) {
      expect(p).toContain(EVIDENCE_LIBRARY_HEADER);
      expect(p).toContain("[E1] 基准压测：QPS 1000 时 P99 200ms");
      expect(p).toContain(EVIDENCE_LIBRARY_NOTE);
      // 盲答边界不破：claim-0 仍不注入
      expect(p).not.toContain("单体架构");
      expect(p).not.toContain(CLAIM0_HEADER);
    }
    // 种子轮模板逐字节：topic → 证据库 → SEED_INSTRUCTION（debate 无 claim-0）
    expect(seen[0]).toBe(
      `${topic}\n\n${buildEvidenceLibrary(evidence)}\n\n${SEED_INSTRUCTION}`
    );
    // 第 2 轮：证据块在 claim-0 头之前（顺序 = evidence、claim-0、实录）
    for (const p of seen.slice(2, 4)) {
      expect(p).toContain(EVIDENCE_LIBRARY_HEADER);
      expect(p.indexOf(EVIDENCE_LIBRARY_HEADER)).toBeLessThan(
        p.indexOf(CLAIM0_HEADER)
      );
      expect(p.indexOf(CLAIM0_HEADER)).toBeLessThan(p.indexOf("上一轮发言:"));
    }
    // 投票轮：不注入证据库
    for (const p of seen.slice(4)) {
      expect(p).not.toContain(EVIDENCE_LIBRARY_HEADER);
      expect(p).not.toContain("[E1] 基准压测");
    }
  });

  it("evidence 注入矩阵：relay 各轮（含种子轮）均注入，顺序 evidence → claim-0（R2.3）", async () => {
    const evidence = ["实测数据点甲"];
    const { adapter, seen } = makeCaptureAdapter();

    await runDialogue(
      { topic, targets, mode: "relay", rounds: 2, summarize: false, context, evidence },
      makeConfig(adapter)
    );

    expect(seen).toHaveLength(4);
    for (const p of seen) {
      expect(p).toContain(EVIDENCE_LIBRARY_HEADER);
      expect(p).toContain("单体架构");
      expect(p.indexOf(EVIDENCE_LIBRARY_HEADER)).toBeLessThan(
        p.indexOf(CLAIM0_HEADER)
      );
    }
    // 种子轮（无实录分支）：topic → 证据库 → claim-0 → SEED_INSTRUCTION
    expect(seen[0]!.indexOf(EVIDENCE_LIBRARY_HEADER)).toBeLessThan(
      seen[0]!.indexOf(CLAIM0_HEADER)
    );
    expect(seen[0]!.indexOf(CLAIM0_HEADER)).toBeLessThan(
      seen[0]!.indexOf(SEED_INSTRUCTION)
    );
  });

  it("无 evidence：所有 prompt 组装逐字节还原现状（AC1 红线）", async () => {
    const { adapter, seen } = makeCaptureAdapter();
    await runDialogue(
      { topic, targets, mode: "debate", rounds: 2, summarize: false, context },
      makeConfig(adapter)
    );
    for (const p of seen) {
      expect(p).not.toContain(EVIDENCE_LIBRARY_HEADER);
      expect(p).not.toContain(EVIDENCE_LIBRARY_NOTE);
    }
    // 种子轮现状形状（无 context/evidence）
    const { adapter: a2, seen: seen2 } = makeCaptureAdapter();
    await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false },
      makeConfig(a2)
    );
    expect(seen2[0]).toBe(`${topic}\n\n${SEED_INSTRUCTION}`);
    // evidence 全空白等价于未传
    const { adapter: a3, seen: seen3 } = makeCaptureAdapter();
    await runDialogue(
      { topic, targets, mode: "debate", rounds: 1, summarize: false, evidence: ["  ", ""] },
      makeConfig(a3)
    );
    expect(seen3[0]).toBe(`${topic}\n\n${SEED_INSTRUCTION}`);
  });

  it("collectEvidenceRefs：多专家计数、越界编号忽略、未引用专家空列表（AC6）", () => {
    const turns: DialogueTurn[] = [
      { round: 1, expertId: "a", expertName: "安全专家", icon: "", content: "如 [E1] 所示；[E1] 亦印证" },
      { round: 2, expertId: "b", expertName: "性能专家", icon: "", content: "引用 [E9] 越界无效，[E2] 有效" },
      { round: 2, expertId: "c", expertName: "架构专家", icon: "", content: "不引用任何证据" },
    ];
    expect(collectEvidenceRefs(turns, 3)).toEqual([
      { expertName: "安全专家", cited: [{ id: 1, count: 2 }] },
      { expertName: "性能专家", cited: [{ id: 2, count: 1 }] },
      { expertName: "架构专家", cited: [] },
    ]);
  });

  it("报告证据两小节：证据库在实录前、引用统计在实录后魔鬼代言人前；零引用/无 evidence 零输出（AC2/AC6）", () => {
    const evidence = ["证据甲", "证据乙"];
    const refTurns: DialogueTurn[] = [
      { round: 1, expertId: "a", expertName: "安全专家", icon: "🤖", content: "引用 [E1] 两次 [E1]" },
      { round: 1, expertId: "b", expertName: "性能专家", icon: "🤖", content: "无引用" },
    ];
    const report = formatBrainstormReport("主题", "debate", 2, refTurns, undefined, {
      evidence,
      devilsAdvocates: [{ round: 2, expertName: "专家-a" }],
    });
    expect(report).toContain("### 证据库");
    expect(report).toContain("[E1] 证据甲");
    expect(report).toContain("[E2] 证据乙");
    expect(report.indexOf("### 证据库")).toBeLessThan(report.indexOf("### 第 1 轮"));
    expect(report).toContain("### 证据引用统计");
    expect(report).toContain("- 安全专家：[E1]×2");
    expect(report).toContain("- 性能专家：（未引用证据）");
    expect(report.indexOf("### 证据引用统计")).toBeLessThan(
      report.indexOf("### 魔鬼代言人轮换")
    );

    // 证据提供但零引用 → 统计小节零输出（证据库小节仍输出）
    const zeroRefs = formatBrainstormReport(
      "主题",
      "debate",
      1,
      refTurns.map((t) => ({ ...t, content: "无引用" })),
      undefined,
      { evidence }
    );
    expect(zeroRefs).toContain("### 证据库");
    expect(zeroRefs).not.toContain("### 证据引用统计");

    // 无 evidence → 两小节零输出
    const noEvidence = formatBrainstormReport("主题", "debate", 1, refTurns);
    expect(noEvidence).not.toContain("### 证据库");
    expect(noEvidence).not.toContain("证据引用统计");
  });
});

// ============================================================
// groupchat-strengths（吸收 AgentMore 群聊优点）：R1 卡粒度通知 /
// R2 主持人插话 / R3 专家记忆注入与收获
// ============================================================
describe("groupchat-strengths：卡粒度流式通知（R1）", () => {
  function makeFakeNotifier() {
    const events: StreamEvent[] = [];
    return { events, notifier: (e: StreamEvent) => void events.push(e) };
  }

  it("debate 2 轮 2 卡：brainstorm.turn 4 条，(round, card) 与 turns 一一对应，round 事件保持轮粒度", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b")];
    const { events, notifier } = makeFakeNotifier();

    const result = await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: false, notifier },
      makeConfig(adapter)
    );

    const turnEvents = events.filter((e) => e.type === "brainstorm.turn");
    expect(turnEvents).toHaveLength(4); // 2 轮 × 2 卡
    // 轮 1：卡 a、b（并行 settle 顺序即 targets 顺序）
    expect(
      turnEvents.slice(0, 2).map((e) => (e.type === "brainstorm.turn" ? `${e.round}:${e.card}` : ""))
    ).toEqual(["1:card-a", "1:card-b"]);
    // 轮 2 同理
    expect(
      turnEvents.slice(2).map((e) => (e.type === "brainstorm.turn" ? `${e.round}:${e.card}` : ""))
    ).toEqual(["2:card-a", "2:card-b"]);
    // 全部 ok=true、total=2、expertName 正确
    expect(
      turnEvents.every(
        (e) =>
          e.type === "brainstorm.turn" &&
          e.ok === true &&
          e.total === 2 &&
          e.expertName.startsWith("专家-")
      )
    ).toBe(true);
    // round 事件仍为轮粒度（每轮 1 条）
    const roundEvents = events.filter((e) => e.type === "brainstorm.round");
    expect(roundEvents).toHaveLength(2);
    // turn 事件先于同轮的 round 事件（序列：turn,turn,round,turn,turn,round）
    expect(events[0]?.type).toBe("brainstorm.turn");
    expect(events[2]?.type).toBe("brainstorm.round");
    expect(events[3]?.type).toBe("brainstorm.turn");
    expect(events[5]?.type).toBe("brainstorm.round");
    // turns 与事件对齐
    expect(result.turns).toHaveLength(4);
  });

  it("relay 2 轮：turn 事件按发言顺序逐卡发出；缺席卡 ok=false", async () => {
    // 让 a 卡永远失败（第一次调用抛错），b 卡正常 → 缺席标记验证
    const adapter = makeStubAdapter(async (params, i) => {
      if (params.model === "fail-model") throw new Error("provider 超时");
      return { content: `回答${i}` };
    });
    const targets = [
      makeTarget("a", { modelId: "fail-model" }),
      makeTarget("b"),
    ];
    const { events, notifier } = makeFakeNotifier();

    await runDialogue(
      { topic: "主题", targets, mode: "relay", rounds: 2, summarize: false, notifier },
      makeConfig(adapter)
    );

    const turnEvents = events.filter((e) => e.type === "brainstorm.turn");
    expect(turnEvents).toHaveLength(4);
    const aEvents = turnEvents.filter(
      (e) => e.type === "brainstorm.turn" && e.card === "card-a"
    );
    expect(aEvents).toHaveLength(2);
    expect(aEvents.every((e) => e.type === "brainstorm.turn" && e.ok === false)).toBe(true);
    const bEvents = turnEvents.filter(
      (e) => e.type === "brainstorm.turn" && e.card === "card-b"
    );
    expect(bEvents.every((e) => e.type === "brainstorm.turn" && e.ok === true)).toBe(true);
  });
});

describe("groupchat-strengths：主持人插话（R2）", () => {
  it("interjections 注入下一轮 prompt：块头+原文+说明行出现在轮 2 各专家 prompt，轮 1 盲答不含", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b")];

    await runDialogue(
      {
        topic: "主题",
        targets,
        mode: "debate",
        rounds: 2,
        summarize: false,
        interjections: [{ afterRound: 1, message: "请聚焦成本维度" }],
      },
      makeConfig(adapter)
    );

    // debate 轮 1 是并行种子轮（calls 0-1），轮 2 是 calls 2-3
    const round2Prompts = [
      adapter.calls[2]?.messages.at(-1)?.content ?? "",
      adapter.calls[3]?.messages.at(-1)?.content ?? "",
    ];
    for (const p of round2Prompts) {
      expect(p).toContain("【主持人插话（发起方追加）】");
      expect(p).toContain("请聚焦成本维度");
      expect(p).toContain("不是专家发言，不参与互评投票");
    }
    // 轮 1 盲答不受插话影响
    const round1Prompts = [
      adapter.calls[0]?.messages.at(-1)?.content ?? "",
      adapter.calls[1]?.messages.at(-1)?.content ?? "",
    ];
    for (const p of round1Prompts) {
      expect(p).not.toContain("主持人插话");
    }
  });

  it("插话块不产生投票候选：VOTE_INSTRUCTION 注入的匿名实录场景安全（块头无专家代号形态）", () => {
    // parseVotedForAlias 白名单：块头「【主持人插话（发起方追加）】」不含
    // 专家[A-Z] 代号，票文解析不会命中（静态断言契约）
    const ballot = "我投专家A：论据充分";
    const parsed = parseVotedForAlias(ballot, "专家B", ["专家A", "专家B"]);
    expect(parsed).toBe("专家A");
    // 块头本身作为票文时不应解析出任何别名
    expect(
      parseVotedForAlias("【主持人插话（发起方追加）】请聚焦成本", "专家B", ["专家A", "专家B"])
    ).toBe("");
  });

  it("报告实录渲染 🎙️ 主持人块（afterRound 轮之后、下一轮之前）；无插话零输出", () => {
    const turns: DialogueTurn[] = [
      { round: 1, expertId: "a", expertName: "专家-a", icon: "🤖", content: "观点A" },
      { round: 2, expertId: "a", expertName: "专家-a", icon: "🤖", content: "观点B" },
    ];
    const withInterj = formatBrainstormReport("主题", "debate", 2, turns, undefined, {
      interjections: [{ afterRound: 1, message: "请聚焦成本维度" }],
    });
    const idxR1 = withInterj.indexOf("### 第 1 轮");
    const idxR2 = withInterj.indexOf("### 第 2 轮");
    const idxHost = withInterj.indexOf("🎙️ **主持人（第 1 轮后插话）**");
    expect(idxHost).toBeGreaterThan(idxR1);
    expect(idxHost).toBeLessThan(idxR2);
    expect(withInterj).toContain("请聚焦成本维度");
    // 无插话 → 零输出
    const without = formatBrainstormReport("主题", "debate", 2, turns);
    expect(without).not.toContain("主持人");
  });
});

describe("groupchat-strengths：专家记忆（R3）", () => {
  it("末轮收获：回答含「记忆：」行时剥离正文并返回 harvestedMemories；「无」不收获", async () => {
    const adapter = makeStubAdapter(async (params, i) => {
      // debate 2 轮：轮 1 (calls 0-1)，轮 2 = 末轮 (calls 2-3) 带 harvest 指令
      if (i >= 2) {
        if (params.model === "no-mem-model") return { content: "正常观点\n记忆：无" };
        return { content: "我的观点\n记忆：这个团队成本敏感" };
      }
      return { content: `观点${i}` };
    });
    const targets = [
      makeTarget("a"),
      makeTarget("b", { modelId: "no-mem-model" }),
    ];

    const result = await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: false, remember: true },
      makeConfig(adapter)
    );

    // a 专家收获一条；b 专家写了「无」→ 不收获
    expect(result.harvestedMemories).toHaveLength(1);
    expect(result.harvestedMemories?.[0]).toMatchObject({
      expertId: "a",
      text: "这个团队成本敏感",
    });
    // 正文已剥离记忆行
    const aTurn2 = result.turns.find((t) => t.round === 2 && t.expertId === "a");
    expect(aTurn2?.content).toBe("我的观点");
    const bTurn2 = result.turns.find((t) => t.round === 2 && t.expertId === "b");
    expect(bTurn2?.content).toBe("正常观点");
    // 末轮 prompt 含收获指令
    expect(adapter.calls[2]?.messages.at(-1)?.content).toContain("「记忆：」");
  });

  it("记忆注入：memories Map 提供条目时注入该专家 prompt 头部；缺席专家零注入", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a"), makeTarget("b")];

    await runDialogue(
      {
        topic: "主题",
        targets,
        mode: "debate",
        rounds: 1,
        summarize: false,
        memories: new Map([
          ["a", [{ ts: "2026-10-01T00:00:00.000Z", text: "上次结论：选 B 方案" }]],
        ]),
      },
      makeConfig(adapter)
    );

    const promptA = adapter.calls[0]?.messages.at(-1)?.content ?? "";
    const promptB = adapter.calls[1]?.messages.at(-1)?.content ?? "";
    expect(promptA.startsWith("【你的历史记忆")).toBe(true);
    expect(promptA).toContain("上次结论：选 B 方案");
    expect(promptB).not.toContain("历史记忆");
    // 记忆块在 prompt 头部（topic 之前）
    expect(promptA.indexOf("【你的历史记忆")).toBeLessThan(promptA.indexOf("主题"));
  });

  it("零改动红线：不传新参数时 prompt 逐字节等于旧版形状", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a")];

    await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 1, summarize: false },
      makeConfig(adapter)
    );

    // 旧版 prompt 形状：topic + 空行 + SEED_INSTRUCTION，无任何新块
    const prompt = adapter.calls[0]?.messages.at(-1)?.content ?? "";
    expect(prompt).toBe(`主题\n\n${SEED_INSTRUCTION}`);
  });

  it("remember=true 但轮次非末轮（rounds=2 轮 1）：不追加收获指令", async () => {
    const adapter = makeEchoAdapter();
    const targets = [makeTarget("a")];

    await runDialogue(
      { topic: "主题", targets, mode: "debate", rounds: 2, summarize: false, remember: true },
      makeConfig(adapter)
    );

    const round1Prompt = adapter.calls[0]?.messages.at(-1)?.content ?? "";
    const round2Prompt = adapter.calls[1]?.messages.at(-1)?.content ?? "";
    expect(round1Prompt).not.toContain("「记忆：」");
    expect(round2Prompt).toContain("「记忆：」");
  });
});
