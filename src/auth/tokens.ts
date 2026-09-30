/**
 * MCP 访问令牌池 —— 纯逻辑 + 文件 IO（无 HTTP 依赖，可单测）。
 *
 * 契约（design.md §1）：
 * - 明文格式 `mtok_<base64url>`（crypto.randomBytes(24)），仅创建响应返回一次；
 * - 落盘只存 SHA-256 hex（tokenHash），明文绝不持久化；
 * - 存储文件默认 experts.json 同目录 `mcp-tokens.json`，`TALKIO_MCP_TOKENS_FILE` 可覆盖；
 * - 写盘 tmp + rename 原子替换；写失败仅 `[auth]` warn，不影响主请求；
 * - lastUsedAt 内存即时更新 + 60s 节流持久化，避免每请求写盘；
 * - 文件缺失 / 损坏 → 空池（fail-closed：无令牌即全拒），绝不注入默认凭据。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Logger } from "../utils/log.js";

/** 落盘记录（tokenHash 为 SHA-256 hex，明文永不落盘）。 */
export interface McpTokenRecord {
  /** 随机 id，URL 路径用（非机密） */
  id: string;
  /** 用户起的名字 */
  name: string;
  /** SHA-256(plaintext) hex */
  tokenHash: string;
  /** ISO8601 */
  createdAt: string;
  /** ISO8601 | null */
  lastUsedAt: string | null;
}

interface StoreFile {
  version: 1;
  tokens: McpTokenRecord[];
}

/** 列表条目（不含哈希与明文）；fingerprint = 哈希后 4 位。 */
export interface McpTokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  fingerprint: string;
}

/** generate() 的返回体；plaintext 仅此一次。 */
export interface GeneratedToken {
  id: string;
  name: string;
  createdAt: string;
  plaintext: string;
}

const TOKEN_PREFIX = "mtok_";
const DEFAULT_LAST_USED_THROTTLE_MS = 60_000;

/** SHA-256 hex（token 指纹 / 常量时间比较的定长化）。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 常量时间字符串比较：先各自 SHA-256 定长为 32 字节再 timingSafeEqual，
 * 避免长度差异直接短路造成长度泄漏。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = createHash("sha256").update(a, "utf8").digest();
  const bb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ab, bb);
}

/** 随机令牌 id（URL 路径用，非机密）。 */
export function newTokenId(): string {
  return TOKEN_PREFIX + randomBytes(8).toString("base64url");
}

/** 随机令牌明文：`mtok_<43字符 base64url>`。 */
export function newTokenPlaintext(): string {
  return TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

export class McpTokenStore {
  private tokens: McpTokenRecord[] = [];
  private lastPersistAt = 0;
  private pendingSave: Promise<void> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly logger?: Logger,
    /** lastUsedAt 持久化节流窗口（ms）；默认 60s，测试可注入更小值。 */
    private readonly lastUsedThrottleMs: number = DEFAULT_LAST_USED_THROTTLE_MS,
  ) {}

  /**
   * 从磁盘加载令牌池。文件缺失 → 空池；JSON 损坏 → 空池 + `[auth]` warn
   * （fail-closed：解析不出令牌就全部拒绝，绝不回退到默认凭据）。
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      this.tokens = [];
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { tokens?: unknown };
      if (!Array.isArray(parsed.tokens)) throw new Error("tokens 字段不是数组");
      this.tokens = [];
      for (const item of parsed.tokens) {
        const rec = item as Partial<McpTokenRecord> | null;
        if (
          rec &&
          typeof rec.id === "string" &&
          typeof rec.name === "string" &&
          typeof rec.tokenHash === "string" &&
          typeof rec.createdAt === "string"
        ) {
          this.tokens.push({
            id: rec.id,
            name: rec.name,
            tokenHash: rec.tokenHash,
            createdAt: rec.createdAt,
            lastUsedAt: typeof rec.lastUsedAt === "string" ? rec.lastUsedAt : null,
          });
        }
      }
    } catch (err) {
      this.tokens = [];
      this.logger?.warn(
        `[auth] 令牌文件损坏，按空令牌池处理（所有 MCP 令牌将 401）: ${this.filePath} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 生成新令牌：明文仅本返回值携带一次；落盘即时持久化。 */
  async generate(name: string): Promise<GeneratedToken> {
    const plaintext = newTokenPlaintext();
    const record: McpTokenRecord = {
      id: newTokenId(),
      name,
      tokenHash: sha256Hex(plaintext),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.tokens.push(record);
    await this.save();
    return { id: record.id, name: record.name, createdAt: record.createdAt, plaintext };
  }

  /**
   * 校验明文令牌：SHA-256 后与池内哈希做常量时间比对。
   * 命中即更新内存 lastUsedAt（节流持久化）；未命中不区分「不存在/已吊销」。
   */
  async verify(plaintext: string): Promise<boolean> {
    const hash = sha256Hex(plaintext);
    const hit = this.tokens.find(
      (t) =>
        t.tokenHash.length === hash.length &&
        timingSafeEqual(Buffer.from(t.tokenHash, "utf8"), Buffer.from(hash, "utf8")),
    );
    if (!hit) return false;
    this.touch(hit);
    return true;
  }

  /** 吊销（即时生效：每请求查内存）；id 不存在返回 false。落盘即时持久化。 */
  async revoke(id: string): Promise<boolean> {
    const idx = this.tokens.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.tokens.splice(idx, 1);
    await this.save();
    return true;
  }

  /** 列表快照（不含哈希与明文）。 */
  list(): McpTokenInfo[] {
    return this.tokens.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      fingerprint: t.tokenHash.slice(-4),
    }));
  }

  /** 仅供测试/优雅退出：等待尚未完成的落盘。 */
  async flush(): Promise<void> {
    const pending = this.pendingSave;
    if (pending) {
      this.pendingSave = null;
      await pending;
    }
  }

  /** lastUsedAt 内存即时更新；距上次落盘超过节流窗口才安排一次持久化。 */
  private touch(record: McpTokenRecord): void {
    record.lastUsedAt = new Date().toISOString();
    const now = Date.now();
    if (now - this.lastPersistAt >= this.lastUsedThrottleMs) {
      this.lastPersistAt = now;
      void this.save();
    }
  }

  /** 原子落盘：tmp 文件 + rename；失败仅 `[auth]` warn，绝不向上抛。 */
  private async persist(): Promise<void> {
    const data: StoreFile = { version: 1, tokens: this.tokens };
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      await rename(tmp, this.filePath);
      // 节流基准 = 上一次真实落盘成功时刻（generate/revoke 的即时保存同样计入窗口）
      this.lastPersistAt = Date.now();
    } catch (err) {
      this.logger?.warn(
        `[auth] 令牌文件写入失败（不影响主流程）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private save(): Promise<void> {
    this.pendingSave = this.persist();
    return this.pendingSave;
  }
}
