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
  mergeRunSummaries,
  type DialogueOptions,
  type DialogueTurn,
} from "../orchestrator/dialogue.js";
import { formatBrainstormReport, formatRunsSection } from "../utils/format.js";
import { defaultLogger } from "../utils/log.js";
import { redactPII } from "../utils/redact.js";
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
  context: z
    .string()
    .optional()
    .describe(
      "发起方的初步分析或背景（claim-0，可能有误）：debate 模式第 1 轮各专家盲答不注入，第 2 轮起以「主理 AI 初步判断」块注入供质疑推翻；relay 模式随每轮注入；报告单列该块且它不参与互评投票",
    ),
  evidence: z
    .array(z.string())
    .optional()
    .describe(
      "调用方提供的证据包(代码片段/数据/文档引文/实测输出),将编号为[E1..En]注入各轮供专家引用;区别于 context(发起方主张)",
    ),
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
  select: z
    .enum(["auto"])
    .optional()
    .describe(
      "选卡策略：auto=按主题内容信号路由自动选卡；缺省按 cards/默认卡逻辑",
    ),
  runs: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe(
      "多轮运行次数:对同一主题完整重跑 N 次对话(每次轮换匿名别名)并去重合并结论,每条结论标注稳定性 [K/N RUNS];>1 时成本按倍数增长,建议配合 vote+debate 使用(默认 1)",
    ),
};

/** Inferred argument type for the handler. */
export type BrainstormArgs = {
  topic: string;
  context?: string;
  evidence?: string[];
  mode?: "debate" | "relay";
  rounds?: number;
  cards?: string[];
  summarize?: boolean;
  vote?: boolean;
  judgeCard?: string;
  select?: "auto";
  runs?: 1 | 2 | 3;
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
    select: args.select,
    text: args.topic,
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
    context: args.context,
    evidence: args.evidence,
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

  // P3-A runs：多轮执行。runsTotal=1 时循环退化为单次、别名恒等、事件不带
  // run 键、无合并调用——报告与事件流与现状逐字节一致（AC1 红线）。
  const runsTotal = args.runs ?? 1;
  interface RunOutcome {
    run: number;
    result: Awaited<ReturnType<typeof runDialogue>>;
  }
  const runResults: RunOutcome[] = [];
  for (let run = 1; run <= runsTotal; run++) {
    // run=1 恒等映射；run k 轮换偏移 k-1（确定性 rotate，可测）。
    const runOpts: DialogueOptions =
      run === 1 ? opts : { ...opts, aliasRotation: run - 1 };
    const result = await runDialogue(runOpts, config);
    runResults.push({ run, result });

    // 事件落盘：runsTotal>1 时四类事件带 run 字段（缺省不写键，对齐惯例）。
    const runField = runsTotal > 1 ? run : undefined;
    recordTurns(record, result.turns, rounds, runField);
    if (result.roundVotes && result.roundVotes.ballots.length > 0) {
      record?.append({
        type: "vote",
        round: result.roundVotes.round,
        votes: result.roundVotes.ballots.map((b) => ({
          voterCardId: b.voterCardId,
          votedForAlias: b.votedForAlias,
          reason: b.reason,
          // 自投显式标记（P3-R3）：仅 true 时写键（additive，正常票 JSONL 字节不变）。
          ...(b.selfVote === true ? { selfVote: true } : {}),
          // 二阶预测（R1.3）：仅非空时写键（additive）。
          ...(b.predictions && b.predictions.length > 0
            ? { predictions: b.predictions }
            : {}),
        })),
        // SP 赢家（R1.5）：仅计算成功时写键（additive，顶层）。
        ...(result.spWinner ? { spWinner: result.spWinner } : {}),
        ...(runField !== undefined ? { run: runField } : {}),
      });
    }
    if (result.summary !== undefined) {
      record?.append({
        type: "summary",
        content: result.summary,
        ...(runField !== undefined ? { run: runField } : {}),
      });
    }
  }

  // 合并调用（仅 runsTotal>1 且存在 ≥1 份结论）：judge 优先，否则第一张
  // 议事卡（与 summarize 路径总结者同规则）。失败回退并列展示，不翻转 isError。
  const first = runResults[0]!.result;
  const reportTurns = runResults.flatMap((r) => r.result.turns);
  const reportVotes = runResults.flatMap((r) => r.result.votes ?? []);
  let mergedSummary: string | undefined;
  let mergeFailed = false;
  let mergeUsage: { promptTokens?: number; completionTokens?: number } | undefined;
  if (runsTotal > 1) {
    const summaries = runResults
      .map((r) => ({ run: r.run, summary: r.result.summary }))
      .filter(
        (s): s is { run: number; summary: string } =>
          typeof s.summary === "string" && s.summary.trim() !== ""
      );
    const merger = judge ?? debateTargets[0];
    if (summaries.length > 0 && merger) {
      try {
        const merged = await mergeRunSummaries(
          args.topic,
          summaries,
          runsTotal,
          merger,
          config
        );
        mergedSummary = merged.content;
        mergeUsage = merged.usage;
      } catch (err) {
        mergeFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        defaultLogger.warn(
          `[runs] 合并调用失败，回退为逐运行结论并列展示: ${redactPII(msg)}`
        );
      }
    } else {
      mergeFailed = true;
    }
  }

  const report =
    formatBrainstormReport(args.topic, mode, rounds, first.turns, first.summary, {
      initiatorContext: args.context,
      evidence: args.evidence,
      votes: first.votes,
      aliases: first.aliases,
      roundVotes: first.roundVotes,
      spWinner: first.spWinner,
      judgeInfo: first.judgeInfo,
      devilsAdvocates: first.devilsAdvocates,
      ...(runsTotal > 1 ? { runsTotal } : {}),
    }) +
    (runsTotal > 1
      ? formatRunsSection(
          runsTotal,
          runResults.map((r) => ({ run: r.run, summary: r.result.summary })),
          mergedSummary,
          mergeFailed
        )
      : "") +
    formatSelectionNotes(selection, DEFAULT_CARD_LIMIT);

  const isError = first.turns.length === 0;
  record?.finish({
    status: isError ? "all_failed" : "ok",
    report,
    usage: sumTurnsUsage([
      ...reportTurns,
      ...reportVotes,
      ...(mergeUsage ? [{ usage: mergeUsage }] : []),
    ]),
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

/**
 * 逐轮写 turn 行 + round_end 行（对齐 notifier 的轮粒度）。
 * run 传入时（P3-A runs>1）四类事件追加 run 字段；缺省不写键（AC1 红线）。
 */
function recordTurns(
  record: RecordSession | undefined,
  turns: DialogueTurn[],
  rounds: number,
  run?: number
): void {
  if (!record) return;
  const runField = run !== undefined ? { run } : {};
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
        ...runField,
      });
    }
    record.append({ type: "round_end", round: r, total: rounds, ...runField });
  }
}
