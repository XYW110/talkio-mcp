/**
 * Pure string builders for MCP tool output.
 *
 * These functions never perform IO or call the LLM — they only format data
 * into Markdown, making them trivially unit-testable.
 */
import type { ConsultationItem } from "../orchestrator/parallel.js";
import type {
  DialogueTurn,
  DialogueAlias,
  RoundVotes,
  VoteBallot,
} from "../orchestrator/dialogue.js";

/** Build the Markdown consultation report (design §3.1). */
export function formatConsultReport(
  question: string,
  context: string | undefined,
  items: ConsultationItem[],
): string {
  const lines: string[] = [];
  lines.push("## 专家团咨询报告");
  lines.push("");
  lines.push(`**问题:** ${question}`);
  if (context && context.trim().length > 0) {
    lines.push("");
    lines.push("**背景信息:**");
    lines.push("");
    lines.push(context.trim());
  }
  lines.push("");

  const okItems = items.filter((it) => it.ok);
  const errItems = items.filter((it) => !it.ok);

// Successful cards first, grouped under their card name headers.
  for (const item of okItems) {
    const { target } = item;
    lines.push(`### ${target.expert.icon} ${target.card.name} (${target.modelId})`);
    lines.push("");
    lines.push(item.content ?? "");
    lines.push("");
  }

  // Failed experts collected into a single warning section.
  if (errItems.length > 0) {
    lines.push(formatErrorSection(errItems));
    lines.push("");
  }

  if (items.length === 0) {
    lines.push("> 没有可用的专家来回答该问题。");
    lines.push("");
  }

  return lines.join("\n");
}

/** Build the failure section listing experts that errored. */
export function formatErrorSection(items: ConsultationItem[]): string {
  const lines: string[] = [];
  lines.push("### ⚠️ 咨询失败的专家");
  lines.push("");
  for (const item of items) {
    lines.push(`- **${item.target.expert.icon} ${item.target.card.name}**: ${item.error ?? "未知错误"}`);
  }
  return lines.join("\n");
}

/**
 * Build the Markdown transcript for the brainstorm tool (design §3.2).
 * Turns are grouped by round with a round header and per-expert entries.
 */
