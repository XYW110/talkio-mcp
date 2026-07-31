/**
 * Provider registry —— provider type 名 → adapter 工厂（design.md §5）。
 *
 * - 已注册类型："openai" | "anthropic" | "openai-compatible"
 * - 未知 type → 抛出错误（启动期由 config 层拦截，运行期兜底）
 * - TALKIO_MOCK_PROVIDER=1 时，任何 type 都返回 echo mock adapter：
 *   回显用户消息并附加标记，用于无 API key 的集成测试（implement.md Step 7）
 */

import type { ProviderAdapter } from "./adapter.js";
import { createOpenAIAdapter, OPENAI_DEFAULT_BASE_URL } from "./openai.js";
import { createAnthropicAdapter, ANTHROPIC_DEFAULT_BASE_URL } from "./anthropic.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";

/** mock adapter 在回显内容末尾附加的标记，便于测试断言 */
export const MOCK_MARKER = "[TALKIO-MOCK]";

/**
 * echo mock adapter：不发起任何网络请求，
 * 回显最后一条用户消息（无用户消息时回显最后一条消息）并附加 MOCK_MARKER。
 */
function createMockAdapter(): ProviderAdapter {
  return {
    async chat(params) {
      const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
      const echo = lastUser?.content ?? params.messages.at(-1)?.content ?? "(empty)";
      return {
        content: `${echo}\n\n${MOCK_MARKER} model=${params.model}`,
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    },
  };
}

/** 单例缓存：同一 type 复用同一 adapter 实例（adapter 无状态） */
const adapterCache = new Map<string, ProviderAdapter>();
let mockAdapterSingleton: ProviderAdapter | undefined;

/** 是否启用 mock provider（每次调用时读取，便于测试动态切换） */
export function isMockProviderEnabled(): boolean {
  return process.env.TALKIO_MOCK_PROVIDER === "1";
}

/**
 * 按 provider type 获取 adapter。
 * @throws {Error} 未知 type
 */
export function getAdapter(type: string): ProviderAdapter {
  if (isMockProviderEnabled()) {
    mockAdapterSingleton ??= createMockAdapter();
    return mockAdapterSingleton;
  }

  const cached = adapterCache.get(type);
  if (cached) {
    return cached;
  }

  let adapter: ProviderAdapter;
  switch (type) {
    case "openai":
      adapter = createOpenAIAdapter();
      break;
    case "anthropic":
      adapter = createAnthropicAdapter();
      break;
    case "openai-compatible":
      // 通用兼容实现：默认 baseUrl 仅作兜底，实际以 creds.baseUrl 为准
      adapter = createOpenAICompatibleAdapter(OPENAI_DEFAULT_BASE_URL);
      break;
    default:
      throw new Error(
        `未知的 provider type: "${type}"（已注册: openai, anthropic, openai-compatible）`
      );
  }

  adapterCache.set(type, adapter);
  return adapter;
}

/** 供 registry 使用方参考的默认 baseUrl 表 */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: OPENAI_DEFAULT_BASE_URL,
  anthropic: ANTHROPIC_DEFAULT_BASE_URL,
};
