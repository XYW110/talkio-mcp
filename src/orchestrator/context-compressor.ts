/**
 * Semantic context compression (语义截断 — 方案 B).
 *
 * When a dialogue transcript grows past the hard-truncation budget, this
 * module replaces "drop the oldest turns" with a conversation-style summary:
 * the long history is compressed into a concise summary via a dedicated LLM
 * call, and subsequent rounds inject a compact summary prefix + the full
 * latest-round transcript instead of the truncated transcript.
 *
 * Design (task 08-28-semantic-truncation, .trellis/tasks/.../design.md §3-5):
 *  - Budget check uses raw character length aligned with the dialogue
 *    `TRANSCRIPT_BUDGET_CHARS` (12000) — no token estimation (Q4 deferred).
 *  - The compressor re-implements the small provider call the same way
 *    dialogue.ts's summarize path does (system override + redactPII), so the
 *    input side is masked before leaving for the LLM and the output is masked
 *    again before it is stored in the summary state (R5 two-sided PII).
 *  - Compressor model/target reuse: `targets[0]` — same as summarize (Q4).
 *  - Failure of the compressor call propagates to the caller, which falls back
 *    to the existing hard truncation (R4 graceful degradation).
 */
import type { AppConfig } from "../types.js";
import type { ChatMessage, ChatParams } from "../providers/adapter.js";
import { getAdapter, isMockProviderEnabled } from "../providers/registry.js";
import { resolveProviderCredentials } from "../config.js";
import { redactPII } from "../utils/redact.js";
import type { Logger } from "../utils/log.js";
import type { ResolvedCard } from "../tools/select-cards.js";
import { formatTranscriptForPrompt, type DialogueTurn } from "./dialogue.js";

/**
 * Transcript budget aligned with dialogue.ts's TRANSCRIPT_BUDGET_CHARS.
 * Duplicated here so the compressor module stays self-contained and testable;
 * the value MUST stay in sync with the hard-truncation budget.
 */
export const CONTEXT_COMPRESSOR_BUDGET_CHARS = 12000;

/**
 * System prompt for the compressor call (neutral, task-focused). Follows the
 * SUMMARIZER_SYSTEM pattern (design §5): a compact role + explicit output
 * contract.
 */
export const COMPRESSOR_SYSTEM =
  "你是对话记录压缩器。请把以下讨论实录压缩为简洁的要点概要，保留：核心观点、各方立场与分歧、关键论据与结论。直接输出概要正文，不要额外说明。";

/**
 * Estimate the character length of a transcript assembled with the same
 * framing as `formatTranscriptForPrompt` (title per turn + "\n\n" separators),
 * but WITHOUT the per-turn 500-char truncation or the 12000-char block cap.
 *
 * This is the *trigger* measurement for enabling compression, so it must match
 * where hard truncation would otherwise kick in, while representing the real
 * payload size being handed to the model.
 */
export function estimateTranscriptChars(turns: DialogueTurn[]): number {
  if (turns.length === 0) return 0;
  let total = 0;
  for (const turn of turns) {
    const title = `【${turn.icon} ${turn.expertName}】(第${turn.round}轮): `;
    total += title.length + turn.content.length;
  }
  return total + (turns.length - 1) * 2; // "\n\n" separators
}

/** True when the current transcript exceeds the character budget. */
export function exceedsBudget(turns: DialogueTurn[]): boolean {
  return estimateTranscriptChars(turns) > CONTEXT_COMPRESSOR_BUDGET_CHARS;
}

/** Incremental summary state carried across rounds within one run. */
export interface SummaryState {
  /** Compressed summary text (already PII-masked). Empty = not enabled. */
  summaryText: string;
  /** Highest round whose turns have been merged into summaryText. */
  lastRound: number;
}

/** A fresh (not yet enabled) summary state. */
export function emptySummaryState(): SummaryState {
  return { summaryText: "", lastRound: 0 };
}

/** Highest round present in a set of turns (0 when empty). */
function maxRound(turns: DialogueTurn[]): number {
  return turns.reduce((m, t) => Math.max(m, t.round), 0);
}

/**
 * Render the turns of the latest round in full — no per-turn 500-char
 * truncation — for the "最近发言完整实录" block (R1).
 */
export function renderLatestRound(turns: DialogueTurn[], latestRound: number): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.round !== latestRound) continue;
    lines.push(
      `【${turn.icon} ${turn.expertName}】(第${turn.round}轮): ${turn.content}`
    );
  }
  return lines.join("\n\n");
}

/**
 * Build the prompt-injection transcript when summary is enabled:
 * a compact summary prefix covering rounds [1..lastRound], then the full
 * latest-round transcript (design §4.3).
 */
export function buildInjection(
  summary: SummaryState,
  latestRoundTurns: DialogueTurn[]
): string {
  const header =
    summary.lastRound > 1
      ? `【对话概要·第1-${summary.lastRound}轮】`
      : "【对话概要·第1轮】";
  const summaryBlock = [header, summary.summaryText].join("\n");
  const latest = renderLatestRound(latestRoundTurns, maxRound(latestRoundTurns));
  return `${summaryBlock}\n\n最近发言完整实录:\n${latest}`;
}

/** Mirror of dialogue.ts's private resolveProvider (mock-aware). */
function resolveProvider(providerName: string, config: AppConfig) {
  const providerConfig = config.providers[providerName];
  if (!providerConfig) return null;
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
 * Compress a batch of turns into a summary (single LLM call), following the
 * summarize path: neutral COMPRESSOR_SYSTEM override + redactPII on input,
 * and the returned summary is masked again before being returned (R5).
 *
 * `existingSummary` (optional) enables incremental merge: the previous summary
 * plus the new turns are compressed together into the *next* summary.
 *
 * Throws on provider failure — the caller decides the fallback (hard
 * truncation). On success returns the updated SummaryState with lastRound
 * advanced to the highest round in `turns`.
 */
export async function compressTurns(
  topic: string,
  turns: DialogueTurn[],
  target: ResolvedCard,
  config: AppConfig,
  existingSummary?: string,
  logger?: Logger
): Promise<SummaryState> {
  const previous =
    existingSummary && existingSummary.length > 0
      ? `先前概要:\n${existingSummary}\n\n`
      : "";
  const rendered = formatTranscriptForPrompt(turns);
  const userContent = `讨论主题: ${topic}\n\n${previous}讨论实录:\n${rendered}`;

  const resolved = resolveProvider(target.providerName, config);
  if (!resolved) {
    throw new Error(`未找到 provider 配置: "${target.providerName}"`);
  }
  const { adapter, creds } = resolved;
  const messages: ChatMessage[] = [
    { role: "system", content: COMPRESSOR_SYSTEM },
    // Input-side PII masking (same discipline as askExpert / summarize).
    { role: "user", content: redactPII(userContent) },
  ];
  const params: ChatParams = {
    model: target.modelId,
    messages,
    temperature: target.expert.temperature,
    maxTokens: target.expert.maxTokens,
    timeoutMs: target.expert.timeoutMs,
  };
  const result = await adapter.chat(params, creds);
  if (!result || typeof result.content !== "string") {
    throw new Error("provider 返回了无效的响应内容");
  }
  // Output-side PII masking before the summary is stored / reinjected (R5).
  return {
    summaryText: redactPII(result.content),
    lastRound: maxRound(turns),
  };
}