/**
 * list_cards MCP tool — discover configured card ids before consulting.
 *
 * Registered via McpServer.registerTool with a zod raw-shape inputSchema.
 * Outputs each card together with the resolved expert name/icon and model
 * name/provider, plus provider-key readiness (never exposes the systemPrompt).
 */
import { z } from "zod";
import type { AppConfig, CardConfig } from "../types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  hasProviderKey,
  missingKeyReason,
  resolveCard,
} from "./select-cards.js";

/** Zod raw shape for list_cards arguments (passed as inputSchema). */
export const listCardsSchema = {
  includeDisabled: z
    .boolean()
    .optional()
    .describe("是否包含未启用的角色卡;默认只返回 enabled 的角色卡"),
};

export type ListCardsArgs = {
  includeDisabled?: boolean;
};

export interface CardSummary {
  id: string;
  name: string;
  expertName: string;
  expertIcon: string;
  provider: string;
  model: string;
  temperature: number;
  enabled: boolean;
  ready: boolean;
  /** 未就绪原因与指引（已就绪时缺省；绝不包含密钥任何形态）。 */
  missingReason?: string;
}

/** Project a card config into the discovery payload (resolved names, no systemPrompt). */
export function summarizeCard(
  card: CardConfig,
  config: AppConfig
): CardSummary {
  const resolved = resolveCard(card, config);
  const providerName = resolved?.providerName ?? "";
  const ready = hasProviderKey(config, providerName);
  return {
    id: card.id,
    name: card.name,
    expertName: resolved?.expert.name ?? `<missing expert "${card.expertId}">`,
    expertIcon: resolved?.expert.icon ?? "❓",
    provider: providerName,
    model: resolved?.modelId ?? `<missing model "${card.modelId}">`,
    temperature: resolved?.expert.temperature ?? 0,
    enabled: card.enabled !== false,
    ready,
    ...(ready ? {} : { missingReason: missingKeyReason(config, providerName) }),
  };
}

/** Select cards for discovery. Default: enabled only, preserve config order. */
export function selectListedCards(
  config: AppConfig,
  includeDisabled = false
): CardConfig[] {
  if (includeDisabled) return [...config.cards];
  return config.cards.filter((c) => c.enabled !== false);
}

/**
 * The handler invoked by the MCP server when list_cards is called.
 */
export async function handleListCards(
  args: ListCardsArgs,
  config: AppConfig
): Promise<CallToolResult> {
  const includeDisabled = args.includeDisabled ?? false;
  const selected = selectListedCards(config, includeDisabled);
  const cards = selected.map((card) => summarizeCard(card, config));
  const enabledCount = config.cards.filter((c) => c.enabled !== false).length;
  const readyCount = cards.filter((c) => c.ready).length;

  const payload = {
    cards,
    count: cards.length,
    readyCount,
    enabledCount,
    totalCount: config.cards.length,
  };
  const lines = cards.map((c) => {
    const disabled = c.enabled ? "" : " · disabled";
    const missing = c.ready ? "" : ` · ${c.missingReason}`;
    return `- ${c.expertIcon} **${c.name}** (\`${c.id}\`) · ${c.provider}/${c.model} · temperature=${c.temperature}${disabled}${missing}`;
  });
  const header = includeDisabled
    ? `当前共 ${payload.totalCount} 张角色卡（含未启用）：`
    : `当前启用 ${payload.enabledCount} 张角色卡：`;
  const hint =
    "调用 consult_experts / brainstorm 时，将 id 填入 cards 参数即可。未配置 API Key 的卡仍可显式指定，但该项会失败；在管理后台「渠道」页配置密钥后即时生效，无需重启。";

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