export function formatTranscript(
  turns: DialogueTurn[],
  /** 主持人插话（groupchat-strengths P2）：按 afterRound 渲染在对应轮之后；缺省零输出。 */
  interjections?: Array<{ afterRound: number; message: string }>
): string {
  if (turns.length === 0) return "";
  const lines: string[] = [];
  // Group turns by round while preserving order.
  const rounds = new Map<number, DialogueTurn[]>();
  for (const turn of turns) {
    const arr = rounds.get(turn.round) ?? [];
    arr.push(turn);
    rounds.set(turn.round, arr);
  }
  const interjByAfter = new Map(
    (interjections ?? [])
      .filter((i) => i.message.trim() !== "")
      .map((i) => [i.afterRound, i.message.trim()])
  );
  for (const round of rounds.keys()) {
    const roundTurns = rounds.get(round)!;
    lines.push(`### 第 ${round} 轮`);
    lines.push("");
    for (const turn of roundTurns) {
      lines.push(`**${turn.icon} ${turn.expertName}:**`);
      lines.push("");
      lines.push(turn.content);
      lines.push("");
    }
    // 主持人插话（P2）：镜像 prompt 注入位置——afterRound 轮结束后、下一轮
    // 发言之前；与 prompt 使用同一原文（透明度：读者看到的就是专家看到的）。
    const interj = interjByAfter.get(round);
    if (interj !== undefined) {
      lines.push(`> 🎙️ **主持人（第 ${round} 轮后插话）**：${interj}`);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

/** formatBrainstormReport 的可选扩展段（R1 互评投票 / R3 裁决者 / R6 claim-0）。 */
export interface BrainstormReportExtras {
  /**
   * 发起方初步判断（claim-0，R6）：提供时在实录之前渲染「发起方初步判断」
   * 小节，标注其未参与第 1 轮盲答、也不是投票候选人；缺省时完全不输出。
   */
  initiatorContext?: string;
  /** 投票轮产物（R1）；为空时省略投票段。 */
  votes?: DialogueTurn[];
  /** 匿名代号映射（R2）：投票逐条匿名展示 + 末尾代号↔专家对照表。 */
  aliases?: DialogueAlias[];
  /** 结构化投票结果（P1-A）：渲染「投票明细」小节；为空时省略。 */
  roundVotes?: RoundVotes;
  /** 裁决者标注（R3）：综合段标题注明裁决卡或回退。 */
  judgeInfo?: { cardId: string; cardName: string; fallback?: boolean };
  /** P3-A runs：多轮运行总数（>1 时报告头主题行追加 (runs=N)）。 */
  runsTotal?: number;
  /** 魔鬼代言人轮换（P3-R1）：debate round≥2 每轮一位；为空时省略小节（零字节）。 */
  devilsAdvocates?: Array<{ round: number; expertName: string }>;
  /**
   * 证据包（R2.4）：提供（且含非空白项）时在实录前渲染「### 证据库」小节、
   * 实录后渲染「### 证据引用统计」小节；缺省时两小节零输出。
   */
  evidence?: string[];
  /**
   * 主持人插话（groupchat-strengths P2）：传入 formatTranscript 在对应轮
   * 之后渲染 🎙️ 块（与 prompt 注入原文一致）；缺省零输出。
   */
  interjections?: Array<{ afterRound: number; message: string }>;
  /** SP 赢家（R1.5）：仅计算成功时提供；与 roundVotes 一同渲染「### 聚合结果」。 */
  spWinner?: string;
}

/** 证据引用统计的单条计数（R2.4）：id = 证据编号（1 起），count = 引用次数。 */
export interface EvidenceRefCount {
  id: number;
  count: number;
}

/** 单专家的 [En] 引用扫描结果（R2.4）：零引用专家 cited 为空数组。 */
export interface ExpertEvidenceRefs {
  expertName: string;
  cited: EvidenceRefCount[];
}

/**
 * 扫描实录 turns 中的 [En] 证据引用（R2.4/D4：客观正则扫描，不做语义级抽取）。
 * 正则 /\[E(\d+)\]/g 逐 turn 匹配，编号 > evidenceCount 的越界引用忽略；
 * 同一专家按编号去重计数、按首次出现顺序排列；专家按 turns 首现顺序输出。
 * runs>1 由调用方传入 first run 的 turns（与 votes 同策略）。
 */
export function collectEvidenceRefs(
  turns: DialogueTurn[],
  evidenceCount: number
): ExpertEvidenceRefs[] {
  const byExpert = new Map<string, EvidenceRefCount[]>();
  for (const turn of turns) {
    const cited = byExpert.get(turn.expertName) ?? [];
    for (const m of turn.content.matchAll(/\[E(\d+)\]/g)) {
      const id = Number(m[1]);
      if (!Number.isInteger(id) || id < 1 || id > evidenceCount) continue;
      const existing = cited.find((c) => c.id === id);
      if (existing) existing.count += 1;
      else cited.push({ id, count: 1 });
    }
    byExpert.set(turn.expertName, cited);
  }
  return [...byExpert.entries()].map(([expertName, cited]) => ({
    expertName,
    cited,
  }));
}

/**
 * 多数赢家（R1.5）：有效票（votedForAlias 非空）的唯一众数；无有效票或票数
 * 并列（无单一多数）返回 null。纯函数，供「### 聚合结果」三态渲染。
 */
function resolveMajorityWinner(ballots: VoteBallot[]): string | null {
  const counts = new Map<string, number>();
  for (const b of ballots) {
    if (!b.votedForAlias) continue;
    counts.set(b.votedForAlias, (counts.get(b.votedForAlias) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  let tie = false;
  for (const [alias, count] of counts) {
    if (count > bestCount) {
      best = alias;
      bestCount = count;
      tie = false;
    } else if (count === bestCount) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * Build the full brainstorm output: header + transcript + optional votes +
 * optional summary.
 */
export function formatBrainstormReport(
  topic: string,
  mode: "debate" | "relay",
  rounds: number,
  turns: DialogueTurn[],
  summary?: string,
  extras?: BrainstormReportExtras,
): string {
  const lines: string[] = [];
  lines.push("## 专家头脑风暴实录");
  lines.push("");
  lines.push(
    `**主题:** ${topic}${extras?.runsTotal ? `（runs=${extras.runsTotal}）` : ""}`
  );
  lines.push(`**模式:** ${mode === "debate" ? "辩论" : "接龙"}`);
  lines.push(`**轮数:** ${rounds}`);
  lines.push("");
  // 证据库小节（R2.4）：提供 evidence 时在实录之前展示编号条目（透明度），
  // 编号语义与 prompt 注入块一致（跳过空白项、按顺序编号）；缺省/全空白
  // → 零字节输出。位置镜像注入顺序：证据库（事实基底）→ claim-0（可推翻主张）。
  const evidenceItems = (extras?.evidence ?? [])
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (evidenceItems.length > 0) {
    lines.push("### 证据库");
    lines.push("");
    evidenceItems.forEach((item, i) => {
      lines.push(`[E${i + 1}] ${item}`);
      lines.push("");
    });
  }
  // claim-0 小节（R6）：仅 initiatorContext 存在时输出；标注其未参与盲答
  // 与投票。缺省时完全不进入输出流（上方内容逐字节不变）。
  const initiator = extras?.initiatorContext;
  if (initiator && initiator.trim().length > 0) {
    lines.push("## 发起方初步判断（claim-0）");
    lines.push("");
    lines.push(`> ${initiator.trim()}`);
    lines.push("");
    lines.push(
      "（claim-0 未参与第 1 轮盲答，也不是投票候选人；以上内容仅供检验。）"
    );
    lines.push("");
  }
  lines.push(formatTranscript(turns, extras?.interjections));
  lines.push("");
  // 证据引用统计（R2.4）：实录之后、魔鬼代言人轮换之前；per-expert [En]
  // 客观正则扫描。无 evidence、或证据提供了但零引用 → 零字节输出。
  if (evidenceItems.length > 0) {
    const refStats = collectEvidenceRefs(turns, evidenceItems.length);
    const totalDistinctRefs = refStats.reduce(
      (acc, r) => acc + r.cited.length,
      0
    );
    if (totalDistinctRefs > 0) {
      lines.push("### 证据引用统计");
      lines.push("");
      for (const stat of refStats) {
        const cited = stat.cited.length
          ? stat.cited.map((c) => `[E${c.id}]×${c.count}`).join("、")
          : "（未引用证据）";
        lines.push(`- ${stat.expertName}：${cited}`);
      }
      lines.push("");
    }
  }
  // 魔鬼代言人轮换（P3-R1）：位于实录之后、「互评投票」之前，按轮列出该轮
  // 指定的专家实名；缺省（relay / rounds<2 / 旧路径）零字节输出。
  const devils = extras?.devilsAdvocates ?? [];
  if (devils.length > 0) {
    lines.push("### 魔鬼代言人轮换");
    lines.push("");
    for (const d of devils) {
      lines.push(`- 第 ${d.round} 轮：${d.expertName}`);
    }
    lines.push("");
  }
  // 互评投票（R1）：匿名代号逐条呈现，末尾还原代号↔专家对照表。
  const votes = extras?.votes ?? [];
  if (votes.length > 0) {
    const aliasById = new Map(
      (extras?.aliases ?? []).map((a) => [a.expertId, a.alias]),
    );
    lines.push("### 互评投票");
    lines.push("");
    for (const v of votes) {
      lines.push(
        `- **${aliasById.get(v.expertId) ?? v.expertName}**：${v.content.trim()}`,
      );
    }
    lines.push("");
    const mapping = (extras?.aliases ?? [])
      .map((a) => `${a.alias}=${a.expertName}`)
      .join("、");
    if (mapping) {
      lines.push(`> 代号对照：${mapping}`);
      lines.push("");
    }
    // 投票明细（P1-A）：在投票汇总小节后新增结构化逐票一行
    // `专家A → 专家B：理由摘录`。P3-R3 三态：正常（字节不变）/ 自投（显式
    // 无效票标记）/ 其余未识别（现状占位符）。
    const roundVotes = extras?.roundVotes;
    if (roundVotes && roundVotes.ballots.length > 0) {
      lines.push("### 投票明细");
      lines.push("");
      for (const b of roundVotes.ballots) {
        if (b.votedForAlias) {
          lines.push(`- ${b.voterAlias} → ${b.votedForAlias}：${b.reason}`);
        } else if (b.selfVote === true) {
          lines.push(`- **${b.voterAlias}** → ⚠️ 自投（无效票）：${b.reason}`);
        } else {
          lines.push(`- ${b.voterAlias} → （未识别代号）：${b.reason}`);
        }
      }
      lines.push("");
    }
  }
  // 聚合结果（R1.5/D2）：投票明细之后、讨论总结之前，双轨三态呈现——
  // 多数赢家（唯一众数）恒有定义，SP 赢家是附加信号；多数与 SP 的分歧本身
  // 即趋同警报。无票（roundVotes 缺省/空）→ 零字节输出。
  const aggVotes = extras?.roundVotes;
  if (aggVotes && aggVotes.ballots.length > 0) {
    const majority = resolveMajorityWinner(aggVotes.ballots);
    const sp = extras?.spWinner;
    lines.push("### 聚合结果");
    lines.push("");
    if (majority && sp) {
      lines.push(
        majority === sp
          ? `- 多数赢家与 SP 赢家一致：${sp}（聚合信号稳健）`
          : `- 多数赢家：${majority}；SP 赢家：${sp} —— ⚠️ 多数可能被预期锁定（趋同警报），请阅读双方论据后再裁决`
      );
    } else if (majority) {
      lines.push(`- 多数赢家：${majority}（预测不足，未计算 SP）`);
    } else if (sp) {
      lines.push(
        `- 多数赢家：（票数并列）；SP 赢家：${sp} —— ⚠️ 多数可能被预期锁定（趋同警报），请阅读双方论据后再裁决`
      );
    } else {
      lines.push("- 多数赢家：（票数并列，预测不足，未计算 SP）");
    }
    lines.push("");
  }
  if (summary && summary.trim().length > 0) {
    // 裁决者标注（R3）：fallback 时在综合段标题注明回退。
    const ji = extras?.judgeInfo;
    const heading = ji
      ? ji.fallback
        ? "### 讨论总结（裁决者无效，回退第一张卡）"
        : `### 讨论总结（裁决者：${ji.cardName}）`
      : "### 讨论总结";
    lines.push(heading);
    lines.push("");
    lines.push(summary.trim());
    lines.push("");
  }
  return lines.join("\n");
}

/** formatRunsSection 的单次运行输入（P3-A）。 */
export interface RunSectionEntry {
  run: number;
  summary?: string;
}

/** 「多轮稳定性」小节的每运行一行摘要截断长度。 */
const RUN_LINE_TRUNCATE_CHARS = 80;

/**
 * 「多轮稳定性」小节（P3-A runs，仅 N>1 时由调用方拼入报告）：
 * 每运行一行摘要 + 合并结论全文；合并失败时回退为逐运行结论并列展示。
 */
export function formatRunsSection(
  runsTotal: number,
  runs: RunSectionEntry[],
  merged?: string,
  mergeFailed?: boolean
): string {
  const lines: string[] = [];
  lines.push(`### 多轮稳定性（runs=${runsTotal}）`);
  lines.push("");
  for (const r of runs) {
    const firstLine = (r.summary ?? "（无总结）").trim().split("\n", 1)[0] ?? "";
    const truncated =
      firstLine.length > RUN_LINE_TRUNCATE_CHARS
        ? firstLine.slice(0, RUN_LINE_TRUNCATE_CHARS) + "…"
        : firstLine;
    lines.push(`- Run ${r.run}：${truncated}`);
  }
  lines.push("");
  if (merged !== undefined && merged.trim().length > 0) {
    lines.push(merged.trim());
  } else {
    lines.push(
      mergeFailed
        ? "> ⚠️ 合并调用失败，以下为各次运行结论并列展示："
        : "> ⚠️ 无可用结论可合并，以下为各次运行结论并列展示："
    );
    lines.push("");
    for (const r of runs) {
      if (r.summary !== undefined && r.summary.trim().length > 0) {
        lines.push(`**Run ${r.run}**：`);
        lines.push("");
        lines.push(r.summary.trim());
        lines.push("");
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}
