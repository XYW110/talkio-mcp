/**
 * 鉴权门 —— 位于单一 HTTP 监听器请求回调最前部（index.ts 接线）。
 *
 * 路径分类（design.md §0）：
 * - 静态资源（非 /sse、/messages、/api/*）→ 放行（公开壳子 + 登录页）；
 * - /sse、/messages            → MCP 令牌池（mcp-tokens.json 哈希查表）；
 * - /api/*（含 /api/auth/check）→ admin token（env TALKIO_ADMIN_TOKEN）。
 *
 * 凭证解析：`Authorization: Bearer` 优先，`?token=` 兜底（浏览器 EventSource
 * 无 header 能力，如 /api/chat 的 GET SSE 订阅；README 明示 query 仅作降级）。
 *
 * fail-closed：TALKIO_ADMIN_TOKEN 未设置 → 受保护面一律 401；静态壳不受影响。
 * 两池完全隔离：admin token 打 /sse 拒绝、MCP token 打 /api 拒绝。
 *
 * 日志红线：`[auth]` warn 只含 path + reason + pool，绝不输出 token 内容。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../utils/log.js";
import { constantTimeEqual, type McpTokenStore } from "./tokens.js";

export type ProtectedPool = "api" | "mcp";

/** 受保护面分类；静态资源返回 "static"（放行）。 */
export function classifyPath(pathname: string): ProtectedPool | "static" {
  if (pathname === "/sse" || pathname === "/messages") return "mcp";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  return "static";
}

/**
 * 从请求解析凭证：`Authorization: Bearer <t>` → `?token=` → null。
 * 401 响应不区分「缺失/错误/已删除」，避免枚举探测（design.md §8）。
 */
export function resolveCredential(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.length > 0) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) return m[1] ?? null;
  }
  const q = url.searchParams.get("token");
  return q && q.length > 0 ? q : null;
}

export interface AuthGateOptions {
  /** admin 静态令牌（env TALKIO_ADMIN_TOKEN）；undefined = fail-closed。 */
  adminToken: string | undefined;
  /** MCP 令牌池（index.ts 装配并 load 的共享实例，吊销即时生效）。 */
  mcpTokens: McpTokenStore;
  logger: Logger;
}

/**
 * 返回鉴权门：true 表示请求已被拒绝（401 已写出，调用方必须停止路由）；
 * false 表示放行（含静态资源），继续后续路由。
 */
export function createAuthGate(options: AuthGateOptions) {
  const { adminToken, mcpTokens, logger } = options;

  /** /api/* 的 401：JSON 体 + WWW-Authenticate；fail-closed 附 reason 供登录页区分文案。 */
  function denyApi(res: ServerResponse, failClosed: boolean): void {
    const body = JSON.stringify(
      failClosed
        ? { error: "unauthorized", reason: "admin_token_not_configured" }
        : { error: "unauthorized" },
    );
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": "Bearer",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  /** /sse、/messages 的 401：直接写头结束，不进 transport。 */
  function denyRaw(res: ServerResponse): void {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" });
    res.end("unauthorized");
  }

  return async function authGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const pool = classifyPath(url.pathname);
    if (pool === "static") return false;

    // fail-closed：admin token 未配置 → /api/* 与 MCP 端点全部 401。
    if (!adminToken) {
      logger.warn(`[auth] 401 path=${url.pathname} reason=fail-closed pool=${pool}`);
      if (pool === "api") denyApi(res, true);
      else denyRaw(res);
      return true;
    }

    const credential = resolveCredential(req, url);
    if (!credential) {
      logger.warn(`[auth] 401 path=${url.pathname} reason=missing pool=${pool}`);
      if (pool === "api") denyApi(res, false);
      else denyRaw(res);
      return true;
    }

    if (pool === "api") {
      if (!constantTimeEqual(credential, adminToken)) {
        logger.warn(`[auth] 401 path=${url.pathname} reason=bad-token pool=api`);
        denyApi(res, false);
        return true;
      }
      return false;
    }

    // pool === "mcp"：与 admin 池完全隔离，只查 MCP 令牌池。
    if (!(await mcpTokens.verify(credential))) {
      logger.warn(`[auth] 401 path=${url.pathname} reason=bad-token pool=mcp`);
      denyRaw(res);
      return true;
    }
    return false;
  };
}
