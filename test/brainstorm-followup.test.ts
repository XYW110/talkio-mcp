import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
} from "../src/providers/adapter.js";
import type { AppConfig, CardConfig, ExpertConfig, ModelConfig } from "../src/types.js";

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
  handleBrainstormFollowup,
  type BrainstormFollowupArgs,
} from "../src/tools/brainstorm-followup.js";
import type { DialogueTurn } from "../src/orchestrator/dialogue.js";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
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
    name: `专家-${id}`,
    icon: "🤖",
    systemPrompt: `你是 ${id}`,
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    enabled: true,
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

function makeCard(id: string, expertId: string, modelId: string): CardConfig {
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
    },
    experts: [
      makeExpert("architect"),
      makeExpert("security"),
      makeExpert("performance"),
    ],
    models: [
      makeModel("m-openai", "openai"),
      makeModel("m-anthropic", "anthropic"),
      makeModel("m-openai-2", "openai"),
    ],
    cards: [
      makeCard("c-architect", "architect", "m-openai"),
      makeCard("c-security", "security", "m-anthropic"),
      makeCard("c-performance", "performance", "m-openai-2"),
    ],
  };
}

/** 2 轮、3 位专家的上一轮实录（all / specific / 降级 均可用）。 */
const prevTurns: DialogueTurn[] = [
  { round: 1, expertId: "architect", expertName: "专家-architect", icon: "🤖", content: "第一轮架构师发言" },
  { round: 1, expertId: "security", expertName: "专家-security", icon: "🤖", content: "第一轮安全专家发言" },
  { round: 2, expertId: "architect", expertName: "专家-architect", icon: "🤖", content: "第二轮架构师发言" },
  { round: 2, expertId: "security", expertName: "专家-security", icon: "🤖", content: "第二轮安全专家发言" },
];

function baseArgs(overrides: Partial<BrainstormFollowupArgs> = {}): BrainstormFollowupArgs {
  return { question: "追问问题", turns: prevTurns, ...overrides };
}

snapshotEnv();

beforeEach(() => {
  stubHolder.current = undefined;
});

afterEach(() => {
  restoreEnv();
});

