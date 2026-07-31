/**
 * OpenAI 兼容 API adapter —— 对应 design.md §5 的 openai-compatible。
 *
 * 请求：POST {baseUrl}/chat/completions，Authorization: Bearer <key>
 * 响应：解析 choices[0].message.content 与 usage.prompt_tokens/completion_tokens
 *
 * DeepSeek、Moonshot、Qwen 等 OpenAI 兼容服务直接复用本 adapter（config-only 新增 provider）。
 */

import type { ChatParams, ChatResult, ProviderAdapter } from "./adapter.js";
import { fetchWithRetry } from "../utils/retry.js";

/** OpenAI chat.completions 响应的最小类型（仅取我们需要的字段） */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/** 规范化 baseUrl：去掉末尾斜杠，避免拼接出 //chat/completions */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * 创建 OpenAI 兼容 adapter。
 * @param defaultBaseUrl 该实现的默认 baseUrl（creds.baseUrl 为空时兜底）
 */
export function createOpenAICompatibleAdapter(defaultBaseUrl: string): ProviderAdapter {
  return {
    async chat(params: ChatParams, creds: { apiKey: string; baseUrl: string }): Promise<ChatResult> {
      const baseUrl = normalizeBaseUrl(creds.baseUrl || defaultBaseUrl);
      const url = `${baseUrl}/chat/completions`;

      const body: Record<string, unknown> = {
        model: params.model,
        messages: params.messages,
      };
      if (params.temperature !== undefined) {
        body.temperature = params.temperature;
      }
      if (params.maxTokens !== undefined) {
        body.max_tokens = params.maxTokens;
      }

      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        { timeoutMs: params.timeoutMs }
      );

      const data = (await res.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("OpenAI-compatible API 响应缺少 choices[0].message.content");
      }

      const result: ChatResult = { content };
      const promptTokens = data.usage?.prompt_tokens;
      const completionTokens = data.usage?.completion_tokens;
      if (promptTokens !== undefined || completionTokens !== undefined) {
        result.usage = { promptTokens, completionTokens };
      }
      return result;
    },
  };
}
