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

/** 思考强度等级（reasoning 模型专用，undefined = 不传，使用模型默认行为） */
export type ThinkingLevel = "high" | "medium" | "low" | "disabled";

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 思考强度（仅 reasoning 模型生效，由 openai-compatible adapter 映射到 body 参数） */
  thinkingLevel?: ThinkingLevel;
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
