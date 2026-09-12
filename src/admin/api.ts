/**
 * admin HTTP API —— 供前端管理页读写 experts.json 与探测 provider 模型。
 *
 * 只有 SSE 模式才启动这些接口（stdio 不适用）。
 * 安全提示：这些接口会修改/返回配置信息，绑定非回环地址时应小心。
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { fetchWithRetry } from "../utils/retry.js";
import type { AppConfig } from "../types.js";
import { handleBrainstorm } from "../tools/brainstorm.js";
import { startSession, type RecordSession } from "../records/store.js";
import type { Logger } from "../utils/log.js";
import {
  listSessions,
  readSession,
  deleteSessions,
  clearSessions,
  isValidSessionId,
} from "../records/store.js";

/** 探测模型时单次超时（ms） */
const PROBE_TIMEOUT_MS = 10000;

interface AdminApiOptions {
  /** experts.json 的绝对路径 */
  configPath: string;
  /** 前端构建产物目录（admin-web/dist），用于静态托管 */
  staticDir?: string;
  /** 是否需要重启 server 才生效（当前实现：配置在启动时闭合捕获，改完必须重启） */
  restartHint?: boolean;
  /** 会话记录目录；未配置时 records 接口返回空列表 / 404 */
  recordsDir?: string;
  /** 启动时已校验的配置（用于网页版发起群聊，避免每次重读+重复校验） */
  config: AppConfig;
  /** 日志器（复用主循环 logger，避免 admin 层自建） */
  logger: Logger;
}

