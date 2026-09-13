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
  ThinkingLevel,
} from "../types.js";
import { selectCardsBySignals } from "./signal-routing.js";

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
  /** 思考强度（来自 model.thinkingLevel，undefined = 不传额外参数） */
  thinkingLevel?: ThinkingLevel;
}

/** ResolvedCard → 会话记录 meta 里的卡片快照（records 模块形状的最小子集）。 */
export function toCardRefs(targets: ResolvedCard[]): Array<{
  cardId: string;
  cardName: string;
  expertId: string;
  expertName: string;
  modelId: string;
  provider: string;
}> {
  return targets.map((t) => ({
    cardId: t.card.id,
    cardName: t.card.name,
    expertId: t.expert.id,
    expertName: t.expert.name,
    modelId: t.modelId,
    provider: t.providerName,
  }));
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
  /**
   * 信号路由（P2-A）附加说明：命中信号组 / 回退默认 / 显式卡优先忽略 auto。
   * 仅 select:"auto" 路径产生；默认路径与显式路径（不带 auto）保持 undefined，
   * 报告输出与现状逐字节一致。
   */
  autoNotes?: string[];
}

export interface SelectCardsOptions {
  defaultLimit: number;
  /** 选卡策略：auto = 按问题文本信号路由自动选卡（缺省/undefined 走默认卡逻辑） */
  select?: "auto";
  /** 信号匹配用的文本（consult=question，brainstorm=topic）；select:"auto" 时必传 */
  text?: string;
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
    thinkingLevel: model.thinkingLevel,
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
 * 信号路径（P2-A，select:"auto" 专用）：按 SIGNAL_KEYWORDS 命中信号组 →
 * 取「signals 有交集或声明 general」的 enabled 卡 → key 过滤 → 文件序截断。
 * 零命中（无信号组命中或无候选卡）→ 回退默认卡逻辑，notes 注明。
 */
function selectBySignals(
  config: AppConfig,
  text: string,
  defaultLimit: number
): CardSelection {
  const autoNotes: string[] = [];
  const match = selectCardsBySignals(config, text);
  if (!match) {
    autoNotes.push("信号未命中，已回退默认卡");
    return {
      ...selectDefault(config, enabledCards(config), defaultLimit),
      autoNotes,
    };
  }

  const withKey: ResolvedCard[] = [];
  const skippedMissingKey: SkippedMissingKey[] = [];
  for (const card of match.cards) {
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
  const groups = match.matched.join("、");
  autoNotes.push(
    groups
      ? `信号路由命中: ${groups}（候选 ${match.cards.length} 张卡）`
      : `信号路由: 命中 general 兜底卡（候选 ${match.cards.length} 张卡）`
  );
  return {
    selected: withKey.slice(0, limit),
    ignored: [],
    skippedMissingKey,
    truncated: withKey.slice(limit),
    autoNotes,
  };
}

/**
 * Resolve which cards a tool should call.
 * - 显式非空 ids → 显式路径（select:"auto" 被忽略并在 notes 注明，保持宽容）；
 * - 空/省略 ids + select:"auto" → 信号路由路径（零命中回退默认卡）；
 * - 其余 → 默认路径（与历史行为完全一致，autoNotes 缺省）。
 */
export function selectCardsForTool(
  config: AppConfig,
  ids: string[] | undefined,
  options: SelectCardsOptions
): CardSelection {
  const enabled = enabledCards(config);
  if (ids && ids.length > 0) {
    const selection = selectExplicit(config, ids, enabled);
    if (options.select === "auto") {
      return {
        ...selection,
        autoNotes: ["已显式指定角色卡列表，忽略 select:auto"],
      };
    }
    return selection;
  }
  if (options.select === "auto") {
    return selectBySignals(
      config,
      options.text ?? "",
      options.defaultLimit
    );
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
  // 信号路由注记（P2-A）排在最前；默认/显式路径为 undefined，不影响现状输出。
  if (selection.autoNotes && selection.autoNotes.length > 0) {
    for (const note of selection.autoNotes) {
      parts.push(`> ${note}`);
    }
  }
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