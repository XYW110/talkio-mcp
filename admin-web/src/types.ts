// Shared types mirroring the MCP server's experts.json shape (三段结构：experts / models / cards).

export interface ProviderConfig {
  type: "openai" | "anthropic" | "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string;
}

export type ProviderMap = Record<string, ProviderConfig>;

export interface Expert {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs?: number;
  enabled: boolean;
  builtin?: boolean;
  /** 可选推理策略（缺省/default 均为默认行为；清空 = 落盘时删除该字段） */
  reasoningStrategy?: "systematic" | "adversarial" | "backward" | "default";
}

export type ThinkingLevel = "high" | "medium" | "low" | "disabled";

export interface ModelConfig {
  id: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  enabled: boolean;
  /** 思考强度（reasoning 模型专用） */
  thinkingLevel?: ThinkingLevel;
  /**
   * 可选模型分级（正整数）：仅 admin 展示排序（tier 降序在前，无 tier 在后保持原序）；
   * 不参与任何选卡/prompt 逻辑。与后端 src/config.ts modelSchema.tier 对应。
   */
  tier?: number;
}

export interface CardConfig {
  id: string;
  name: string;
  expertId: string;
  modelId: string;
  enabled: boolean;
  isDefault?: boolean;
  /**
   * 可选信号标签：select:"auto" 信号路由选卡的候选依据；
   * 值域 = SIGNAL_GROUPS（下方常量副本）。空数组视为未声明。
   */
  signals?: string[];
}

// ── 信号组常量（P2-A）──
// 注意：这是后端 src/tools/signal-routing.ts 中 SIGNAL_GROUPS 的前端副本，
// 两处值域需人工保持同步（改动任一侧时务必同步另一侧）。

/** 内置信号组 id 列表（副本，来源：src/tools/signal-routing.ts 的 SIGNAL_GROUPS） */
export const SIGNAL_GROUPS = [
  "sql-data",
  "security",
  "infra",
  "ml",
  "api",
  "frontend",
  "cost",
  "pipeline",
  "writing",
  "general",
] as const;

export type SignalId = (typeof SIGNAL_GROUPS)[number];

/** 信号组 → 中文显示名（仅 admin 展示用） */
export const SIGNAL_GROUP_LABELS: Record<SignalId, string> = {
  "sql-data": "数据/SQL",
  security: "安全",
  infra: "基础设施",
  ml: "AI/机器学习",
  api: "API/集成",
  frontend: "前端",
  cost: "成本",
  pipeline: "流水线",
  writing: "写作/文档",
  general: "通用兜底",
};

/**
 * tier 稳定排序（P3-B）：有 tier 的按 tier 降序在前（同 tier 保持原序），
 * 无 tier 的在后保持原序。仅展示排序，不影响任何数据流。
 */
