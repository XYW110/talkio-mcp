/**
 * Single-round parallel consultation engine.
 *
 * Each enabled expert is called concurrently via Promise.allSettled so that
 * one expert's failure never blocks the others. A single-expert call helper
 * is exported for reuse by the serial (parallel=false) path.
 */
import type { AppConfig, ExpertConfig } from "../types.js";
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
} from "../providers/adapter.js";
import { getAdapter } from "../providers/registry.js";
import { resolveProviderCredentials } from "../config.js";

/** Per-expert outcome of a single-round consultation. */
export interface ConsultationItem {
  expert: ExpertConfig;
  ok: boolean;
  /** Present when ok === true */
  content?: string;
  /** Present when ok === false */
  error?: string;
  /** Token usage if reported by the provider (ok === true). */
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * Build the chat message list for one expert given a question and optional
 * context. The expert's systemPrompt becomes the system message; the user
 * message combines context (if any) with the question.
 */
export function buildExpertMessages(
  expert: ExpertConfig,
  question: string,
  context?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (expert.systemPrompt) {
    messages.push({ role: "system", content: expert.systemPrompt });
  }
  const userContent =
    context && context.trim().length > 0
      ? `背景信息:\n${context.trim()}\n\n问题:\n${question}`
      : question;
  messages.push({ role: "user", content: userContent });
  return messages;
}

/**
 * Resolve a provider adapter + credentials for an expert from AppConfig.
 * Credentials are resolved lazily from environment variables via
 * resolveProviderCredentials (design §7). Returns null when the referenced
 * provider is not configured, in which case the caller surfaces a clear
 * error rather than crashing.
 */
function resolveProvider(expert: ExpertConfig, config: AppConfig) {
  const providerConfig = config.providers[expert.provider];
  if (!providerConfig) {
    return null;
  }
  return {
    adapter: getAdapter(providerConfig.type),
    creds: resolveProviderCredentials(config, expert.provider),
  };
}

/**
 * Call a single expert. Exported so the serial path (parallel=false) can reuse
 * the exact same call logic without reimplementing message construction.
 *
 * Errors are caught and returned as an item with ok=false (never thrown), so
 * callers can decide how to aggregate.
 */
export async function callExpert(
  expert: ExpertConfig,
  question: string,
  config: AppConfig,
  context?: string
): Promise<ConsultationItem> {
  try {
    const resolved = resolveProvider(expert, config);
    if (!resolved) {
      return {
        expert,
        ok: false,
        error: `未找到 provider 配置: "${expert.provider}"`,
      };
    }
    const { adapter, creds } = resolved;
    const params: ChatParams = {
      model: expert.model,
      messages: buildExpertMessages(expert, question, context),
      temperature: expert.temperature,
      maxTokens: expert.maxTokens,
      timeoutMs: expert.timeoutMs,
    };
    const result: ChatResult = await adapter.chat(params, creds);
    if (!result || typeof result.content !== "string") {
      return {
        expert,
        ok: false,
        error: "provider 返回了无效的响应内容",
      };
    }
    return {
      expert,
      ok: true,
      content: result.content,
      usage: result.usage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { expert, ok: false, error: message };
  }
}

/**
 * Run a single-round parallel consultation across the given experts.
 *
 * - parallel=true (default): Promise.allSettled over all experts concurrently.
 * - parallel=false: experts are called sequentially in order, reusing callExpert.
 *
 * A single expert failing never affects the others; failures are reported
 * per-item with ok=false and an error message.
 */
export async function runConsultation(
  question: string,
  experts: ExpertConfig[],
  config: AppConfig,
  options: { context?: string; parallel?: boolean } = {}
): Promise<ConsultationItem[]> {
  const { context, parallel = true } = options;

  if (experts.length === 0) {
    return [];
  }

  if (parallel) {
    const settled = await Promise.allSettled(
      experts.map((expert) => callExpert(expert, question, config, context))
    );
    // allSettled on a function that already catches means every result is
    // "fulfilled"; map back to the item. A rejected result here would indicate
    // a programming error (e.g. thrown synchronously before try/catch).
    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const err =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      const expert = experts[i];
      if (!expert)
        throw new Error("unreachable: allSettled index always aligns");
      return { expert, ok: false as const, error: err };
    });
  }

  // Serial path: call each expert one after another in configured order.
  const items: ConsultationItem[] = [];
  for (const expert of experts) {
    items.push(await callExpert(expert, question, config, context));
  }
  return items;
}
