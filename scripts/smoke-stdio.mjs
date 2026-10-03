#!/usr/bin/env node
/**
 * smoke-stdio.mjs — MCP stdio 冒烟测试（无需真实 API key）
 *
 * 前置条件：已执行 `npm run build` 生成 dist/index.js。
 * 行为：
 *   1. 以 TALKIO_MOCK_PROVIDER=1 spawn `node dist/index.js`，并注入临时 keys.json
 *      （TALKIO_KEYS_FILE，按 experts.json 的 provider 列表写入 dummy key，
 *      覆盖 keys store 加载路径；mock 模式下密钥不参与凭据解析）
 *   2. 通过 @modelcontextprotocol/sdk Client + StdioClientTransport 建立连接
 *   3. 断言 listTools() 包含 list_cards / consult_experts / brainstorm
 *   4. 调用 list_cards，断言返回启用角色卡 id 与专家/模型展示名
*   5. 调用 consult_experts + cards 参数，断言 mock 报告且非 isError
 *   6. 调用 brainstorm（1 轮、不总结），断言非 isError
 *   7. 调用 list_cards 对不存在的卡断言报错（isError）
 *   8. 订阅 logging notifications（logger=talkio.stream），断言 consult 逐卡、
 *      每轮 brainstorm 的流式增量通知
 *   9. 打印 PASS / FAIL，以 0 / 1 退出
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, "..", "dist", "index.js");

/** 冒烟脚本默认卡 id 与专家展示名（需与 experts.json 当前配置保持一致） */
const DEFAULT_CARD = "card-security-deepseek";
const DEFAULT_EXPERT_NAME = "安全专家";
const DEFAULT_EXPERT_ID = "security";
const DEFAULT_MODEL_NAME = "deepseek-v4-flash";

// ── 临时 keys.json 注入（09-30-provider-keys-ui）──
// 按 experts.json 的 provider 列表写 dummy key，覆盖 keys store 的磁盘加载路径。
const repoRoot = resolve(__dirname, "..");
const expertsPath = resolve(repoRoot, "experts.json");
let providers = {};
try {
  const cfg = JSON.parse(await readFile(expertsPath, "utf8"));
  providers = cfg.providers ?? {};
} catch {
  providers = {}; // mock 模式下密钥不参与解析，读不到配置也能跑
}
const tmpKeysDir = await mkdtemp(resolve(tmpdir(), "talkio-smoke-keys-"));
const keysFile = resolve(tmpKeysDir, "keys.json");
await writeFile(
  keysFile,
  JSON.stringify({
    version: 1,
    providers: Object.fromEntries(
      Object.keys(providers).map((pid) => [
        pid,
        { apiKey: `sk-smoke-dummy-${pid}`, updatedAt: new Date().toISOString() },
      ]),
    ),
  }),
  "utf8",
);

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
    TALKIO_KEYS_FILE: keysFile,
  },
  stderr: "pipe",
});

