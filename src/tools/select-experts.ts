/**
 * Shared expert selection for consult_experts / brainstorm.
 *
 * Default path: enabled ∩ has-key, then slice to defaultLimit.
 * Explicit ids: enabled matches only — no key filter, no defaultLimit.
 * Never calls resolveProviderCredentials (missing keys throw).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isMockProviderEnabled } from "../providers/registry.js";
import type { AppConfig, ExpertConfig } from "../types.js";

/** Default cap for unattended consult / brainstorm. */
export const DEFAULT_EXPERT_LIMIT = 3;

export interface SkippedMissingKey {
  expert: ExpertConfig;
  apiKeyEnv: string;
}

export interface ExpertSelection {
  selected: ExpertConfig[];
  ignored: string[];
  skippedMissingKey: SkippedMissingKey[];
  truncated: ExpertConfig[];
}

export interface SelectExpertsOptions {
  defaultLimit: number;
}

/** True when mock mode is on, or the expert's provider env var is non-empty. */
export function hasProviderKey(config: AppConfig, expert: ExpertConfig): boolean {
  if (isMockProviderEnabled()) return true;
  const provider = config.providers[expert.provider];
  if (!provider) return false;
  const apiKey = process.env[provider.apiKeyEnv];
  return Boolean(apiKey);
}

function missingKeyEnv(config: AppConfig, expert: ExpertConfig): string {
  const provider = config.providers[expert.provider];
  return provider?.apiKeyEnv ?? `未配置 provider "${expert.provider}"`;
}

function selectExplicit(
  enabled: ExpertConfig[],
  ids: string[],
): ExpertSelection {
  const byId = new Map(enabled.map((e) => [e.id, e]));
  const selected: ExpertConfig[] = [];
  const ignored: string[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) {
      selected.push(found);
      byId.delete(id);
    } else {
      ignored.push(id);
    }
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
  enabled: ExpertConfig[],
  defaultLimit: number,
): ExpertSelection {
  const withKey: ExpertConfig[] = [];
  const skippedMissingKey: SkippedMissingKey[] = [];
  for (const expert of enabled) {
    if (hasProviderKey(config, expert)) {
      withKey.push(expert);
    } else {
      skippedMissingKey.push({
        expert,
        apiKeyEnv: missingKeyEnv(config, expert),
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
 * Resolve which experts a tool should call.
 * Empty / omitted ids → default path. Non-empty ids → explicit path.
 */
export function selectExpertsForTool(
  config: AppConfig,
  ids: string[] | undefined,
  options: SelectExpertsOptions,
): ExpertSelection {
  const enabled = config.experts.filter((e) => e.enabled !== false);
  if (ids && ids.length > 0) {
    return selectExplicit(enabled, ids);
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
  selection: ExpertSelection,
  defaultLimit: number,
): string {
  const parts: string[] = [];
  if (selection.skippedMissingKey.length > 0) {
    const items = selection.skippedMissingKey
      .map((s) => `${s.expert.id}（缺 ${s.apiKeyEnv}）`)
      .join("、");
    parts.push(`> 已跳过 ${items}`);
  }
  if (selection.truncated.length > 0) {
    const ids = selection.truncated.map((e) => e.id).join(", ");
    parts.push(`> 默认最多 ${defaultLimit} 位专家，未包含: ${ids}`);
  }
  if (selection.ignored.length > 0) {
    parts.push(
      `> 注: 以下请求的专家 id 未找到或未启用,已忽略: ${selection.ignored.join(", ")}`,
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n")}\n` : "";
}

/** isError payload when selection produced nobody to call. */
export function noSelectedExpertsResult(
  config: AppConfig,
  selection: ExpertSelection,
  requestedIds?: string[],
): CallToolResult {
  const validIds = config.experts
    .filter((e) => e.enabled !== false)
    .map((e) => e.id)
    .join(", ");

  if (requestedIds && requestedIds.length > 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `没有匹配到任何可用的专家。` +
            `\n请求的专家 id: ${requestedIds.join(", ")}` +
            `\n当前可用的专家 id: ${validIds || "(无)"}`,
        },
      ],
    };
  }

  const skipped =
    selection.skippedMissingKey.length > 0
      ? selection.skippedMissingKey
          .map((s) => `${s.expert.id}（缺 ${s.apiKeyEnv}）`)
          .join("、")
      : "";
  const reason = skipped ? `已跳过 ${skipped}` : `当前可用的专家 id: ${validIds || "(无)"}`;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `没有可调用的专家。${reason}`,
      },
    ],
  };
}
