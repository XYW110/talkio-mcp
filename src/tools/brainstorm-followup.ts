/**
 * brainstorm_followup MCP tool — continue / deepen a prior brainstorm
 * transcript with a follow-up question.
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * The server is stateless, so the caller must pass back the structured turns
 * from a previous brainstorm call, plus a question. Two granularities
 * (design §5a / Q2 → 方案 C):
 *  - no `card`  → all selected cards answer (parallel debate / sequential relay)
 *  - with `card` → one specific card deepens (1 LLM call, 1 new turn)
 *
 * Invalid / empty `turns` degrade to a context-free follow-up with a marker
 * (design §6 / Q3 → 降级无上下文 + 标注), never an error by itself.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../types.js";
import {
  askExpert,
  formatTranscriptForPrompt,
  type DialogueTurn,
} from "../orchestrator/dialogue.js";
import {
  buildInjection,
  compressTurns,
  emptySummaryState,
  exceedsBudget,
  type SummaryState,
} from "../orchestrator/context-compressor.js";
import { formatTranscript } from "../utils/format.js";
import { redactPII } from "../utils/redact.js";
import { buildMemoryBlock, loadExpertMemories } from "../experts/memory.js";
import type { StreamNotifier } from "../utils/notify.js";
import type { RecordSession } from "../records/store.js";
import { sumUsage } from "../records/store.js";
import {
  DEFAULT_CARD_LIMIT,
  blankInputError,
  formatSelectionNotes,
  noSelectedCardsResult,
  selectCardsForTool,
  toCardRefs,
  type ResolvedCard,
} from "./select-cards.js";

/** Follow-up instruction appended to every prompt (shared, exported for tests). */
export const FOLLOWUP_INSTRUCTION =
  "以下是基于此前讨论的追问。请基于此前讨论,仅回应以下追问,可深化、补充或修正你之前的观点。";

/** Deepening emphasis for the single-card (specific) path. */
const SPECIFIC_EMPHASIS =
  "请重点基于你在此前讨论中表达的观点,对上述追问进行深入展开或必要修正。";

/** Marker appended to the report when turns were unusable as prior context. */
const DEGRADED_MARKER = "> ⚠️ 未使用历史上下文（turns 格式无效/为空）";

/** Zod raw shape for brainstorm_followup arguments (passed as inputSchema). */
export const brainstormFollowupSchema = {
  question: z.string().describe("追问问题（去空白后不能为空）"),
  turns: z
    .array(
      z.object({
        round: z.number().int().positive(),
        expertId: z.string(),
        expertName: z.string(),
        icon: z.string(),
        content: z.string(),
      })
    )
    .describe("上一轮 brainstorm 的实录 turns（调用方从 brainstorm 返回值保留）"),
  cards: z
    .array(z.string())
    .optional()
    .describe(
      "参与追问的卡 id 列表（缺省=已启用且有 key 的卡,最多 3 张;传 card 时忽略）",
    ),
  card: z
    .string()
    .optional()
    .describe(
      "指定单张卡 id 深化（传则仅该卡作答 1 条 turn;省略则全体选定卡各作答）",
    ),
  mode: z
    .enum(["debate", "relay"])
    .optional()
    .describe(
      "对话风格（仅全体追问时有效: debate=并行, relay=接龙;缺省 relay）",
    ),
  memory: z
    .boolean()
    .optional()
    .describe(
      "是否注入各专家的历史记忆(brainstorm 末轮沉淀的经验,最多 3 条):注入后专家能引用此前经验(默认 true;设 false 获得与旧版逐字节一致的 prompt)"
    ),
};

/** Inferred argument type for the handler. */
export type BrainstormFollowupArgs = {
  question: string;
  turns: DialogueTurn[];
  cards?: string[];
  card?: string;
  mode?: "debate" | "relay";
  /** 历史记忆注入开关（groupchat-strengths P3，缺省 true）。 */
  memory?: boolean;
};

/**
 * True when turns are usable as prior-round context (design §6 判定式).
 * Anything else degrades to a context-free follow-up.
 */
function isValidTurns(turns: unknown): boolean {
  return (
    Array.isArray(turns) &&
    turns.length > 0 &&
    turns.every(
      (t) =>
        t !== null &&
        typeof t === "object" &&
        typeof (t as DialogueTurn).round === "number" &&
        typeof (t as DialogueTurn).expertId === "string" &&
        typeof (t as DialogueTurn).content === "string",
    )
  );
}

