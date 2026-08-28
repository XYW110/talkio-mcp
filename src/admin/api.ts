/**
 * admin HTTP API —— 供前端管理页读写 experts.json 与探测 provider 模型。
 *
 * 只有 SSE 模式才启动这些接口（stdio 不适用）。
 * 安全提示：这些接口会修改/返回配置信息，绑定非回环地址时应小心。
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { fetchWithRetry } from "../utils/retry.js";

/** 探测模型时单次超时（ms） */
const PROBE_TIMEOUT_MS = 10000;

interface AdminApiOptions {
  /** experts.json 的绝对路径 */
  configPath: string;
  /** 前端构建产物目录（admin-web/dist），用于静态托管 */
  staticDir?: string;
  /** 是否需要重启 server 才生效（当前实现：配置在启动时闭合捕获，改完必须重启） */
  restartHint?: boolean;
}

/** 应答辅助：统一 JSON 输出与错误格式 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** MIME 映射（前端静态资源） */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveStatic(dir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  // Map "/" and unknown paths to index.html (SPA fallback).
  const clean = decodeURIComponent(urlPath.replace(/^\/+/, "") || "index.html");
  let filePath = path.resolve(dir, clean);
  if (!filePath.startsWith(path.resolve(dir))) {
    sendError(res, 403, "Forbidden");
    return true;
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = path.join(filePath, "index.html");
    const ext = path.extname(filePath).toLowerCase();
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * 由 baseUrl + apiKey 探测 OpenAI 兼容端点返回的模型列表。
 * 兼容各家响应格式：{ data: [{id,...}] } / { models: [{name,...}] } 等。
 */
async function probeModels(baseUrl: string, apiKey: string): Promise<unknown[]> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${normalized}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  }, {
    // 单次尝试 10s，最多 1 次（不重试）；超时抛 TimeoutError
    timeoutMs: PROBE_TIMEOUT_MS,
    maxAttempts: 1,
  });
  if (!res.ok) {
    throw new Error(`GET /models 返回 HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as unknown;
  // 常见格式：{ data: [{id}] }、{ models: [{name}] }、{ model_list: [...] }
  const arr = (json as { data?: unknown }).data
    ?? (json as { models?: unknown }).models
    ?? (json as { model_list?: unknown }).model_list;
  if (!Array.isArray(arr)) {
    throw new Error("无法从响应中解析 models 列表");
  }
  return arr
    .map((m) => {
      const rec = m as { id?: unknown; name?: unknown };
      return { id: String(rec.id ?? rec.name ?? ""), ownedBy: undefined };
    })
    .filter((m) => m.id.length > 0);
}

/**
 * 构建 admin API 处理器。返回 (req, res) => Promise<boolean>；
 * 返回 true 表示已处理（response 已结束），false 表示未匹配到 /api 路由。
 */
export function createAdminApi(options: AdminApiOptions) {
  const { configPath, staticDir } = options;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // ── /api/config ──
    if (url.pathname === "/api/config") {
      if (req.method === "GET") {
        try {
          const raw = await readFile(configPath, "utf-8");
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(raw);
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        }
        return true;
      }
      if (req.method === "PUT") {
        try {
          const bodyText = await readBody(req);
          // 先做一次 JSON 解析校验，拒绝非法配置
          JSON.parse(bodyText);
          await writeFile(configPath, bodyText, "utf-8");
          sendJson(res, 200, { ok: true, restartRequired: options.restartHint ?? false });
        } catch (err) {
          sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return true;
      }
      sendError(res, 405, "Method not allowed");
      return true;
    }

    // ── /api/providers/probe ──
    if (url.pathname === "/api/providers/probe" && req.method === "POST") {
      try {
        const bodyText = await readBody(req);
        const body = JSON.parse(bodyText) as { baseUrl?: unknown; apiKey?: unknown };
        const baseUrl = String(body.baseUrl ?? "").trim();
        const apiKey = String(body.apiKey ?? "").trim();
        if (!baseUrl) throw new Error("baseUrl 不能为空");
        if (!apiKey) throw new Error("apiKey 不能为空");
        const models = await probeModels(baseUrl, apiKey);
        sendJson(res, 200, models);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    // ── /api/env/status ──（告知前端哪些 key 已配置，避免展示 key 明文）
    if (url.pathname === "/api/env/status" && req.method === "GET") {
      try {
        const raw = await readFile(configPath, "utf-8");
        const cfg = JSON.parse(raw) as { providers?: Record<string, { apiKeyEnv?: string }> };
        const names = new Set<string>();
        for (const p of Object.values(cfg.providers ?? {})) {
          if (p.apiKeyEnv) names.add(p.apiKeyEnv);
        }
        sendJson(
          res,
          200,
          [...names].map((name) => ({ name, configured: Boolean(process.env[name]) })),
        );
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    // ── static assets (SPA) ──
    if (staticDir && url.pathname !== "/sse" && url.pathname !== "/messages") {
      if (await serveStatic(staticDir, url.pathname, res)) return true;
    }

    return false;
  };
}

/** 探测静态目录是否存在（供启动时提示） */
export async function resolveStaticDir(defaultDir?: string): Promise<string | undefined> {
  if (!defaultDir) return undefined;
  try {
    await mkdir(defaultDir, { recursive: true });
    const entries = await readdir(defaultDir);
    return entries.includes("index.html") ? defaultDir : undefined;
  } catch {
    return undefined;
  }
}