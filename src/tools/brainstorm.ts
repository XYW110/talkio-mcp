/**
 * brainstorm MCP tool — multi-round expert dialogue (debate / relay) via role cards.
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * The handler validates caps (rounds ≤ 5, cards ≤ 6), resolves the card
 * subset, runs the dialogue engine, and returns a formatted transcript +
 * summary as text content.
 */
import { z } from "zod";
import type { AppConfig } from "../types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  runDialogue,
  type DialogueOptions,
  type DialogueTurn,
} from "../orchestrator/dialogue.js";
import { formatBrainstormReport } from "../utils/format.js";
import type { RecordSession } from "../records/store.js";
import { sumUsage } from "../records/store.js";
import {
  DEFAULT_CARD_LIMIT,
  blankInputError,
  formatSelectionNotes,
  noSelectedCardsResult,
  selectCardsForTool,
  toCardRefs,
} from "./select-cards.js";
import type { StreamNotifier } from "../utils/notify.js";

/** Zod raw shape for brainstorm arguments (passed as inputSchema). */
export const brainstormSchema = {
  topic: z.string().describe("要讨论的主题（去空白后不能为空）"),
  mode: z
    .enum(["debate", "relay"])
    .optional()
    .describe("对话模式: debate=辩论(并行), relay=接龙(串行)。默认 debate"),
  rounds: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("对话轮数(1-5,默认 1)"),
  cards: z
    .array(z.string())
    .max(6)
    .optional()
    .describe(
      "参与的角色卡 id 列表(最多 6 张);缺省使用已启用且已配置 API Key 的角色卡（最多 3 张）",
    ),
  summarize: z
    .boolean()
    .optional()
    .describe("是否在对话结束后生成总结(默认 false)"),
};

/** Inferred argument type for the handler. */
export type BrainstormArgs = {
  topic: string;
  mode?: "debate" | "relay";
  rounds?: number;
  cards?: string[];
  summarize?: boolean;
};

/**
 * The handler invoked by the MCP server when brainstorm is called.
 */
export async function handleBrainstorm(
  args: BrainstormArgs,
  config: AppConfig,
  deps?: { notifier?: StreamNotifier; record?: RecordSession },
): Promise<CallToolResult> {
  if (args.topic.trim() === "") {
    return blankInputError("topic");
  }

  const mode = args.mode ?? "debate";
  const rounds = args.rounds ?? 1;
  const summarize = args.summarize ?? false;

  const selection = selectCardsForTool(config, args.cards, {
    defaultLimit: DEFAULT_CARD_LIMIT,
  });

  if (selection.selected.length === 0) {
    return noSelectedCardsResult(config, selection, args.cards);
  }

  const opts: DialogueOptions = {
    topic: args.topic,
    targets: selection.selected,
    mode,
    rounds,
    summarize,
    notifier: deps?.notifier,
  };

  const record = deps?.record;
  record?.append({ type: "cards", cards: toCardRefs(selection.selected) });

  const { turns, summary } = await runDialogue(opts, config);

  // 按轮次分组实录：turn 行 + 轮边界 round_end 行 + 可选 summary 行。
  recordTurns(record, turns, rounds);
  if (summary !== undefined) {
    record?.append({ type: "summary", content: summary });
  }

  const report =
    formatBrainstormReport(args.topic, mode, rounds, turns, summary) +
    formatSelectionNotes(selection, DEFAULT_CARD_LIMIT);

  const isError = turns.length === 0;
  record?.finish({
    status: isError ? "all_failed" : "ok",
    report,
    usage: sumTurnsUsage(turns),
  });

  return {
    isError,
    content: [{ type: "text", text: report }],
  };
}

/** 全会话 usage 归并（turn 级逐条累加）。 */
function sumTurnsUsage(
  turns: Array<{ usage?: { promptTokens?: number; completionTokens?: number } }>
): { promptTokens?: number; completionTokens?: number } | undefined {
  let acc: { promptTokens?: number; completionTokens?: number } | undefined;
  for (const t of turns) acc = sumUsage(acc, t.usage);
  return acc;
}

/** 逐轮写 turn 行 + round_end 行（对齐 notifier 的轮粒度）。 */
function recordTurns(
  record: RecordSession | undefined,
  turns: DialogueTurn[],
  rounds: number
): void {
  if (!record) return;
  const byRound = new Map<number, DialogueTurn[]>();
  for (const t of turns) {
    const arr = byRound.get(t.round) ?? [];
    arr.push(t);
    byRound.set(t.round, arr);
  }
  for (let r = 1; r <= rounds; r++) {
    const roundTurns = byRound.get(r) ?? [];
    for (const t of roundTurns) {
      record.append({
        type: "turn",
        round: t.round,
        expertId: t.expertId,
        expertName: t.expertName,
        icon: t.icon,
        content: t.content,
        usage: t.usage,
      });
    }
    record.append({ type: "round_end", round: r, total: rounds });
  }
}