export function sortByTierDesc<T extends { tier?: number }>(list: T[]): T[] {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ta = a.item.tier;
      const tb = b.item.tier;
      if (ta !== undefined && tb !== undefined && ta !== tb) return tb - ta;
      if (ta !== undefined && tb === undefined) return -1;
      if (ta === undefined && tb !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

export interface ConfigFile {
  providers: ProviderMap;
  experts: Expert[];
  models: ModelConfig[];
  cards: CardConfig[];
  /** 工具开关（admin 暂不编辑；加载/保存时原样透传避免被清掉） */
  disabledTools?: string[];
}

export interface ProbeRequest {
  baseUrl: string;
  apiKey: string;
}

export interface ProbeModel {
  id: string;
  ownedBy?: string;
  /** 可选分级（探测端点通常不返回；存在时 ModelPicker 按 tier 降序稳定排序） */
  tier?: number;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  issueCount?: number;
  restartRequired?: boolean;
}

export interface EnvVarStatus {
  name: string;
  configured: boolean;
}

// ── 鉴权与 MCP 访问令牌（GET /api/auth/check、/api/tokens，mirrors src/auth/tokens.ts）──

/** 登录自检结果（authCheck 前端本地推导，notConfigured 对应 401 reason=admin_token_not_configured） */
export interface AuthCheckResult {
  ok: boolean;
  /** true = 服务器未配置 TALKIO_ADMIN_TOKEN（fail-closed） */
  notConfigured?: boolean;
}

/** GET /api/tokens 列表项（不含哈希与明文；fingerprint = 哈希后 4 位） */
export interface McpTokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  fingerprint: string;
}

/** POST /api/tokens 返回体（plaintext 仅此一次，之后任何接口不可再取） */
export interface CreatedMcpToken {
  id: string;
  name: string;
  createdAt: string;
  plaintext: string;
}

// ── 会话记录（mirrors src/records/store.ts RecordEvent union）──

export interface UsageRecord {
  promptTokens?: number;
  completionTokens?: number;
}

export interface RecordCardRef {
  cardId: string;
  cardName: string;
  expertId: string;
  expertName: string;
  modelId: string;
  provider: string;
}

/** meta 行 = listSessions 返回的每个元素（额外带 sizeBytes） */
export interface SessionMeta {
  type: "meta";
  id: string;
  tool: "consult_experts" | "brainstorm" | "brainstorm_followup";
  startedAt: string;
  prompt: string;
  context?: string;
  mode?: string;
  rounds?: number;
  degraded?: boolean;
  prevTurnsCount?: number;
  sizeBytes?: number;
}

/** 详情接口返回的每个事件（meta 之后的各种类型） */
export type RecordEvent =
  | SessionMeta
  | { type: "cards"; ts?: string; cards: RecordCardRef[] }
  | {
      type: "card_result";
      ts?: string;
      cardId: string;
      ok: boolean;
      content?: string;
      error?: string;
      usage?: UsageRecord;
    }
  | {
      type: "turn";
      ts?: string;
      round: number;
      expertId: string;
      expertName: string;
      icon: string;
      content: string;
      usage?: UsageRecord;
      /** P3-A runs：多轮运行序号（从 1 开始）；旧 JSONL 无该字段 */
      run?: number;
    }
  /** 新版 vote 事件（按轮聚合，P1-A）：每轮一条，结构化选票数组 */
  | {
      type: "vote";
      ts?: string;
      round: number;
      votes: {
        voterCardId: string;
        votedForAlias: string;
        reason: string;
      }[];
      /** P3-A runs：多轮运行序号（从 1 开始）；旧 JSONL 无该字段 */
      run?: number;
    }
  /** 旧版 vote 事件（逐专家一行，仅存在于旧 JSONL）：读侧容错保留 */
  | {
      type: "vote";
      ts?: string;
      expertId: string;
      expertName: string;
      icon: string;
      content: string;
      usage?: UsageRecord;
    }
  | { type: "round_end"; ts?: string; round: number; total: number; /** P3-A runs */ run?: number }
  | { type: "summary"; ts?: string; content: string; /** P3-A runs */ run?: number }
  | {
      type: "done";
      ts?: string;
      status: "ok" | "partial" | "all_failed" | "no_cards" | "error";
      report?: string;
      usage?: UsageRecord;
    };

/** GET /api/records/:id 返回体 */
export interface SessionDetail {
  id: string;
  events: RecordEvent[];
}

/** DELETE /api/records 返回体（批量删除/清空共用） */
export interface DeleteRecordsResult {
  ok: boolean;
  deleted: number;
}

// ── 网页版发起群聊（/api/chat POST 返回 + SSE 事件）──

/** POST /api/chat 返回体 */
export interface RunBrainstormResult {
  ok: boolean;
  sessionId: string;
}

/** 发起群聊请求体 */
export interface RunBrainstormBody {
  topic: string;
  mode?: "debate" | "relay";
  rounds?: number; // 1-5
  summarize?: boolean;
  cards?: string[]; // 角色卡 id 列表
}

/**
 * GET /api/chat?session= 的 SSE 事件数据（event 名 = progress / done / error）。
 * - progress：{ type:"brainstorm.round", round, total }
 * - done：{ isError, report, sessionId }
 * - error：{ message }
 */
export type ChatSessionEvent =
  | { type: "brainstorm.round"; round: number; total: number }
  | { type: "done"; isError: boolean; report: string; sessionId: string }
  | { type: "error"; message: string };

// ── Token 用量聚合（GET /api/usage 返回体，mirrors src/records/store.ts UsageAggregate）──

/** GET /api/usage?days=N 返回体 */
export interface UsageAggregate {
  /** 实际采用的时间窗（天） */
  days: number;
  /** 全部 turn/card_result 事件的 usage 合计 */
  total: UsageRecord;
  sessionCount: number;
  callCount: number;
  /** 按天聚合，date = 本地 YYYY-MM-DD，升序 */
  byDay: Array<{ date: string; usage: UsageRecord }>;
  /** 按角色卡聚合，usage 降序；未匹配到快照的用量归入 cardId "unknown"（cardName 未知卡片） */
  byCard: Array<{
    cardId: string;
    cardName: string;
    modelId: string;
    provider: string;
    usage: UsageRecord;
    sessions: number;
    calls: number;
  }>;
  /** 按模型聚合，usage 降序 */
  byModel: Array<{ modelId: string; provider: string; usage: UsageRecord; calls: number }>;
  /** 解析失败的会话文件数 */
  skipped: number;
}
