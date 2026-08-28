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
} from "../orchestrator/dialogue.js";
import { formatBrainstormReport } from "../utils/format.js";
import {
  DEFAULT_CARD_LIMIT,
  blankInputError,
  formatSelectionNotes,
  noSelectedCardsResult,
  selectCardsForTool,
} from "./select-cards.js";

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
  };

  const { turns, summary } = await runDialogue(opts, config);

  const report =
    formatBrainstormReport(args.topic, mode, rounds, turns, summary) +
    formatSelectionNotes(selection, DEFAULT_CARD_LIMIT);

  const isError = turns.length === 0;
  return {
    isError,
    content: [{ type: "text", text: report }],
  };
}