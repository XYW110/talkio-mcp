/**
 * Multi-round dialogue engine (brainstorm tool).
 *
 * Two modes per design §6:
 *  - debate: each round, every expert sees the previous round's transcript and
 *    is prompted to challenge / supplement / refine others' points. Turns
 *    within a round run in parallel.
 *  - relay: experts speak sequentially; each sees the full running transcript
 *    so far and is asked to deepen the previous speaker's idea.
 *
 * Token budget: each expert's prior-round history is truncated to the most
 * recent ~500 chars per turn when injected into prompts, and the assembled
 * transcript block is capped at ~12k chars (ol turns dropped first).
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
import type { ResolvedCard } from "../tools/select-cards.js";

/** A single turn in the dialogue transcript. */
export interface DialogueTurn {
  round: number;
  expertId: string;
  expertName: string;
  icon: string;
  content: string;
}

/** Options for runDialogue. */
export interface DialogueOptions {
  topic: string;
  targets: ResolvedCard[];
  mode: "debate" | "relay";
  rounds: number; // default 2, max 5
  summarize: boolean; // default true
  /** Injectable logging sink; defaults to the module-level info logger. */
  logger?: Logger;
}

/** Result of runDialogue: ordered turns + optional summary. */
export interface DialogueResult {
  turns: DialogueTurn[];
  summary?: string;
}

// --- Prompt templates (exported for unit testing) -----------------------

/** Seed instruction for round 1 (every expert answers the topic fresh). */
export const SEED_INSTRUCTION =
  "请就以下主题给出你的专业见解,清晰阐述你的核心观点与理由。";

/** Debate instruction injected from round 2 onward. */
export const DEBATE_INSTRUCTION =
  "以下是其他专家在上一轮的发言。请针对上述观点,提出你的质疑、补充或反驳,并完善你自己的立场。";

/** Relay instruction injected for each sequential speaker. */
export const RELAY_INSTRUCTION =
  "以下是此前各位专家的发言。请在最新一位专家的观点基础上深化和发展,补充新的角度或论据,避免简单重复。";

/** System prompt for the summarizer call. */
export const SUMMARIZER_SYSTEM =
  "你是一位中立的讨论主持人。请基于以下完整的讨论实录,客观总结各方达成的共识、仍存在的分歧,以及可执行的下一步建议。用 Markdown 输出。";

// --- Token budget constants ---------------------------------------------

/** Per-turn truncation: keep only the tail of each prior turn's content. */
const PER_TURN_TRUNCATE_CHARS = 500;
/** Hard cap on the assembled transcript block injected into a prompt. */
const TRANSCRIPT_BUDGET_CHARS = 12000;

// --- Internal helpers ----------------------------------------------------

