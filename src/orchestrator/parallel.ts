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
import { defaultLogger, type Logger } from "../utils/log.js";
import type { StreamNotifier } from "../utils/notify.js";
import type { ResolvedCard } from "../tools/select-cards.js";
import { applyReasoningStrategy } from "./strategy.js";

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
  // 推理策略（P1-B）：default/缺省时返回原串引用，prompt 逐字节不变。
  const systemPrompt = applyReasoningStrategy(
    target.expert.systemPrompt,
    target.expert.reasoningStrategy
  );
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  // claim-0 框架（R5）：发起方 context 不再以「背景信息」权威背书呈现，
  // 明示其可能有误、需独立判断；拼接结构与现状一致（仅标签文案变化）。
  const userContent =
    context && context.trim().length > 0
      ? `主理 AI 提供的初步分析（可能有误，请独立判断，欢迎质疑）:\n${context.trim()}\n\n问题:\n${question}`
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
      thinkingLevel: target.thinkingLevel,
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
  options: { context?: string; parallel?: boolean; logger?: Logger; notifier?: StreamNotifier } = {}
): Promise<ConsultationItem[]> {
  const { context, parallel = true, notifier } = options;
  const logger = options.logger ?? defaultLogger;
  const startedAt = Date.now();

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
    const items = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const err =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      const target = targets[i];
      if (!target)
        throw new Error("unreachable: allSettled index always aligns");
      return { target, ok: false as const, error: err };
    });
    // 流式增量（R1）：每张卡 settle 后各发一条（在 finalize 压缩之前，
    // 因此全失败时也逐卡通知，与聚合返回值语义互补）。顺序 = settle 顺序。
    if (notifier) {
      for (const item of items) {
        notifier({
          type: "consult.card",
          card: item.target.card.id,
          status: item.ok ? "ok" : "failed",
        });
      }
    }
    return finalize(items);
  }

  // Serial path: call each target one after another in configured order.
  const items: ConsultationItem[] = [];
  for (const target of targets) {
    const item = await callExpert(target, question, config, context);
    items.push(item);
    // 串行路径天然逐卡，发一条再调下一张（即时性更好）。
    notifier?.({
      type: "consult.card",
      card: item.target.card.id,
      status: item.ok ? "ok" : "failed",
    });
  }
  return finalize(items);

  /** Log the [summary] typeline, then compress an all-failed round to one item. */
  function finalize(items: ConsultationItem[]): ConsultationItem[] {
    const totalMs = Date.now() - startedAt;
    const failed = items.filter((i) => !i.ok);
    const ok = items.length - failed.length;
    if (items.length > 0) {
      const avgMs = Math.round(totalMs / items.length);
      logger.info(
        `[summary] consult cards=${items.length} ok=${ok} failed=${failed.length} avg_ms=${avgMs} total_ms=${totalMs}`
      );
    }
    // All cards failed → compress to a single summary item instead of N ⚠️.
    if (failed.length === targets.length && failed.length > 0) {
      const first = failed[0];
      const firstError = first?.error ?? "未知错误";
      const timeoutHint = /超时|timed?\s*out|timeout/i.test(firstError)
        ? "（含超时）"
        : "";
      return [
        {
          target: targets[0] as ResolvedCard,
          ok: false as const,
          error: `全部 ${failed.length} 张卡咨询失败（均为 provider 调用失败）${timeoutHint}: ${firstError}`,
        },
      ];
    }
    return items;
  }
}