describe("handleBrainstormFollowup", () => {
  it("all：全体选定卡并行追问，新 turn round=max+1=3", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    process.env.TALKIO_MOCK_PROVIDER = "";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstormFollowup(
      baseArgs({ cards: ["c-architect", "c-security"], mode: "debate" }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    // 2 卡 × 1 轮 = 2 次 LLM 调用
    expect(adapter.calls).toHaveLength(2);
    const text = textOf(result);
    expect(text).toContain("## 专家追问实录");
    expect(text).toContain("第 3 轮追问");
    // report 正文仅 2 条新 turn
    expect(text).not.toContain("第 2 轮");
// 追问 prompt 含实录上下文与追问指令（最后一条 user 消息 = 注入后的完整内容）
    const lastMsg = String(adapter.calls[0]!.messages.at(-1)?.content ?? "");
    expect(lastMsg).toContain("第一轮架构师发言");
    expect(lastMsg).toContain("以下是基于此前讨论的追问");
  });

  it("specific：传 card 单卡深化，1 次 LLM 调用、1 条新 turn", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstormFollowup(
      baseArgs({ card: "c-architect" }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    expect(adapter.calls).toHaveLength(1);
    const text = textOf(result);
    expect(text).toContain("第 3 轮追问");
    // 仅架构师一条新 turn（历史实录会经 echo 回显，故用 turn 标题判定，不用全文排除）
    expect(text).toContain("**🤖 专家-architect:**");
    expect(text).not.toContain("**🤖 专家-security:**");
  });

  it("降级：turns=[] 时标注降级、isError=false、round=1", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstormFollowup(
      baseArgs({ turns: [], cards: ["c-architect"] }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("未使用历史上下文");
    expect(text).toContain("第 1 轮追问");
  });

  it("PII：question 含手机号被掩码，前序实录取自 turns", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstormFollowup(
      baseArgs({
        question: "我的手机号是 13800138000，怎么办？",
        cards: ["c-architect"],
      }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    expect(adapter.calls).toHaveLength(1);
    const content = String(adapter.calls[0]!.messages.at(-1)?.content ?? "");
    expect(content).not.toContain("13800138000");
    expect(content).toContain("[手机号]");
    // 旧实录来自 turns（第一轮架构师发言在 prompt 中且被掩码同规则）——无手机号上一轮，故仅检查上下文注入
    expect(content).toContain("第一轮架构师发言");
  });

  it("全员失败：聚合 1 条 ⚠️ 摘要 turn，isError=true", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = makeStubAdapter(async () => {
      throw new Error("provider down");
    });
    const result = await handleBrainstormFollowup(
      baseArgs({ cards: ["c-architect", "c-security"] }),
      councilConfig(adapter)
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("⚠️ 全部专家追问失败");
    // 只聚合 1 条摘要 turn，第 3 轮下不再出现两条缺席
    expect(text).not.toContain("c-security");
  });

  it("空 question 立即 isError，不调用 adapter", async () => {
    const adapter = makeEchoAdapter();
    const result = await handleBrainstormFollowup(
      baseArgs({ question: "   " }),
      councilConfig(adapter)
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("question 不能为空");
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("handleBrainstormFollowup — 语义截断（任务 08-28-semantic-truncation）", () => {
  /** 构造超出 12000 字符预算的 prevTurns（单 turn content 13000 字）。 */
  function oversizedTurns(round = 1): DialogueTurn[] {
    return [
      {
        round,
        expertId: "architect",
        expertName: "专家-architect",
        icon: "🤖",
        content: "长".repeat(13000),
      },
    ];
  }

  it("debate：超预算 prevTurns 触发概要压缩，prompt 注入概要前缀而非完整实录", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a"; // c-security 走 anthropic，两个 key 都要
    // 调用 1 = 压缩器；调用 2/3 = 两张卡作答（回显注入文本以便断言）
    const adapter = makeStubAdapter(async (params, callIndex) => ({
      content:
        callIndex === 0
          ? "压缩后的概要内容XYZ"
          : `echo:${String(params.messages.at(-1)?.content ?? "")}`,
    }));
    const result = await handleBrainstormFollowup(
      baseArgs({
        turns: oversizedTurns(),
        cards: ["c-architect", "c-security"],
        mode: "debate",
      }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    // 1 次压缩 + 2 次作答 = 3 次调用（handler 级缓存：不是 2 次压缩）
    expect(adapter.calls).toHaveLength(3);
    // 压缩调用使用 COMPRESSOR_SYSTEM（system 覆盖）
    expect(String(adapter.calls[0]!.messages[0]?.content ?? "")).toContain(
      "对话记录压缩器"
    );
    // 作答 prompt 注入概要前缀与压缩结果
    const answerPrompt = String(adapter.calls[1]!.messages.at(-1)?.content ?? "");
    expect(answerPrompt).toContain("【对话概要·第1轮】");
    expect(answerPrompt).toContain("最近发言完整实录:");
    expect(answerPrompt).toContain("压缩后的概要内容XYZ");
  });

it("relay：缓存复用——压缩仅 1 次，后续专家不再重复压缩", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a"; // c-security 走 anthropic，两个 key 都要
    let callCount = 0;
    const adapter = makeStubAdapter(async () => {
      callCount += 1;
      if (callCount === 1) return { content: "接龙概要ABC" };
      return { content: `接龙发言-${callCount}` };
    });
    const result = await handleBrainstormFollowup(
      baseArgs({
        turns: oversizedTurns(),
        cards: ["c-architect", "c-security"],
        mode: "relay",
      }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    // 1 次压缩 + 2 次作答 = 3 次调用（若逐专家重复压缩会是 4 次）
    expect(adapter.calls).toHaveLength(3);
    expect(String(adapter.calls[0]!.messages[0]?.content ?? "")).toContain(
      "对话记录压缩器"
    );
  });

it("schema/报告不变：超预算下返回结构与短路径一致（question/turns/mode 原样）", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a"; // c-security 走 anthropic，两个 key 都要
    let callCount = 0;
    const adapter = makeStubAdapter(async () => {
      callCount += 1;
      if (callCount === 1) return { content: "概要内容" };
      return { content: `观点-${callCount}` };
    });
    const result = await handleBrainstormFollowup(
      baseArgs({
        turns: oversizedTurns(),
        cards: ["c-architect", "c-security"],
        mode: "debate",
      }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    // 报告结构零改动
    expect(text).toContain("## 专家追问实录");
    expect(text).toContain("**追问:** 追问问题");
    expect(text).toContain("**模式:** 辩论");
    expect(text).toContain("第 2 轮追问"); // oversizedTurns 只有 round=1 → nextRound=2
    // 新 turn 正常（callCount 2/3 的观点）
    expect(text).toContain("观点-2");
    expect(text).toContain("观点-3");
    // 不含降级标注（turns 有效）
    expect(text).not.toContain("未使用历史上下文");
  });

it("降级路径：turns 无效 → prevTurns=[] → 永不触发压缩（无压缩调用）", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    const adapter = makeEchoAdapter();
    const result = await handleBrainstormFollowup(
      baseArgs({ turns: "不是数组" as unknown as DialogueTurn[], cards: ["c-architect"] }),
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("未使用历史上下文");
    // 仅作答调用（1 卡 1 次），无压缩调用
    expect(adapter.calls).toHaveLength(1);
    // system prompt = 专家 persona，不是压缩器 → 无压缩路径
    expect(String(adapter.calls[0]!.messages[0]?.content ?? "")).not.toContain(
      "对话记录压缩器"
    );
  });

it("压缩失败：硬截断兜底（isError=false，作答仍进行）", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a"; // c-security 走 anthropic，两个 key 都要
    let callCount = 0;
    const adapter = makeStubAdapter(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("compressor down");
      return { content: `兜底观点-${callCount}` };
    });
    const result = await handleBrainstormFollowup(
      baseArgs({
        turns: oversizedTurns(),
        cards: ["c-architect", "c-security"],
        mode: "debate",
      }),
      councilConfig(adapter)
    );
    // 压缩失败不传染：作答照常完成
    expect(result.isError).not.toBe(true);
    expect(adapter.calls).toHaveLength(3); // 1 失败压缩 + 2 作答
    const text = textOf(result);
    expect(text).toContain("兜底观点-2");
    // 兜底走 formatTranscriptForPrompt 硬截断：无概要前缀
    expect(text).not.toContain("【对话概要");
  });
});