/** 群聊 SSE 频道端点前缀。 */
export const CHAT_CHANNEL_PREFIX = "/api/chat";

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
  const { configPath, staticDir, recordsDir, config: baseConfig, logger } = options;

  // 群聊 SSE：按 sessionId 分频道的广播器（支持多点开 concurrent 群聊）。
  const chatBus = new EventEmitter();

  /** 向某个频道广播一条 SSE 事件（JSON 载荷）。见 sendSseEvent。 */
  function broadcast(channel: string, type: string, data: unknown): void {
    chatBus.emit(channel, type, data);
  }

  /**
   * 以原始 SSE 帧写一条事件到响应流：`event:` 名 + `data:` JSON 载荷。
   * 兼容 EventSource/SSE 客户端：默认事件（无自定义 event 名）客户端走 onmessage。
   */
  function writeSseFrame(res: ServerResponse, data: unknown, event?: string): void {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

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
          const incoming = JSON.parse(bodyText) as {
            experts?: Array<{ id?: unknown; builtin?: unknown }>;
          };
          // ── 内置专家保护：以磁盘上当前配置为准，收集 builtin 专家 id ──
          // 前端只是 UI 层面的兜底；这里在后端强制「内置专家不可删除/降级」，
          // 即使客户端提交被挖空（gutted）的 payload 也无法绕过。
          const currentRaw = await readFile(configPath, "utf-8");
          const current = JSON.parse(currentRaw) as {
            experts?: Array<{ id?: unknown; builtin?: unknown }>;
          };
          const builtinIds = new Set<string>();
          for (const e of current.experts ?? []) {
            if (e && e.builtin === true && typeof e.id === "string") {
              builtinIds.add(e.id);
            }
          }
          if (builtinIds.size > 0) {
            const incomingIds = new Map<string, boolean>();
            for (const e of incoming.experts ?? []) {
              if (e && typeof e.id === "string") {
                incomingIds.set(e.id, e.builtin === true);
              }
            }
            for (const id of builtinIds) {
              if (!incomingIds.has(id)) {
                sendError(res, 400, `内置专家 "${id}" 不可删除`);
                return true;
              }
              if (incomingIds.get(id) === false) {
                sendError(res, 400, `内置专家 "${id}" 不可修改为普通专家`);
                return true;
              }
            }
          }
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

// ── /api/chat （网页版发起群聊）──
    // POST: 触发一次 brainstorm，返回 { sessionId }；结果经 GET /api/chat?session=SSE 实时推送。
    // GET:  订阅某个 session 的 SSE 流（EventSource 兼容）。
    if (url.pathname === CHAT_CHANNEL_PREFIX) {
      if (req.method === "POST") {
        try {
          const bodyText = await readBody(req);
          const body = JSON.parse(bodyText) as {
            topic?: unknown;
            mode?: unknown;
            rounds?: unknown;
            summarize?: unknown;
            cards?: unknown;
          };
          const topic = String(body.topic ?? "").trim();
          if (!topic) {
            sendError(res, 400, "topic 不能为空");
            return true;
          }
          const mode = body.mode === "relay" ? "relay" : "debate";
          const roundsRaw = Number(body.rounds);
          const rounds = Number.isFinite(roundsRaw) ? Math.min(Math.max(Math.round(roundsRaw), 1), 5) : 1;
          const summarize = body.summarize !== false;
          const cards = Array.isArray(body.cards)
            ? body.cards.map((c) => String(c)).filter((c) => c.length > 0)
            : undefined;

          // 复用会话记录链路（与 MCP 工具一致，落盘到同一 records 目录）。
          let record: RecordSession | undefined;
          try {
            record =
              (await startSession(
                { tool: "brainstorm", prompt: topic, mode, rounds },
                recordsDir,
                logger,
              )) ?? undefined;
          } catch {
            record = undefined; // 记录失败不影响群聊本身
          }
          const sessionId = record?.id ?? `web-${Date.now()}`;
          const channel = `${CHAT_CHANNEL_PREFIX}/${sessionId}`;

          // fire-and-forget：后台跑群聊，进度经 chatBus 广播到 SSE 频道。
          void (async () => {
            const notifier = (ev: { type: string; round?: number; total?: number }) => {
              broadcast(channel, "progress", ev);
            };
            try {
              const result = await handleBrainstorm(
                { topic, mode, rounds, summarize, cards },
                baseConfig,
                { notifier: notifier as never, record },
              );
              const text =
                result.content
                  ?.map((c) =>
                    typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "",
                  )
                  .filter(Boolean)
                  .join("\n")
                  .trim() ?? "";
              broadcast(channel, "done", {
                isError: Boolean(result.isError),
                report: text,
                sessionId,
              });
            } catch (err) {
              broadcast(channel, "error", {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          })();

          sendJson(res, 200, { ok: true, sessionId });
        } catch (err) {
          sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return true;
      }

      if (req.method === "GET") {
        const sessionId = url.searchParams.get("session");
        if (!sessionId || !isValidSessionId(sessionId)) {
          sendError(res, 400, "缺少有效的 session 参数");
          return true;
        }
        const channel = `${CHAT_CHANNEL_PREFIX}/${sessionId}`;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const onEvent = (type: string, data: unknown) =>
          writeSseFrame(res, data, type === "progress" ? "progress" : type);
        chatBus.on(channel, onEvent);
        // 30s 心跳，避免代理/浏览器断开空闲连接。
        const beat = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(beat);
          chatBus.off(channel, onEvent);
        });
        return true;
      }

      sendError(res, 405, "Method not allowed");
      return true;
    }

    // ── /api/records（会话记录列表，mtime 倒序，limit 默认 50 上限 200）──
    if (url.pathname === "/api/records" && req.method === "GET") {
      try {
        if (!recordsDir) {
          sendJson(res, 200, []);
          return true;
        }
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw === null ? 50 : Number(limitRaw);
        const list = await listSessions(recordsDir, Number.isFinite(limit) ? limit : 50);
        sendJson(res, 200, list);
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    // ── DELETE /api/records（清空 / 批量删除）──
    // body 可带 { ids?: string[] }：提供 ids 则只删这些会话；否则清空全部。
    if (url.pathname === "/api/records" && req.method === "DELETE") {
      try {
        if (!recordsDir) {
          sendError(res, 404, "记录未启用");
          return true;
        }
        const bodyText = await readBody(req);
        let ids: string[] | undefined;
        if (bodyText.trim() !== "") {
          const parsed = JSON.parse(bodyText) as { ids?: unknown };
          if (parsed.ids !== undefined) {
            if (!Array.isArray(parsed.ids)) throw new Error("ids 需要是数组");
            ids = parsed.ids.map(String);
          }
        }
        const deleted =
          ids && ids.length > 0
            ? await deleteSessions(recordsDir, ids)
            : await clearSessions(recordsDir);
        sendJson(res, 200, { ok: true, deleted });
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    // ── /api/records/:id（单会话完整事件流）──
    if (
      url.pathname.startsWith("/api/records/") &&
      url.pathname.length > "/api/records/".length &&
      req.method === "GET"
    ) {
      try {
        const id = decodeURIComponent(url.pathname.slice("/api/records/".length));
        if (!isValidSessionId(id)) {
          sendError(res, 404, "记录不存在");
          return true;
        }
        const events = recordsDir ? await readSession(recordsDir, id) : null;
        if (!events) {
          sendError(res, 404, "记录不存在");
          return true;
        }
        sendJson(res, 200, { id, events });
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