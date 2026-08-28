/**
 * Shared card selection for consult_experts / brainstorm.
 *
 * Default path: enabled cards ∩ (card's model provider has a key), slice to defaultLimit.
 * Explicit ids: enabled matches only — no key filter, no defaultLimit.
 * Never calls resolveProviderCredentials (missing keys throw).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isMockProviderEnabled } from "../providers/registry.js";
import type {
  AppConfig,
  CardConfig,
  ExpertConfig,
  ModelConfig,
} from "../types.js";

/** Default cap for unattended consult / brainstorm. */
export const DEFAULT_CARD_LIMIT = 3;

/** 卡解析后的调用目标：卡 + 专家 + 真实模型名。 */
export interface ResolvedCard {
  card: CardConfig;
  expert: ExpertConfig;
  /** 来自 model.providerId，resolveProvider 用它取 provider 表 */
  providerName: string;
  /** 真实模型名（传给 provider adapter），来自 model.modelId */
  modelId: string;
}

export interface SkippedMissingKey {
  card: CardConfig;
  apiKeyEnv: string;
}

export interface CardSelection {
  selected: ResolvedCard[];
  ignored: string[];
  skippedMissingKey: SkippedMissingKey[];
  truncated: ResolvedCard[];
}

export interface SelectCardsOptions {
  defaultLimit: number;
}

/** True when mock mode is on, or the provider's env var is non-empty. */
export function hasProviderKey(
  config: AppConfig,
  providerName: string
): boolean {
  if (isMockProviderEnabled()) return true;
  const provider = config.providers[providerName];
  if (!provider) return false;
  const apiKey = process.env[provider.apiKeyEnv];
  return Boolean(apiKey);
}

export function missingKeyEnv(
  config: AppConfig,
  providerName: string
): string {
  const provider = config.providers[providerName];
  return provider?.apiKeyEnv ?? `未配置 provider "${providerName}"`;
}

/** 通过 name 找到模型（不存在则 undefined）。 */
function findModel(config: AppConfig, modelId: string): ModelConfig | undefined {
  return config.models.find((m) => m.id === modelId);
}

/**
 * 解析「卡 → 调用目标」：按卡引用取专家与模型；缺引用返回 null。
 * 卡本身必须 enabled，且引用的专家/模型必须存在。
 */
export function resolveCard(
  card: CardConfig,
  config: AppConfig
): ResolvedCard | null {
  const expert = config.experts.find((e) => e.id === card.expertId);
  const model = findModel(config, card.modelId);
  if (!expert || !model) return null;
  return {
    card,
    expert,
    providerName: model.providerId,
    modelId: model.modelId,
  };
}

/** 仅取 enabled 卡（含默认 isDefault 优先级保持文件顺序）。 */
function enabledCards(config: AppConfig): CardConfig[] {
  return config.cards.filter((c) => c.enabled !== false);
}

function selectExplicit(
  config: AppConfig,
  ids: string[],
  enabled: CardConfig[]
): CardSelection {
  const byId = new Map(enabled.map((c) => [c.id, c]));
  const selected: ResolvedCard[] = [];
  const ignored: string[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) {
      const resolved = resolveCard(found, config);
      if (resolved) {
        selected.push(resolved);
        byId.delete(id);
        continue;
      }
    }
    ignored.push(id);
  }
  return {
    selected,
    ignored,
    skippedMissingKey: [],
    truncated: [],
  };
}

function selectDefault(
  config: AppConfig,
  enabled: CardConfig[],
  defaultLimit: number
): CardSelection {
  const withKey: ResolvedCard[] = [];
  const skippedMissingKey: SkippedMissingKey[] = [];
  for (const card of enabled) {
    const resolved = resolveCard(card, config);
    if (!resolved) continue;
    if (hasProviderKey(config, resolved.providerName)) {
      withKey.push(resolved);
    } else {
      skippedMissingKey.push({
        card,
        apiKeyEnv: missingKeyEnv(config, resolved.providerName),
      });
    }
  }
  const limit = Math.max(0, defaultLimit);
  return {
    selected: withKey.slice(0, limit),
    ignored: [],
    skippedMissingKey,
    truncated: withKey.slice(limit),
  };
}

/**
 * Resolve which cards a tool should call.
 * Empty / omitted ids → default path. Non-empty ids → explicit path.
 */
export function selectCardsForTool(
  config: AppConfig,
  ids: string[] | undefined,
  options: SelectCardsOptions
): CardSelection {
  const enabled = enabledCards(config);
  if (ids && ids.length > 0) {
    return selectExplicit(config, ids, enabled);
  }
  return selectDefault(config, enabled, options.defaultLimit);
}

/** MCP error payload for blank question / topic. */
export function blankInputError(paramName: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${paramName} 不能为空`,
      },
    ],
  };
}

/** Notes appended to the Markdown report. Empty string when nothing to say. */
export function formatSelectionNotes(
  selection: CardSelection,
  defaultLimit: number
): string {
  const parts: string[] = [];
  if (selection.skippedMissingKey.length > 0) {
    const items = selection.skippedMissingKey
      .map((s) => `${s.card.name}（缺 ${s.apiKeyEnv}）`)
      .join("、");
    parts.push(`> 已跳过 ${items}`);
  }
  if (selection.truncated.length > 0) {
    const names = selection.truncated.map((t) => t.card.name).join(", ");
    parts.push(`> 默认最多 ${defaultLimit} 张角色卡，未包含: ${names}`);
  }
  if (selection.ignored.length > 0) {
    parts.push(
      `> 注: 以下请求的角色卡 id 未找到或未启用,已忽略: ${selection.ignored.join(
        ", "
      )}`
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n")}\n` : "";
}

/** isError payload when selection produced nobody to call. */
export function noSelectedCardsResult(
  config: AppConfig,
  selection: CardSelection,
  requestedIds?: string[]
): CallToolResult {
  const validIds = config.cards
    .filter((c) => c.enabled !== false)
    .map((c) => c.id)
    .join(", ");

  if (requestedIds && requestedIds.length > 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `没有匹配到任何可用的角色卡。` +
            `\n请求的角色卡 id: ${requestedIds.join(", ")}` +
            `\n当前可用的角色卡 id: ${validIds || "(无)"}`,
        },
      ],
    };
  }

  const skipped =
    selection.skippedMissingKey.length > 0
      ? selection.skippedMissingKey
          .map((s) => `${s.card.name}（缺 ${s.apiKeyEnv}）`)
          .join("、")
      : "";
  const reason = skipped
    ? `已跳过 ${skipped}`
    : `当前可用的角色卡 id: ${validIds || "(无)"}`;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `没有可调用的角色卡。${reason}`,
      },
    ],
  };
}