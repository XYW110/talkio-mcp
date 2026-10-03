import { expect } from "vitest";
import { KeysStore, setKeysStore } from "../../src/keys/store.js";

/**
 * keys.json fixture helper（任务 09-30-provider-keys-ui）。
 *
 * 渠道密钥不再来自 process.env：凭据解析（resolveProviderCredentials）与选卡
 * 过滤（hasProviderKey）都读进程级 KeysStore 单例。测试通过本 helper 注入
 * 内存模式的 store（set 即时生效、不落盘），替代旧的 env fixture。
 *
 * 用法（每个测试文件）：
 *   let keys: KeysStore;
 *   beforeEach(() => { keys = installKeysStore(); });
 *   // 用例内： await keys.set("openai", "sk-o");
 */

/** 安装空的进程级密钥池（内存模式，不落盘），返回实例供用例填 key。 */
export function installKeysStore(): KeysStore {
  const store = new KeysStore();
  setKeysStore(store);
  return store;
}

/** 批量填入渠道 key（等价后台逐渠道 PUT /api/keys，内存即时生效）。 */
export async function fillKeys(
  store: KeysStore,
  entries: Record<string, string>
): Promise<void> {
  for (const [pid, key] of Object.entries(entries)) {
    await store.set(pid, key);
  }
}

/**
 * 片段级掩码断言（掩码红线，09-30-provider-keys-ui）：body 中不得出现 secret
 * 的任何 ≥minLen 字符连续片段。合法响应最多含尾 4 位指纹（长度 4 < minLen），
 * 因此任何命中都意味着尾 4 位之外的片段泄漏（整串泄漏是其超集，一并覆盖）。
 */
export function expectNoKeyFragment(
  body: string,
  secret: string,
  minLen = 5
): void {
  for (let i = 0; i + minLen <= secret.length; i++) {
    const fragment = secret.slice(i, i + minLen);
    expect(body, `泄漏片段 "${fragment}"（位置 ${i}）`).not.toContain(fragment);
  }
}
