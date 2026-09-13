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
  /** 裁决者信息（R3）：报告综合段标注用；未提供 judgeCard 时缺省。 */
  judgeInfo?: { cardId: string; cardName: string; fallback?: boolean };
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
}

/** 每轮投票结果（P1-A/D2：投票轮发生在全部内容轮后，round = 内容轮数）。 */
export interface RoundVotes {
  round: number;
  ballots: VoteBallot[];
}

// --- Prompt templates (exported for unit testing) -----------------------

/** Seed instruction for round 1 (every expert answers the topic fresh). */
export const SEED_INSTRUCTION =
  "请就以下主题给出你的专业见解,清晰阐述你的核心观点与理由。";

/** Debate instruction injected from round 2 onward. */
export const DEBATE_INSTRUCTION =
  "以下是其他专家在上一轮的发言。请针对上述观点,提出你的质疑、补充或反驳,并完善你自己的立场。";

/** Relay instruction injected for each sequential speaker. */
export const RELAY_INSTRUCTION =
  "以下是此前各位专家的发言。请在最新一位专家的观点基础上深化和发展,补充新的角度或论据,避免简单重复。";

/** System prompt for the summarizer call. */
export const SUMMARIZER_SYSTEM =
  "你是一位中立的讨论主持人。请基于以下完整的讨论实录,客观总结各方达成的共识、仍存在的分歧,以及可执行的下一步建议。用 Markdown 输出。";

/** 投票轮指令（R1）：注入在匿名实录之后，要求每位专家给出互评投票。
 * 禁自投 + 限长：真实验证发现模型会投自己且票文过长（vote-prompt-fix），
 * 匿名制下自投等于无效票，票文过长会让投票段退化成第三轮发言。 */
export const VOTE_INSTRUCTION =
  "以上是本次讨论的完整实录（已匿名，标注【你的发言】的行是你本人的观点）。请投票：选出你最认同的一位其他专家（代号），不得投给你自己。150 字以内，直接给出专家代号与核心理由，并一句话说明你是否修正了自己的立场；不要展开论述，不要使用标题。";

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

/**
 * 从票文中解析被投者代号（P1-A）：按出现顺序找到第一个「不是投票者本人」的
 * 已知别名。匿名实录中投票者自己的行带 own 标注且排在最前，真实票文里
 * 提及的第一个他人代号即被投者；识别失败返回空串（调用方按未识别展示）。
 */
export function parseVotedForAlias(
  content: string,
  voterAlias: string,
  knownAliases: string[]
): string {
  const known = new Set(knownAliases);
  const matches = content.match(/专家[A-Z]/g) ?? [];
  for (const m of matches) {
    if (known.has(m) && m !== voterAlias) return m;
  }
  return "";
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
  // Semantic compression state (task 08-28-semantic-truncation, design §4/§6).
  // summary: incremental summary; empty summaryText = not yet enabled.
  // summarizerFailed: set after a failed compressor call → hard truncation for
  // the rest of this session (no retry, no oscillation).
  let ctxSummary: SummaryState = emptySummaryState();
  let summarizerFailed = false; // session-level: never retry after first fail

  // 匿名代号映射（R2）：按 targets 顺序分配 专家A/B/…；debate 轮间注入与投票轮共用。
  // P3-A runs：aliasRotation>0 时整体轮换映射，使多次运行之间映射不同（确定性）。
  const aliases = rotateAliases(buildAliases(targets), opts.aliasRotation ?? 0);

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
      const results = await Promise.allSettled(
        targets.map((target) =>
          askExpert(target, `${opts.topic}\n\n${SEED_INSTRUCTION}`, config)
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
      const userContents = targets.map(
        (target) =>
          `${opts.topic}\n\n${DEBATE_INSTRUCTION}\n\n上一轮发言:\n${render(target.expert.id)}`
      );
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
        const userContent =
          transcript.length > 0
            ? `${opts.topic}\n\n${RELAY_INSTRUCTION}\n\n此前发言:\n${transcript}`
            : `${opts.topic}\n\n${SEED_INSTRUCTION}`;
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
        return {
          voterCardId: cardIdByExpertId.get(v.expertId) ?? v.expertId,
          voterAlias,
          votedForAlias: parseVotedForAlias(
            v.content,
            voterAlias,
            knownAliases
          ),
          reason: truncateBallotReason(v.content),
        };
      }),
    };
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
