/**
 * admin HTTP API —— 供前端管理页读写 experts.json、管理渠道密钥（keys.json）
 * 与探测 provider 模型。
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
import { validateExpertsFile } from "../config.js";
import { handleBrainstorm } from "../tools/brainstorm.js";
import { startSession, type RecordSession } from "../records/store.js";
import type { Logger } from "../utils/log.js";
import type { McpTokenStore } from "../auth/tokens.js";
import type { KeysStore } from "../keys/store.js";
import {
  listSessions,
  readSession,
  deleteSessions,
  clearSessions,
  isValidSessionId,
  aggregateUsage,
} from "../records/store.js";
import {
  loadExpertMemories,
  clearExpertMemory,
} from "../experts/memory.js";

/** 探测模型时单次超时（ms） */
const PROBE_TIMEOUT_MS = 10000;

interface AdminApiOptions {
  /** experts.json 的绝对路径 */
  configPath: string;
  /** 前端构建产物目录（admin-web/dist），用于静态托管 */
  staticDir?: string;
  /** 会话记录目录；未配置时 records 接口返回空列表 / 404，usage 返回空结构 */
  recordsDir?: string;
  /**
   * 专家记忆目录（groupchat-strengths P3）；未注入时 memory 接口返回
   * 404（与 mcpTokens 同语义：仅测试/纯 API 部署场景缺省）。
   */
  memoryDir?: string;
  /**
   * 可变配置持有者（R4 热生效）：与 createServer 共享同一引用。
   * PUT /api/config 校验通过后原位替换 `.config`，工具调用与 memory/chat
   * 路由都读取当前值，改配置无需重启。
   */
  configRef: { config: AppConfig };
  /**
   * 渠道密钥池（09-30-provider-keys-ui）：与 index.ts initKeysStore 返回的
   * 单例同一实例（凭据解析/选卡过滤读同一池，PUT /api/keys 写入即热生效）。
   * 未注入时 keys 路由返回 404（仅测试/纯 API 部署场景缺省）。
   */
  keys?: KeysStore;
  /** 日志器（复用主循环 logger，避免 admin 层自建） */
  logger: Logger;
  /**
   * MCP 动态令牌池（与鉴权门共享同一实例，吊销即时生效）。
   * 未注入时 tokens 路由返回 404（仅测试/纯 API 部署场景）。
   */
  mcpTokens?: McpTokenStore;
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
  const { configPath, staticDir, recordsDir, memoryDir, configRef, keys, logger, mcpTokens } = options;

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
          // ── 写盘前校验（R4 热生效，09-30-provider-keys-ui）──
          // 复用 loadConfig 的纯校验核心：非法 → 400 且不写盘（磁盘不落脏数据，
          // 也就无需「写盘成功但校验失败回写旧文件」的回滚路径）。
          const validation = validateExpertsFile(incoming);
          if (!validation.ok) {
            sendError(
              res,
              400,
              `配置校验失败（未写盘）：${validation.errors.join("；")}`
            );
            return true;
          }
          await writeFile(configPath, bodyText, "utf-8");
          // 磁盘 ≈ 内存：用校验产物原位替换持有者，工具调用/群聊即取新配置。
          configRef.config = validation.config;
          sendJson(res, 200, { ok: true });
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

    // ── /api/keys（渠道密钥管理，09-30-provider-keys-ui）──
    // GET：掩码列表（providerId + hasKey + 指纹尾4位 + updatedAt）——无明文无哈希。
    // PUT /api/keys/:pid：{ apiKey }，空串=清除；写入即热生效（内存+落盘）。
    if (url.pathname === "/api/keys" && req.method === "GET") {
      if (!keys) {
        sendError(res, 404, "密钥存储未启用");
        return true;
      }
      // 只列当前配置内的渠道（keys.json 中已删渠道的残留条目不回显）。
      const payload = Object.keys(configRef.config.providers).map((pid) => {
        const fp = keys.fingerprint(pid);
        return {
          providerId: pid,
          hasKey: fp !== undefined,
          ...(fp ? { fingerprint: fp.fingerprint, updatedAt: fp.updatedAt } : {}),
        };
      });
      sendJson(res, 200, payload);
      return true;
    }

