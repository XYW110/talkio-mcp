/**
 * list_experts MCP tool — discover configured expert ids before consulting.
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * Does not call any AI provider; it only reads AppConfig and env key presence.
 */
import { z } from "zod";
import type { AppConfig, ExpertConfig } from "../types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hasProviderKey, missingKeyEnv } from "./select-experts.js";

/** Zod raw shape for list_experts arguments (passed as inputSchema). */
export const listExpertsSchema = {
  includeDisabled: z
    .boolean()
    .optional()
    .describe("是否包含未启用的专家;默认只返回 enabled 的专家"),
};

export type ListExpertsArgs = {
  includeDisabled?: boolean;
};

export interface ExpertSummary {
  id: string;
  name: string;
  icon: string;
  provider: string;
  model: string;
  temperature: number;
  enabled: boolean;
  ready: boolean;
  missingEnv?: string;
}

/** Project an expert config into the discovery payload (no systemPrompt). */
export function summarizeExpert(
  expert: ExpertConfig,
  config: AppConfig
): ExpertSummary {
  const ready = hasProviderKey(config, expert);
  return {
    id: expert.id,
    name: expert.name,
    icon: expert.icon,
    provider: expert.provider,
    model: expert.model,
    temperature: expert.temperature,
    enabled: expert.enabled !== false,
    ready,
    ...(ready ? {} : { missingEnv: missingKeyEnv(config, expert) }),
  };
}

/** Select experts for discovery. Default: enabled only, preserve config order. */
export function selectListedExperts(
  config: AppConfig,
  includeDisabled = false
): ExpertConfig[] {
  if (includeDisabled) return [...config.experts];
  return config.experts.filter((e) => e.enabled !== false);
}

/**
 * The handler invoked by the MCP server when list_experts is called.
 */
export async function handleListExperts(
  args: ListExpertsArgs,
  config: AppConfig
): Promise<CallToolResult> {
  const includeDisabled = args.includeDisabled ?? false;
  const selected = selectListedExperts(config, includeDisabled);
  const experts = selected.map((expert) => summarizeExpert(expert, config));
  const enabledCount = config.experts.filter((e) => e.enabled !== false).length;
  const readyCount = experts.filter((e) => e.ready).length;

  const payload = {
    experts,
    count: experts.length,
    readyCount,
    enabledCount,
    totalCount: config.experts.length,
  };
  const lines = experts.map((e) => {
    const disabled = e.enabled ? "" : " · disabled";
    const missing = e.ready ? "" : ` · 缺 ${e.missingEnv}`;
    return `- ${e.icon} **${e.name}** (\`${e.id}\`) · ${e.provider}/${e.model} · temperature=${e.temperature}${disabled}${missing}`;
  });
  const header = includeDisabled
    ? `当前共 ${payload.totalCount} 位专家（含未启用）：`
    : `当前启用 ${payload.enabledCount} 位专家：`;
  const hint =
    "调用 consult_experts / brainstorm 时，将 id 填入 experts 参数即可。缺 key 的专家仍可显式指定，但该项会失败。";

  return {
    content: [
      {
        type: "text",
        text: `${header}\n${
          lines.join("\n") || "(无)"
        }\n\n${hint}\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  };
}
