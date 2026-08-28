/**
 * Pure string builders for MCP tool output.
 *
 * These functions never perform IO or call the LLM — they only format data
 * into Markdown, making them trivially unit-testable.
 */
import type { ConsultationItem } from "../orchestrator/parallel.js";
import type { DialogueTurn } from "../orchestrator/dialogue.js";

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

/**
 * Build the full brainstorm output: header + transcript + optional summary.
 */
export function formatBrainstormReport(
  topic: string,
  mode: "debate" | "relay",
  rounds: number,
  turns: DialogueTurn[],
  summary?: string,
): string {
  const lines: string[] = [];
  lines.push("## 专家头脑风暴实录");
  lines.push("");
  lines.push(`**主题:** ${topic}`);
  lines.push(`**模式:** ${mode === "debate" ? "辩论" : "接龙"}`);
  lines.push(`**轮数:** ${rounds}`);
  lines.push("");
  lines.push(formatTranscript(turns));
  lines.push("");
  if (summary && summary.trim().length > 0) {
    lines.push("### 讨论总结");
    lines.push("");
    lines.push(summary.trim());
    lines.push("");
  }
  return lines.join("\n");
}