    if (
      url.pathname.startsWith("/api/keys/") &&
      url.pathname.length > "/api/keys/".length &&
      req.method === "PUT"
    ) {
      if (!keys) {
        sendError(res, 404, "密钥存储未启用");
        return true;
      }
      try {
        const pid = decodeURIComponent(
          url.pathname.slice("/api/keys/".length)
        );
        if (!configRef.config.providers[pid]) {
          sendError(res, 404, `渠道 "${pid}" 不存在`);
          return true;
        }
        const bodyText = await readBody(req);
        const body = JSON.parse(bodyText) as { apiKey?: unknown };
        if (typeof body.apiKey !== "string") {
          sendError(res, 400, "apiKey 必须是字符串（空串表示清除该渠道密钥）");
          return true;
        }
        await keys.set(pid, body.apiKey);
        const fp = keys.fingerprint(pid);
        // 日志红线：只记指纹尾 4 位与动作，绝不出现明文。
        logger.info(
          fp
            ? `[keys] 渠道 ${pid} 的 API Key 已更新（尾4位 ${fp.fingerprint}），即时生效`
            : `[keys] 渠道 ${pid} 的 API Key 已清除，即时生效`
        );
        sendJson(res, 200, {
          ok: true,
          providerId: pid,
          hasKey: fp !== undefined,
          ...(fp
            ? { fingerprint: fp.fingerprint, updatedAt: fp.updatedAt }
            : {}),
        });
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
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
            interjections?: unknown;
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
          // 主持人插话（groupchat-p4 R1）：形态校验与工具层 handleBrainstorm 同规则
          // （1 ≤ afterRound ≤ rounds-1、message 非空白；rounds=1 无轮间隙直接拒绝）。
          let interjections: Array<{ afterRound: number; message: string }> | undefined;
          if (body.interjections !== undefined) {
            if (!Array.isArray(body.interjections)) {
              sendError(res, 400, "interjections 必须是数组");
              return true;
            }
            const parsed = body.interjections
              .filter(
                (i): i is { afterRound: number; message: string } =>
                  typeof i === "object" &&
                  i !== null &&
                  Number.isInteger((i as { afterRound?: unknown }).afterRound) &&
                  typeof (i as { message?: unknown }).message === "string",
              )
              .map((i) => ({ afterRound: i.afterRound, message: i.message }));
            const bad = parsed.find(
              (i) =>
                i.afterRound < 1 ||
                i.afterRound > rounds - 1 ||
                i.message.trim() === "",
            );
            if (bad || parsed.length !== body.interjections.length) {
              sendError(
                res,
                400,
                rounds <= 1
                  ? `interjections 无效：rounds=${rounds} 时没有可插话的轮间隙（afterRound 需满足 1 ≤ afterRound ≤ rounds-1）`
                  : `interjections 无效：afterRound 必须为 [1, ${rounds - 1}] 内的整数且 message 非空`,
              );
              return true;
            }
            if (parsed.length > 0) interjections = parsed;
          }

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
                { topic, mode, rounds, summarize, cards, interjections },
                configRef.config,
                { notifier: notifier as never, record, memoryDir },
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

    // ── /api/memory（专家记忆总览，groupchat-strengths P3）──
    // 返回全部有记忆文件的专家：[{ expertId, expertName, count, entries }]。
    // expertName 从启动时配置解析（id 不在配置中时回退 id——专家可能已删除）。
    if (url.pathname === "/api/memory" && req.method === "GET") {
      try {
        if (!memoryDir) {
          sendError(res, 404, "记忆未启用");
          return true;
        }
        // 目录不存在（从未写过记忆）→ 视为空列表，配置内专家仍列空态。
        let names: string[] = [];
        try {
          names = await readdir(memoryDir);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("ENOENT")) throw err;
        }
        const payload = [];
        for (const name of names) {
          if (!name.endsWith(".jsonl")) continue;
          const expertId = name.slice(0, -".jsonl".length);
          // 防路径穿越回显：与 config.ts idRegex 同形态（文件本就由该约束保证）。
          if (!/^[a-z0-9][a-z0-9_-]*$/i.test(expertId)) continue;
          const entries = loadExpertMemories(memoryDir, expertId, logger);
          if (entries.length === 0) continue;
          const cfg = configRef.config.experts.find((e) => e.id === expertId);
          payload.push({
            expertId,
            expertName: cfg?.name ?? expertId,
            icon: cfg?.icon ?? "",
            count: entries.length,
            entries,
          });
        }
        // 有配置但暂无记忆的专家也列出（count=0），前端可渲染空态。
        for (const e of configRef.config.experts) {
          if (payload.some((p) => p.expertId === e.id)) continue;
          payload.push({
            expertId: e.id,
            expertName: e.name,
            icon: e.icon,
            count: 0,
            entries: [],
          });
        }
        sendJson(res, 200, payload);
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    // ── DELETE /api/memory/:expertId（清空单个专家记忆）──
    if (
      url.pathname.startsWith("/api/memory/") &&
      url.pathname.length > "/api/memory/".length &&
      req.method === "DELETE"
    ) {
      try {
        if (!memoryDir) {
          sendError(res, 404, "记忆未启用");
          return true;
        }
        const expertId = decodeURIComponent(
          url.pathname.slice("/api/memory/".length)
        );
        // 路径安全：与 config.ts idRegex 同形态，防 ../ 穿越。
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(expertId)) {
          sendError(res, 404, "专家不存在");
          return true;
        }
        const ok = clearExpertMemory(memoryDir, expertId);
        if (!ok) {
          sendError(res, 404, "该专家暂无记忆");
          return true;
        }
        logger.info(`[memory] 已清空专家 ${expertId} 的记忆（admin DELETE）`);
        sendJson(res, 200, { ok: true, expertId });
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    // ── /api/usage（token 用量聚合；records 未启用返回空结构而非 404）──
    if (url.pathname === "/api/usage" && req.method === "GET") {
      try {
        const daysRaw = url.searchParams.get("days");
        const daysNum = daysRaw === null ? NaN : Number(daysRaw);
        // days 钳制到 [1,90]；缺省 / 非数字 → 30
        const days =
          daysRaw !== null && Number.isFinite(daysNum)
            ? Math.min(Math.max(Math.round(daysNum), 1), 90)
            : 30;
        if (!recordsDir) {
          sendJson(res, 200, {
            days,
            total: {},
            sessionCount: 0,
            callCount: 0,
            byDay: [],
            byCard: [],
            byModel: [],
            skipped: 0,
          });
          return true;
        }
        sendJson(res, 200, await aggregateUsage(recordsDir, days));
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    // ── /api/auth/check（登录页自检；能到达这里说明 admin 鉴权门已放行）──
    if (url.pathname === "/api/auth/check" && req.method === "GET") {
      sendJson(res, 200, { role: "admin" });
      return true;
    }

    // ── /api/tokens（MCP 动态令牌管理；明文仅创建响应出现一次）──
    if (url.pathname === "/api/tokens" && req.method === "GET") {
      if (!mcpTokens) {
        sendError(res, 404, "令牌存储未启用");
        return true;
      }
      sendJson(res, 200, mcpTokens.list());
      return true;
    }

    if (url.pathname === "/api/tokens" && req.method === "POST") {
      if (!mcpTokens) {
        sendError(res, 404, "令牌存储未启用");
        return true;
      }
      try {
        const bodyText = await readBody(req);
        const body = JSON.parse(bodyText) as { name?: unknown };
        const name = String(body.name ?? "").trim();
        if (!name) throw new Error("name 不能为空");
        if (name.length > 50) throw new Error("name 过长（最多 50 字符）");
        sendJson(res, 200, await mcpTokens.generate(name));
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    if (
      url.pathname.startsWith("/api/tokens/") &&
      url.pathname.length > "/api/tokens/".length &&
      req.method === "DELETE"
    ) {
      if (!mcpTokens) {
        sendError(res, 404, "令牌存储未启用");
        return true;
      }
      try {
        const id = decodeURIComponent(url.pathname.slice("/api/tokens/".length));
        const revoked = await mcpTokens.revoke(id);
        if (!revoked) {
          sendError(res, 404, "令牌不存在");
          return true;
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
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