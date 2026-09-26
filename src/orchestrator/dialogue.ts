/**
 * Multi-round dialogue engine (brainstorm tool).
 *
 * Two modes per design §6:
 *  - debate: each round, every expert sees the previous round's transcript and
 *    is prompted to challenge / supplement / refine others' points. Turns
 *    within a round run in parallel.
 *  - relay: experts speak sequentially; each sees the full running transcript
 *    so far and is asked to deepen the previous speaker's idea.
 *
 * Token budget: each expert's prior-round history is truncated to the most
 * recent ~500 chars per turn when injected into prompts, and the assembled
 * transcript block is capped at ~12k chars (ol turns dropped first).
 */
import type { AppConfig } from "../types.js";
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
} from "../providers/adapter.js";
import { getAdapter, isMockProviderEnabled } from "../providers/registry.js";
import { resolveProviderCredentials } from "../config.js";
import { redactPII } from "../utils/redact.js";
import { defaultLogger, type Logger } from "../utils/log.js";
import type { StreamNotifier } from "../utils/notify.js";
import type { ResolvedCard } from "../tools/select-cards.js";
import {
  buildInjection,
  compressTurns,
  emptySummaryState,
  exceedsBudget,
  type SummaryState,
} from "./context-compressor.js";
import { applyReasoningStrategy } from "./strategy.js";