const client = new Client(
  { name: "talkio-smoke-client", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

// 订阅流式增量通知（R4：logger=talkio.stream 的 logging notifications）。
// 必须在 connect 之前注册 handler（SDK 在 connect 时挂载到 transport）。
const streamEvents = [];
client.setNotificationHandler(LoggingMessageNotificationSchema, (notif) => {
  const params = notif.params;
  if (params && params.logger === "talkio.stream") streamEvents.push(params.data);
});

let exitCode = 0;
try {
  console.error(`[smoke] spawning server: node ${serverEntry}`);
await client.connect(transport);
  console.error("[smoke] connected via stdio");
  await client.setLoggingLevel("info");
  console.error("[smoke] logging level set to info");

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check("listTools 返回 list_cards", names.includes("list_cards"), `实际: ${names.join(",")}`);
  check("listTools 返回 consult_experts", names.includes("consult_experts"), `实际: ${names.join(",")}`);
check("listTools 返回 brainstorm", names.includes("brainstorm"), `实际: ${names.join(",")}`);
  check("listTools 返回 brainstorm_followup", names.includes("brainstorm_followup"), `实际: ${names.join(",")}`);
  check("listTools 不再返回 list_experts", !names.includes("list_experts"), `实际: ${names.join(",")}`);

  const listed = await client.callTool({ name: "list_cards", arguments: {} });
  const listedText = textOf(listed);
  check("list_cards 未返回 isError", listed.isError !== true, JSON.stringify(listed).slice(0, 200));
  check("list_cards 包含默认卡", listedText.includes(DEFAULT_CARD));
  check("list_cards 展示专家名", listedText.includes(DEFAULT_EXPERT_NAME));
  check("list_cards 展示模型名", listedText.includes(DEFAULT_MODEL_NAME));

  const consult = await client.callTool({
    name: "consult_experts",
    arguments: { question: "测试问题", cards: [DEFAULT_CARD] },
  });
const consultText = textOf(consult);
  check("consult_experts 未返回 isError", consult.isError !== true, JSON.stringify(consult).slice(0, 200));
  check("consult_experts 返回至少一个 text 内容块", consultText.trim().length > 0);
  check("consult_experts mock 标记", consultText.includes("[TALKIO-MOCK]"));

  const consultCards = streamEvents.filter((d) => d && d.type === "consult.card");
  check("consult 后收到 → consult.card 通知", consultCards.length >= 1, `实际: ${streamEvents.length} 条`);
  if (consultCards.length >= 1) {
    check(
      "consult.card 载荷含 card id 与状态",
      typeof consultCards[0].card === "string" &&
        (consultCards[0].status === "ok" || consultCards[0].status === "failed"),
      JSON.stringify(consultCards[0])
    );
  }

  const brainstorm = await client.callTool({
    name: "brainstorm",
    arguments: {
      topic: "测试主题",
      cards: [DEFAULT_CARD],
      rounds: 1,
      summarize: false,
    },
  });
const brainstormText = textOf(brainstorm);
  check("brainstorm 未返回 isError", brainstorm.isError !== true, JSON.stringify(brainstorm).slice(0, 200));
  check("brainstorm mock 报告非空", brainstormText.trim().length > 0);

  const brainstormRounds = streamEvents.filter((d) => d && d.type === "brainstorm.round");
  check(
    "每轮结束 → brainstorm.round 通知（total=1）",
    brainstormRounds.length >= 1 &&
      brainstormRounds.every((d) => d.type === "brainstorm.round" && d.total === 1),
    `实际: ${JSON.stringify(brainstormRounds)}`
  );

  const bad = await client.callTool({
    name: "consult_experts",
    arguments: { question: "测试问题", cards: ["no-such-card"] },
  });
check("不存在的卡返回 isError 并列出可用卡", bad.isError === true && textOf(bad).includes(DEFAULT_CARD), JSON.stringify(bad).slice(0, 300));

  // brainstorm_followup：带上一步 brainstorm 的 turns + 追问 → 全体（无 card）单轮追问
  const followup = await client.callTool({
    name: "brainstorm_followup",
    arguments: {
      question: "追问问题",
      turns: [
        { round: 1, expertId: DEFAULT_EXPERT_ID, expertName: DEFAULT_EXPERT_NAME, icon: "🤖", content: brainstormText },
      ],
    },
  });
  const followupText = textOf(followup);
  check("brainstorm_followup 未返回 isError", followup.isError !== true, JSON.stringify(followup).slice(0, 300));
check(
    "brainstorm_followup 报告含追问标记与延续轮次",
    followupText.includes("专家追问实录") && followupText.includes("第 2 轮追问"),
    followupText.slice(0, 300)
  );

  // 语义截断（08-28-semantic-truncation）：超预算 turns → 压缩器启用。
  // mock 回显 userContent → 报告应包含注入的【对话概要】概要前缀。
  const bigFollowup = await client.callTool({
    name: "brainstorm_followup",
    arguments: {
      question: "超长追问",
      turns: [
        { round: 1, expertId: "architect", expertName: "架构师", icon: "🤖", content: "长".repeat(13000) },
        { round: 2, expertId: "security", expertName: "安全师", icon: "🛡️", content: "超长补充意见".repeat(90) },
      ],
      cards: [DEFAULT_CARD],
    },
  });
  const bigFollowupText = textOf(bigFollowup);
  check(
    "超预算 followup 未返回 isError",
    bigFollowup.isError !== true,
    JSON.stringify(bigFollowup).slice(0, 300)
  );
  check(
    "超预算 followup 注入【对话概要·第1-2轮】概要前缀（压缩器启用）",
    bigFollowupText.includes("【对话概要·第1-2轮】"),
    bigFollowupText.slice(0, 300)
  );
  check(
    "超预算 followup 报告含第 3 轮追问标记",
    bigFollowupText.includes("第 3 轮追问"),
    bigFollowupText.slice(0, 300)
  );
} catch (err) {
  failures += 1;
  console.error(`[smoke] 异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
} finally {
  try {
    await client.close();
  } catch {
    // 忽略关闭阶段的异常，不影响判定
  }
  await rm(tmpKeysDir, { recursive: true, force: true }).catch(() => {});
}

if (failures === 0) {
  console.error("PASS: smoke-stdio 全部断言通过");
  exitCode = 0;
} else {
  console.error(`FAIL: smoke-stdio 有 ${failures} 项断言失败`);
  exitCode = 1;
}

process.exit(exitCode);