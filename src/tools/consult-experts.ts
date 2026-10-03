/**
 * consult_experts MCP tool — single-round parallel consultation via role cards.
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * The handler validates args, resolves the card subset, runs the
 * consultation engine, and returns a Markdown report as text content.
 */
import { z } from "zod";
import type { AppConfig } from "../types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runConsultation } from "../orchestrator/parallel.js";
import type { StreamNotifier } from "../utils/notify.js";
import { formatConsultReport } from "../utils/format.js";
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
import {
  loadExpertMemories,
  type MemoryEntry,
} from "../experts/memory.js";

/** Zod raw shape for consult_experts arguments (passed as inputSchema). */
export const consultExpertsSchema = {
  question: z.string().describe("要咨询的问题（去空白后不能为空）"),
  context: z
    .string()
    .optional()
    .describe(
      "主理 AI 的初步分析/背景（claim-0，可能有误）：供专家独立参考与质疑，不作为权威事实",
    ),
  cards: z
    .array(z.string())
    .optional()
    .describe(
      "可选,角色卡 id 列表;缺省使用已启用且已配置 API Key 的角色卡（最多 3 张）",
    ),
  parallel: z
    .boolean()
    .optional()
    .describe("是否并行调用专家(默认 true),false 时按顺序逐个调用"),
  select: z
    .enum(["auto"])
    .optional()
    .describe(
      "选卡策略：auto=按问题内容信号路由自动选卡；缺省按 cards/默认卡逻辑",
    ),
  memory: z
    .boolean()
    .optional()
    .describe(
      "是否注入各专家的历史记忆(brainstorm 末轮沉淀的经验,最多 3 条):注入后专家能引用此前经验(默认 true;设 false 获得与旧版逐字节一致的 prompt)"
    ),
};

/** Inferred argument type for the handler. */
export type ConsultExpertsArgs = {
  question: string;
  context?: string;
  cards?: string[];
  parallel?: boolean;
  select?: "auto";
  /** 历史记忆注入开关（groupchat-strengths P3，缺省 true）。 */
  memory?: boolean;
};

/**
 * The handler invoked by the MCP server when consult_experts is called.
 * Returns a CallToolResult with the Markdown report (and isError when every
 * card failed).
 */
export async function handleConsultExperts(
  args: ConsultExpertsArgs,
  config: AppConfig,
  deps?: {
    notifier?: StreamNotifier;
    record?: RecordSession;
    /** 记忆目录（P3）；缺省时记忆注入降级为零（不报错）。 */
    memoryDir?: string;
  },
): Promise<CallToolResult> {
  if (args.question.trim() === "") {
    return blankInputError("question");
  }

  const selection = selectCardsForTool(config, args.cards, {
    defaultLimit: DEFAULT_CARD_LIMIT,
    select: args.select,
    text: args.question,
  });

  if (selection.selected.length === 0) {
    return noSelectedCardsResult(config, selection, args.cards);
  }

  const record = deps?.record;
  record?.append({ type: "cards", cards: toCardRefs(selection.selected) });

  // 记忆预读（P3）：memory !== false 且提供 memoryDir 时注入；IO 在工具层。
  const memories = new Map<string, MemoryEntry[]>();
  if (args.memory !== false && deps?.memoryDir) {
    for (const t of selection.selected) {
      memories.set(
        t.expert.id,
        loadExpertMemories(deps.memoryDir, t.expert.id)
      );
    }
  }

  const items = await runConsultation(args.question, selection.selected, config, {
    context: args.context,
    parallel: args.parallel ?? true,
    notifier: deps?.notifier,
    ...(memories.size > 0 ? { memories } : {}),
  });

  // 记录每张卡的原始回答/失败原因，语义与报告一致（含全失败聚合项）。
  for (const item of items) {
    record?.append({
      type: "card_result",
      cardId: item.target.card.id,
      ok: item.ok,
      content: item.ok ? item.content : undefined,
      error: item.ok ? undefined : item.error,
      usage: item.ok ? item.usage : undefined,
    });
  }

  const report =
    formatConsultReport(args.question, args.context, items) +
    formatSelectionNotes(selection, DEFAULT_CARD_LIMIT);

  const allFailed = items.length > 0 && items.every((it) => !it.ok);

  // 完成：全会话 usage 求和（缺省字段不虚构）。
  let status: "ok" | "all_failed" | "no_cards" | "error" = "ok";
  if (items.length === 0) status = "no_cards";
  else if (allFailed) status = "all_failed";
  record?.finish({ status, report, usage: sumUsageList(items) });

  return {
    isError: allFailed,
    content: [{ type: "text", text: report }],
  };
}

/** 逐项 usage 归并（sumUsage 一次只能并两个，reduce 串联）。 */
function sumUsageList(
  items: Array<{ usage?: { promptTokens?: number; completionTokens?: number } }>
): { promptTokens?: number; completionTokens?: number } | undefined {
  let acc: { promptTokens?: number; completionTokens?: number } | undefined;
  for (const it of items) acc = sumUsage(acc, it.usage);
  return acc;
}