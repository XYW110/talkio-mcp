// Browser API client for the MCP backend /api endpoints.
import type { ConfigFile, ProbeModel, SaveResult, EnvVarStatus, ProbeRequest } from "./types";

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
};