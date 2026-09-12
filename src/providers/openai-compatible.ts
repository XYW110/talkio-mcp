/**
 * OpenAI 兼容 API adapter —— 对应 design.md §5 的 openai-compatible。
 *
 * 请求：POST {baseUrl}/chat/completions，Authorization: Bearer <key>
 * 传输：SSE 流式（stream: true）逐 chunk 聚合，对外仍暴露非流式 chat() 接口。
 *   - 长回答不再受「总时长」超时影响：以 chunk 间空闲超时为准（每个 chunk 到达即续期），
 *     连接建立与首 chunk 用同一空闲窗口兜底；空闲超时抛 IdleTimeoutError（不静默截断）。
 *   - usage：优先取 SSE 末尾 `usage` 字段（OpenAI stream_options.include_usage 风格），
 *     缺失时退化为按字符数估算 completionTokens。
 *   - reasoning 模型兜底：choices[].delta.reasoning_content 不计入 content；
 *     全程无 delta.content 且有 reasoning_content 时，取 reasoning 文本兜底。
 *   - 兜底：服务端忽略 stream:true 返回非 SSE 的 JSON 时，按非流式 JSON 解析
 *     （choices[0].message.content，缺失时 message.reasoning_content 兜底）。
 *
 * DeepSeek、Moonshot、Qwen 等 OpenAI 兼容服务直接复用本 adapter（config-only 新增 provider）。
 */

import type { ChatParams, ChatResult, ProviderAdapter } from "./adapter.js";
import { fetchWithRetry } from "../utils/retry.js";

/** 规范化 baseUrl：去掉末尾斜杠，避免拼接出 //chat/completions */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** 空闲超时错误（区别于 retry.ts 的 TimeoutError 语义） */
class IdleTimeoutError extends Error {
  constructor(idleMs: number, receivedChars: number) {
    super(
      `Stream idle for more than ${idleMs}ms (received ${receivedChars} chars before stall)`
    );
    this.name = "IdleTimeoutError";
  }
}

interface SseChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** 从流式聚合结果收敛最终 content 与 usage（reasoning 兜底 + token 估算） */
function finalizeResult(
  content: string,
  reasoning: string,
  usage: ChatResult["usage"] | undefined
): ChatResult {
  let finalContent = content;
  if (finalContent === "" && reasoning !== "") {
    // reasoning 模型兜底：全程无 content 但有 reasoning 时，取 reasoning 文本
    finalContent = reasoning;
  }
  if (finalContent === "") {
    throw new Error("OpenAI-compatible API 响应无任何 content/reasoning 输出");
  }
  if (content === "" && reasoning !== "" && !usage) {
    // 以 reasoning 兜底且上游未报 usage：按字符数估算 completionTokens
    usage = {
      promptTokens: undefined,
      completionTokens: Math.ceil(finalContent.length / 2),
    };
  }
  return { content: finalContent, ...(usage ? { usage } : {}) };
}

/** 非流式 JSON 响应解析（服务端忽略 stream:true 的兜底路径） */
async function parseJsonResponse(res: Response): Promise<ChatResult> {
  const text = await res.text();
  let data: {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `OpenAI-compatible API 返回非 JSON 响应：${text.slice(0, 200)}`
    );
  }
  const message = data.choices?.[0]?.message;
  const content = message?.content ?? "";
  const reasoning = message?.reasoning_content ?? "";
  let usage: ChatResult["usage"] | undefined;
  const p = data.usage?.prompt_tokens;
  const c = data.usage?.completion_tokens;
  if (p !== undefined || c !== undefined) {
    usage = { promptTokens: p, completionTokens: c };
  }
  return finalizeResult(content, reasoning, usage);
}

export function createOpenAICompatibleAdapter(defaultBaseUrl: string): ProviderAdapter {
  return {
    async chat(params: ChatParams, creds: { apiKey: string; baseUrl: string }): Promise<ChatResult> {
      const baseUrl = normalizeBaseUrl(creds.baseUrl || defaultBaseUrl);
      const url = `${baseUrl}/chat/completions`;

      const body: Record<string, unknown> = {
        model: params.model,
        messages: params.messages,
        stream: true,
      };
      if (params.temperature !== undefined) {
        body.temperature = params.temperature;
      }
      if (params.maxTokens !== undefined) {
        body.max_tokens = params.maxTokens;
      }
      // 思考强度控制（reasoning 模型专用）：探针实测 thinking={type:"disabled"} 效果最佳
      if (params.thinkingLevel) {
        switch (params.thinkingLevel) {
          case "disabled":
            body.thinking = { type: "disabled" };
            break;
          case "low":
            body.thinking = { type: "enabled", effort: "low" };
            break;
          case "medium":
            body.thinking = { type: "enabled", effort: "medium" };
            break;
          case "high":
            body.thinking = { type: "enabled", effort: "high" };
            break;
        }
      }

      // 空闲超时窗口：同时约束「建立连接 + 首 chunk」与「后续 chunk 间隔」
      const idleMs = params.timeoutMs ?? 120_000;
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.apiKey}`,
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
        },
        { timeoutMs: idleMs }
      );

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && res.body) {
        return readSseStream(res, idleMs);
      }
      // 网关/服务端忽略 stream:true 返回完整 JSON → 非流式兜底解析
      return parseJsonResponse(res);
    },
  };
}

/** 读取 SSE 流并聚合为非流式 ChatResult（空闲超时抛 IdleTimeoutError） */
async function readSseStream(res: Response, idleMs: number): Promise<ChatResult> {
  if (!res.body) {
    throw new Error("OpenAI-compatible 流式响应缺少 body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage: ChatResult["usage"] | undefined;
  let idleTimedOut = false;

  // 空闲超时：每收到一个 chunk 重置定时器；到点后 cancel reader（read() 会以 done 结束）
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      reader.cancel().catch(() => {});
    }, idleMs);
  };

  try {
    resetIdle();
    for (;;) {
      const { done, value } = await reader.read();
      resetIdle();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: SseChunk;
        try {
          chunk = JSON.parse(payload) as SseChunk;
        } catch {
          continue; // 心跳/非 JSON 行
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        if (chunk.usage) {
          const p = chunk.usage.prompt_tokens;
          const c = chunk.usage.completion_tokens;
          if (p !== undefined || c !== undefined) {
            usage = { promptTokens: p, completionTokens: c };
          }
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    reader.releaseLock();
  }

  if (idleTimedOut) {
    // 明确报错而非静默把半截内容当完整结果返回
    throw new IdleTimeoutError(idleMs, content.length + reasoning.length);
  }
  return finalizeResult(content, reasoning, usage);
}
