/**
 * 渠道密钥存储 keys.json —— provider（渠道）API Key 的独立持久化池。
 *
 * 契约（design.md §1，任务 09-30-provider-keys-ui）：
 * - 文件形如 { version: 1, providers: { <providerId>: { apiKey, updatedAt } } }，
 *   默认 experts.json 同目录 keys.json，TALKIO_KEYS_FILE 可覆盖（路径装配在 index.ts）；
 * - 缺失 / JSON 损坏 → 空密钥池（fail-closed：无 key 即报 missing key）+ `[keys]` warn；
 * - set(pid, "") = 清除该渠道条目；写入后内存即时生效（热生效），落盘失败仅 warn，
 *   绝不影响主请求（对齐 records-persistence 红线）；tmp + rename 原子写；
 * - 明文永不回传：对外只暴露 get()（内部凭据解析用）与 fingerprint()（尾 4 位 + updatedAt）。
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Logger } from "../utils/log.js";

/** keys.json 中单渠道的落盘记录。 */
export interface ProviderKeyEntry {
  apiKey: string;
  /** ISO8601；写入/更新时间 */
  updatedAt: string;
}

interface KeysFile {
  version: 1;
  providers: Record<string, ProviderKeyEntry>;
}

/** fingerprint() 返回的对外快照：只有指纹（尾 4 位）与 updatedAt，绝不含明文。 */
export interface KeyFingerprint {
  fingerprint: string;
  updatedAt: string;
}

export class KeysStore {
  private providers = new Map<string, ProviderKeyEntry>();

  constructor(
    /** keys.json 绝对路径；undefined = 纯内存模式（测试注入用，set 不落盘） */
    private readonly filePath?: string,
    private readonly logger?: Logger
  ) {}

  /**
   * 从磁盘加载密钥池。文件缺失 → 空池（静默，首次部署常态）；
   * JSON 损坏 / 结构非法 → 空池 + `[keys]` warn（fail-closed，绝不回退到默认凭据）。
   */
  async load(): Promise<void> {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      this.providers = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { providers?: unknown };
      const table = parsed.providers;
      if (typeof table !== "object" || table === null || Array.isArray(table)) {
        throw new Error("providers 字段不是对象");
      }
      const next = new Map<string, ProviderKeyEntry>();
      for (const [pid, entry] of Object.entries(table as Record<string, unknown>)) {
        const rec = entry as Partial<ProviderKeyEntry> | null;
        // 空串 / 非法条目按未配置处理（等价清除）
        if (rec && typeof rec.apiKey === "string" && rec.apiKey.length > 0) {
          next.set(pid, {
            apiKey: rec.apiKey,
            updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : "",
          });
        }
      }
      this.providers = next;
    } catch (err) {
      this.providers = new Map();
      this.logger?.warn(
        `[keys] 密钥文件损坏，按空密钥池处理（渠道调用将报 missing key）: ${this.filePath} — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /** 读取渠道明文 key（内部凭据解析专用；管理接口一律走 fingerprint）。 */
  get(providerId: string): string | undefined {
    return this.providers.get(providerId)?.apiKey;
  }

  /**
   * 写入或清除渠道 key。空串（含纯空白）= 清除条目。
   * 内存即时更新（热生效），随后异步落盘；落盘失败仅 `[keys]` warn（内存值保留）。
   */
  async set(providerId: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed === "") {
      this.providers.delete(providerId);
    } else {
      this.providers.set(providerId, {
        apiKey: trimmed,
        updatedAt: new Date().toISOString(),
      });
    }
    await this.persist();
  }

  /** 对外快照：指纹 = 明文尾 4 位；未配置返回 undefined。 */
  fingerprint(providerId: string): KeyFingerprint | undefined {
    const entry = this.providers.get(providerId);
    if (!entry) return undefined;
    return { fingerprint: entry.apiKey.slice(-4), updatedAt: entry.updatedAt };
  }

  /** 原子落盘：tmp 文件 + rename；失败仅 `[keys]` warn，绝不向上抛。 */
  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const table: Record<string, ProviderKeyEntry> = {};
    for (const [pid, entry] of this.providers) {
      table[pid] = entry;
    }
    const data: KeysFile = { version: 1, providers: table };
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      this.logger?.warn(
        `[keys] 密钥文件写入失败（内存已更新，重启后可能回退旧值）: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 进程级单例（与 config.ts cachedConfig 同款模式）
// ---------------------------------------------------------------------------

let singleton: KeysStore | undefined;

/** 获取进程级密钥池；未装配时返回空内存池（get 恒 undefined = fail-closed）。 */
export function getKeysStore(): KeysStore {
  singleton ??= new KeysStore();
  return singleton;
}

/** 替换进程级密钥池（index.ts 启动装配；测试注入用）。 */
export function setKeysStore(store: KeysStore): void {
  singleton = store;
}

/** 装配并加载进程级密钥池（load 完成后返回同一实例）。 */
export async function initKeysStore(
  filePath: string | undefined,
  logger?: Logger
): Promise<KeysStore> {
  const store = new KeysStore(filePath, logger);
  await store.load();
  setKeysStore(store);
  return store;
}
