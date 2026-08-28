#!/usr/bin/env node
/**
 * smoke-stdio.mjs — MCP stdio 冒烟测试（无需真实 API key）
 *
 * 前置条件：已执行 `npm run build` 生成 dist/index.js。
 * 行为：
 *   1. 以 TALKIO_MOCK_PROVIDER=1 spawn `node dist/index.js`
 *   2. 通过 @modelcontextprotocol/sdk Client + StdioClientTransport 建立连接
 *   3. 断言 listTools() 包含 list_cards / consult_experts / brainstorm
 *   4. 调用 list_cards，断言返回启用角色卡 id 与专家/模型展示名
 *   5. 调用 consult_experts + cards 参数，断言 mock 报告且非 isError
 *   6. 调用 brainstorm（1 轮、不总结），断言非 isError
 *   7. 调用 list_cards 对不存在的卡断言报错（isError）
 *   8. 打印 PASS / FAIL，以 0 / 1 退出
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

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
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

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check("listTools 返回 list_cards", names.includes("list_cards"), `实际: ${names.join(",")}`);
  check("listTools 返回 consult_experts", names.includes("consult_experts"), `实际: ${names.join(",")}`);
  check("listTools 返回 brainstorm", names.includes("brainstorm"), `实际: ${names.join(",")}`);
  check("listTools 不再返回 list_experts", !names.includes("list_experts"), `实际: ${names.join(",")}`);

  const listed = await client.callTool({ name: "list_cards", arguments: {} });
  const listedText = textOf(listed);
  check("list_cards 未返回 isError", listed.isError !== true, JSON.stringify(listed).slice(0, 200));
  check("list_cards 包含 architect 卡", listedText.includes("architect-openai-gpt-4o"));
  check("list_cards 展示专家名", listedText.includes("架构师") || listedText.includes("architect"));
  check("list_cards 展示模型名", listedText.includes("gpt-4o"));

  const consult = await client.callTool({
    name: "consult_experts",
    arguments: { question: "测试问题", cards: ["architect-openai-gpt-4o"] },
  });
  const consultText = textOf(consult);
  check("consult_experts 未返回 isError", consult.isError !== true, JSON.stringify(consult).slice(0, 200));
  check("consult_experts 返回至少一个 text 内容块", consultText.trim().length > 0);
  check("consult_experts mock 标记", consultText.includes("[TALKIO-MOCK]"));

  const brainstorm = await client.callTool({
    name: "brainstorm",
    arguments: {
      topic: "测试主题",
      cards: ["architect-openai-gpt-4o"],
      rounds: 1,
      summarize: false,
    },
  });
  const brainstormText = textOf(brainstorm);
  check("brainstorm 未返回 isError", brainstorm.isError !== true, JSON.stringify(brainstorm).slice(0, 200));
  check("brainstorm mock 报告非空", brainstormText.trim().length > 0);

  const bad = await client.callTool({
    name: "consult_experts",
    arguments: { question: "测试问题", cards: ["no-such-card"] },
  });
  check("不存在的卡返回 isError 并列出可用卡", bad.isError === true && textOf(bad).includes("architect-openai-gpt-4o"), JSON.stringify(bad).slice(0, 300));
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