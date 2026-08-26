/**
 * consult_experts MCP tool — single-round parallel expert consultation.
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * The handler validates args, resolves the expert subset, runs the
 * consultation engine, and returns a Markdown report as text content.
 */
import { z } from "zod";
import type { AppConfig } from "../types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runConsultation } from "../orchestrator/parallel.js";
import { formatConsultReport } from "../utils/format.js";
import {
  DEFAULT_EXPERT_LIMIT,
  blankInputError,
  formatSelectionNotes,
  noSelectedExpertsResult,
  selectExpertsForTool,
} from "./select-experts.js";

/** Zod raw shape for consult_experts arguments (passed as inputSchema). */
export const consultExpertsSchema = {
  question: z.string().describe("要咨询的问题（去空白后不能为空）"),
  context: z
    .string()
    .optional()
    .describe("可选背景信息(代码片段、约束等)"),
  experts: z
    .array(z.string())
    .optional()
    .describe(
      "可选,专家 id 列表;缺省使用已启用且已配置 API Key 的专家（最多 3 位）",
    ),
  parallel: z
    .boolean()
    .optional()
    .describe("是否并行调用专家(默认 true),false 时按顺序逐个调用"),
};

/** Inferred argument type for the handler. */
export type ConsultExpertsArgs = {
  question: string;
  context?: string;
  experts?: string[];
  parallel?: boolean;
};

/**
 * The handler invoked by the MCP server when consult_experts is called.
 * Returns a CallToolResult with the Markdown report (and isError when every
 * expert failed).
 */
export async function handleConsultExperts(
  args: ConsultExpertsArgs,
  config: AppConfig,
): Promise<CallToolResult> {
  if (args.question.trim() === "") {
    return blankInputError("question");
  }

  const selection = selectExpertsForTool(config, args.experts, {
    defaultLimit: DEFAULT_EXPERT_LIMIT,
  });

  if (selection.selected.length === 0) {
    return noSelectedExpertsResult(config, selection, args.experts);
  }

  const items = await runConsultation(args.question, selection.selected, config, {
    context: args.context,
    parallel: args.parallel ?? true,
  });

  const report =
    formatConsultReport(args.question, args.context, items) +
    formatSelectionNotes(selection, DEFAULT_EXPERT_LIMIT);

  const allFailed = items.length > 0 && items.every((it) => !it.ok);
  return {
    isError: allFailed,
    content: [{ type: "text", text: report }],
  };
}
