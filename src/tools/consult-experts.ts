/**
 * consult_experts MCP tool — single-round parallel expert consultation.
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * The handler validates args, resolves the expert subset, runs the
 * consultation engine, and returns a Markdown report as text content.
 */
import { z } from "zod";
import type { AppConfig, ExpertConfig } from "../types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runConsultation } from "../orchestrator/parallel.js";
import { formatConsultReport } from "../utils/format.js";

/** Zod raw shape for consult_experts arguments (passed as inputSchema). */
export const consultExpertsSchema = {
  question: z.string().describe("要咨询的问题"),
  context: z
    .string()
    .optional()
    .describe("可选背景信息(代码片段、约束等)"),
  experts: z
    .array(z.string())
    .optional()
    .describe("可选,专家 id 列表;缺省使用所有启用的专家"),
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
 * Select the experts to consult based on the requested ids.
 *
 * - If `ids` is omitted/empty: return all enabled experts.
 * - If `ids` provided: keep only enabled experts whose id matches; ids that
 *   do not correspond to any enabled expert are collected in `ignored` so the
 *   tool can surface them in the report.
 */
export function selectExperts(
  config: AppConfig,
  ids?: string[],
): { selected: ExpertConfig[]; ignored: string[] } {
  const enabled = config.experts.filter((e) => e.enabled !== false);
  if (!ids || ids.length === 0) {
    return { selected: enabled, ignored: [] };
  }
  const byId = new Map(enabled.map((e) => [e.id, e]));
  const selected: ExpertConfig[] = [];
  const ignored: string[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) {
      selected.push(found);
      byId.delete(id); // avoid duplicates if same id listed twice
    } else {
      ignored.push(id);
    }
  }
  return { selected, ignored };
}

/**
 * The handler invoked by the MCP server when consult_experts is called.
 * Returns a CallToolResult with the Markdown report (and isError when every
 * expert failed).
 */
export async function handleConsultExperts(
  args: ConsultExpertsArgs,
  config: AppConfig,
): Promise<CallToolResult> {
  const { selected, ignored } = selectExperts(config, args.experts);

  if (selected.length === 0) {
    const validIds = config.experts
      .filter((e) => e.enabled !== false)
      .map((e) => e.id)
      .join(", ");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `没有匹配到任何可用的专家。` +
            (args.experts && args.experts.length > 0
              ? `\n请求的专家 id: ${args.experts.join(", ")}`
              : "") +
            `\n当前可用的专家 id: ${validIds || "(无)"}`,
        },
      ],
    };
  }

  const items = await runConsultation(args.question, selected, config, {
    context: args.context,
    parallel: args.parallel ?? true,
  });

  // Build the report, optionally noting ignored expert ids.
  let report = formatConsultReport(args.question, args.context, items);
  if (ignored.length > 0) {
    report += `\n\n> 注: 以下请求的专家 id 未找到或未启用,已忽略: ${ignored.join(", ")}\n`;
  }

  const allFailed = items.length > 0 && items.every((it) => !it.ok);
  return {
    isError: allFailed,
    content: [{ type: "text", text: report }],
  };
}
