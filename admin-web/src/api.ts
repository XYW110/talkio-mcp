// Browser API client for the MCP backend /api endpoints.
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
} from "./types";

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : res.statusText) as string;
    throw new Error(err || `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
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
  chatEventSource: (sessionId: string) =>
    new EventSource(`/api/chat?session=${encodeURIComponent(sessionId)}`),
};