/** A single turn in the dialogue transcript. */
export interface DialogueTurn {
  round: number;
  expertId: string;
  expertName: string;
  icon: string;
  content: string;
  /** Token usage if reported by the provider (recorded, not prompted). */
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** askExpert 的返回：回答正文 + provider 上报的用量（可缺省）。 */
export interface AskExpertResult {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** Options for runDialogue. */
export interface DialogueOptions {
  topic: string;
  targets: ResolvedCard[];
  mode: "debate" | "relay";
  rounds: number; // default 2, max 5
  summarize: boolean; // default true
/** Injectable logging sink; defaults to the module-level info logger. */
  logger?: Logger;
  /** 每轮结束的流式增量通知（R2：brainstorm 按轮粒度）。 */
  notifier?: StreamNotifier;
  /** 互评投票开关（R1）：仅 debate 模式生效，relay 下忽略；缺省 false。 */
  vote?: boolean;
  /**
   * 裁决者卡（R3）：工具层已按 judgeCard 解析为可用卡；提供时用作综合调用方。
   * undefined = 未提供（沿用第一张卡）。
   */
  judge?: ResolvedCard;
  /** judgeCard 提供但无效（不存在/禁用/缺 key）时的回退标注信息。 */
  judgeFallbackInfo?: { cardId: string; cardName: string };
  /**
   * 别名轮换偏移（P3-A runs）：把「卡 ↔ 匿名别名」映射整体旋转该偏移位，
   * 使多次运行之间映射不同。缺省/0 = 恒等（与现状逐字节一致）。
   */
  aliasRotation?: number;
  /**
   * 发起方初步分析/背景（claim-0，R1-R4）：debate 模式下第 1 轮盲答不注入，
   * 第 ≥2 轮以 claim-0 块前置于注入块；relay 模式下随每轮 prompt（含种子轮）
   * 在 topic 后注入。缺省/纯空白 = 无 claim-0，prompt 组装形状与现状一致。
   */
  context?: string;
  /**
   * 证据锚定（R2）：调用方提供的证据包（代码片段/数据/文档引文/实测输出），
   * 编号为 [E1]..[En] 组装成「可引用证据库」块。debate 种子轮 / debate ≥2 轮 /
   * relay 各轮均注入（证据是共享事实基底，区别于 claim-0 的可推翻主张），
   * 投票轮不注入。缺省/全空白项 = 不注入，prompt 组装形状与现状逐字节一致。
   */
  evidence?: string[];
}

/** 匿名化代号映射（R2）：按 targets 顺序分配 专家A/B/…。 */
export interface DialogueAlias {
  alias: string;
  expertId: string;
  expertName: string;
}

/**
 * 确定性别名轮换（P3-A runs）：把别名「代号」按专家顺序整体旋转 offset 位，
 * 使多次运行之间「卡 ↔ 匿名别名」映射不同（run k 用 offset=k-1）。
 * 只轮换代号字符串、保持 expertId 对位，确保映射真的变化；offset=0 或单卡时
 * 返回原引用，保证 run=1 路径与现状逐字节一致。
 */
export function rotateAliases(
  aliases: DialogueAlias[],
  offset: number
): DialogueAlias[] {
  const n = aliases.length;
  const k = ((Math.trunc(offset) % n) + n) % n;
  if (n <= 1 || k === 0) return aliases;
  return aliases.map((a, i) => ({ ...a, alias: aliases[(i + k) % n]!.alias }));
}

/**
 * 第 round 轮（≥2）的魔鬼代言人下标（P3-R1）：targets[(round-2) % n]，确定性轮换；
 * round<2 或空数组返回 -1（调用方按「本轮无魔鬼代言人」处理）。
 */
export function devilsAdvocateIndex(
  round: number,
  targetCount: number
): number {
  if (round < 2 || targetCount <= 0) return -1;
  return (round - 2) % targetCount;
}

/** Result of runDialogue: ordered turns + optional summary. */
export interface DialogueResult {
  turns: DialogueTurn[];
  summary?: string;
  /** 投票轮产物（R1）；vote 未启用或全部失败时缺省。 */
  votes?: DialogueTurn[];
  /** 代号映射（R2）：报告对照表 / 投票摘要渲染用；与 votes 一同返回。 */
  aliases?: DialogueAlias[];
  /** 结构化投票结果（P1-A）：vote 开启且至少一票成功时返回。 */
  roundVotes?: RoundVotes;
  /** 魔鬼代言人轮换记录（P3-R1）：debate 模式 round≥2 每轮一条；relay / rounds<2 缺省。 */
  devilsAdvocates?: Array<{ round: number; expertId: string; expertName: string }>;
  /** 裁决者信息（R3）：报告综合段标注用；未提供 judgeCard 时缺省。 */
  judgeInfo?: { cardId: string; cardName: string; fallback?: boolean };
  /** SP 赢家（R1.5）：surprisinglyPopular 唯一 argmax 时的别名；未计算/并列/
   * 预测不足时不写键（JSONL additive，design §3.4）。 */
  spWinner?: string;
}

/** 单张选票（P1-A 结构化中间结果；voterCardId 仅落盘用，展示一律走别名）。 */
export interface VoteBallot {
  /** 投票者真实卡 id（JSONL 内部映射，与 card_result 同等可见级别）。 */
  voterCardId: string;
  /** 投票者匿名别名（如 "专家A"，报告用）。 */
  voterAlias: string;
  /** 被投者别名；无法从票文识别时为空串。 */
  votedForAlias: string;
  /** 投票理由原文（截断到 ~200 字符，超长加省略号）。 */
  reason: string;
  /** 自投显式标记（P3-R3）：票文只提及本人别名时置 true（无效票）；仅 true 时写键（additive）。 */
  selfVote?: boolean;
  /**
   * 二阶预测（R1.2/R1.3）：该票预测段内收集到的其他专家别名（排除本人、
   * 去重保序）；无预测段或未收集到任何别名时不写键（JSONL additive）。
   */
  predictions?: string[];
}

/** 每轮投票结果（P1-A/D2：投票轮发生在全部内容轮后，round = 内容轮数）。 */
export interface RoundVotes {
  round: number;
  ballots: VoteBallot[];
}

// --- Prompt templates (exported for unit testing) -----------------------

/** Seed instruction for round 1 (every expert answers the topic fresh).
 * R7（论据锚定）：要求核心主张 + 可验证依据 + 不确定点，并附防锚定句——
 * topic 可能携带发起方的倾向/预设，专家必须独立判断而非默认其正确。 */
export const SEED_INSTRUCTION =
  "请就以下主题给出你的专业见解,清晰阐述你的核心主张、支持该主张的依据(尽量给出可验证来源:代码位置/文档/数据/实测/案例),以及你尚不确定、需要进一步验证的点。注意:主题描述可能包含发起方的倾向或预设结论,请独立判断,不要默认其为正确。";

/** Debate instruction injected from round 2 onward.
 * R8（论据锚定）：质疑/反驳必须点名对方具体论据；己方新论据须尽量给来源；
 * 无依据的观点必须显式标注为推测。 */
export const DEBATE_INSTRUCTION =
  "以下是其他专家在上一轮的发言。请针对上述观点,提出你的质疑、补充或反驳,并完善你自己的立场。要求:质疑或反驳必须点名对方的具体论据,不要泛泛否定;提出新的己方论据时尽量给出可验证来源;没有依据支撑的观点,请明确标注为推测。";

/** 魔鬼代言人轮指令（P3）：注入于该专家当轮 prompt 的 DEBATE_INSTRUCTION 之后。
 * 用「你」称呼，不含任何专家名/代号 → 匿名安全（anonymize 路径不触碰本常量）。 */
export const DEVILS_ADVOCATE_INSTRUCTION =
  "【魔鬼代言人指令】本轮你担任魔鬼代言人:请优先找出前轮发言(包括主理 AI 初步判断)中最薄弱的论据,给出你能构造的最强质疑或最坏情形分析,即使你个人认同该观点也要执行;质疑必须点名具体论据并给依据;完成反驳后,照常给出你自己修正后的立场。";

/** Relay instruction injected for each sequential speaker. */
export const RELAY_INSTRUCTION =
  "以下是此前各位专家的发言。请在最新一位专家的观点基础上深化和发展,补充新的角度或论据,避免简单重复。";

/** System prompt for the summarizer call.
 * R10（无共识条款）：票数分裂或论据冲突未解时必须显式输出「无共识」，
 * 禁止把少数意见强行归并进多数意见（对抗趋同退化的最后一道闸）。 */
export const SUMMARIZER_SYSTEM =
  "你是一位中立的讨论主持人。请基于以下完整的讨论实录,客观总结各方达成的共识、仍存在的分歧,以及可执行的下一步建议。用 Markdown 输出。注意:若票数分裂或论据冲突仍未解决,请明确输出「无共识」,并列出分歧点与各方论据的强度,不得强行把少数意见归并进多数意见。";

/** 投票轮指令（R1）：注入在匿名实录之后，要求每位专家给出互评投票。
 * 禁自投 + 限长：真实验证发现模型会投自己且票文过长（vote-prompt-fix），
 * 匿名制下自投等于无效票，票文过长会让投票段退化成第三轮发言。
 * R9（论据化投票）+ SP 二阶预测行（R1.1，task 09-27-sp-evidence-aggregation，
 * design §3.1 原文）：投票理由引用被投者具体论据（论据若基于证据库标注证据
 * 编号）；最后一行以「预测：」开头预测其他专家的票——二阶信息供
 * surprisinglyPopular 聚合（「主理 AI 初步判断（claim-0）」无别名，天然非
 * 候选人；结构要求为软约束，解析按「预测」标记容错）。 */
export const VOTE_INSTRUCTION =
  "以上是本次讨论的完整实录（已匿名，标注【你的发言】的行是你本人的观点）。请投票：\n第一行给出投票——选出你最认同的一位其他专家（代号）与其核心理由（必须引用该专家的具体论据；论据若基于证据库请标注证据编号），150 字以内，不要标题；\n最后一行以「预测：」开头——预测其他专家会各投给谁（列出代号，不含你自己）。\n不得投给你自己；一句话说明你是否修正了自己的立场。";

/** claim-0 块头（R3/R5）：发起方初步判断在 prompt 注入块中的统一标题。
 * 与别名「专家[A-Z]」形态刻意不同，parseVotedForAlias 天然不会命中。 */
export const CLAIM0_HEADER = "【主理 AI 初步判断（claim-0）】";

/** claim-0 说明行（R3）：紧跟 context 文本之后，声明其非专家、不可投、可推翻。 */
export const CLAIM0_NOTE =
  "以上是发起本次讨论的主理 AI 的初步分析，可能包含错误、片面或过时的假设。它不是专家发言，不参与互评投票；欢迎质疑、修正或推翻。";

/**
 * 组装 claim-0 块（R3/R4）：header + context 原文 + 说明行。
 * context 为 undefined 或去空白后为空时返回空串，调用点按「无 context」处理
 * （保证不传 context 时 prompt 组装形状与现状逐字节一致，design §4 红线）。
 */
export function buildClaim0Block(context: string | undefined): string {
  const trimmed = context?.trim() ?? "";
  if (trimmed === "") return "";
  return `${CLAIM0_HEADER}\n${trimmed}\n\n${CLAIM0_NOTE}`;
}

/** 证据库块头（R2）：调用方证据包在 prompt 注入块中的统一标题。
 * 形态刻意区别于别名「专家[A-Z]」，parseVotedForAlias 不会命中。 */
export const EVIDENCE_LIBRARY_HEADER =
  "【可引用证据库（主理 AI 提供，编号 [E1]..[En]）】";

/** 证据库说明行（R2/D3）：紧跟证据条目之后。与 claim-0 的认识论区分写在
 * 块内——证据是共享事实材料（首轮可见、非立场），claim-0 是可推翻主张。 */
export const EVIDENCE_LIBRARY_NOTE =
  "以上证据是共享的事实材料,不是立场主张;引用其中内容时请标注编号,如 [E1]。证据可能不完整或有误,发现相互矛盾或与你的知识冲突时,请明确指出。";

/** 单条证据截断上限（R2.2），超长加省略号。 */
export const EVIDENCE_ITEM_MAX_CHARS = 2000;
/** 证据库总量截断上限（R2.2），超限在截断处加省略号 + 截断标注。 */
export const EVIDENCE_LIBRARY_MAX_CHARS = 8000;

const EVIDENCE_LIBRARY_TRUNCATED_SUFFIX = "…（证据库已截断）";

/**
 * 组装证据库块（R2.2）：header + 编号条目 + 说明行。
 * 编号 [E1]..[En] 按传入顺序分配，纯空白项跳过（不占编号）；单条超
 * EVIDENCE_ITEM_MAX_CHARS 截断加省略号；条目区总量超 EVIDENCE_LIBRARY_MAX_CHARS
 * 在截断处加省略号 + 「（证据库已截断）」。
 * 无 evidence 或全部条目纯空白时返回空串，调用点按「无证据」处理
 * （保证不传 evidence 时 prompt 组装形状与现状逐字节一致，design §4 红线）。
 */
export function buildEvidenceLibrary(evidence: string[] | undefined): string {
  const items: string[] = [];
  for (const raw of evidence ?? []) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    items.push(
      trimmed.length > EVIDENCE_ITEM_MAX_CHARS
        ? trimmed.slice(0, EVIDENCE_ITEM_MAX_CHARS) + "…"
        : trimmed
    );
  }
  if (items.length === 0) return "";
  let body = items.map((item, i) => `[E${i + 1}] ${item}`).join("\n\n");
  if (body.length > EVIDENCE_LIBRARY_MAX_CHARS) {
    body = body.slice(0, EVIDENCE_LIBRARY_MAX_CHARS) + EVIDENCE_LIBRARY_TRUNCATED_SUFFIX;
  }
  return `${EVIDENCE_LIBRARY_HEADER}\n\n${body}\n\n${EVIDENCE_LIBRARY_NOTE}`;
}

/** 多轮 runs 合并调用系统提示（P3-A）：对 N 次运行的结论去重合并。 */
export const RUNS_MERGE_SYSTEM =
  "你是多轮议事合并器。你会收到同一主题的多次独立运行结论。请去重合并：语义相同的结论只保留一条，并在其前缀标注 [K/N RUNS]（K=该结论被提及的运行次数，N=总运行数）；仅出现一次的结论同样保留并标注。直接输出 Markdown 结论列表，不要额外解释。";

/** 一次运行的结论（P3-A 合并调用输入项）。 */
export interface RunSummaryEntry {
  run: number;
  summary: string;
}

// --- Token budget constants ---------------------------------------------

/** Per-turn truncation: keep only the tail of each prior turn's content. */
const PER_TURN_TRUNCATE_CHARS = 500;
/** Hard cap on the assembled transcript block injected into a prompt. */
const TRANSCRIPT_BUDGET_CHARS = 12000;
/** Max chars kept per expert in the local fallback summary. */
const FALLBACK_SUMMARY_TRUNCATE_CHARS = 400;

/** Truncate a turn's content for the local fallback summary. */
function truncateForSummary(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= FALLBACK_SUMMARY_TRUNCATE_CHARS) return trimmed;
  return trimmed.slice(0, FALLBACK_SUMMARY_TRUNCATE_CHARS) + "…";
}

