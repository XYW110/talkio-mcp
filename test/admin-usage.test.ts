import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminApi } from "../src/admin/api.js";
import { aggregateUsage, startSession } from "../src/records/store.js";
import { createLogger } from "../src/utils/log.js";
import type { AppConfig } from "../src/types.js";

/** createAdminApi 需要的配置桩（usage 路由只用 recordsDir，config 仅为满足签名）。 */
const stubConfig: AppConfig = {
  providers: {},
  experts: [],
  models: [],
  cards: [],
};
const logger = createLogger("error");

/** 最小 req/res 桩：与 admin-records.test.ts 同款，仅覆盖 createAdminApi 用到的 surface。 */
function makeReqRes(
  method: string,
  url: string,
): {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number;
  body: () => string;
} {
  let statusCode = 0;
  let data = "";
  type Listener = (chunk?: unknown) => void;
  const listeners: Record<string, Listener[]> = {};
  let reqBody: string | undefined;
  let emitted = false;
  const emit = () => {
    if (emitted) return;
    emitted = true;
    if (reqBody !== undefined && reqBody !== "") {
      const buf = Buffer.from(reqBody, "utf-8");
      for (const cb of listeners["data"] ?? []) cb(buf);
    }
    for (const cb of listeners["end"] ?? []) cb();
  };
  const req = {
    method,
    url,
    get body() {
      return reqBody;
    },
    set body(v: string | undefined) {
      reqBody = v;
    },
    on(event: string, cb: Listener) {
      (listeners[event] ??= []).push(cb);
      if (event === "end") emit();
    },
  } as unknown as IncomingMessage;
  const res = {
    writeHead(code: number, _headers?: unknown) {
      statusCode = code;
    },
    end(payload?: unknown) {
      if (typeof payload === "string") data += payload;
      else if (payload) data += String(payload);
    },
    statusCode: 0,
  } as unknown as ServerResponse;
  return {
    req,
    res,
    status: () => statusCode,
    body: () => data,
  };
}

