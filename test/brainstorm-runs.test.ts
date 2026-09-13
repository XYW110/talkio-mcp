/**
 * P3-A brainstorm 多轮 runs 测试。
 *
 * Step 1（implement.md）：先落 runs=1 等价性护栏——runs 缺省 vs runs=1 的
 * 报告与事件流必须逐字节一致（AC1），此用例在改造前即应通过。
 * Step 2 补 AC2/AC3：runs=2|3 的多轮执行、合并调用、[K/N RUNS] 标注、
 * 合并失败回退、zod 拒绝非法值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
} from "../src/providers/adapter.js";
import type { AppConfig, CardConfig, ExpertConfig, ModelConfig } from "../src/types.js";
import { startSession, type RecordSession } from "../src/records/store.js";
import { brainstormSchema } from "../src/tools/brainstorm.js";
import { SUMMARIZER_SYSTEM } from "../src/orchestrator/dialogue.js";

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

import { handleBrainstorm } from "../src/tools/brainstorm.js";

const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"] as const;

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

type CallLog = ChatParams & { __kind?: string };

function makeStubAdapter(
  behavior: (params: ChatParams, callIndex: number) => Promise<ChatResult>
): ProviderAdapter & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResult> {
      calls.push(params as CallLog);
      return behavior(params, calls.length - 1);
    },
  };
}

function makeEchoAdapter(): ProviderAdapter & { calls: CallLog[] } {
  return makeStubAdapter(async (params) => ({
    content: `echo:${params.messages.at(-1)?.content ?? ""}`,
  }));
}

/**
 * 区分调用种类的 stub：总结（SUMMARIZER_SYSTEM）与合并（MERGE_SYSTEM）
 * 调用返回固定短文，其余（发言/投票）返回 echo，便于断言调用顺序与合并时机。
 */