/** 选票理由摘录上限（P1-A design：~200 字符，超长加省略号）。 */
const BALLOT_REASON_TRUNCATE_CHARS = 200;

/** Truncate a vote's raw text into the ballot reason excerpt. */
function truncateBallotReason(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= BALLOT_REASON_TRUNCATE_CHARS) return trimmed;
  return trimmed.slice(0, BALLOT_REASON_TRUNCATE_CHARS) + "…";
}

/** 单条票文别名提及（P3）：alias=映射后的已知别名；source=匹配来源。 */
interface AliasMention {
  alias: string;
  source: "full" | "bare";
}

/**
 * 按序收集票文中的全部已知别名提及（P3 共享 helper，parseVotedForAlias 与
 * isSelfVoteBallot 共同消费，避免两套正则漂移）：先全称（专家[A-Z]，现状
 * 语义），后裸代号（独立大写字母，前后均非 [A-Za-z0-9]，映射 专家X 且必须
 * 落在 knownAliases 白名单内——邻接排除 + 白名单共同防误报，API/QPS/AB/
 * 未知字母均不命中）。不在此处排除投票者本人：parseVotedForAlias 需要跳过
 * 本人，isSelfVoteBallot 依赖本人提及检测，由消费方各自处理。
 */
function collectAliasMentions(
  content: string,
  knownAliases: string[]
): AliasMention[] {
  const known = new Set(knownAliases);
  const mentions: AliasMention[] = [];
  for (const m of content.match(/专家[A-Z]/g) ?? []) {
    if (known.has(m)) mentions.push({ alias: m, source: "full" });
  }
  for (const m of content.match(/(?<![A-Za-z0-9])[A-Z](?![A-Za-z0-9])/g) ?? []) {
    const alias = `专家${m}`;
    if (known.has(alias)) mentions.push({ alias, source: "bare" });
  }
  return mentions;
}

/**
 * 从票文中解析被投者代号（P1-A，P3 两级匹配强化）：按出现顺序找到第一个
 * 「不是投票者本人」的已知别名——先全称（专家[A-Z]，现状逻辑优先），无命中
 * 再回退裸代号（独立大写字母）。匿名实录中投票者自己的行带 own 标注且排在
 * 最前，真实票文里提及的第一个他人代号即被投者；识别失败返回空串
 * （调用方结合 isSelfVoteBallot 区分自投与未识别）。
 */
export function parseVotedForAlias(
  content: string,
  voterAlias: string,
  knownAliases: string[]
): string {
  const mentions = collectAliasMentions(content, knownAliases);
  // 步骤1（优先）：全称提及中第一个非本人别名（现状语义）。
  for (const m of mentions) {
    if (m.source === "full" && m.alias !== voterAlias) return m.alias;
  }
  // 步骤2（回退）：裸代号提及中第一个非本人别名。
  for (const m of mentions) {
    if (m.source === "bare" && m.alias !== voterAlias) return m.alias;
  }
  return "";
}

/**
 * 自投显式标记（P3-R3）：票文提及了投票者本人别名（全称或裸代号）且未提及
 * 任何其他已知别名 → 判为自投（无效票）。与「未识别代号」显式区分，让
 * 自投复发可见（零自投非 prompt 可保证，见 vote-prompt-fix 基线）。
 */
