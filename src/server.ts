/**
 * MCP server assembly.
 *
 * createServer() builds a high-level McpServer, registers the three tools
 * (list_cards, consult_experts, brainstorm) with zod raw-shape input schemas,
 * and returns the server instance ready to be connected to a transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./types.js";
import {
  consultExpertsSchema,
  handleConsultExperts,
} from "./tools/consult-experts.js";
import { brainstormSchema, handleBrainstorm } from "./tools/brainstorm.js";
import { listCardsSchema, handleListCards } from "./tools/list-cards.js";
import { createMcpNotifier } from "./utils/notify.js";

/** Server identity advertised to MCP clients. */
export const SERVER_NAME = "talkio-mcp-expert-council";
export const SERVER_VERSION = "0.1.0";

/**
 * Create and configure the MCP server. The config is captured in the closure
 * of each tool handler so the handlers receive it without globals.
 */
export function createServer(config: AppConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } }
  );

  // 流式增量通知（design §1）：logging notifications 统一由闭包内注入。
  const notifier = createMcpNotifier(server);

// list_cards: discover configured role-card ids before consulting.
  server.registerTool(
    "list_cards",
    {
      title: "列出角色卡",
      description:
        "列出当前可用的角色卡 id、名称、专家与模型。调用 consult_experts / brainstorm 前先用本工具确认角色卡 id",
      inputSchema: listCardsSchema,
    },
    async (args) => {
      const result = await handleListCards(args, config);
      return result;
    }
  );

  // consult_experts: single-round parallel consultation.
  server.registerTool(
    "consult_experts",
    {
      title: "专家团咨询",
      description:
        "向一组角色卡（专家 × 模型）并行咨询同一个问题,返回结构化的多视角咨询报告。\n\n隐私约定：调用前请把问题与背景中的个人敏感信息替换为占位符后再传入——姓名→[人名]，地名/住址/城市→[地名]，公司/机构名→[机构]；手机号/身份证/邮箱/银行卡/微信号等将由系统在发往模型前自动脱敏。请勿把真实用户隐私原文直接传给本工具。",
      inputSchema: consultExpertsSchema,
    },
    async (args) => {
      // args is already parsed/validated against consultExpertsSchema by the SDK.
      const result = await handleConsultExperts(args, config, { notifier });
      return result;
    }
  );

  // brainstorm: multi-round debate / relay dialogue.
  server.registerTool(
    "brainstorm",
    {
      title: "角色卡头脑风暴",
      description:
        "组织一组角色卡围绕主题进行多轮头脑风暴(辩论或接龙),输出讨论实录与总结。\n\n隐私约定：调用前请把主题中的个人敏感信息替换为占位符后再传入——姓名→[人名]，地名/住址/城市→[地名]，公司/机构名→[机构]；手机号/身份证/邮箱/银行卡/微信号等将由系统在发往模型前自动脱敏。",
      inputSchema: brainstormSchema,
    },
    async (args) => {
      const result = await handleBrainstorm(args, config, { notifier });
      return result;
    }
  );

  return server;
}