/** Build the Markdown report for a follow-up round. */
function formatFollowupReport(
  question: string,
  mode: "debate" | "relay",
  round: number,
  turns: DialogueTurn[],
  degraded: boolean,
): string {
  const lines: string[] = [];
  lines.push("## 专家追问实录");
  lines.push("");
  lines.push(`**追问:** ${question}`);
  lines.push(`**模式:** ${mode === "debate" ? "辩论" : "接龙"}`);
  lines.push(`**轮次:** 第 ${round} 轮追问`);
  if (degraded) {
    lines.push("");
    lines.push(DEGRADED_MARKER);
  }
  lines.push("");
  lines.push(formatTranscript(turns));
  lines.push("");
  return lines.join("\n");
}

/**
 * The handler invoked by the MCP server when brainstorm_followup is called.
 *
 * `deps` mirrors the brainstorm handler shape for interface parity; the
 * follow-up does not emit stream notifications this iteration (PRD Notes).
 */
export async function handleBrainstormFollowup(
  args: BrainstormFollowupArgs,
  config: AppConfig,
  deps?: {
    notifier?: StreamNotifier;
    record?: RecordSession;
    /** 记忆目录（groupchat-strengths P3）；缺省时记忆注入降级为零。 */
    memoryDir?: string;
  },
): Promise<CallToolResult> {
  if (args.question.trim() === "") {
    return blankInputError("question");
  }

  // 记忆前缀构造器（P3）：memory !== false 且提供 memoryDir 时按专家构造；
  // 无记忆 → 空串零注入（userContent 逐字节还原现状）。
  const memoryPrefixFor = (expertId: string): string => {
    if (args.memory === false || !deps?.memoryDir) return "";
    return buildMemoryBlock(loadExpertMemories(deps.memoryDir, expertId));
  };

  // Turns degradation (Q3): unusable turns → context-free follow-up + marker.
  const degraded = !isValidTurns(args.turns);
  const prevTurns: DialogueTurn[] = degraded ? [] : args.turns;
  const nextRound = prevTurns.reduce((max, t) => Math.max(max, t.round), 0) + 1;
  const mode = args.mode ?? "relay";
  const record = deps?.record;

  /** 新 turn 逐条 append（含 usage），与会话报告语义一致。 */
  const recordTurn = (t: DialogueTurn): void => {
    record?.append({
      type: "turn",
      round: t.round,
      expertId: t.expertId,
      expertName: t.expertName,
      icon: t.icon,
      content: t.content,
      usage: t.usage,
    });
  };

  // Semantic compression (task 08-28-semantic-truncation, design §7 / Q2):
  // handler-level summary cache so a relay loop never re-compresses per expert.
  let followupSummary: SummaryState = emptySummaryState();
  let followupCompressorFailed = false;
  const buildFollowupTranscript = async (
    question: string,
    history: DialogueTurn[],
    compressorTarget: ResolvedCard
  ): Promise<string> => {
    if (!exceedsBudget(history) && followupSummary.summaryText === "") {
      return formatTranscriptForPrompt(history);
    }
    if (followupSummary.summaryText === "" && !followupCompressorFailed) {
      try {
        followupSummary = await compressTurns(
          question,
          history,
          compressorTarget,
          config
        );
        return buildInjection(followupSummary, history);
      } catch {
        followupCompressorFailed = true;
        return formatTranscriptForPrompt(history);
      }
    }
    return buildInjection(followupSummary, history);
  };

  // Specific (single card) path takes precedence; `cards` is ignored.
  if (args.card) {
    const selection = selectCardsForTool(config, [args.card], {
      defaultLimit: DEFAULT_CARD_LIMIT,
    });
    if (selection.selected.length === 0) {
      return noSelectedCardsResult(config, selection, [args.card]);
    }
    const target = selection.selected[0]!;
    const transcript = await buildFollowupTranscript(
      args.question,
      prevTurns,
      target
    );
    const mem = memoryPrefixFor(target.expert.id);
    const memPrefix = mem ? `${mem}\n\n` : "";
    const userContent = transcript
      ? `${memPrefix}${args.question}\n\n${FOLLOWUP_INSTRUCTION}\n\n${SPECIFIC_EMPHASIS}\n\n此前讨论实录:\n${transcript}`
      : `${memPrefix}${args.question}\n\n${FOLLOWUP_INSTRUCTION}\n\n${SPECIFIC_EMPHASIS}`;
const newTurns: DialogueTurn[] = [];
    record?.append({ type: "cards", cards: toCardRefs(selection.selected) });
    try {
      const answer = await askExpert(target, userContent, config);
      const t: DialogueTurn = {
        round: nextRound,
        expertId: target.expert.id,
        expertName: target.expert.name,
        icon: target.expert.icon,
        content: answer.content,
        usage: answer.usage,
      };
      newTurns.push(t);
      recordTurn(t);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const t: DialogueTurn = {
        round: nextRound,
        expertId: target.expert.id,
        expertName: target.expert.name,
        icon: target.expert.icon,
        // Privacy: sanitize provider error echoes.
        content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
      };
      newTurns.push(t);
      recordTurn(t);
    }
    const report =
      formatFollowupReport(args.question, mode, nextRound, newTurns, degraded) +
      formatSelectionNotes(selection, DEFAULT_CARD_LIMIT);
    const allFailed = newTurns.every((t) => t.content.startsWith("⚠️"));
    record?.finish({
      status: allFailed ? "all_failed" : "ok",
      report,
      usage: sumTurnsUsage(newTurns),
    });
    return {
      isError: allFailed,
      content: [{ type: "text", text: report }],
    };
  }

  // All path: resolve the shared card set, then answer per mode.
  const selection = selectCardsForTool(config, args.cards, {
    defaultLimit: DEFAULT_CARD_LIMIT,
  });
  if (selection.selected.length === 0) {
    return noSelectedCardsResult(config, selection, args.cards);
  }
const targets = selection.selected;
  const newTurns: DialogueTurn[] = [];
  record?.append({ type: "cards", cards: toCardRefs(targets) });

  const runTarget = async (target: ResolvedCard, transcript: string) => {
    const mem = memoryPrefixFor(target.expert.id);
    const memPrefix = mem ? `${mem}\n\n` : "";
    const userContent = transcript
      ? `${memPrefix}${args.question}\n\n${FOLLOWUP_INSTRUCTION}\n\n此前讨论实录:\n${transcript}`
      : `${memPrefix}${args.question}\n\n${FOLLOWUP_INSTRUCTION}`;
    try {
      const answer = await askExpert(target, userContent, config);
      const t: DialogueTurn = {
        round: nextRound,
        expertId: target.expert.id,
        expertName: target.expert.name,
        icon: target.expert.icon,
        content: answer.content,
        usage: answer.usage,
      };
      newTurns.push(t);
      recordTurn(t);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const t: DialogueTurn = {
        round: nextRound,
        expertId: target.expert.id,
        expertName: target.expert.name,
        icon: target.expert.icon,
        // Privacy: sanitize provider error echoes.
        content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
      };
      newTurns.push(t);
      recordTurn(t);
    }
  };

  if (mode === "debate") {
    // Parallel: every card sees the same prior-round transcript only.
    const transcript = await buildFollowupTranscript(
      args.question,
      prevTurns,
      targets[0]!
    );
    await Promise.all(targets.map((target) => runTarget(target, transcript)));
  } else {
    // Relay: each card sees the running transcript (prior + this round so far).
    for (const target of targets) {
      const running = [...prevTurns, ...newTurns];
      const transcript = await buildFollowupTranscript(
        args.question,
        running,
        targets[0]!
      );
      await runTarget(target, transcript);
    }
  }

  // All-failure aggregation: one ⚠️ summary turn + isError (design §6).
  const failed = newTurns.filter((t) => t.content.startsWith("⚠️"));
  let isError = newTurns.length === 0;
  if (failed.length === targets.length) {
    const names = targets.map((t) => t.expert.name).join("、");
    newTurns.length = 0;
    newTurns.push({
      round: nextRound,
      expertId: targets.map((t) => t.card.id).join(","),
      expertName: names,
      icon: "⚠️",
      content: `⚠️ 全部专家追问失败（${names}）。`,
    });
    isError = true;
  }

const report =
    formatFollowupReport(args.question, mode, nextRound, newTurns, degraded) +
    formatSelectionNotes(selection, DEFAULT_CARD_LIMIT);
  record?.finish({
    status: isError ? "all_failed" : "ok",
    report,
    usage: sumTurnsUsage(newTurns),
  });
  return {
    isError,
    content: [{ type: "text", text: report }],
  };
}

/** 会话语 usage 归并（turn 级逐条累加）。 */
function sumTurnsUsage(
  turns: Array<{ usage?: { promptTokens?: number; completionTokens?: number } }>
): { promptTokens?: number; completionTokens?: number } | undefined {
  let acc: { promptTokens?: number; completionTokens?: number } | undefined;
  for (const t of turns) acc = sumUsage(acc, t.usage);
  return acc;
}