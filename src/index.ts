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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer as createHttpServer } from "node:http";

/** Parse minimal CLI args: --transport, --port, --host, --config. */
interface CliArgs {
  transport: "stdio" | "sse";
  port: number;
  host: string;
  config?: string;
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
        args.host = argv[++i];
        break;
      }
      case "--config": {
        args.config = argv[++i];
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
            "",
          ].join("\n") + "\n",
        );
        process.exit(0);
        break;
      }
      default:
        if (a.startsWith("--")) {
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
async function startSse(port: number, host: string): Promise<void> {
  // Security: warn when binding to a non-loopback address (no auth configured).
  const isLoopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1";
  if (!isLoopback) {
    log(
      `⚠️ 安全警告: SSE 绑定到非回环地址 ${host}。当前未配置任何认证,` +
        `任何能访问该地址的客户端都可调用本服务。请确保处于受控网络或增加鉴权层。`,
    );
  }

  // Map of sessionId -> SSEServerTransport so POST /messages can route back.
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "", `http://${host}:${port}`);
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
        log(`建立 SSE 流失败: ${err instanceof Error ? err.message : String(err)}`);
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
        log(`处理 POST 消息失败: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Error handling request");
        }
      }
      return;
    }

    // Anything else: 404.
    res.statusCode = 404;
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });
  log(
    `talkio-mcp-expert-council 已在 SSE 模式启动: http://${host}:${port} ` +
      `(GET /sse 建立 SSE 流, POST /messages?sessionId=... 发送消息)`,
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

  // Load config (may throw with a clear message on invalid experts.json).
  const config = loadConfig(args.config);
  server = createServer(config);

  if (args.transport === "stdio") {
    await startStdio();
  } else {
    await startSse(args.port, args.host);
  }
}

main().catch((err) => {
  log(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
