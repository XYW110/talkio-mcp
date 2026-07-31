/**
 * brainstorm MCP tool — multi-round expert dialogue (debate / relay).
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * The handler validates caps (rounds ≤ 5, experts ≤ 6), resolves the expert
 * subset, runs the dialogue engine, and returns a formatted transcript +
 * summary as text content.
 */
import { z } from "zod";
import type { AppConfig, ExpertConfig } from "../types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  runDialogue,
  type DialogueOptions,
} from "../orchestrator/dialogue.js";
import { formatBrainstormReport } from "../utils/format.js";

/** Zod raw shape for brainstorm arguments (passed as inputSchema). */
export const brainstormSchema = {
  topic: z.string().describe("要讨论的主题"),
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
    .describe("对话轮数(1-5,默认 2)"),
  experts: z
    .array(z.string())
    .max(6)
    .optional()
    .describe("参与的专家 id 列表(最多 6 个);缺省使用所有启用的专家"),
  summarize: z
    .boolean()
    .optional()
    .describe("是否在对话结束后生成总结(默认 true)"),
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
 * Select the experts to participate. Mirrors consult-experts selection logic
 * but also enforces the ≤6 cap at the tool layer (zod already validates the
 * array length, but we also guard here in case all-enabled exceeds 6).
 */
export function selectDialogueExperts(
  config: AppConfig,
  ids?: string[],
): { selected: ExpertConfig[]; ignored: string[] } {
  const enabled = config.experts.filter((e) => e.enabled !== false);
  if (!ids || ids.length === 0) {
    // When no ids given, use up to 6 enabled experts (preserve config order).
    return { selected: enabled.slice(0, 6), ignored: [] };
  }
  const byId = new Map(enabled.map((e) => [e.id, e]));
  const selected: ExpertConfig[] = [];
  const ignored: string[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) {
      selected.push(found);
      byId.delete(id);
    } else {
      ignored.push(id);
    }
  }
  return { selected, ignored };
}

/**
 * The handler invoked by the MCP server when brainstorm is called.
 */
export async function handleBrainstorm(
  args: BrainstormArgs,
  config: AppConfig,
): Promise<CallToolResult> {
  const mode = args.mode ?? "debate";
  const rounds = args.rounds ?? 2;
  const summarize = args.summarize ?? true;

  const { selected, ignored } = selectDialogueExperts(config, args.experts);

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
            `没有匹配到任何可用的专家来参与对话。` +
            (args.experts && args.experts.length > 0
              ? `\n请求的专家 id: ${args.experts.join(", ")}`
              : "") +
            `\n当前可用的专家 id: ${validIds || "(无)"}`,
        },
      ],
    };
  }

  const opts: DialogueOptions = {
    topic: args.topic,
    experts: selected,
    mode,
    rounds,
    summarize,
  };

  const { turns, summary } = await runDialogue(opts, config);

  let report = formatBrainstormReport(args.topic, mode, rounds, turns, summary);
  if (ignored.length > 0) {
    report += `\n\n> 注: 以下请求的专家 id 未找到或未启用,已忽略: ${ignored.join(", ")}\n`;
  }

  // Treat as error only if we got zero turns back.
  const isError = turns.length === 0;
  return {
    isError,
    content: [{ type: "text", text: report }],
  };
}