export function isSelfVoteBallot(
  content: string,
  voterAlias: string,
  knownAliases: string[]
): boolean {
  const mentioned = new Set(
    collectAliasMentions(content, knownAliases).map((m) => m.alias)
  );
  if (!mentioned.has(voterAlias)) return false;
  for (const alias of knownAliases) {
    if (alias !== voterAlias && mentioned.has(alias)) return false;
  }
  return true;
}

/**
 * 按「预测」标记把票文分割为投票段与预测段（R1.2，SP 二阶聚合）：
 * 优先匹配「预测：/预测:」（全半角冒号容错）；无冒号时回退行首「预测」标记；
 * 无任何标记 → 全文为投票段、预测段为空串。分割只发生在 ballot 组装层，
 * parseVotedForAlias / isSelfVoteBallot 的签名与既有语义不变（design §4.5）。
 */
function splitBallotPrediction(content: string): {
  votePart: string;
  predictionPart: string;
} {
  const colonIdx = content.search(/预测[：:]/);
  if (colonIdx >= 0) {
    return {
      votePart: content.slice(0, colonIdx),
      predictionPart: content.slice(colonIdx),
    };
  }
  const lineMatch = content.match(/(?:^|\n)[ \t]*预测/);
  if (lineMatch && lineMatch.index !== undefined) {
    // 命中含换行/行首本身：跳过换行符，让预测段从「预测」一词起。
    const splitAt = lineMatch.index === 0 ? 0 : lineMatch.index + 1;
    return {
      votePart: content.slice(0, splitAt),
      predictionPart: content.slice(splitAt),
    };
  }
  return { votePart: content, predictionPart: "" };
}

/**
 * 收集预测段中的二阶预测别名（R1.2）：复用 collectAliasMentions（单一正则
 * 来源，两级匹配），排除投票者本人（预测自己的条目丢弃）、去重保序。
 */
function collectPredictions(
  predictionPart: string,
  voterAlias: string,
  knownAliases: string[]
): string[] {
  const seen = new Set<string>();
  const predictions: string[] = [];
  for (const m of collectAliasMentions(predictionPart, knownAliases)) {
    if (m.alias === voterAlias) continue;
    if (seen.has(m.alias)) continue;
    seen.add(m.alias);
    predictions.push(m.alias);
  }
  return predictions;
}

/** SP 边际比较的浮点容差：份额均为小数值，epsilon 防止 float 误差误判并列。 */
const SP_MARGIN_EPSILON = 1e-9;

/**
 * Surprisingly Popular 二阶聚合（R1.4；Prelec 2017，多 LLM 版见任务 research.md）。
 *
 * votes: 各有效票的被投者别名（空串 = 未识别/自投，不计入实际得票；
 * knownAliases 外的提及忽略）。predictions: 与 votes 平行的每票预测别名数组
 * （可空；缺预测的票计入实际得票但不参与预测均值——Q2=A 降级语义）。
 *
 * 对每个候选 c：margin(c) = 实际得票率 − 跨预测者平均预测得票率（预测份内
 * 条目为该预测者眼中的得票分布，份额 = 该别名出现次数 / 列表长度）。
 * 返回唯一 argmax 的别名；预测份 <2、并列最大或无有效票 → null（不输出 SP）。
 */
export function surprisinglyPopular(
  votes: string[],
  predictions: string[][],
  knownAliases: string[]
): string | null {
  const known = new Set(knownAliases);
  const validVotes = votes.filter((v) => v !== "" && known.has(v));
  const validPredictions = predictions
    .map((p) => p.filter((a) => known.has(a)))
    .filter((p) => p.length > 0);
  if (validVotes.length === 0 || validPredictions.length < 2) return null;

  const actualCount = new Map<string, number>();
  for (const v of validVotes) {
    actualCount.set(v, (actualCount.get(v) ?? 0) + 1);
  }
  const predictedSum = new Map<string, number>();
  for (const p of validPredictions) {
    for (const alias of known) {
      const hits = p.filter((a) => a === alias).length;
      predictedSum.set(alias, (predictedSum.get(alias) ?? 0) + hits / p.length);
    }
  }

  let best: string | null = null;
  let bestMargin = -Infinity;
  let tie = false;
  for (const alias of new Set(knownAliases)) {
    const actual = (actualCount.get(alias) ?? 0) / validVotes.length;
    const predicted = (predictedSum.get(alias) ?? 0) / validPredictions.length;
    const margin = actual - predicted;
    if (margin > bestMargin + SP_MARGIN_EPSILON) {
      best = alias;
      bestMargin = margin;
      tie = false;
    } else if (Math.abs(margin - bestMargin) <= SP_MARGIN_EPSILON) {
      tie = true;
    }
  }
  return tie ? null : best;
}

// --- Internal helpers ----------------------------------------------------

/** 匿名代号：按 targets 顺序分配 专家A/B/…；超过 26 张时加序号后缀（工具层上限 6，实际不触发）。 */
export function buildAliases(targets: ResolvedCard[]): DialogueAlias[] {
  return targets.map((t, i) => {
    const letter = String.fromCharCode(65 + (i % 26));
    const suffix = i >= 26 ? String(Math.floor(i / 26) + 1) : "";
    return {
      alias: `专家${letter}${suffix}`,
      expertId: t.expert.id,
      expertName: t.expert.name,
    };
  });
}

/**
 * 匿名化 turn 副本（R2，prompt 专用）：expertName → 代号、icon 置空、
 * 正文中出现的专家名（如缺席占位符）替换为代号；viewerExpertId 对应的
 * 行内容追加 own 标注。仅用于进入压缩器 / 注入渲染前的映射——
 * 压缩路径（buildInjection / renderLatestRound）没有渲染选项，靠副本
 * 携带匿名身份。存储的 turns / 会话记录 / 报告保持实名，不受影响。
 */
function anonymizeTurnCopies(
  turns: DialogueTurn[],
  aliases: DialogueAlias[],
  viewerExpertId?: string
): DialogueTurn[] {
  const aliasById = new Map(aliases.map((a) => [a.expertId, a.alias]));
  return turns.map((t) => {
    const alias = aliasById.get(t.expertId) ?? t.expertName;
    let content = t.content;
    if (t.expertName && t.expertName !== alias) {
      content = content.split(t.expertName).join(alias);
    }
    // own 标注进 expertName（行头）：真实验证发现尾部追加会被长发言淹没。
    const name =
      viewerExpertId !== undefined && t.expertId === viewerExpertId
        ? `${alias} · 你的发言`
        : alias;
    return { ...t, expertName: name, icon: "", content };
  });
}