/** 本地日期 key（与 aggregateUsage 的 byDay 口径一致）。 */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-admin-usage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 写一个 JSONL 会话文件（meta 首行 / done 末行的手工 fixture）。 */
async function writeJsonl(name: string, lines: unknown[]): Promise<void> {
  await writeFile(
    path.join(dir, name),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

describe("aggregateUsage 聚合纯函数", () => {
  it("正常×2 + 损坏×1 + 窗外×1：total/byDay/byCard/byModel/skipped 精确聚合", async () => {
    // 时间窗内的两个本地日（noon 保证落在同一本地日，跨时区稳定）
    const day1 = new Date();
    day1.setDate(day1.getDate() - 2);
    day1.setHours(12, 0, 0, 0);
    const day2 = new Date();
    day2.setDate(day2.getDate() - 1);
    day2.setHours(12, 0, 0, 0);
    const day1Key = localDate(day1);
    const day2Key = localDate(day2);

    // 文件 A：consult，card_result 自带 cardId（快照命中）
    await writeJsonl("20260911-000000-aaaa.jsonl", [
      { type: "meta", id: "20260911-000000-aaaa", tool: "consult_experts", startedAt: day1.toISOString(), prompt: "问题A" },
      {
        type: "cards",
        ts: day1.toISOString(),
        cards: [
          { cardId: "card-a", cardName: "卡片A", expertId: "exp-1", expertName: "专家一", modelId: "model-x", provider: "openai" },
        ],
      },
      { type: "card_result", ts: day1.toISOString(), cardId: "card-a", ok: true, usage: { promptTokens: 100, completionTokens: 50 } },
      { type: "done", ts: day1.toISOString(), status: "ok", usage: { promptTokens: 999, completionTokens: 999 } },
    ]);

    // 文件 B：brainstorm，turn 按 expertId 反查（命中 card-b / 落空 → unknown），
    // 含 usage 缺失的事件与 usage 不完整的字段；done 行 usage 不计入（避免与会话汇总重复）
    await writeJsonl("20260912-000000-bbbb.jsonl", [
      { type: "meta", id: "20260912-000000-bbbb", tool: "brainstorm", startedAt: day2.toISOString(), prompt: "问题B" },
      {
        type: "cards",
        ts: day2.toISOString(),
        cards: [
          { cardId: "card-b", cardName: "卡片B", expertId: "exp-2", expertName: "专家二", modelId: "model-y", provider: "anthropic" },
          { cardId: "card-c", cardName: "卡片C", expertId: "exp-3", expertName: "专家三", modelId: "model-x", provider: "openai" },
        ],
      },
      { type: "turn", ts: day2.toISOString(), round: 1, expertId: "exp-2", expertName: "专家二", icon: "🤖", content: "r1", usage: { promptTokens: 200, completionTokens: 80 } },
      // expertId 无快照命中 → unknown 桶
      { type: "turn", ts: day2.toISOString(), round: 1, expertId: "exp-9", expertName: "幽灵", icon: "👻", content: "r1", usage: { promptTokens: 10, completionTokens: 5 } },
      // usage 只带 promptTokens：不虚构 completionTokens 零字段
      { type: "turn", ts: day2.toISOString(), round: 2, expertId: "exp-2", expertName: "专家二", icon: "🤖", content: "r2", usage: { promptTokens: 30 } },
      // 完全无 usage：callCount 照常 +1，但不计入任何用量合计
      { type: "turn", ts: day2.toISOString(), round: 2, expertId: "exp-3", expertName: "专家三", icon: "🤖", content: "r2" },
      { type: "card_result", ts: day2.toISOString(), cardId: "card-b", ok: true, usage: { promptTokens: 40, completionTokens: 20 } },
      { type: "done", ts: day2.toISOString(), status: "ok", usage: { promptTokens: 280, completionTokens: 105 } },
    ]);

    // 损坏文件：任一行 parse 失败 → skipped+1 并跳过整个文件
    await writeFile(
      path.join(dir, "20260912-000000-cccc.jsonl"),
      '{"type":"meta","id":"20260912-000000-cccc"}\nnot-json{{{\n',
      "utf-8",
    );

    // 窗外文件：内容完全正常，但 mtime 在时间窗之外 → 整体排除（不计 skipped）
    const oldName = "20260101-000000-dddd.jsonl";
    await writeJsonl(oldName, [
      { type: "meta", id: "20260101-000000-dddd", tool: "brainstorm", startedAt: "2026-01-01T00:00:00.000Z", prompt: "旧会话" },
      { type: "card_result", ts: "2026-01-01T00:00:00.000Z", cardId: "card-a", ok: true, usage: { promptTokens: 5000, completionTokens: 5000 } },
      { type: "done", ts: "2026-01-01T00:00:00.000Z", status: "ok" },
    ]);
    const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await utimes(path.join(dir, oldName), oldTime, oldTime);

    const agg = await aggregateUsage(dir, 30);

    expect(agg.days).toBe(30);
    expect(agg.sessionCount).toBe(2);
    expect(agg.callCount).toBe(6); // 5 个带 usage 的事件 + 1 个无 usage 事件
    // done 行 usage 不重复计入
    expect(agg.total).toEqual({ promptTokens: 380, completionTokens: 155 });

    // byDay：升序，date = meta.startedAt 的本地日
    expect(agg.byDay.map((d) => d.date)).toEqual([day1Key, day2Key]);
    expect(agg.byDay[0]!.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(agg.byDay[1]!.usage).toEqual({ promptTokens: 280, completionTokens: 105 });

    // byCard：usage 降序（370 > 150 > 15）；unknown 桶 cardId="unknown" 名称"未知卡片"；
    // 无 usage 的 exp-3 turn 不创建卡片桶（card-c 不出现）
    expect(agg.byCard.map((c) => c.cardId)).toEqual(["card-b", "card-a", "unknown"]);
    expect(agg.byCard[0]).toEqual({
      cardId: "card-b",
      cardName: "卡片B",
      modelId: "model-y",
      provider: "anthropic",
      usage: { promptTokens: 270, completionTokens: 100 },
      sessions: 1,
      calls: 3,
    });
    expect(agg.byCard[1]).toEqual({
      cardId: "card-a",
      cardName: "卡片A",
      modelId: "model-x",
      provider: "openai",
      usage: { promptTokens: 100, completionTokens: 50 },
      sessions: 1,
      calls: 1,
    });
    expect(agg.byCard[2]).toEqual({
      cardId: "unknown",
      cardName: "未知卡片",
      modelId: "",
      provider: "",
      usage: { promptTokens: 10, completionTokens: 5 },
      sessions: 1,
      calls: 1,
    });

    // byModel：usage 降序（370 > 150）；model-x 汇总 card-a + card-c
    expect(agg.byModel.map((m) => m.modelId)).toEqual(["model-y", "model-x"]);
    expect(agg.byModel[0]).toEqual({
      modelId: "model-y",
      provider: "anthropic",
      usage: { promptTokens: 270, completionTokens: 100 },
      calls: 3,
    });
    expect(agg.byModel[1]).toEqual({
      modelId: "model-x",
      provider: "openai",
      usage: { promptTokens: 100, completionTokens: 50 },
      calls: 1,
    });

    expect(agg.skipped).toBe(1);
  });

  it("目录不存在返回空结构；days 防御性钳制", async () => {
    const empty = await aggregateUsage(path.join(dir, "不存在"), 30);
    expect(empty).toEqual({
      days: 30,
      total: {},
      sessionCount: 0,
      callCount: 0,
      byDay: [],
      byCard: [],
      byModel: [],
      skipped: 0,
    });

    expect((await aggregateUsage(dir, 999)).days).toBe(90);
    expect((await aggregateUsage(dir, 0)).days).toBe(1);
    expect((await aggregateUsage(dir, NaN)).days).toBe(30);
  });
});

describe("admin API GET /api/usage", () => {
  it("recordsDir 未配置返回 200 + 空结构（不是 404）", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), configRef: { config: stubConfig }, logger });
    const res = makeReqRes("GET", "/api/usage");
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({
      days: 30,
      total: {},
      sessionCount: 0,
      callCount: 0,
      byDay: [],
      byCard: [],
      byModel: [],
      skipped: 0,
    });
  });

  it("days 参数钳制到 [1,90]，缺省 / 非数字 → 30", async () => {
    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, configRef: { config: stubConfig }, logger });

    const res999 = makeReqRes("GET", "/api/usage?days=999");
    await handle(res999.req, res999.res);
    expect(res999.status()).toBe(200);
    expect((JSON.parse(res999.body()) as { days: number }).days).toBe(90);

    const res0 = makeReqRes("GET", "/api/usage?days=0");
    await handle(res0.req, res0.res);
    expect((JSON.parse(res0.body()) as { days: number }).days).toBe(1);

    const resDefault = makeReqRes("GET", "/api/usage");
    await handle(resDefault.req, resDefault.res);
    expect((JSON.parse(resDefault.body()) as { days: number }).days).toBe(30);

    const resBad = makeReqRes("GET", "/api/usage?days=abc");
    await handle(resBad.req, resBad.res);
    expect((JSON.parse(resBad.body()) as { days: number }).days).toBe(30);
  });

  it("正常返回体形状：session/call 计数与 usage 合计，done 行不重复计入", async () => {
    const sess = (await startSession({ tool: "consult_experts", prompt: "问题" }, dir))!;
    sess.append({
      type: "cards",
      cards: [
        { cardId: "card-a", cardName: "卡片A", expertId: "exp-1", expertName: "专家一", modelId: "model-x", provider: "openai" },
      ],
    });
    sess.append({ type: "card_result", cardId: "card-a", ok: true, usage: { promptTokens: 100, completionTokens: 50 } });
    sess.finish({ status: "ok", usage: { promptTokens: 100, completionTokens: 50 } });
    await sess.flush();

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, configRef: { config: stubConfig }, logger });
    const res = makeReqRes("GET", "/api/usage?days=7");
    const handled = await handle(res.req, res.res);
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    const agg = JSON.parse(res.body()) as {
      days: number;
      total: { promptTokens?: number; completionTokens?: number };
      sessionCount: number;
      callCount: number;
      byCard: Array<{ cardId: string; cardName: string; calls: number; sessions: number }>;
      byModel: Array<{ modelId: string; calls: number }>;
      skipped: number;
    };
    expect(agg.days).toBe(7);
    expect(agg.sessionCount).toBe(1);
    expect(agg.callCount).toBe(1);
    // 只有 card_result 的 usage；done 行（会话级汇总）不重复计入
    expect(agg.total).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(agg.byCard).toHaveLength(1);
    expect(agg.byCard[0]).toMatchObject({ cardId: "card-a", cardName: "卡片A", calls: 1, sessions: 1 });
    expect(agg.byModel).toHaveLength(1);
    expect(agg.byModel[0]).toMatchObject({ modelId: "model-x", calls: 1 });
    expect(agg.skipped).toBe(0);
  });

  it("损坏文件不 500：skipped ≥ 1，其余文件正常聚合", async () => {
    const sess = (await startSession({ tool: "brainstorm", prompt: "正常会话" }, dir))!;
    sess.append({ type: "card_result", cardId: "card-a", ok: true, usage: { promptTokens: 10, completionTokens: 5 } });
    sess.finish({ status: "ok" });
    await sess.flush();
    await writeFile(path.join(dir, "20260912-000000-bad.jsonl"), "garbage{{{\n", "utf-8");

    const handle = createAdminApi({ configPath: path.join(dir, "experts.json"), recordsDir: dir, configRef: { config: stubConfig }, logger });
    const res = makeReqRes("GET", "/api/usage");
    await handle(res.req, res.res);
    expect(res.status()).toBe(200);
    const agg = JSON.parse(res.body()) as { sessionCount: number; callCount: number; skipped: number; total: { promptTokens?: number } };
    expect(agg.skipped).toBe(1);
    expect(agg.sessionCount).toBe(1);
    expect(agg.callCount).toBe(1);
    expect(agg.total).toEqual({ promptTokens: 10, completionTokens: 5 });
  });
});
