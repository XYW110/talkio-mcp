/**
 * MCP server assembly.
 *
 * createServer() builds a high-level McpServer, registers the two tools
 * (consult_experts, brainstorm) with zod raw-shape input schemas, and returns
 * the server instance ready to be connected to a transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./types.js";
import {
  consultExpertsSchema,
  handleConsultExperts,
} from "./tools/consult-experts.js";
import {
  brainstormSchema,
  handleBrainstorm,
} from "./tools/brainstorm.js";

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
    { capabilities: { logging: {} } },
  );

  // consult_experts: single-round parallel consultation.
  server.registerTool(
    "consult_experts",
    {
      title: "专家团咨询",
      description:
        "向一组 AI 专家并行咨询同一个问题,返回结构化的多视角咨询报告",
      inputSchema: consultExpertsSchema,
    },
    async (args) => {
      // args is already parsed/validated against consultExpertsSchema by the SDK.
      const result = await handleConsultExperts(args, config);
      return result;
    },
  );

  // brainstorm: multi-round debate / relay dialogue.
  server.registerTool(
    "brainstorm",
    {
      title: "专家头脑风暴",
      description:
        "组织 AI 专家围绕主题进行多轮头脑风暴(辩论或接龙),输出讨论实录与总结",
      inputSchema: brainstormSchema,
    },
    async (args) => {
      const result = await handleBrainstorm(args, config);
      return result;
    },
  );

  return server;
}
