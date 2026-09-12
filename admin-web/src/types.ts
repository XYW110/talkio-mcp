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
}

export interface CardConfig {
  id: string;
  name: string;
  expertId: string;
  modelId: string;
  enabled: boolean;
  isDefault?: boolean;
}

export interface ConfigFile {
  providers: ProviderMap;
  experts: Expert[];
  models: ModelConfig[];
  cards: CardConfig[];
}

export interface ProbeRequest {
  baseUrl: string;
  apiKey: string;
}

export interface ProbeModel {
  id: string;
  ownedBy?: string;
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
    }
  | {
      type: "vote";
      ts?: string;
      expertId: string;
      expertName: string;
      icon: string;
      content: string;
      usage?: UsageRecord;
    }
  | { type: "round_end"; ts?: string; round: number; total: number }
  | { type: "summary"; ts?: string; content: string }
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