function resolveProvider(providerName: string, config: AppConfig) {
  const providerConfig = config.providers[providerName];
  if (!providerConfig) return null;
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
 * Render the transcript (turns so far) into a compact text block for prompt
 * injection. Each prior turn is truncated to its last PER_TURN_TRUNCATE_CHARS
 * characters, and the whole block is capped at TRANSCRIPT_BUDGET_CHARS by
 * dropping the oldest turns first. A truncation marker is appended when any
 * content was dropped.
 */
export function formatTranscriptForPrompt(turns: DialogueTurn[]): string {
  if (turns.length === 0) return "";
  const lines: string[] = [];
  let truncated = false;
  for (const turn of turns) {
    let text = turn.content;
    if (text.length > PER_TURN_TRUNCATE_CHARS) {
      text = "…" + text.slice(-PER_TURN_TRUNCATE_CHARS);
      truncated = true;
    }
    lines.push(
      `【${turn.icon} ${turn.expertName}】(第${turn.round}轮): ${text}`
    );
  }
  let block = lines.join("\n\n");
  if (block.length > TRANSCRIPT_BUDGET_CHARS) {
    // Drop oldest turns until we fit; keep at least the most recent turn.
    while (lines.length > 1 && block.length > TRANSCRIPT_BUDGET_CHARS) {
      lines.shift();
      block = lines.join("\n\n");
      truncated = true;
    }
  }
  return truncated ? `（较早的发言已省略）\n${block}` : block;
}

/**
 * Call one card target with a synthesized user message. Returns the assistant
 * content string, or throws on failure (caller handles per-mode).
 */
async function askExpert(
  target: ResolvedCard,
  userContent: string,
  config: AppConfig
): Promise<string> {
  const resolved = resolveProvider(target.providerName, config);
  if (!resolved) {
    throw new Error(`未找到 provider 配置: "${target.providerName}"`);
  }
  const { adapter, creds } = resolved;
  const messages: ChatMessage[] = [];
  if (target.expert.systemPrompt) {
    messages.push({ role: "system", content: target.expert.systemPrompt });
  }
  // Privacy: mask rule-based PII before anything leaves for the LLM.
  messages.push({ role: "user", content: redactPII(userContent) });
  const params: ChatParams = {
    model: target.modelId,
    messages,
    temperature: target.expert.temperature,
    maxTokens: target.expert.maxTokens,
    timeoutMs: target.expert.timeoutMs,
  };
  const result: ChatResult = await adapter.chat(params, creds);
  if (!result || typeof result.content !== "string") {
    throw new Error("provider 返回了无效的响应内容");
  }
  return result.content;
}

// --- Main engine ---------------------------------------------------------

/**
 * Run a multi-round dialogue. See module docstring and design §6.
 *
 * rounds is clamped to [1, 5]. targets is used as-is (the tool layer enforces
 * the ≤6 cap). summarize=true asks the first expert to synthesize all turns.
 */
export async function runDialogue(
  opts: DialogueOptions,
  config: AppConfig
): Promise<DialogueResult> {
  const logger = opts.logger ?? defaultLogger;
  const startedAt = Date.now();
  const rounds = Math.max(1, Math.min(5, Math.trunc(opts.rounds)));
  const targets = opts.targets;
  const turns: DialogueTurn[] = [];

  if (targets.length === 0 || rounds === 0) {
    return { turns };
  }

  for (let round = 1; round <= rounds; round++) {
    if (round === 1) {
      // Seed round: every expert answers the topic fresh (parallel).
      const results = await Promise.allSettled(
        targets.map((target) =>
          askExpert(target, `${opts.topic}\n\n${SEED_INSTRUCTION}`, config)
        )
      );
      results.forEach((res, i) => {
        const target = targets[i];
        if (!target) return; // defensive: index always aligns with allSettled order
        if (res.status === "fulfilled") {
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            content: res.value,
          });
        } else {
          const msg =
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            // Privacy: sanitize provider error echoes.
            content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
          });
        }
      });
      continue;
    }

    if (opts.mode === "debate") {
      // Each expert sees the PREVIOUS round's turns only, in parallel.
      const prevRoundTurns = turns.filter((t) => t.round === round - 1);
      const transcript = formatTranscriptForPrompt(prevRoundTurns);
      const userContent = `${opts.topic}\n\n${DEBATE_INSTRUCTION}\n\n上一轮发言:\n${transcript}`;
      const results = await Promise.allSettled(
        targets.map((target) => askExpert(target, userContent, config))
      );
      results.forEach((res, i) => {
        const target = targets[i];
        if (!target) return; // defensive: index always aligns with allSettled order
        if (res.status === "fulfilled") {
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            content: res.value,
          });
        } else {
          const msg =
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            // Privacy: sanitize provider error echoes.
            content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
          });
        }
      });
    } else {
      // Relay: experts speak sequentially; each sees the full running transcript.
      for (const target of targets) {
        const transcript = formatTranscriptForPrompt(turns);
        const userContent =
          transcript.length > 0
            ? `${opts.topic}\n\n${RELAY_INSTRUCTION}\n\n此前发言:\n${transcript}`
            : `${opts.topic}\n\n${SEED_INSTRUCTION}`;
        try {
          const content = await askExpert(target, userContent, config);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            content,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            // Privacy: sanitize provider error echoes.
            content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
          });
        }
      }
    }
  }

  // Optional summary by the first expert using a dedicated summarizer prompt.
  let summary: string | undefined;
  if (opts.summarize && targets.length > 0 && turns.length > 0) {
    const summarizer = targets[0];
    if (!summarizer)
      throw new Error("unreachable: summarizer always exists when turns > 0");
    const fullTranscript = formatTranscriptForPrompt(turns);
    try {
      // Override the system prompt for the summary call so the persona is neutral.
      const resolved = resolveProvider(summarizer.providerName, config);
      if (resolved) {
        const { adapter, creds } = resolved;
        const params: ChatParams = {
          model: summarizer.modelId,
          messages: [
            { role: "system", content: SUMMARIZER_SYSTEM },
            {
              role: "user",
              // Privacy: mask rule-based PII in the summary prompt too.
              content: redactPII(`讨论主题: ${opts.topic}\n\n讨论实录:\n${fullTranscript}`),
            },
          ],
          temperature: summarizer.expert.temperature,
          maxTokens: summarizer.expert.maxTokens,
          timeoutMs: summarizer.expert.timeoutMs,
        };
        const result = await adapter.chat(params, creds);
        if (result && typeof result.content === "string") {
          summary = result.content;
        }
      }
    } catch {
      // Summary is best-effort; leave undefined on failure.
    }
  }

  // Observability: emit a compact [summary] typeline (stderr, never in report).
  const failed = turns.filter((t) => t.content.includes("⚠️")).length;
  const ok = turns.length - failed;
  logger.info(
    `[summary] brainstorm rounds=${rounds} turns=${turns.length} summary=${summary ? "yes" : "no"} ok=${ok} failed=${failed} total_ms=${Date.now() - startedAt}`
  );

  return { turns, summary };
}