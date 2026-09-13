/**
 * Reasoning strategy injection (P1-B, task 09-13-council-enhancement).
 *
 * Optional per-expert strategy instructions appended to the expert's system
 * prompt. Single source of truth: every injection point must go through
 * applyReasoningStrategy — no ad-hoc string concatenation elsewhere.
 *
 * Hard red line: for an absent or "default" strategy the function returns the
 * ORIGINAL string reference, so the default path is byte-identical to the
 * pre-change behavior (guarded by a snapshot/identity test).
 */
import type { ExpertConfig } from "../types.js";

/** 推理策略取值（与 ExpertConfig.reasoningStrategy 同构）。 */
export type ReasoningStrategy = NonNullable<ExpertConfig["reasoningStrategy"]>;

/**
 * 策略指令常量表（集中、可测）。default 为空串：缺省路径不追加任何内容。
 * 注入格式固定为 `\n\n${instruction}` 追加在 system prompt 末尾。
 */
export const REASONING_STRATEGY_INSTRUCTIONS: Record<ReasoningStrategy, string> = {
  default: "",
  systematic:
    "请采用系统化枚举的推理方式：先列出问题的所有关键维度，再逐一给出判断与依据。",
  adversarial:
    "请采用对抗式视角：主动寻找当前主流观点的漏洞、反例与被忽略的风险，并给出你的反驳。",
  backward:
    "请采用反向推理：从问题的理想结论/目标状态倒推，检验各方案能否支撑该结论。",
};

/**
 * Apply the expert's reasoning strategy to a system prompt.
 *
 * - strategy 缺省 / "default" / 未知值 → 返回原字符串引用（逐字节一致红线）。
 * - 其他合法策略 → 在末尾追加 `\n\n` + 指令文案。
 */
export function applyReasoningStrategy(
  systemPrompt: string,
  strategy?: string
): string {
  if (!strategy || strategy === "default") return systemPrompt;
  const instruction =
    REASONING_STRATEGY_INSTRUCTIONS[strategy as ReasoningStrategy];
  if (!instruction) return systemPrompt; // 未知策略值：容错，不注入
  return `${systemPrompt}\n\n${instruction}`;
}
