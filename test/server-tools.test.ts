import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { KNOWN_TOOLS } from "../src/config.js";
import type { AppConfig, CardConfig } from "../src/types.js";

/**
 * server 级工具注册契约（task 09-13-council-enhancement-p2 / P2-B 工具开关）：
 * - 缺省（无 disabledTools）→ 全部 4 个工具注册，tools/list 可见；
 * - disabledTools 含 brainstorm_followup → 不注册，tools/list 不可见，
 *   调用返回「not found」（SDK 默认行为）；
 * - 核心工具（list_cards/consult_experts/brainstorm）在 loadConfig 层已拒绝禁用，
 *   注册处兜底守卫仅覆盖 disabledTools 通道。
 */

function makeCard(id: string): CardConfig {
  return {
    id,
    name: id,
    expertId: "expert",
    modelId: "model",
    enabled: true,
  };
}

function configWith(disabledTools?: string[]): AppConfig {
  return {
    providers: {},
    experts: [],
    models: [],
    cards: [makeCard("c-a"), makeCard("c-b")],
    ...(disabledTools ? { disabledTools } : {}),
  };
}

async function connect(config: AppConfig): Promise<Client> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

const ALL_TOOLS = ["list_cards", "consult_experts", "brainstorm", "brainstorm_followup"];

describe("createServer 工具注册（disabledTools）", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("缺省全开：tools/list 含全部 4 个已知工具", async () => {
    client = await connect(configWith());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());
    expect(KNOWN_TOOLS).toHaveLength(4);
  });

  it("disabledTools 含 followup：tools/list 不含它，其余工具仍在", async () => {
    client = await connect(configWith(["brainstorm_followup"]));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("brainstorm_followup");
    expect(names).toContain("list_cards");
    expect(names).toContain("consult_experts");
    expect(names).toContain("brainstorm");
  });

  it("禁用 followup 后调用它返回 not found 错误", async () => {
    client = await connect(configWith(["brainstorm_followup"]));
    // SDK 1.30：未知工具经 callTool 返回 isError 结果（文本含 "not found"）
    const result = await client.callTool({
      name: "brainstorm_followup",
      arguments: { question: "x" },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("not found");
    expect(text).toContain("brainstorm_followup");
  });
});
