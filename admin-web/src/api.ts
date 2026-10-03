// Browser API client for the MCP backend /api endpoints.
//
// 鉴权单点（design.md §4）：
// - admin token 存取 localStorage["talkio.adminToken"]；
// - 所有请求自动附 `Authorization: Bearer`；
// - 任何 401 → 清 token + 触发全局登出（App 切回登录页）+ 抛 UnauthorizedError；
// - EventSource 无法带 header，chatEventSource 以 `?token=` 兜底（/api/chat 属管理面）。
import type {
  ConfigFile,
  ProbeModel,
  SaveResult,
  EnvVarStatus,
  ProbeRequest,
  SessionDetail,
  SessionMeta,
  DeleteRecordsResult,
  RunBrainstormResult,
  RunBrainstormBody,
  UsageAggregate,
  McpTokenInfo,
  CreatedMcpToken,
  AuthCheckResult,
  ExpertMemory,
} from "./types";

const TOKEN_KEY = "talkio.adminToken";

export function getStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 存储不可用时静默：本次会话内仍可用 */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** 401 统一登出回调（App 挂载时注册）。 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** 401 拦截抛出；App 捕获后切回登录页。 */
export class UnauthorizedError extends Error {
  constructor() {
    super("登录已过期，请重新登录");
    this.name = "UnauthorizedError";
  }
}

/** 统一请求头：JSON Content-Type + 已存 token 的 Bearer。 */
function authHeaders(extra?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (extra) Object.assign(headers, extra);
  return headers;
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(init?.headers) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) {
      clearToken();
      unauthorizedHandler?.();
      throw new UnauthorizedError();
    }
    const err = (body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : res.statusText) as string;
    throw new Error(err || `HTTP ${res.status}`);
  }
  return body as T;
}

/**
 * 登录页自检：不走 http() 的 401 拦截（校验候选 token 时不该触发全局登出副作用）。
 * notConfigured = 服务器未配置 TALKIO_ADMIN_TOKEN（fail-closed，401 带 reason）。
 */
export async function authCheck(token: string): Promise<AuthCheckResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/check", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401) {
    const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
    return { ok: false, notConfigured: body?.reason === "admin_token_not_configured" };
  }
  return { ok: false };
}

export const api = {
  /** 登录页自检（GET /api/auth/check，能 200 即已通过 admin 鉴权门）。 */
  authCheck,
  getConfig: () => http<ConfigFile>("/api/config"),
  saveConfig: (cfg: ConfigFile) =>
    http<SaveResult>(`/api/config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),
  probeModels: (req: ProbeRequest) =>
    http<ProbeModel[]>(`/api/providers/probe`, {
      method: "POST",
      body: JSON.stringify(req),
    }),
  envStatus: () => http<EnvVarStatus[]>("/api/env/status"),
  getRecords: (limit?: number) =>
    http<SessionMeta[]>(`/api/records${limit ? `?limit=${limit}` : ""}`),
getRecord: (id: string) => http<SessionDetail>(`/api/records/${encodeURIComponent(id)}`),
deleteRecords: (ids?: string[]) =>
    http<DeleteRecordsResult>(`/api/records`, {
      method: "DELETE",
      body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
    }),
  /** 发起一次 brainstorm 群聊，返回 { ok, sessionId }。 */
  runBrainstorm: (body: RunBrainstormBody) =>
    http<RunBrainstormResult>(`/api/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** 订阅某个群聊 session 的 SSE 流（事件名 progress / done / error）。 */
  chatEventSource: (sessionId: string) => {
    // EventSource 无 header 能力：admin token 走 ?token= 兜底（仅作降级，README 已注明泄漏面）
    const token = getStoredToken();
    const tokenPart = token ? `&token=${encodeURIComponent(token)}` : "";
    return new EventSource(
      `/api/chat?session=${encodeURIComponent(sessionId)}${tokenPart}`,
    );
  },
  /** Token 用量聚合（days ∈ [1,90]，后端钳制；缺省 30）。 */
  getUsage: (days: number) => http<UsageAggregate>(`/api/usage?days=${days}`),
  /** 专家记忆总览（含配置内空态专家；memoryDir 未装配的部署 404）。 */
  listMemory: () => http<ExpertMemory[]>("/api/memory"),
  /** 清空单个专家记忆。 */
  clearMemory: (expertId: string) =>
    http<{ ok: boolean; expertId: string }>(
      `/api/memory/${encodeURIComponent(expertId)}`,
      { method: "DELETE" },
    ),
  /** MCP 访问令牌列表（不含明文/哈希）。 */
  listTokens: () => http<McpTokenInfo[]>(`/api/tokens`),
  /** 生成 MCP 访问令牌；明文仅本响应出现一次。 */
  createToken: (name: string) =>
    http<CreatedMcpToken>(`/api/tokens`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  /** 吊销 MCP 访问令牌（即时生效）。 */
  deleteToken: (id: string) =>
    http<{ ok: boolean }>(`/api/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