function resolveProvider(providerName: string, config: AppConfig) {
  const providerConfig = config.providers[providerName];
  if (!providerConfig) return null;
  // Mock mode must skip env-key lookup so smoke / CI can run without secrets.
  if (isMockProviderEnabled()) {
    return {
      adapter: getAdapter(providerConfig.type),
      creds: { apiKey: "mock", baseUrl: providerConfig.baseUrl },
    };
  }
  return {
    adapter: getAdapter(providerConfig.type),
    creds: resolveProviderCredentials(config, providerName),
  };
}

/** formatTranscriptForPrompt 的渲染选项（R2 匿名互评）。 */
export interface TranscriptRenderOptions {
  /** true 时行头用代号（专家A/B/…），不出现专家名与图标。 */
  anonymize?: boolean;
  /** 代号映射（anonymize 时传入；buildAliases 按 targets 顺序生成）。 */
  aliases?: DialogueAlias[];
  /** 当前阅读者 expertId：其历史发言行追加 own 标注，便于延续自身立场。 */
  viewerExpertId?: string;
}

/**
 * Render the transcript (turns so far) into a compact text block for prompt
 * injection. Each prior turn is truncated to its last PER_TURN_TRUNCATE_CHARS
 * characters, and the whole block is capped at TRANSCRIPT_BUDGET_CHARS by
 * dropping the oldest turns first. A truncation marker is appended when any
 * content was dropped.
 *
 * 匿名化（R2）：anonymize=true 时行头改为代号并隐藏 icon；正文里出现的
 * 专家名（如缺席占位符）一并替换为代号，保证 prompt 不泄露身份。
 */
export function formatTranscriptForPrompt(
  turns: DialogueTurn[],
  options?: TranscriptRenderOptions
): string {
  if (turns.length === 0) return "";
  const anonymize = options?.anonymize === true;
  const aliasById = new Map(
    (options?.aliases ?? []).map((a) => [a.expertId, a.alias])
  );
  const viewerExpertId = options?.viewerExpertId;
  const lines: string[] = [];
  let truncated = false;
  for (const turn of turns) {
    let text = turn.content;
    if (text.length > PER_TURN_TRUNCATE_CHARS) {
      text = "…" + text.slice(-PER_TURN_TRUNCATE_CHARS);
      truncated = true;
    }
    let header: string;
    if (anonymize) {
      const alias = aliasById.get(turn.expertId) ?? turn.expertName; // 映射缺失兜底
      if (turn.expertName && turn.expertName !== alias) {
        text = text.split(turn.expertName).join(alias);
      }
      // own 标注进行头（vote-prompt-fix）：尾部追加在长发言下不够显眼。
      const ownSuffix =
        viewerExpertId !== undefined && turn.expertId === viewerExpertId
          ? " · 你的发言"
          : "";
      header = `【${alias}${ownSuffix}】(第${turn.round}轮)`;
    } else {
      // icon 为空的匿名副本（压缩器输入走本分支）渲染为 "【代号】" 而非 "【 代号】"。
      const iconPrefix = turn.icon ? `${turn.icon} ` : "";
      header = `【${iconPrefix}${turn.expertName}】(第${turn.round}轮)`;
    }
    lines.push(`${header}: ${text}`);
  }
  let block = lines.join("\n\n");
  if (block.length > TRANSCRIPT_BUDGET_CHARS) {
    // Drop oldest turns until we fit; keep at least the most recent turn.
    while (lines.length > 1 && block.length > TRANSCRIPT_BUDGET_CHARS) {
      lines.shift();
      block = lines.join("\n\n");
      truncated = true;
    }
  }
  return truncated ? `（较早的发言已省略）\n${block}` : block;
}

/**
 * Call one card target with a synthesized user message. Returns the assistant
 * content plus provider-reported usage, or throws on failure (caller handles
 * per-mode).
 */
export async function askExpert(
  target: ResolvedCard,
  userContent: string,
  config: AppConfig
): Promise<AskExpertResult> {
  const resolved = resolveProvider(target.providerName, config);
  if (!resolved) {
    throw new Error(`未找到 provider 配置: "${target.providerName}"`);
  }
  const { adapter, creds } = resolved;
  const messages: ChatMessage[] = [];
  // 推理策略（P1-B）：default/缺省时返回原串引用，prompt 逐字节不变。
  const systemPrompt = applyReasoningStrategy(
    target.expert.systemPrompt,
    target.expert.reasoningStrategy
  );
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  // Privacy: mask rule-based PII before anything leaves for the LLM.
  messages.push({ role: "user", content: redactPII(userContent) });
  const params: ChatParams = {
    model: target.modelId,
    messages,
    temperature: target.expert.temperature,
    maxTokens: target.expert.maxTokens,
    timeoutMs: target.expert.timeoutMs,
    thinkingLevel: target.thinkingLevel,
  };
  const result: ChatResult = await adapter.chat(params, creds);
  if (!result || typeof result.content !== "string") {
    throw new Error("provider 返回了无效的响应内容");
  }
  return { content: result.content, usage: result.usage };
}

// --- Main engine ---------------------------------------------------------

/**
 * 多轮 runs 的合并调用（P3-A）：把 N 次运行的结论交给合并者（judge 优先，
 * 否则第一张议事卡——与 summarize 路径总结者同规则）去重合并。失败时抛错，
 * 由调用方回退为逐运行并列展示（不翻转 isError）。
 */
export async function mergeRunSummaries(
  topic: string,
  runSummaries: RunSummaryEntry[],
  totalRuns: number,
  merger: ResolvedCard,
  config: AppConfig
): Promise<AskExpertResult> {
  const resolved = resolveProvider(merger.providerName, config);
  if (!resolved) {
    throw new Error(`未找到 provider 配置: "${merger.providerName}"`);
  }
  const { adapter, creds } = resolved;
  const runBlocks = runSummaries
    .map((s) => `--- 第 ${s.run} 次运行结论 ---\n${s.summary.trim()}`)
    .join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: RUNS_MERGE_SYSTEM },
    {
      role: "user",
      // Privacy: mask rule-based PII in the merge prompt too.
      content: redactPII(
        `讨论主题: ${topic}\n\n以下是对同一主题的 ${totalRuns} 次独立运行结论（共 ${runSummaries.length} 份）。请输出去重合并后的结论列表，每条结论前缀标注 [K/${totalRuns} RUNS]。\n\n${runBlocks}`
      ),
    },
  ];
  const params: ChatParams = {
    model: merger.modelId,
    messages,
    temperature: merger.expert.temperature,
    maxTokens: merger.expert.maxTokens,
    timeoutMs: merger.expert.timeoutMs,
    thinkingLevel: merger.thinkingLevel,
  };
  const result = await adapter.chat(params, creds);
  if (!result || typeof result.content !== "string" || result.content.trim() === "") {
    throw new Error("provider 返回了无效的合并结论");
  }
  return { content: result.content, usage: result.usage };
}

