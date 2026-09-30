#!/usr/bin/env node
/**
 * smoke-sse.mjs — SSE 鉴权冒烟测试（本地自检 / 部署后公网验证两用）。
 *
 * 用法：
 *   1. 本地自检（自动起服务，无需真实 API key）:
 *        TALKIO_ADMIN_TOKEN=dev node scripts/smoke-sse.mjs
 *      前置条件：已执行 `npm run build`（需要 dist/index.js）。
 *      行为：以 mock 模式 + 测试 admin token + 预置 MCP 令牌的临时令牌文件
 *      启动本地 SSE 服务，断言：
 *        a) 无凭证访问 /sse、/api/config → 401
 *        b) 带 admin token 访问 /api/config → 200（admin 池）
 *        c) 带 MCP 令牌完成 SSE 握手并调用 list_cards → 成功（MCP 池）
 *
 *   2. 部署后公网验证（不启动本地服务）:
 *        node scripts/smoke-sse.mjs <base-url> <mcp-token>
 *        例: node scripts/smoke-sse.mjs http://111.229.147.203:3100 mtok_xxxx
 *      行为：断言公网无凭证 401 → 用给定 MCP 令牌完成 SSE 握手 + list_cards。
 *
 * 输出 PASS / FAIL，以 0 / 1 退出。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, "..", "dist", "index.js");

const LOCAL_PORT = Number(process.env.SMOKE_PORT ?? 3199);

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.error(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** 带 Bearer 凭证的 fetch（SSE GET 与 JSON-RPC POST 共用）。 */
function authedFetch(token) {
  return (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    });
}

/** 用 MCP 令牌建立 SSE 传输（GET /sse 与 POST /messages 都带 Bearer）。 */
function sseTransport(base, token) {
  const url = new URL("/sse", base);
  return new SSEClientTransport(url, {
    eventSourceInit: { fetch: authedFetch(token) },
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** 无凭证 /sse 握手应 401（EventSource 等价行为）。 */
async function expectUnauthorized401(base, label) {
  const res = await fetch(new URL("/sse", base));
  check(`${label}：无凭证 GET /sse → 401`, res.status === 401, `实际 ${res.status}`);
  try {
    await res.text();
  } catch {
    /* 忽略读取异常 */
  }
}

/** 连接 MCP 并断言 list_cards 可用。 */
async function checkListCards(base, token) {
  const client = new Client(
    { name: "talkio-smoke-sse", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = sseTransport(base, token);
  try {
    await client.connect(transport);
    check("SSE 握手成功（带 MCP 令牌）", true);
    const listed = await client.callTool({ name: "list_cards", arguments: {} });
    const text = textOf(listed);
    check(
      "list_cards 调用成功（非 isError 且有内容）",
      listed.isError !== true && text.trim().length > 0,
      JSON.stringify(listed).slice(0, 200),
    );
  } finally {
    try {
      await client.close();
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

/** 等待本地端口可访问（任何 HTTP 状态都算就绪）。 */
async function waitForServer(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(base);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

// ── 主流程 ──

const [baseUrlArg, mcpTokenArg] = process.argv.slice(2);

if (baseUrlArg && mcpTokenArg) {
  // ── 远程模式：公网验证 ──
  console.error(`[smoke] 远程模式: ${baseUrlArg}`);
  await expectUnauthorized401(baseUrlArg, "远程");
  await checkListCards(baseUrlArg, mcpTokenArg);
} else {
  // ── 本地模式：自动起服务 ──
  if (!existsSync(serverEntry)) {
    console.error(`[smoke] 未找到 ${serverEntry}，请先执行 npm run build`);
    process.exit(1);
  }
  const adminToken = process.env.TALKIO_ADMIN_TOKEN || "dev";
  const mcpPlaintext = `mtok_${randomBytes(24).toString("base64url")}`;
  const mcpHash = createHash("sha256").update(mcpPlaintext, "utf8").digest("hex");

  const tmpDir = await mkdtemp(join(tmpdir(), "talkio-smoke-sse-"));
  const tokensFile = resolve(tmpDir, "mcp-tokens.json");
  await writeFile(
    tokensFile,
    JSON.stringify({
      version: 1,
      tokens: [
        {
          id: "mtok_smoke0000000",
          name: "smoke-sse",
          tokenHash: mcpHash,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      ],
    }),
    "utf8",
  );

  // experts.json 缺失时回退镜像同款脱敏默认配置
  const repoRoot = resolve(__dirname, "..");
  const expertsPath = existsSync(resolve(repoRoot, "experts.json"))
    ? resolve(repoRoot, "experts.json")
    : resolve(repoRoot, "experts.default.json");

  const base = `http://127.0.0.1:${LOCAL_PORT}`;
  const child = spawn(
    process.execPath,
    [serverEntry, "--transport", "sse", "--port", String(LOCAL_PORT), "--host", "127.0.0.1", "--config", expertsPath],
    {
      env: {
        ...process.env,
        TALKIO_MOCK_PROVIDER: "1",
        TALKIO_ADMIN_TOKEN: adminToken,
        TALKIO_MCP_TOKENS_FILE: tokensFile,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let serverLog = "";
  child.stderr.on("data", (d) => {
    serverLog += String(d);
  });

  try {
    console.error(`[smoke] 本地模式: spawning server (port ${LOCAL_PORT}, mock 模式)`);
    const ready = await waitForServer(base);
    check("本地服务已就绪", ready, serverLog.slice(-300));

    await expectUnauthorized401(base, "本地");

    const apiNoAuth = await fetch(new URL("/api/config", base));
    check("本地：无凭证 GET /api/config → 401", apiNoAuth.status === 401, `实际 ${apiNoAuth.status}`);
    try {
      await apiNoAuth.text();
    } catch {
      /* 忽略 */
    }

    const apiWithAdmin = await fetch(new URL("/api/config", base), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    check(
      "本地：带 admin token GET /api/config → 200",
      apiWithAdmin.status === 200,
      `实际 ${apiWithAdmin.status}`,
    );
    try {
      await apiWithAdmin.text();
    } catch {
      /* 忽略 */
    }

    await checkListCards(base, mcpPlaintext);
  } finally {
    child.kill();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (failures === 0) {
  console.error("PASS: smoke-sse 全部断言通过");
  process.exit(0);
} else {
  console.error(`FAIL: smoke-sse 有 ${failures} 项断言失败`);
  process.exit(1);
}
