#!/usr/bin/env node
/**
 * smoke-stdio.mjs — MCP stdio 冒烟测试（无需真实 API key）
 *
 * 前置条件：已执行 `npm run build` 生成 dist/index.js。
 * 行为：
 *   1. 以 TALKIO_MOCK_PROVIDER=1 spawn `node dist/index.js`
 *   2. 通过 @modelcontextprotocol/sdk Client + StdioClientTransport 建立连接
 *   3. 断言 listTools() 包含 consult_experts 与 brainstorm
 *   4. 调用 consult_experts（question: "测试问题"），断言返回非空 mock 报告
 *   5. 打印 PASS / FAIL，以 0 / 1 退出
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, "..", "dist", "index.js");

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.error(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: {
    ...process.env,
    TALKIO_MOCK_PROVIDER: "1",
  },
  stderr: "pipe",
});

const client = new Client(
  { name: "talkio-smoke-client", version: "0.1.0" },
  { capabilities: {} },
);

let exitCode = 0;
try {
  console.error(`[smoke] spawning server: node ${serverEntry}`);
  await client.connect(transport);
  console.error("[smoke] connected via stdio");

  // 1. tools/list
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check("listTools 返回 consult_experts", names.includes("consult_experts"), `实际: ${names.join(",")}`);
  check("listTools 返回 brainstorm", names.includes("brainstorm"), `实际: ${names.join(",")}`);

  // 2. 调用 consult_experts（mock provider echo）
  const result = await client.callTool({
    name: "consult_experts",
    arguments: { question: "测试问题" },
  });

  check("consult_experts 未返回 isError", result.isError !== true, JSON.stringify(result).slice(0, 200));

  const textBlocks = (result.content ?? []).filter((c) => c.type === "text");
  check("consult_experts 返回至少一个 text 内容块", textBlocks.length >= 1);

  const report = textBlocks.map((c) => c.text).join("\n");
  check("mock 报告非空", typeof report === "string" && report.trim().length > 0);
} catch (err) {
  failures += 1;
  console.error(`[smoke] 异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
} finally {
  try {
    await client.close();
  } catch {
    // 忽略关闭阶段的异常，不影响判定
  }
}

if (failures === 0) {
  console.error("PASS: smoke-stdio 全部断言通过");
  exitCode = 0;
} else {
  console.error(`FAIL: smoke-stdio 有 ${failures} 项断言失败`);
  exitCode = 1;
}

process.exit(exitCode);
