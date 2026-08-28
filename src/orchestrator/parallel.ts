/**
 * Single-round parallel consultation engine.
 *
 * Each selected card's target (expert + provider + model) is called
 * concurrently via Promise.allSettled so that one card's failure never blocks
 * the others. A single-call helper is exported for reuse by the serial
 * (parallel=false) path.
 */
import type { AppConfig } from "../types.js";
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
} from "../providers/adapter.js";
import { getAdapter, isMockProviderEnabled } from "../providers/registry.js";
import { resolveProviderCredentials } from "../config.js";
import { redactPII } from "../utils/redact.js";
import type { ResolvedCard } from "../tools/select-cards.js";

/** Per-card outcome of a single-round consultation. */
export interface ConsultationItem {
  target: ResolvedCard;
  ok: boolean;
  /** Present when ok === true */
  content?: string;
  /** Present when ok === false */
  error?: string;
  /** Token usage if reported by the provider (ok === true). */
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * Build the chat message list for one target given a question and optional
 * context. The expert's systemPrompt becomes the system message; the user
 * message combines context (if any) with the question.
 *
 * Privacy: user-provided PII (phone / ID / email / card / wechat) is masked
 * via redactPII before being sent to the LLM. Caller agents are instructed
 * (via the tool descriptions) to replace names / locations with placeholders
 * like [人名] / [地名] beforehand.
 */
export function buildTargetMessages(
  target: ResolvedCard,
  question: string,
  context?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (target.expert.systemPrompt) {
    messages.push({ role: "system", content: target.expert.systemPrompt });
  }
  const userContent =
    context && context.trim().length > 0
      ? `背景信息:\n${context.trim()}\n\n问题:\n${question}`
      : question;
  messages.push({ role: "user", content: redactPII(userContent) });
  return messages;
}

/**
 * Resolve a provider adapter + credentials for a card target from AppConfig.
 * Credentials are resolved lazily from environment variables via
 * resolveProviderCredentials (design §7). Returns null when the referenced
 * provider is not configured, in which case the caller surfaces a clear
 * error rather than crashing.
 */
function resolveProvider(providerName: string, config: AppConfig) {
  const providerConfig = config.providers[providerName];
  if (!providerConfig) {
    return null;
  }
  // Mock mode must skip env-key lookup so smoke / CI can run without secrets.
  if (isMockProviderEnabled()) {
    return {
      adapter: getAdapter(providerConfig.type),
      creds: { apiKey: "mock", baseUrl: providerConfig.baseUrl },
    };
  }
  return {
    adapter: getAdapter(providerConfig.type),
    creds: resolveProviderCredentials(config, providerName),
  };
}

/**
 * Call a single card target. Exported so the serial path (parallel=false) can
 * reuse the exact same call logic without reimplementing message construction.
 *
 * Errors are caught and returned as an item with ok=false (never thrown), so
 * callers can decide how to aggregate.
 */
export async function callExpert(
  target: ResolvedCard,
  question: string,
  config: AppConfig,
  context?: string
): Promise<ConsultationItem> {
  try {
    const resolved = resolveProvider(target.providerName, config);
    if (!resolved) {
      return {
        target,
        ok: false,
        error: `未找到 provider 配置: "${target.providerName}"`,
      };
    }
    const { adapter, creds } = resolved;
    const params: ChatParams = {
      model: target.modelId,
      messages: buildTargetMessages(target, question, context),
      temperature: target.expert.temperature,
      maxTokens: target.expert.maxTokens,
      timeoutMs: target.expert.timeoutMs,
    };
    const result: ChatResult = await adapter.chat(params, creds);
    if (!result || typeof result.content !== "string") {
      return {
        target,
        ok: false,
        error: "provider 返回了无效的响应内容",
      };
    }
    return {
      target,
      ok: true,
      content: result.content,
      usage: result.usage,
    };
} catch (err) {
    // Privacy: sanitize the error text (it may echo provider/user input) —
    // rule-based PII is masked before it reaches the client-facing report.
    const message = err instanceof Error ? err.message : String(err);
    return { target, ok: false, error: redactPII(message) };
  }
}

/**
 * Run a single-round parallel consultation across the given card targets.
 *
 * - parallel=true (default): Promise.allSettled over all targets concurrently.
 * - parallel=false: targets are called sequentially in order, reusing callExpert.
 *
 * A single card failing never affects the others; failures are reported
 * per-item with ok=false and an error message.
 */
export async function runConsultation(
  question: string,
  targets: ResolvedCard[],
  config: AppConfig,
  options: { context?: string; parallel?: boolean } = {}
): Promise<ConsultationItem[]> {
  const { context, parallel = true } = options;

  if (targets.length === 0) {
    return [];
  }

  if (parallel) {
    const settled = await Promise.allSettled(
      targets.map((target) => callExpert(target, question, config, context))
    );
    // allSettled on a function that already catches means every result is
    // "fulfilled"; map back to the item. A rejected result here would indicate
    // a programming error (e.g. thrown synchronously before try/catch).
    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const err =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      const target = targets[i];
      if (!target)
        throw new Error("unreachable: allSettled index always aligns");
      return { target, ok: false as const, error: err };
    });
  }

  // Serial path: call each target one after another in configured order.
  const items: ConsultationItem[] = [];
  for (const target of targets) {
    items.push(await callExpert(target, question, config, context));
  }
  return items;
}