/**
 * brainstorm MCP tool — multi-round expert dialogue (debate / relay).
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * The handler validates caps (rounds ≤ 5, experts ≤ 6), resolves the expert
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
  DEFAULT_EXPERT_LIMIT,
  blankInputError,
  formatSelectionNotes,
  noSelectedExpertsResult,
  selectExpertsForTool,
} from "./select-experts.js";

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
  experts: z
    .array(z.string())
    .max(6)
    .optional()
    .describe(
      "参与的专家 id 列表(最多 6 个);缺省使用已启用且已配置 API Key 的专家（最多 3 位）",
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
  experts?: string[];
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

  const selection = selectExpertsForTool(config, args.experts, {
    defaultLimit: DEFAULT_EXPERT_LIMIT,
  });

  if (selection.selected.length === 0) {
    return noSelectedExpertsResult(config, selection, args.experts);
  }

  const opts: DialogueOptions = {
    topic: args.topic,
    experts: selection.selected,
    mode,
    rounds,
    summarize,
  };

  const { turns, summary } = await runDialogue(opts, config);

  const report =
    formatBrainstormReport(args.topic, mode, rounds, turns, summary) +
    formatSelectionNotes(selection, DEFAULT_EXPERT_LIMIT);

  const isError = turns.length === 0;
  return {
    isError,
    content: [{ type: "text", text: report }],
  };
}