function makeKindedAdapter(): ProviderAdapter & { calls: CallLog[] } {
  return makeStubAdapter(async (params) => {
    const sys = params.messages.find((m) => m.role === "system")?.content ?? "";
    if (sys === SUMMARIZER_SYSTEM) {
      return { content: `SUMMARY:${params.messages.at(-1)?.content ?? ""}` };
    }
    if (sys.startsWith("你是多轮议事合并器")) {
      return { content: "MERGED:\n- [2/2 RUNS] 共识结论甲\n- [1/2 RUNS] 单轮孤例乙" };
    }
    return { content: `echo:${params.messages.at(-1)?.content ?? ""}` };
  });
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

function makeModel(id: string, providerId: string, modelId = "test-model"): ModelConfig {
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
    experts: [makeExpert("architect"), makeExpert("reviewer")],
    models: [makeModel("m-openai", "openai"), makeModel("m-anthropic", "anthropic")],
    cards: [
      makeCard("c-architect", "architect", "m-openai"),
      makeCard("c-reviewer", "reviewer", "m-anthropic"),
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

/**
 * 去掉不稳定字段后比较事件流：ts（append 时间戳）与 meta 行
 * （会话 id / startedAt 天然不同）不参与对比。
 */
function stripVolatile(
  events: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.type !== "meta")
    .map((e) => {
      const { ts: _ts, ...rest } = e;
      return rest;
    });
}

describe("AC1：runs=1（或缺省）与现状逐字节一致", () => {
  let recDir: string;
  beforeEach(async () => {
    recDir = await mkdtemp(path.join(tmpdir(), "talkio-runs-"));
    process.env.TALKIO_RECORDS = "1";
  });
  afterEach(async () => {
    delete process.env.TALKIO_RECORDS;
    await rm(recDir, { recursive: true, force: true });
  });

  async function runAndRecord(
    args: Parameters<typeof handleBrainstorm>[0]
  ): Promise<{ report: string; events: Array<Record<string, unknown>> }> {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    const adapter = makeEchoAdapter();
    const sess = (await startSession({ tool: "brainstorm", prompt: "x" }, recDir))!;
    const result = await handleBrainstorm(
      { topic: "落地路径", cards: ["c-architect", "c-reviewer"], rounds: 1, ...args },
      councilConfig(adapter),
      { record: sess }
    );
    expect(result.isError).not.toBe(true);
    sess.finish({ status: "ok" });
    await sess.flush();
    const raw = await readFile(path.join(recDir, `${sess.id}.jsonl`), "utf-8");
    const events = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { report: textOf(result), events };
  }

  it("runs 缺省 vs runs=1：报告逐字节一致，事件流一致（去 ts）", async () => {
    const absent = await runAndRecord({});
    const one = await runAndRecord({ runs: 1 });

    expect(one.report).toBe(absent.report);

    const absentStripped = stripVolatile(absent.events);
    const oneStripped = stripVolatile(one.events);
    expect(JSON.stringify(oneStripped)).toBe(JSON.stringify(absentStripped));

    // 红线：单轮路径的任何事件都不得携带 run 键
    for (const ev of [...absentStripped, ...oneStripped]) {
      expect(ev).not.toHaveProperty("run");
    }
  });
});

describe("AC2：runs=2 多轮执行 + 合并", () => {
  let recDir: string;
  beforeEach(async () => {
    recDir = await mkdtemp(path.join(tmpdir(), "talkio-runs2-"));
    process.env.TALKIO_RECORDS = "1";
  });
  afterEach(async () => {
    delete process.env.TALKIO_RECORDS;
    await rm(recDir, { recursive: true, force: true });
  });

  it("两次 runDialogue、别名轮换、事件带 run 字段、合并调用在两次运行之后", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    const adapter = makeKindedAdapter();
    const sess = (await startSession({ tool: "brainstorm", prompt: "x" }, recDir))!;
    const result = await handleBrainstorm(
      {
        topic: "落地路径",
        cards: ["c-architect", "c-reviewer"],
        rounds: 1,
        vote: true,
        runs: 2,
      },
      councilConfig(adapter),
      { record: sess }
    );
    expect(result.isError).not.toBe(true);
    sess.finish({ status: "ok" });
    await sess.flush();

    // 调用数：2 runs ×（2 种子 + 2 投票 + 1 总结）+ 1 合并 = 11；合并是最后一次
    expect(adapter.calls).toHaveLength(11);
    const lastCall = adapter.calls.at(-1)!;
    expect(
      lastCall.messages.find((m) => m.role === "system")?.content
    ).toContain("多轮议事合并器");
    // 合并提示词包含两份运行结论与 N 值
    const mergeUser = lastCall.messages.find((m) => m.role === "user")!.content;
    expect(mergeUser).toContain("第 1 次运行结论");
    expect(mergeUser).toContain("第 2 次运行结论");
    expect(mergeUser).toContain("[K/2 RUNS]");

    // 别名轮换：run1 中 architect=专家A，run2 中 architect=专家B（rotate(1)）
    // 过滤到「专家本人」的投票调用（system=卡人设；总结/合并调用的嵌入文本
    // 也会包含"请投票"字样，需排除）。
    const voteCalls = adapter.calls.filter(
      (c) =>
        c.messages[0]?.role === "system" &&
        /^你是 /.test(c.messages[0]?.content ?? "") &&
        c.messages.some(
          (m) => m.role === "user" && m.content.includes("请投票")
        )
    );
    expect(voteCalls).toHaveLength(4);
    const archRun1 = voteCalls
      .slice(0, 2)
      .find((c) => c.messages[0]?.content === "你是 architect");
    const archRun2 = voteCalls
      .slice(2, 4)
      .find((c) => c.messages[0]?.content === "你是 architect");
    expect(archRun1?.messages.at(-1)?.content).toContain("【专家A · 你的发言】");
    expect(archRun2?.messages.at(-1)?.content).toContain("【专家B · 你的发言】");

    // 报告：runs 头标注 + 多轮稳定性小节 + [K/N RUNS]
    const text = textOf(result);
    expect(text).toContain("**主题:** 落地路径（runs=2）");
    expect(text).toContain("### 多轮稳定性（runs=2）");
    expect(text).toContain("- Run 1：");
    expect(text).toContain("- Run 2：");
    expect(text).toContain("[2/2 RUNS] 共识结论甲");
    expect(text).toContain("[1/2 RUNS] 单轮孤例乙");

    // 事件流：turn/round_end/vote/summary 带 run 字段且可区分轮次归属
    const raw = await readFile(path.join(recDir, `${sess.id}.jsonl`), "utf-8");
    const events = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const body = events.filter(
      (e) => e.type !== "meta" && e.type !== "done"
    ) as Array<{ type: string; run?: unknown; round?: unknown }>;
    const turns = body.filter((e) => e.type === "turn");
    expect(turns).toHaveLength(4);
    expect(turns.filter((e) => e.run === 1)).toHaveLength(2);
    expect(turns.filter((e) => e.run === 2)).toHaveLength(2);
    const roundEnds = body.filter((e) => e.type === "round_end");
    expect(roundEnds.map((e) => e.run)).toEqual([1, 2]);
    const summaries = body.filter((e) => e.type === "summary");
    expect(summaries.map((e) => e.run)).toEqual([1, 2]);
    const votes = body.filter((e) => e.type === "vote");
    expect(votes.map((e) => e.run)).toEqual([1, 2]);
  });

  it("runs=3 + 合并调用失败：回退逐运行并列展示，isError 不翻转", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    const adapter = makeStubAdapter(async (params) => {
      const sys = params.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.startsWith("你是多轮议事合并器")) throw new Error("merge boom");
      if (sys === SUMMARIZER_SYSTEM) {
        return { content: `SUMMARY:${params.messages.at(-1)?.content ?? ""}` };
      }
      return { content: `echo:${params.messages.at(-1)?.content ?? ""}` };
    });
    const result = await handleBrainstorm(
      {
        topic: "落地路径",
        cards: ["c-architect", "c-reviewer"],
        rounds: 1,
        runs: 3,
      },
      councilConfig(adapter)
    );
    expect(result.isError).not.toBe(true);
    // 3 runs ×（2 种子 + 1 总结）= 9 次成功调用 + 1 次合并尝试（抛错即回退，不重试）
    expect(adapter.calls).toHaveLength(10);
    const text = textOf(result);
    expect(text).toContain("**主题:** 落地路径（runs=3）");
    expect(text).toContain("### 多轮稳定性（runs=3）");
    expect(text).toContain("- Run 1：");
    expect(text).toContain("- Run 2：");
    expect(text).toContain("- Run 3：");
    expect(text).toContain("合并调用失败");
    expect(text).toContain("**Run 1**：");
    expect(text).toContain("**Run 3**：");
  });
});

describe("AC3：zod 校验 runs", () => {
  const schema = z.object(brainstormSchema);

  it("runs=1/2/3 与缺省通过；0/4/\"2\" 等非法值被拒", () => {
    const base = { topic: "x" };
    expect(schema.safeParse(base).success).toBe(true);
    for (const v of [1, 2, 3]) {
      expect(schema.safeParse({ ...base, runs: v }).success).toBe(true);
    }
    for (const v of [0, 4, -1, 1.5, "2", null, true]) {
      expect(schema.safeParse({ ...base, runs: v }).success).toBe(false);
    }
  });

  it("inputSchema 原始 shape 含 runs 枚举（tools/list 输出即含）", () => {
    expect(brainstormSchema.runs).toBeDefined();
  });
});
