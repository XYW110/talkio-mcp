/**
 * 专家记忆模块单测（groupchat-strengths R3）。
 * 覆盖：resolve 覆盖链 / append+load 往返 / 坏行容错 / buildMemoryBlock
 * 窗口截断与零字节 / parseMemoryLine（最后行优先、未命中零改动、截断）/
 * redactPII 生效 / clearExpertMemory。
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMemory,
  buildMemoryBlock,
  clearExpertMemory,
  loadExpertMemories,
  parseMemoryLine,
  resolveMemoryDir,
  MEMORY_BLOCK_MAX_CHARS,
  MEMORY_MAX_ENTRIES,
  MEMORY_TEXT_MAX_CHARS,
} from "../src/experts/memory.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "talkio-memory-"));
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  delete process.env.TALKIO_MEMORY_DIR;
});

describe("resolveMemoryDir", () => {
  it("显式参数最优先；空白视为未传", () => {
    process.env.TALKIO_MEMORY_DIR = "/from-env";
    expect(resolveMemoryDir("/explicit")).toBe("/explicit");
    expect(resolveMemoryDir("  ")).toBe("/from-env");
  });

  it("env 次之；都缺省落到 <cwd>/memory", () => {
    delete process.env.TALKIO_MEMORY_DIR;
    process.env.TALKIO_MEMORY_DIR = "/from-env";
    expect(resolveMemoryDir()).toBe("/from-env");
    delete process.env.TALKIO_MEMORY_DIR;
    expect(resolveMemoryDir()).toBe(path.resolve(process.cwd(), "memory"));
  });
});

describe("appendMemory / loadExpertMemories", () => {
  it("追加 → 读取往返（旧→新顺序）；目录懒创建", () => {
    const dir = tmp();
    expect(loadExpertMemories(dir, "arch")).toEqual([]);
    appendMemory(dir, "arch", "该团队偏好简短结论");
    appendMemory(dir, "arch", "成本敏感");
    const entries = loadExpertMemories(dir, "arch");
    expect(entries.map((e) => e.text)).toEqual([
      "该团队偏好简短结论",
      "成本敏感",
    ]);
    expect(typeof entries[0]!.ts).toBe("string");
  });

  it("超长文本截断到 MEMORY_TEXT_MAX_CHARS", () => {
    const dir = tmp();
    appendMemory(dir, "arch", "x".repeat(200));
    const [entry] = loadExpertMemories(dir, "arch");
    expect(entry!.text.length).toBe(MEMORY_TEXT_MAX_CHARS);
  });

  it("PII 掩码：手机号/邮箱在落盘前被替换", () => {
    const dir = tmp();
    appendMemory(dir, "arch", "联系 13800138000 或 a@b.com");
    const [entry] = loadExpertMemories(dir, "arch");
    expect(entry!.text).not.toContain("13800138000");
    expect(entry!.text).not.toContain("a@b.com");
    expect(entry!.text).toContain("[手机号]");
    expect(entry!.text).toContain("[邮箱]");
  });

  it("坏行容错：坏行跳过，好行照常返回", () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, "arch.jsonl"),
      "{not json}\n" +
        JSON.stringify({ ts: "2026-10-02T00:00:00.000Z", text: "ok1" }) +
        "\n\n" +
        JSON.stringify({ ts: "x", text: "" }) +
        "\n" +
        JSON.stringify({ ts: "2026-10-02T00:00:01.000Z", text: "ok2" }) +
        "\n"
    );
    expect(loadExpertMemories(dir, "arch").map((e) => e.text)).toEqual([
      "ok1",
      "ok2",
    ]);
  });

  it("空白文本不落盘", () => {
    const dir = tmp();
    appendMemory(dir, "arch", "   ");
    expect(loadExpertMemories(dir, "arch")).toEqual([]);
  });
});

describe("buildMemoryBlock", () => {
  it("空条目 → 空串（零字节注入红线）", () => {
    expect(buildMemoryBlock([])).toBe("");
  });

  it("只保留最近 N 条（旧→新），更早的丢弃", () => {
    const entries = [1, 2, 3, 4, 5].map((i) => ({
      ts: `2026-10-0${i}T00:00:00.000Z`,
      text: `m${i}`,
    }));
    const block = buildMemoryBlock(entries);
    expect(block).toContain("m3");
    expect(block).toContain("m5");
    expect(block).not.toContain("m1");
    expect(block).not.toContain("m2");
  });

  it("块长超预算从最旧开始丢，但至少保留 1 条", () => {
    // 3 条 × 203 chars 必然超 400 预算 → 丢到只剩最新 1 条
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ts: `2026-10-0${i + 1}T00:00:00.000Z`,
      text: `${"长".repeat(200)}#${i + 1}`,
    }));
    const block = buildMemoryBlock(entries);
    expect(block.length).toBeLessThanOrEqual(MEMORY_BLOCK_MAX_CHARS);
    expect(block).toContain("#5"); // 最新一条永远保留
    expect(block).not.toContain("#3"); // 旧的被丢
    expect(block).not.toContain("#4");
  });

  it("表头含定位说明，条目带日期短缀", () => {
    const block = buildMemoryBlock([
      { ts: "2026-10-02T12:00:00.000Z", text: "abc" },
    ]);
    expect(block).toContain("【你的历史记忆");
    expect(block).toContain("（2026-10-02）");
    expect(block).toContain("- abc");
  });
});

describe("parseMemoryLine", () => {
  it("未命中 → content 原样返回（零改动）", () => {
    const content = "观点A\n论据B";
    expect(parseMemoryLine(content)).toEqual({ content, memory: null });
  });

  it("命中行首「记忆：」：剥离该行，返回记忆文本", () => {
    const { content, memory } = parseMemoryLine(
      "观点A\n论据B\n记忆：这个团队成本敏感"
    );
    expect(memory).toBe("这个团队成本敏感");
    expect(content).toBe("观点A\n论据B");
  });

  it("半角冒号同样识别；多次出现只认最后一行", () => {
    const { content, memory } = parseMemoryLine(
      "记忆: 第一次提到不算\n观点\n记忆：最终沉淀这条"
    );
    expect(memory).toBe("最终沉淀这条");
    expect(content).toBe("记忆: 第一次提到不算\n观点");
  });

  it("「记忆：」后为空 → memory 为 null（不落盘）", () => {
    const { content, memory } = parseMemoryLine("观点\n记忆：");
    expect(memory).toBeNull();
    expect(content).toBe("观点");
  });

  it("行中提及（非行首）不触发剥离", () => {
    const content = "我上次记忆：很深";
    expect(parseMemoryLine(content)).toEqual({ content, memory: null });
  });

  it("剥离后多余空行收敛（≥3 连续空行 → 1 空行）", () => {
    const { content } = parseMemoryLine("a\n\n\n\n\nb\n记忆：x");
    expect(content).toBe("a\n\nb");
  });
});

describe("clearExpertMemory", () => {
  it("存在则删除返回 true；不存在返回 false", () => {
    const dir = tmp();
    appendMemory(dir, "arch", "x");
    expect(clearExpertMemory(dir, "arch")).toBe(true);
    expect(existsSync(path.join(dir, "arch.jsonl"))).toBe(false);
    expect(clearExpertMemory(dir, "arch")).toBe(false);
  });
});

describe("appendMemory IO 失败吞错", () => {
  it("目录被文件占用（ENOTDIR）时不抛错", () => {
    const dir = tmp();
    const blocker = path.join(dir, "arch.jsonl");
    writeFileSync(blocker, ""); // 正常文件占位
    // 制造失败：把 memoryDir 指向一个文件路径
    const fileAsDir = path.join(dir, "occupied");
    writeFileSync(fileAsDir, "not a dir");
    expect(() => appendMemory(fileAsDir, "arch", "x")).not.toThrow();
    // 原文件未被破坏
    expect(readFileSync(blocker, "utf-8")).toBe("");
  });
});

describe("MEMORY_MAX_ENTRIES 窗口常量", () => {
  it("注入窗口为 3（设计值）", () => {
    expect(MEMORY_MAX_ENTRIES).toBe(3);
  });
});
