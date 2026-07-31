/**
 * Provider 抽象层接口 —— 严格对应 design.md §5。
 *
 * 所有 provider adapter 实现统一的非流式 chat() 接口；
 * 凭据（apiKey/baseUrl）在每次调用时传入，adapter 本身保持无状态。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface ProviderAdapter {
  chat(
    params: ChatParams,
    creds: { apiKey: string; baseUrl: string }
  ): Promise<ChatResult>;
}
