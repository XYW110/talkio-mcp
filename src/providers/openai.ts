/**
 * OpenAI adapter —— 复用 openai-compatible 实现，baseUrl 默认 https://api.openai.com/v1。
 * 单独成文件以便未来支持 Responses API 等新接口（design.md §5 / implement.md Step 3）。
 */

import type { ProviderAdapter } from "./adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createOpenAIAdapter(): ProviderAdapter {
  return createOpenAICompatibleAdapter(OPENAI_DEFAULT_BASE_URL);
}
