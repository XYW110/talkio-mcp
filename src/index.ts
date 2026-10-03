#!/usr/bin/env node
/**
 * CLI entry point for talkio-mcp-expert-council.
 *
 * Parses argv by hand (no CLI parsing library), loads config, creates the
 * MCP server, and connects it to the requested transport (stdio or SSE).
 *
 * CRITICAL: in stdio mode stdout is the MCP protocol channel — NEVER use
 * console.log. All diagnostics go to stderr via the `log()` helper.
 */
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { createLogger, normalizeLevel } from "./utils/log.js";
import { initKeysStore } from "./keys/store.js";
import { isMockProviderEnabled } from "./providers/registry.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer as createHttpServer } from "node:http";
import { createAdminApi, resolveStaticDir } from "./admin/api.js";
import { createAuthGate } from "./auth/middleware.js";
import { McpTokenStore } from "./auth/tokens.js";
import path from "node:path";
import type { AppConfig } from "./types.js";

/** Parse minimal CLI args: --transport, --port, --host, --config, --log-level. */
interface CliArgs {
  transport: "stdio" | "sse";
  port: number;
  host: string;
  config?: string;
  logLevel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    transport: "stdio",
    port: 3100,
    host: "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--transport": {
        const v = argv[++i];
        if (v !== "stdio" && v !== "sse") {
          throw new Error(`--transport 仅支持 stdio 或 sse,收到: "${v}"`);
        }
        args.transport = v;
        break;
      }
      case "--port": {
        const v = argv[++i];
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--port 需要正整数,收到: "${v}"`);
        }
        args.port = Math.trunc(n);
        break;
      }
      case "--host": {
        const v = argv[++i];
        if (!v) throw new Error("--host 需要一个值");
        args.host = v;
        break;
      }
      case "--config": {
        args.config = argv[++i];
        break;
      }
      case "--log-level": {
        args.logLevel = argv[++i];
        break;
      }
      case "--help":
      case "-h": {
        process.stderr.write(
          [
            "talkio-mcp-expert-council",
            "",
            "Options:",
            "  --transport stdio|sse   传输方式 (默认 stdio)",
            "  --port <number>         SSE 端口 (默认 3100)",
            "  --host <addr>           SSE 绑定地址 (默认 127.0.0.1)",
            "  --config <path>         专家配置文件路径",
            "  --log-level <level>     silly|debug|info|warn|error (默认 info)",
            "",
          ].join("\n") + "\n"
        );
        process.exit(0);
        break;
      }
      default:
        if (a && a.startsWith("--")) {
          throw new Error(`未知参数: ${a}`);
        }
        // Ignore positional args.
        break;
    }
  }
  return args;
}

/** stderr-only logger so stdio protocol output stays clean. */
function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

/** Start the server in stdio transport mode. */
async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("talkio-mcp-expert-council 已在 stdio 模式启动,等待客户端连接…");
}

// Module-scope server; assigned in main() so signal handlers can close it.
let server: ReturnType<typeof createServer>;

/** Start the server in SSE transport mode using node:http. */
async function startSse(
  port: number,
  host: string,
  configPath: string,
  recordsDir: string | undefined,
  configRef: { config: AppConfig },
  keys: Awaited<ReturnType<typeof initKeysStore>>,
  logger: ReturnType<typeof createLogger>,
  memoryDir?: string,
): Promise<void> {
  // experts.json 绝对路径（鉴权令牌池与 admin API 都相对它落位）。
  const adminPath = path.resolve(configPath);

  // ── 鉴权装配（fail-closed）──
  // admin 静态令牌：env TALKIO_ADMIN_TOKEN；未设置时受保护面（/api/*、/sse、/messages）
  // 一律 401，静态壳不受影响。stdio 模式不经过 HTTP 层，完全不受影响。
  const adminToken = process.env.TALKIO_ADMIN_TOKEN;
  if (!adminToken) {
    logger.error(
      "[auth] 未设置 TALKIO_ADMIN_TOKEN —— fail-closed 已生效：/api/*、/sse、/messages 对一切请求返回 401。" +
        `请在部署环境（.env 或容器 environment）设置 TALKIO_ADMIN_TOKEN=<强随机字符串> 后重启；` +
        `MCP 客户端另需在管理后台「访问令牌」页生成 MCP 令牌。静态页面不受影响，可打开首页确认。`
    );
  } else {
    logger.info(
      "[auth] 鉴权已启用：/api/* 校验 admin token，/sse 与 /messages 校验 MCP 访问令牌"
    );
  }

  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback && !adminToken) {
    log(
      `⚠️ 安全警告: SSE 绑定到非回环地址 ${host} 且未设置 TALKIO_ADMIN_TOKEN（fail-closed），` +
        `外部访问将全部返回 401。请配置 TALKIO_ADMIN_TOKEN 后重启。`
    );
  }

  // MCP 动态令牌池：默认 experts.json 同目录 mcp-tokens.json，TALKIO_MCP_TOKENS_FILE 可覆盖。
  const mcpTokensPath = process.env.TALKIO_MCP_TOKENS_FILE
    ? path.resolve(process.env.TALKIO_MCP_TOKENS_FILE)
    : path.join(path.dirname(adminPath), "mcp-tokens.json");
  const mcpTokens = new McpTokenStore(mcpTokensPath, logger);
  await mcpTokens.load();
  const authGate = createAuthGate({ adminToken, mcpTokens, logger });

// Map of sessionId -> SSEServerTransport so POST /messages can route back.
  const transports = new Map<string, SSEServerTransport>();

  // Admin API: exposes /api/* for the management UI + serves the built frontend.
  // Only wired in SSE mode; stdio has no HTTP surface.
  const staticDir = await resolveStaticDir(
    path.resolve(path.dirname(adminPath), "admin-web", "dist"),
  );
const handleAdmin = createAdminApi({
    configPath: adminPath,
    staticDir,
    recordsDir,
    memoryDir,
    configRef,
    keys,
    logger,
    mcpTokens,
  });
  if (staticDir) {
    log(`管理界面已启用: 访问 http://${host}:${port}/ 打开专家管理页面`);
  } else {
    log(
      `管理界面未启用: 未找到前端构建产物 admin-web/dist（请先 cd admin-web && npm run build）` +
        `，/api/* 接口仍可用`
    );
  }

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "", `http://${host}:${port}`);
    // 鉴权门（fail-closed）：静态资源豁免；/sse|/messages 走 MCP 令牌池；/api/* 走 admin token。
    if (await authGate(req, res, url)) return;
    // GET /sse — establish the SSE stream.
    if (req.method === "GET" && url.pathname === "/sse") {
      try {
        // The endpoint tells the client where to POST messages.
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => {
          transports.delete(transport.sessionId);
        };
        await server.connect(transport);
        log(`SSE 会话已建立: ${transport.sessionId}`);
      } catch (err) {
        log(
          `建立 SSE 流失败: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("SSE stream error");
        }
      }
      return;
    }

    // POST /messages?sessionId=... — forward client JSON-RPC to the transport.
    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.statusCode = 400;
        res.end("Missing sessionId parameter");
        return;
      }
      const transport = transports.get(sessionId);
      if (!transport) {
        res.statusCode = 404;
        res.end("Session not found");
        return;
      }
      try {
        // Read the raw body and let the transport parse it.
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = body.length > 0 ? JSON.parse(body) : undefined;
        } catch {
          parsed = body; // let SDK handle malformed bodies
        }
        await transport.handlePostMessage(req, res, parsed);
      } catch (err) {
        log(
          `处理 POST 消息失败: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Error handling request");
        }
      }
      return;
    }

    // Admin API + static frontend (management UI). Serves /api/* and SPA assets.
    const handled = await handleAdmin(req, res);
    if (handled) return;

    // Anything else: 404.
    res.statusCode = 404;
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });
  log(
    `talkio-mcp-expert-council 已在 SSE 模式启动: http://${host}:${port} ` +
      `(GET /sse 建立 SSE 流, POST /messages?sessionId=... 发送消息)`
  );

  // Graceful shutdown: close all SSE transports then the HTTP server.
  const shutdown = async () => {
    log("正在关闭服务…");
    for (const [, t] of transports) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// --- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Level-gated logger: all levels write to stderr (blocked stdout in stdio
  // mode is the MCP protocol channel, so normal logs must never reach it).
  const logLevel = normalizeLevel(args.logLevel);
  const logger = createLogger(logLevel);
  // Warn when the user passed an unknown level so the fallback is observable.
  if (args.logLevel && args.logLevel.toLowerCase() !== logLevel) {
    logger.warn(`[cli] 未知的 --log-level "${args.logLevel}"，已降级为 info`);
  }

  const cfgPath = args.config ?? process.env.TALKIO_EXPERTS_CONFIG ?? "experts.json";

// Load config (may throw with a clear message on invalid experts.json).
  const config = await loadConfig(cfgPath, { logger });

  // 渠道密钥池（09-30-provider-keys-ui）：keys.json 默认 experts.json 同目录，
  // TALKIO_KEYS_FILE 可覆盖；进程级单例，凭据解析/选卡过滤/admin keys 路由共用。
  const keysPath = process.env.TALKIO_KEYS_FILE?.trim()
    ? path.resolve(process.env.TALKIO_KEYS_FILE.trim())
    : path.join(path.dirname(path.resolve(cfgPath)), "keys.json");
  const keys = await initKeysStore(keysPath, logger);

  // 启动 [keys] 检查：提示尚未配置密钥的渠道（fail-closed，仅提示不退出；
  // mock 模式无需真实密钥，跳过提示避免噪音）。
  if (!isMockProviderEnabled()) {
    const seen = new Set<string>();
    for (const model of config.models) {
      if (seen.has(model.providerId)) continue;
      seen.add(model.providerId);
      if (config.providers[model.providerId] && !keys.get(model.providerId)) {
        logger.error(
          `[keys] 渠道 "${model.providerId}" 尚未配置 API Key，使用该渠道的角色卡调用将失败` +
            `（管理后台-渠道页可配置，保存即生效；不影响其他渠道）`
        );
      }
    }
  }

  // 会话记录目录：<experts.json 所在目录>/records（可被 TALKIO_RECORDS_DIR 覆盖）。
  const recordsDir = path.resolve(
    path.dirname(path.resolve(cfgPath)),
    "records",
  );
  // 专家记忆目录（groupchat-strengths P3）：TALKIO_MEMORY_DIR 覆盖 >
  // <experts.json 所在目录>/memory（与 records 同约定，容器内同层 bind mount）。
  const memoryDir =
    process.env.TALKIO_MEMORY_DIR && process.env.TALKIO_MEMORY_DIR.trim() !== ""
      ? path.resolve(process.env.TALKIO_MEMORY_DIR.trim())
      : path.resolve(path.dirname(path.resolve(cfgPath)), "memory");
  // 可变配置持有者（R4 热生效）：createServer 与 createAdminApi 共享同一引用，
  // admin PUT /api/config 校验通过后原位替换 .config，工具调用取当前值免重启。
  const configRef = { config };
  server = createServer(configRef, { recordsDir, memoryDir });

if (args.transport === "stdio") {
    await startStdio();
  } else {
    await startSse(args.port, args.host, cfgPath, recordsDir, configRef, keys, logger, memoryDir);
  }
}

main().catch((err) => {
  log(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
