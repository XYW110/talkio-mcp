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
export function formatTranscript(turns: DialogueTurn[]): string {
  if (turns.length === 0) return "";
  const lines: string[] = [];
  // Group turns by round while preserving order.
  const rounds = new Map<number, DialogueTurn[]>();
  for (const turn of turns) {
    const arr = rounds.get(turn.round) ?? [];
    arr.push(turn);
    rounds.set(turn.round, arr);
  }
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
  }
  return lines.join("\n").trimEnd();
}

/** formatBrainstormReport 的可选扩展段（R1 互评投票 / R3 裁决者）。 */
export interface BrainstormReportExtras {
  /** 投票轮产物；为空时省略投票段。 */
  votes?: DialogueTurn[];
  /** 代号映射：投票逐条匿名展示 + 末尾代号↔专家对照表。 */
  aliases?: DialogueAlias[];
  /** 结构化投票结果（P1-A）：渲染「投票明细」小节；为空时省略。 */
  roundVotes?: RoundVotes;
  /** 裁决者标注：综合段标题注明裁决卡或回退。 */
  judgeInfo?: { cardId: string; cardName: string; fallback?: boolean };
  /** P3-A runs：多轮运行总数（>1 时报告头主题行追加 (runs=N)）。 */
  runsTotal?: number;
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
  lines.push(formatTranscript(turns));
  lines.push("");
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
    // `专家A → 专家B：理由摘录`；被投代号未识别时以占位符呈现。
    const roundVotes = extras?.roundVotes;
    if (roundVotes && roundVotes.ballots.length > 0) {
      lines.push("### 投票明细");
      lines.push("");
      for (const b of roundVotes.ballots) {
        lines.push(
          `- ${b.voterAlias} → ${b.votedForAlias || "（未识别代号）"}：${b.reason}`,
        );
      }
      lines.push("");
    }
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
