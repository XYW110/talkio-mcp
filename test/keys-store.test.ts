import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeysStore,
  getKeysStore,
  initKeysStore,
  setKeysStore,
} from "../src/keys/store.js";
import { createLogger } from "../src/utils/log.js";
import { expectNoKeyFragment } from "./helpers/keys.js";

/**
 * keys.json 存储契约（design.md §1，任务 09-30-provider-keys-ui）：
 * - set/get round-trip；空串 = 清除；tmp+rename 原子写无残留；
 * - 文件缺失 → 空池静默；损坏 → 空池 + `[keys]` warn（fail-closed）；
 * - 写失败只 warn（内存即时生效，绝不影响主请求）；
 * - fingerprint 只回尾 4 位 + updatedAt，绝不含明文。
 */

describe("KeysStore（内存模式）", () => {
  it("set → get round-trip；重复 set 覆盖旧值", async () => {
    const store = new KeysStore();
    expect(store.get("custom")).toBeUndefined();

    await store.set("custom", "ah-1234567890");
    expect(store.get("custom")).toBe("ah-1234567890");

    await store.set("custom", "ah-0987654321");
    expect(store.get("custom")).toBe("ah-0987654321");
  });

  it("空串 = 清除条目；纯空白等价清除", async () => {
    const store = new KeysStore();
    await store.set("custom", "ah-key");
    await store.set("custom", "");
    expect(store.get("custom")).toBeUndefined();
    expect(store.fingerprint("custom")).toBeUndefined();

    await store.set("other", "ah-key");
    await store.set("other", "   ");
    expect(store.get("other")).toBeUndefined();
  });

  it("set 去除首尾空白", async () => {
    const store = new KeysStore();
    await store.set("custom", "  ah-key \n");
    expect(store.get("custom")).toBe("ah-key");
  });

  it("fingerprint 只暴露尾 4 位与 updatedAt，绝不含明文", async () => {
    const store = new KeysStore();
    const before = store.fingerprint("custom");
    expect(before).toBeUndefined();

    await store.set("custom", "ah-abcdefgh");
    const fp = store.fingerprint("custom");
    expect(fp?.fingerprint).toBe("efgh");
    expect(typeof fp?.updatedAt).toBe("string");
    expect(fp?.updatedAt.length).toBeGreaterThan(0);

    // 对外快照不含明文：JSON 序列化后不得出现完整 key 或尾 4 位之外的片段
    const serialized = JSON.stringify(fp);
    expect(serialized).not.toContain("ah-abcdefgh");
    expectNoKeyFragment(serialized, "ah-abcdefgh");
  });

  it("更新密钥时 updatedAt 单调不回退", async () => {
    const store = new KeysStore();
    await store.set("custom", "ah-first");
    const first = store.fingerprint("custom")!;
    await store.set("custom", "ah-second");
    const second = store.fingerprint("custom")!;
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.updatedAt).getTime()
    );
    expect(second.fingerprint).toBe("cond");
  });
});

describe("KeysStore（落盘模式）", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "talkio-keys-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("落盘 round-trip：set 后新实例 load 读回同值", async () => {
    const filePath = join(workDir, "keys.json");
    const store = new KeysStore(filePath);
    await store.set("custom", "ah-persisted");
    await store.set("openai", "sk-persisted");

    const reloaded = new KeysStore(filePath);
    await reloaded.load();
    expect(reloaded.get("custom")).toBe("ah-persisted");
    expect(reloaded.get("openai")).toBe("sk-persisted");
  });

  it("清除落盘持久：set 空串后重新 load 不再读到", async () => {
    const filePath = join(workDir, "keys.json");
    const store = new KeysStore(filePath);
    await store.set("custom", "ah-key");
    await store.set("custom", "");

    const reloaded = new KeysStore(filePath);
    await reloaded.load();
    expect(reloaded.get("custom")).toBeUndefined();
  });

  it("原子写：落盘后无 .tmp 残留，文件为合法 JSON 且含 version=1", async () => {
    const filePath = join(workDir, "keys.json");
    const store = new KeysStore(filePath);
    await store.set("custom", "ah-key");

    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
      version: number;
      providers: Record<string, { apiKey: string; updatedAt: string }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.providers.custom?.apiKey).toBe("ah-key");
  });

  it("文件缺失 → load 空池且不告警（首次部署常态）", async () => {
    const logger = createLogger("info");
    const warnSpy = vi.spyOn(logger, "warn");
    const store = new KeysStore(join(workDir, "absent.json"), logger);
    await store.load();
    expect(store.get("custom")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("损坏文件 → load 空池 + `[keys]` warn（fail-closed）", async () => {
    const filePath = join(workDir, "keys.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "{ not valid json !!!", "utf-8");

    const logger = createLogger("info");
    const warnSpy = vi.spyOn(logger, "warn");
    const store = new KeysStore(filePath, logger);
    await store.load();

    expect(store.get("custom")).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("[keys]");
  });

  it("结构非法（providers 不是对象）→ 空池 + warn", async () => {
    const filePath = join(workDir, "keys.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, JSON.stringify({ version: 1, providers: [1, 2] }), "utf-8");

    const logger = createLogger("info");
    const warnSpy = vi.spyOn(logger, "warn");
    const store = new KeysStore(filePath, logger);
    await store.load();
    expect(store.get("custom")).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("空 apiKey / 非法条目按未配置处理（加载容错）", async () => {
    const filePath = join(workDir, "keys.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        providers: {
          blank: { apiKey: "", updatedAt: "2026-09-30T00:00:00.000Z" },
          broken: null,
          good: { apiKey: "ah-good", updatedAt: "2026-09-30T00:00:00.000Z" },
        },
      }),
      "utf-8"
    );
    const store = new KeysStore(filePath);
    await store.load();
    expect(store.get("blank")).toBeUndefined();
    expect(store.get("broken")).toBeUndefined();
    expect(store.get("good")).toBe("ah-good");
  });

  it("写失败只 warn：内存即时生效，绝不上抛（红线）", async () => {
    // 指向一个不存在的目录 → writeFile 必失败
    const filePath = join(workDir, "no-such-dir", "keys.json");
    const logger = createLogger("info");
    const warnSpy = vi.spyOn(logger, "warn");
    const store = new KeysStore(filePath, logger);

    await expect(store.set("custom", "ah-key")).resolves.toBeUndefined();
    expect(store.get("custom")).toBe("ah-key");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("[keys]");
    // 失败路径也不得泄漏明文
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain("ah-key");
  });
});

describe("进程级单例装配", () => {
  it("getKeysStore 未装配时返回空内存池（fail-closed）", () => {
    setKeysStore(new KeysStore());
    expect(getKeysStore().get("custom")).toBeUndefined();
  });

  it("initKeysStore 装配并加载，getKeysStore 返回同一实例", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "talkio-keys-singleton-"));
    try {
      const filePath = join(workDir, "keys.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          providers: { custom: { apiKey: "ah-init", updatedAt: "" } },
        }),
        "utf-8"
      );
      const store = await initKeysStore(filePath);
      expect(getKeysStore()).toBe(store);
      expect(getKeysStore().get("custom")).toBe("ah-init");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      setKeysStore(new KeysStore());
    }
  });
});
