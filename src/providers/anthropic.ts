/**
 * Anthropic messages adapter —— 对应 design.md §5 的 anthropic。
 *
 * 请求：POST {baseUrl}/v1/messages
 *   headers: x-api-key + anthropic-version: 2023-06-01
 *   body: { model, system?, messages, max_tokens, temperature? }
 *   —— system 角色的 ChatMessage 拆分为顶层 system 参数（Anthropic 不接受 system 在 messages 里）
 * 响应：拼接 content 数组中所有 type === "text" 的块；
 *   usage.input_tokens/output_tokens 映射为 promptTokens/completionTokens
 */

import type { ChatMessage, ChatParams, ChatResult, ProviderAdapter } from "./adapter.js";
import { fetchWithRetry } from "../utils/retry.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic messages 响应的最小类型 */
interface AnthropicMessagesResponse {
  content?: Array<{
    type: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * 将统一 ChatMessage[] 拆分为 Anthropic 的 system 顶层参数 + messages 数组。
 * 多个 system 消息用空行拼接；user/assistant 保留原顺序。
 */
function splitSystemMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      rest.push({ role: msg.role, content: msg.content });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}

export function createAnthropicAdapter(): ProviderAdapter {
  return {
    async chat(params: ChatParams, creds: { apiKey: string; baseUrl: string }): Promise<ChatResult> {
      const baseUrl = normalizeBaseUrl(creds.baseUrl || ANTHROPIC_DEFAULT_BASE_URL);
      const url = `${baseUrl}/v1/messages`;

      const { system, messages } = splitSystemMessages(params.messages);

      const body: Record<string, unknown> = {
        model: params.model,
        messages,
        // Anthropic 要求 max_tokens 必填
        max_tokens: params.maxTokens ?? 4096,
      };
      if (system !== undefined) {
        body.system = system;
      }
      if (params.temperature !== undefined) {
        body.temperature = params.temperature;
      }

      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": creds.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        },
        { timeoutMs: params.timeoutMs }
      );

      const data = (await res.json()) as AnthropicMessagesResponse;

      // 拼接所有 text 块（thinking 等其他类型块忽略）
      const textParts = (data.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string);

      if (textParts.length === 0) {
        throw new Error("Anthropic API 响应缺少 text 内容块");
      }

      const result: ChatResult = { content: textParts.join("") };
      const promptTokens = data.usage?.input_tokens;
      const completionTokens = data.usage?.output_tokens;
      if (promptTokens !== undefined || completionTokens !== undefined) {
        result.usage = { promptTokens, completionTokens };
      }
      return result;
    },
  };
}
