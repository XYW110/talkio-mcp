import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isRecordingEnabled,
  listSessions,
  readSession,
  resolveRecordsDir,
  isValidSessionId,
  startSession,
  sumUsage,
} from "../src/records/store.js";

const ENV = ["TALKIO_RECORDS", "TALKIO_RECORDS_DIR"] as const;
const saved: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of ENV) saved[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function clearEnv(): void {
  for (const k of ENV) delete process.env[k];
}

let dir: string;
beforeEach(async () => {
  clearEnv();
  dir = await mkdtemp(path.join(tmpdir(), "talkio-records-"));
});
afterEach(async () => {
  restoreEnv();
  await rm(dir, { recursive: true, force: true });
});

describe("isRecordingEnabled", () => {
  it("默认开启", () => {
    clearEnv();
    expect(isRecordingEnabled()).toBe(true);
  });
  it("TALKIO_RECORDS=0 关闭", () => {
    process.env.TALKIO_RECORDS = "0";
    expect(isRecordingEnabled()).toBe(false);
  });
  it("TALKIO_RECORDS=1 开启", () => {
    process.env.TALKIO_RECORDS = "1";
    expect(isRecordingEnabled()).toBe(true);
  });
});

describe("resolveRecordsDir", () => {
  it("显式参数最优先", () => {
    process.env.TALKIO_RECORDS_DIR = "/env/path";
    expect(resolveRecordsDir("/explicit/path")).toBe("/explicit/path");
  });
  it("退到 TALKIO_RECORDS_DIR", () => {
    process.env.TALKIO_RECORDS_DIR = "/env/path";
    expect(resolveRecordsDir(undefined)).toBe("/env/path");
  });
  it("最后退到 cwd/records", () => {
    expect(resolveRecordsDir(undefined)).toBe(
      path.resolve(process.cwd(), "records"),
    );
  });
});

describe("isValidSessionId", () => {
  it("接受合法 id", () => {
    expect(isValidSessionId("20260904-123456-abcd")).toBe(true);
  });
  it("拒绝路径穿越与空值", () => {
    expect(isValidSessionId("../etc/passwd")).toBe(false);
    expect(isValidSessionId("20260904-123456-abcd/../../x")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("..")).toBe(false);
  });
});

describe("startSession + append + finish", () => {
  it("写 meta 行、事件行、done 行，且是合法 JSONL", async () => {
    const sess = await startSession(
      { tool: "consult_experts", prompt: "你好", context: "背景" },
      dir,
    );
    expect(sess).not.toBeNull();
    sess!.append({
      type: "cards",
      cards: [
        {
          cardId: "c1",
          cardName: "架构师",
          expertId: "architect",
          expertName: "架构师",
          modelId: "m1",
          provider: "openai",
        },
      ],
    });
    sess!.append({
      type: "card_result",
      cardId: "c1",
      ok: true,
      content: "回答",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    sess!.finish({
      status: "ok",
      report: "# 报告",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    await sess!.flush();

    const file = path.join(dir, `${sess!.id}.jsonl`);
    const raw = await readFile(file, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(4);

    const meta = JSON.parse(lines[0]!) as {
      type: string;
      id: string;
      tool: string;
      prompt: string;
    };
    expect(meta.type).toBe("meta");
    expect(meta.id).toBe(sess!.id);
    expect(meta.tool).toBe("consult_experts");
    expect(meta.prompt).toBe("你好");

    const cards = JSON.parse(lines[1]!) as { type: string; cards: unknown[] };
    expect(cards.type).toBe("cards");
    expect(cards.cards).toHaveLength(1);

    const cardResult = JSON.parse(lines[2]!) as {
      type: string;
      cardId: string;
      ok: boolean;
      usage: { promptTokens: number };
    };
    expect(cardResult.type).toBe("card_result");
    expect(cardResult.cardId).toBe("c1");
    expect(cardResult.ok).toBe(true);
    expect(cardResult.usage.promptTokens).toBe(10);

    const done = JSON.parse(lines[3]!) as {
      type: string;
      status: string;
      report: string;
    };
    expect(done.type).toBe("done");
    expect(done.status).toBe("ok");
    expect(done.report).toContain("# 报告");
  });

  it("disabled 时返回 null 且不产生文件", async () => {
    process.env.TALKIO_RECORDS = "0";
    const sess = await startSession({ tool: "brainstorm", prompt: "x" }, dir);
    expect(sess).toBeNull();
    const entries = (await readdir(dir).catch(() => [] as string[])).filter(
      (n) => n.endsWith(".jsonl"),
    );
    expect(entries).toHaveLength(0);
  });

  it("目录不可写时吞错返回 null，不抛异常", async () => {
    const bad = path.join(dir, "blocked");
    await writeFile(bad, "x"); // 以文件占位，mkdir(recursive) 必然失败
    let sess: Awaited<ReturnType<typeof startSession>> = null;
    await expect(async () => {
      sess = await startSession({ tool: "brainstorm", prompt: "x" }, bad);
    }).not.toThrow();
    expect(sess).toBeNull();
  });
});

describe("sumUsage", () => {
  it("全空返回 undefined", () => {
    expect(sumUsage(undefined, undefined)).toBeUndefined();
  });
  it("缺省字段不虚构", () => {
    expect(sumUsage({ promptTokens: 1 }, undefined)).toEqual({
      promptTokens: 1,
    });
  });
  it("两对象同字段求和", () => {
    expect(
      sumUsage({ promptTokens: 1, completionTokens: 2 }, { promptTokens: 3 }),
    ).toEqual({ promptTokens: 4, completionTokens: 2 });
  });
});

describe("listSessions + readSession", () => {
  it("列表倒序返回 meta 摘要并含 sizeBytes", async () => {
    const a = (await startSession({ tool: "brainstorm", prompt: "A" }, dir))!;
    const b = (await startSession({ tool: "consult_experts", prompt: "B" }, dir))!;
    a.finish({ status: "ok" });
    b.finish({ status: "ok" });
    await a.flush();
    await b.flush();

    const list = await listSessions(dir, 10);
    expect(list).toHaveLength(2);
    // 按文件名倒序（同秒内创建的会话时间戳前缀相同，顺序由随机后缀决定）。
    const ids = list.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(list[0]!.id > list[1]!.id).toBe(true);
    expect(typeof list[0]!.sizeBytes).toBe("number");
  });

  it("readSession 逐行解析，忽略坏行", async () => {
    const sess = (await startSession({ tool: "brainstorm", prompt: "×" }, dir))!;
    sess.finish({ status: "ok", report: "r" });
    await sess.flush();
    const file = path.join(dir, `${sess.id}.jsonl`);
    // 注入一行坏 JSON，仍应读到剩余合法行。
    await writeFile(file, (await readFile(file, "utf-8")) + "not-json\n", "utf-8");
    const events = await readSession(dir, sess.id);
    expect(events).not.toBeNull();
    expect(events!.length).toBe(2); // meta + done（坏行被跳过）
  });

  it("readSession 拒绝非法 id（路径穿越）", async () => {
    expect(await readSession(dir, "../evil")).toBeNull();
  });

  it("readSession 不存在的 id 返回 null", async () => {
    expect(await readSession(dir, "20260101-000000-ffff")).toBeNull();
  });
});