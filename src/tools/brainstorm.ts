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
  hasProviderKey,
  noSelectedCardsResult,
  resolveCard,
  selectCardsForTool,
  toCardRefs,
} from "./select-cards.js";
import type { ResolvedCard } from "./select-cards.js";
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
    .describe("是否在对话结束后生成收敛总结(默认 true)"),
  vote: z
    .boolean()
    .optional()
    .describe(
      "是否开启互评投票(默认 false):全部内容轮结束后、综合之前,每位专家匿名互评最认同的观点;仅 debate 模式生效,relay 下忽略",
    ),
  judgeCard: z
    .string()
    .optional()
    .describe(
      "裁决者角色卡 id:由该卡(而非第一张卡)执行最终综合;该卡若同时参与议事会被剔除;无效时回退第一张卡并在报告注明",
    ),
};

/** Inferred argument type for the handler. */
export type BrainstormArgs = {
  topic: string;
  mode?: "debate" | "relay";
  rounds?: number;
  cards?: string[];
  summarize?: boolean;
  vote?: boolean;
  judgeCard?: string;
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
  const summarize = args.summarize ?? true;

  const selection = selectCardsForTool(config, args.cards, {
    defaultLimit: DEFAULT_CARD_LIMIT,
  });

  if (selection.selected.length === 0) {
    return noSelectedCardsResult(config, selection, args.cards);
  }

  // 裁决者解析（R3）：judgeCard 指向 enabled 且 provider key 可用的卡 → 作为
  // 综合裁决者；无效（不存在/禁用/缺 key）时回退第一张卡，报告注明。
  let judge: ResolvedCard | undefined;
  let judgeFallbackInfo: { cardId: string; cardName: string } | undefined;
  const judgeCardId = args.judgeCard?.trim();
  if (judgeCardId) {
    const cardCfg = config.cards.find((c) => c.id === judgeCardId);
    const resolved = cardCfg ? resolveCard(cardCfg, config) : null;
    if (
      cardCfg &&
      cardCfg.enabled !== false &&
      resolved &&
      hasProviderKey(config, resolved.providerName)
    ) {
      judge = resolved;
    } else {
      judgeFallbackInfo = { cardId: judgeCardId, cardName: cardCfg?.name ?? judgeCardId };
    }
  }

  // 裁决者若同时出现在议事 targets 中且还有其他卡，先剔除（避免既下场辩论又仲裁）。
  let debateTargets = selection.selected;
  if (judge && debateTargets.length > 1) {
    const filtered = debateTargets.filter((t) => t.card.id !== judge!.card.id);
    if (filtered.length > 0) debateTargets = filtered;
  }

  const opts: DialogueOptions = {
    topic: args.topic,
    targets: debateTargets,
    mode,
    rounds,
    summarize,
    notifier: deps?.notifier,
    vote: args.vote === true,
    judge,
    judgeFallbackInfo,
  };

  const record = deps?.record;
  record?.append({ type: "cards", cards: toCardRefs(selection.selected) });

  const { turns, summary, votes, aliases, judgeInfo } = await runDialogue(
    opts,
    config
  );

  // 按轮次分组实录：turn 行 + 轮边界 round_end 行 + 可选 summary 行。
  recordTurns(record, turns, rounds);
  // 投票轮（R1）：独立 vote 事件行（不占 turn/round 语义）。
  for (const v of votes ?? []) {
    record?.append({
      type: "vote",
      expertId: v.expertId,
      expertName: v.expertName,
      icon: v.icon,
      content: v.content,
      usage: v.usage,
    });
  }
  if (summary !== undefined) {
    record?.append({ type: "summary", content: summary });
  }

  const report =
    formatBrainstormReport(args.topic, mode, rounds, turns, summary, {
      votes,
      aliases,
      judgeInfo,
    }) + formatSelectionNotes(selection, DEFAULT_CARD_LIMIT);

  const isError = turns.length === 0;
  record?.finish({
    status: isError ? "all_failed" : "ok",
    report,
    usage: sumTurnsUsage([...turns, ...(votes ?? [])]),
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