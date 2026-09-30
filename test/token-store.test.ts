import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpTokenStore, sha256Hex } from "../src/auth/tokens.js";
import { createLogger } from "../src/utils/log.js";

const logger = createLogger("error");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talkio-token-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function storePath(): string {
  return path.join(dir, "mcp-tokens.json");
}

describe("McpTokenStore 生成与校验", () => {
  it("生成 → 明文校验通过；错 token 拒绝；格式 mtok_ 前缀", async () => {
    const store = new McpTokenStore(storePath(), logger);
    await store.load();

    const created = await store.generate("cursor-桌面");
    expect(created.plaintext.startsWith("mtok_")).toBe(true);
    expect(created.name).toBe("cursor-桌面");
    expect(created.id.startsWith("mtok_")).toBe(true);

    expect(await store.verify(created.plaintext)).toBe(true);
    expect(await store.verify("mtok_wrong-token")).toBe(false);
    expect(await store.verify("")).toBe(false);
  });

  it("删除即时失效；未知 id 返回 false", async () => {
    const store = new McpTokenStore(storePath(), logger);
    await store.load();
    const a = await store.generate("a");
    const b = await store.generate("b");

    expect(await store.verify(a.plaintext)).toBe(true);
    expect(await store.revoke(a.id)).toBe(true);
    expect(await store.verify(a.plaintext)).toBe(false);
    expect(await store.verify(b.plaintext)).toBe(true);

    expect(await store.revoke("mtok_no-such-id")).toBe(false);
  });

  it("list() 只含 id/name/createdAt/lastUsedAt/指纹后4位，不含哈希与明文", async () => {
    const store = new McpTokenStore(storePath(), logger);
    await store.load();
    const created = await store.generate("列表形态");

    const list = store.list();
    expect(list).toHaveLength(1);
    const item = list[0]!;
    expect(item.id).toBe(created.id);
    expect(item.name).toBe("列表形态");
    expect(item.lastUsedAt).toBeNull();
    expect(item.fingerprint).toBe(sha256Hex(created.plaintext).slice(-4));
    expect(item.fingerprint).toHaveLength(4);
    // 明文/哈希绝不出现
    expect(JSON.stringify(list)).not.toContain(created.plaintext);
    expect(JSON.stringify(list)).not.toContain(sha256Hex(created.plaintext));
  });
});

describe("McpTokenStore 持久化", () => {
  it("持久化 → 新实例 reload 后旧 token 仍可验证、已删 token 保持失效", async () => {
    const store = new McpTokenStore(storePath(), logger);
    await store.load();
    const keep = await store.generate("保留");
    const drop = await store.generate("删除");
    await store.revoke(drop.id);

    const reloaded = new McpTokenStore(storePath(), logger);
    await reloaded.load();
    expect(await reloaded.verify(keep.plaintext)).toBe(true);
    expect(await reloaded.verify(drop.plaintext)).toBe(false);
    expect(reloaded.list()).toHaveLength(1);
  });

  it("落盘只存 SHA-256 哈希，明文绝不出现；不留 .tmp 半截文件", async () => {
    const store = new McpTokenStore(storePath(), logger);
    await store.load();
    const created = await store.generate("机密检查");

    const raw = await readFile(storePath(), "utf8");
    expect(raw).not.toContain(created.plaintext);
    expect(raw).toContain(sha256Hex(created.plaintext));
    const parsed = JSON.parse(raw) as { version: number; tokens: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.tokens).toHaveLength(1);

    await store.revoke(created.id);
    await store.flush();
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("文件缺失 → 空池；JSON 损坏 → 空池 + 全部拒绝（fail-closed）", async () => {
    const missing = new McpTokenStore(path.join(dir, "不存在.json"), logger);
    await missing.load();
    expect(missing.list()).toEqual([]);

    const corrupted = new McpTokenStore(path.join(dir, "corrupted.json"), logger);
    await writeFile(path.join(dir, "corrupted.json"), "{not-json{{{", "utf8");
    await corrupted.load();
    expect(corrupted.list()).toEqual([]);
    expect(await corrupted.verify("mtok_anything")).toBe(false);
  });

  it("lastUsedAt：内存即时更新；节流窗口内不落盘，超窗后持久化", async () => {
    // 大节流窗口（默认量级）：verify 后 flush，文件仍无 lastUsedAt
    const throttled = new McpTokenStore(storePath(), logger, 60_000);
    await throttled.load();
    const created = await throttled.generate("节流");
    expect(await throttled.verify(created.plaintext)).toBe(true);
    expect(throttled.list()[0]!.lastUsedAt).not.toBeNull();
    await throttled.flush();
    const rawThrottled = await readFile(storePath(), "utf8");
    expect(rawThrottled).toContain('"lastUsedAt": null');

    // 节流窗口 = 0：每次 verify 都安排落盘
    const immediate = new McpTokenStore(path.join(dir, "immediate.json"), logger, 0);
    await immediate.load();
    const created2 = await immediate.generate("即时");
    expect(await immediate.verify(created2.plaintext)).toBe(true);
    await immediate.flush();
    const rawImmediate = await readFile(path.join(dir, "immediate.json"), "utf8");
    expect(rawImmediate).not.toContain('"lastUsedAt": null');
    const parsed = JSON.parse(rawImmediate) as {
      tokens: Array<{ lastUsedAt: string | null }>;
    };
    expect(typeof parsed.tokens[0]!.lastUsedAt).toBe("string");
  });
});