/**
 * Run a multi-round dialogue. See module docstring and design §6.
 *
 * rounds is clamped to [1, 5]. targets is used as-is (the tool layer enforces
 * the ≤6 cap). summarize=true asks the first expert to synthesize all turns.
 */
export async function runDialogue(
  opts: DialogueOptions,
  config: AppConfig
): Promise<DialogueResult> {
  const logger = opts.logger ?? defaultLogger;
  const notifier = opts.notifier;
  const startedAt = Date.now();
  const rounds = Math.max(1, Math.min(5, Math.trunc(opts.rounds)));
  const targets = opts.targets;
  const turns: DialogueTurn[] = [];
  // 魔鬼代言人轮换记录（P3-R1）：debate round≥2 每轮恰一位（确定性轮换），
  // 仅记录轮次与实名，供报告「魔鬼代言人轮换」小节渲染。
  const devilsAdvocates: Array<{
    round: number;
    expertId: string;
    expertName: string;
  }> = [];
  // Semantic compression state (task 08-28-semantic-truncation, design §4/§6).
  // summary: incremental summary; empty summaryText = not yet enabled.
  // summarizerFailed: set after a failed compressor call → hard truncation for
  // the rest of this session (no retry, no oscillation).
  let ctxSummary: SummaryState = emptySummaryState();
  let summarizerFailed = false; // session-level: never retry after first fail

  // 匿名代号映射（R2）：按 targets 顺序分配 专家A/B/…；debate 轮间注入与投票轮共用。
  // P3-A runs：aliasRotation>0 时整体轮换映射，使多次运行之间映射不同（确定性）。
  const aliases = rotateAliases(buildAliases(targets), opts.aliasRotation ?? 0);

  // claim-0 块（R1-R4 反锚定）：发起方初步分析降级为可推翻的 claim-0。
  // debate 第 1 轮盲答不注入（R2）；debate 第 ≥2 轮前置于注入块（R3）；
  // relay 各轮（含种子轮，首位发言者需要背景）topic 后注入（R4，D2）。
  // 空白 context → claim0Prefix 为空串，prompt 组装形状与现状逐字节一致。
  const claim0 = buildClaim0Block(opts.context);
  const claim0Prefix = claim0 ? `${claim0}\n\n` : "";

  // 证据库块（R2 证据锚定）：共享事实基底，debate 种子轮即注入（盲答隔离仅
  // 针对 context/claim-0，不针对证据基底）；固定相对顺序 = evidence、claim-0、
  // 实录（design §2.2）。空白/缺省 → evidencePrefix 为空串，逐字节还原现状。
  // 投票轮不注入（票文引用的是已陈述论据）。
  const evidenceBlock = buildEvidenceLibrary(opts.evidence);
  const evidencePrefix = evidenceBlock ? `${evidenceBlock}\n\n` : "";

  if (targets.length === 0 || rounds === 0) {
    return { turns };
  }

  // Semantic compression (design §6): pick the transcript block to inject for
  // the current round. Three branches:
  //  - under budget         → current behavior (formatTranscriptForPrompt)
  //  - first over budget    → compress once, then inject summary + latest round
  //  - already enabled      → increment the summary + latest round (no re-check)
  // `injected` = the turns to compress; `latestRoundTurns` = the most recent
  // round's turns rendered in full (the "最近发言完整实录" layer).
  //
  // 返回渲染函数而非字符串：调用方传 viewerExpertId 获取该阅读者的注入块
  // （匿名化 R2 的 own 标注逐阅读者不同）。anonymize=true 时，进入压缩器与
  // 注入渲染的都是匿名副本（expertName→代号、icon 置空），保证概要文本与
  // 最新轮实录同样匿名（AC2）；存储的 turns / 记录 / 报告保持实名。
  const resolveRenderer = async (
    injected: DialogueTurn[],
    latestRoundTurns: DialogueTurn[],
    render?: TranscriptRenderOptions
  ): Promise<(viewerExpertId?: string) => string> => {
    const anonymize = render?.anonymize === true;
    const aliasesForRender = render?.aliases ?? aliases;
    const toPromptTurns = (list: DialogueTurn[], viewer?: string): DialogueTurn[] =>
      anonymize ? anonymizeTurnCopies(list, aliasesForRender, viewer) : list;
    if (!exceedsBudget(injected) && ctxSummary.summaryText === "") {
      return (viewer) =>
        formatTranscriptForPrompt(
          injected,
          render ? { ...render, viewerExpertId: viewer } : undefined
        );
    }
    if (ctxSummary.summaryText === "" && !summarizerFailed) {
      try {
        ctxSummary = await compressTurns(
          opts.topic,
          toPromptTurns(injected),
          targets[0]!,
          config
        );
      } catch {
        summarizerFailed = true; // session-level: never retry compression.
        return (viewer) =>
          formatTranscriptForPrompt(
            injected,
            render ? { ...render, viewerExpertId: viewer } : undefined
          );
      }
    }
    return (viewer) => {
      if (!anonymize) return buildInjection(ctxSummary, latestRoundTurns);
      // 压缩路径匿名：匿名副本经 buildInjection 渲染。renderLatestRound 的
      // 空 icon 会产出 "【 代号】" 行头，这里做行首清理，与非压缩路径的
      // "【代号】" 对齐（只命中行首，不触碰正文）。
      return buildInjection(ctxSummary, toPromptTurns(latestRoundTurns, viewer)).replace(
        /^【 /gm,
        "【"
      );
    };
  };

  // Merge the latest round's new turns into the summary incrementally
  // (design §4.2 / §9: +1 LLM call per enabled round, best-effort).
  const absorbRound = async (roundNo: number): Promise<void> => {
    if (ctxSummary.summaryText === "") return;
    const roundTurns = turns.filter((t) => t.round === roundNo);
    if (roundTurns.length === 0) return;
    // 匿名化（R2/D3）：debate 概要只用于轮间注入，并入时用匿名副本，
    // 避免概要文本携带真实专家名；relay 不匿名，维持现状。
    const promptTurns =
      opts.mode === "debate" ? anonymizeTurnCopies(roundTurns, aliases) : roundTurns;
    try {
      ctxSummary = await compressTurns(
        opts.topic,
        promptTurns,
        targets[0]!,
        config,
        ctxSummary.summaryText,
        logger
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[context-compressor] 第${roundNo}轮增量并入概要失败，概要保持旧值: ${msg}`
      );
    }
  };

  for (let round = 1; round <= rounds; round++) {
    if (round === 1) {
      // Seed round: every expert answers the topic fresh (parallel).
      // 盲答边界（R2/D2）：debate 第 1 轮是独立盲答，不注入发起方 context；
      // relay 无盲答语义（R4，首位发言者需要背景），topic 后附 claim-0 块。
      // 证据库（R2.3）：种子轮即注入（置于 topic 之后、指令之前），顺序
      // evidence → claim-0（relay）→ SEED_INSTRUCTION。
      const seedClaim0Prefix = opts.mode === "relay" ? claim0Prefix : "";
      const results = await Promise.allSettled(
        targets.map((target) =>
          askExpert(
            target,
            `${opts.topic}\n\n${evidencePrefix}${seedClaim0Prefix}${SEED_INSTRUCTION}`,
            config
          )
        )
      );
      results.forEach((res, i) => {
        const target = targets[i];
        if (!target) return; // defensive: index always aligns with allSettled order
        if (res.status === "fulfilled") {
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            content: res.value.content,
            usage: res.value.usage,
          });
        } else {
          const msg =
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            // Privacy: sanitize provider error echoes.
            content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
          });
        }
      });
      // 流式增量（R2）：本轮种子发言全部 settle 后通知一轮边界（Q2 粒度=轮）。
      notifier?.({ type: "brainstorm.round", round, total: rounds });
      continue;
    }

    if (opts.mode === "debate") {
      // Each expert sees the PREVIOUS round's turns only, in parallel.
      const prevRoundTurns = turns.filter((t) => t.round === round - 1);
      // 匿名互评（R2/D3）：第 2 轮起注入块用代号隐藏身份——未压缩与压缩
      // 路径均匿名（副本映射在 resolveRenderer 内完成）；own 标注逐 expert。
      const render = await resolveRenderer(prevRoundTurns, prevRoundTurns, {
        anonymize: true,
        aliases,
      });
      // claim-0（R3）：置于发言实录段之前（压缩/非压缩路径共用同一包裹点，
      // 不改 context-compressor）；无 context 时 claim0Prefix 为空串，形状不变。
      // 魔鬼代言人轮换（P3-R1）：round≥2 每轮恰一位专家（targets[(round-2)%n]），
      // 对该专家在 DEBATE_INSTRUCTION 及其后既有片段之后（userContent 末尾）追加
      // DEVILS_ADVOCATE_INSTRUCTION——不改 transcript 渲染、不构造 DialogueTurn、
      // 不进压缩器；其余专家、round 1 seed、relay、投票轮均不注入（design §4 红线）。
      const daIdx = devilsAdvocateIndex(round, targets.length);
      const daTarget = daIdx >= 0 ? targets[daIdx] : undefined;
      if (daTarget) {
        devilsAdvocates.push({
          round,
          expertId: daTarget.expert.id,
          expertName: daTarget.expert.name,
        });
      }
      const userContents = targets.map((target, i) => {
        // 证据库（R2.3）：插在现有 claim0Prefix 之前（顺序 = evidence、
        // claim-0、实录；design §2.2），无 evidence 时 evidencePrefix 为空串。
        const base = `${opts.topic}\n\n${DEBATE_INSTRUCTION}\n\n${evidencePrefix}${claim0Prefix}上一轮发言:\n${render(target.expert.id)}`;
        return i === daIdx
          ? `${base}\n\n${DEVILS_ADVOCATE_INSTRUCTION}`
          : base;
      });
      const results = await Promise.allSettled(
        targets.map((target, i) =>
          askExpert(target, userContents[i]!, config)
        )
      );
      results.forEach((res, i) => {
        const target = targets[i];
        if (!target) return; // defensive: index always aligns with allSettled order
        if (res.status === "fulfilled") {
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            content: res.value.content,
            usage: res.value.usage,
          });
        } else {
          const msg =
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            // Privacy: sanitize provider error echoes.
            content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
          });
        }
      });
    } else {
      // Relay: experts speak sequentially; each sees the full running transcript.
      // relay 不匿名（D3）：renderer 不传渲染选项，注入行为与现状一致。
      for (const target of targets) {
        const render = await resolveRenderer(turns, turns);
        const transcript = render();
        // claim-0（R4）：relay 无盲答语义，各轮 topic 后都带发起方初步判断。
        // 证据库（R2.3）：各轮 topic 后注入，顺序 evidence → claim-0。
        const userContent =
          transcript.length > 0
            ? `${opts.topic}\n\n${evidencePrefix}${claim0Prefix}${RELAY_INSTRUCTION}\n\n此前发言:\n${transcript}`
            : `${opts.topic}\n\n${evidencePrefix}${claim0Prefix}${SEED_INSTRUCTION}`;
        try {
          const answer = await askExpert(target, userContent, config);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            content: answer.content,
            usage: answer.usage,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          turns.push({
            round,
            expertId: target.expert.id,
            expertName: target.expert.name,
            icon: target.expert.icon,
            // Privacy: sanitize provider error echoes.
            content: `⚠️ (${target.expert.name} 本轮缺席: ${redactPII(msg)})`,
          });
        }
      }
    }
    // 轮末增量并入：启用概要后把本轮新内容并入增量概要（best-effort，吞错）。
    await absorbRound(round);
    // 流式增量（R2）：每轮结束后通知（debate / relay 均在此收敛，seed 分支已在 continue 前发）。
    notifier?.({ type: "brainstorm.round", round, total: rounds });
  }

  // --- 投票轮（R1：互评投票）---------------------------------------------
  // 时机：全部内容轮结束后、综合之前；仅 debate + vote + 有效议事卡 ≥2。
  // 投票不计入内容轮次（独立 votes 数组，不污染 round 语义 / round_end 对账）。
  const votes: DialogueTurn[] = [];
  const voteEnabled =
    opts.vote === true && opts.mode === "debate" && targets.length >= 2 && turns.length > 0;
  if (voteEnabled) {
    // 与轮间注入共用压缩状态机（一次解析，避免逐 voter 重复触发压缩）。
    // 匿名化贯穿两条注入路径：未压缩路径逐 voter 渲染；压缩路径由
    // resolveRenderer 内部映射匿名副本（own 标注同样生效）。
    const render = await resolveRenderer(turns, turns, {
      anonymize: true,
      aliases,
    });
    const voteResults = await Promise.allSettled(
      targets.map((target) => {
        const userContent = `${opts.topic}\n\n讨论实录（已匿名）:\n${render(target.expert.id)}\n\n${VOTE_INSTRUCTION}`;
        return askExpert(target, userContent, config);
      })
    );
    voteResults.forEach((res, i) => {
      const target = targets[i];
      if (!target) return; // defensive: index always aligns with allSettled order
      if (res.status === "fulfilled") {
        votes.push({
          round: 0, // 投票不计入内容轮次
          expertId: target.expert.id,
          expertName: target.expert.name,
          icon: target.expert.icon,
          content: res.value.content,
          usage: res.value.usage,
        });
      } else {
        // 隔离失败（error-handling 规范）：单专家投票失败不阻断，stderr 留痕。
        const msg =
          res.reason instanceof Error ? res.reason.message : String(res.reason);
        logger.warn(`[vote] ${target.expert.name} 投票失败: ${redactPII(msg)}`);
      }
    });
    if (votes.length > 0) {
      // vote 粒度通知（R4）：投票轮产物就绪。
      notifier?.({ type: "brainstorm.vote" });
    }
  }

  // Optional summary by the first expert using a dedicated summarizer prompt.
  let summary: string | undefined;
  if (opts.summarize && targets.length > 0 && turns.length > 0) {
    // 裁决者（R3）：提供有效 judge 卡时由它综合，否则沿用第一张卡。
    const summarizer = opts.judge ?? targets[0];
    if (!summarizer)
      throw new Error("unreachable: summarizer always exists when turns > 0");
    const fullTranscript = formatTranscriptForPrompt(turns);
    // 投票摘要（R1）：作为综合阶段的输入依据之一追加在实录之后。
    const voteBlock =
      votes.length > 0 && aliases
        ? `\n\n以下是各位专家的互评投票,请在总结时参考:\n${votes
            .map((v) => {
              const alias =
                aliases?.find((a) => a.expertId === v.expertId)?.alias ??
                v.expertName;
              return `【${alias}】${v.content.trim()}`;
            })
            .join("\n\n")}`
        : "";
    try {
      // Override the system prompt for the summary call so the persona is neutral.
      const resolved = resolveProvider(summarizer.providerName, config);
      if (resolved) {
        const { adapter, creds } = resolved;
        const params: ChatParams = {
          model: summarizer.modelId,
          messages: [
            { role: "system", content: SUMMARIZER_SYSTEM },
            {
              role: "user",
              // Privacy: mask rule-based PII in the summary prompt too.
              content: redactPII(
                `讨论主题: ${opts.topic}\n\n讨论实录:\n${fullTranscript}${voteBlock}`
              ),
            },
          ],
          temperature: summarizer.expert.temperature,
          maxTokens: summarizer.expert.maxTokens,
          timeoutMs: summarizer.expert.timeoutMs,
          thinkingLevel: summarizer.thinkingLevel,
        };
        const result = await adapter.chat(params, creds);
        if (result && typeof result.content === "string") {
          summary = result.content;
        }
      }
    } catch {
      // LLM summary is best-effort; fall back to a local convergence below.
    }
    if (!summary || summary.trim() === "") {
      // Guaranteed convergence: when the LLM summary is unavailable (failed,
      // empty, or no usable provider), build a deterministic local summary
      // from the last round's turns so the report always ends with one.
      const lastRound = turns[turns.length - 1]?.round ?? 0;
      const lastRoundTurns = turns.filter((t) => t.round === lastRound);
      const bulletList = lastRoundTurns
        .map((t) => `- **${t.expertName}**：${truncateForSummary(t.content)}`)
        .join("\n");
      summary = [
        "> ⚠️ 本条为本地兜底收敛（LLM 总结调用失败，以下为最后一轮各专家观点摘录）：",
        bulletList,
      ].join("\n");
    }
  }

  // Observability: emit a compact [summary] typeline (stderr, never in report).
  const failed = turns.filter((t) => t.content.includes("⚠️")).length;
  const ok = turns.length - failed;
  const compressed = ctxSummary.summaryText !== ""
    ? "on"
    : summarizerFailed
      ? "failed"
      : "off";
  logger.info(
    `[summary] brainstorm rounds=${rounds} turns=${turns.length} summary=${summary ? "yes" : "no"} compressed=${compressed} ok=${ok} failed=${failed} total_ms=${Date.now() - startedAt}`
  );

  const result: DialogueResult = { turns, summary };
  if (devilsAdvocates.length > 0) {
    result.devilsAdvocates = devilsAdvocates;
  }
  if (votes.length > 0) {
    result.votes = votes;
    result.aliases = aliases;
    // 结构化投票结果（P1-A）：别名解析 + 被投代号识别，供 JSONL 落盘与报告明细。
    const aliasByExpertId = new Map(aliases.map((a) => [a.expertId, a.alias]));
    const cardIdByExpertId = new Map(
      targets.map((t) => [t.expert.id, t.card.id])
    );
    const knownAliases = aliases.map((a) => a.alias);
    result.roundVotes = {
      round: rounds,
      ballots: votes.map((v) => {
        const voterAlias = aliasByExpertId.get(v.expertId) ?? v.expertName;
        // 预测分割（R1.2）：只发生在 ballot 组装层——投票段沿用既有解析
        // （签名/语义不变），预测段单独收集二阶预测。
        const { votePart, predictionPart } = splitBallotPrediction(v.content);
        const votedForAlias = parseVotedForAlias(
          votePart,
          voterAlias,
          knownAliases
        );
        const ballot: VoteBallot = {
          voterCardId: cardIdByExpertId.get(v.expertId) ?? v.expertId,
          voterAlias,
          votedForAlias,
          reason: truncateBallotReason(v.content),
        };
        // 自投显式标记（P3-R3）：未识别出他人代号、且票文只提及本人 → 显式自投。
        if (
          votedForAlias === "" &&
          isSelfVoteBallot(votePart, voterAlias, knownAliases)
        ) {
          ballot.selfVote = true;
        }
        // 二阶预测（R1.2）：仅非空时写键（JSONL additive，design §4.4）。
        const predictions = collectPredictions(
          predictionPart,
          voterAlias,
          knownAliases
        );
        if (predictions.length > 0) {
          ballot.predictions = predictions;
        }
        return ballot;
      }),
    };
    // SP 二阶聚合（R1.4/D2）：多数赢家恒有定义（投票明细三态），SP 赢家是
    // 附加信号——唯一 argmax 才写键；预测不足/并列/无有效票 → 不写键。
    const spWinner = surprisinglyPopular(
      result.roundVotes.ballots.map((b) => b.votedForAlias),
      result.roundVotes.ballots.map((b) => b.predictions ?? []),
      knownAliases
    );
    if (spWinner) {
      result.spWinner = spWinner;
    }
  }
  // 裁决者信息（R3）：报告综合段标注用；无效时标注 fallback。
  if (opts.judge) {
    result.judgeInfo = {
      cardId: opts.judge.card.id,
      cardName: opts.judge.card.name,
    };
  } else if (opts.judgeFallbackInfo) {
    result.judgeInfo = { ...opts.judgeFallbackInfo, fallback: true };
  }
  return result;
}
