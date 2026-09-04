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
import {
  brainstormFollowupSchema,
  handleBrainstormFollowup,
} from "./tools/brainstorm-followup.js";
import { listCardsSchema, handleListCards } from "./tools/list-cards.js";
import { createMcpNotifier } from "./utils/notify.js";
import { startSession } from "./records/store.js";
import type { RecordSession } from "./records/store.js";

/** Server identity advertised to MCP clients. */
export const SERVER_NAME = "talkio-mcp-expert-council";
export const SERVER_VERSION = "0.1.0";

/**
 * Create and configure the MCP server. The config is captured in the closure
 * of each tool handler so the handlers receive it without globals.
 */
export function createServer(
  config: AppConfig,
  options?: { recordsDir?: string }
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } }
  );
  const recordsDir = options?.recordsDir;

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
      const record =
        (await startSession(
          { tool: "consult_experts", prompt: args.question, context: args.context },
          recordsDir
        )) ?? undefined;
      const result = await handleConsultExperts(args, config, {
        notifier,
        record,
      });
      finishOnError(record, result);
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
      const record =
        (await startSession(
          {
            tool: "brainstorm",
            prompt: args.topic,
            mode: args.mode ?? "debate",
            rounds: args.rounds ?? 1,
          },
          recordsDir
        )) ?? undefined;
      const result = await handleBrainstorm(args, config, { notifier, record });
      finishOnError(record, result);
      return result;
    }
  );

  // brainstorm_followup: deepen a prior brainstorm with a follow-up question.
  server.registerTool(
    "brainstorm_followup",
    {
      title: "追问深化",
      description:
        "基于上一次 brainstorm 讨论实录(turns)与一个追问问题,让全体角色卡或指定单张卡继续深化作答,输出第 N 轮追问实录。\n\n调用方式：先调用 brainstorm 获得报告,从该返回值保留 turns 数组,连同 question 一起传入本工具。turns 为空或格式非法时降级为无上下文追问,并在报告中标注。\n\n隐私约定：调用前请把追问问题与实录中的个人敏感信息替换为占位符后再传入——姓名→[人名]，地名/住址/城市→[地名]，公司/机构名→[机构]；手机号/身份证/邮箱/银行卡/微信号等将由系统在发往模型前自动脱敏。",
      inputSchema: brainstormFollowupSchema,
    },
    async (args) => {
      // 本次不接入流式通知（PRD Notes）：followup 单轮、非多轮编排。
      const record =
        (await startSession(
          {
            tool: "brainstorm_followup",
            prompt: args.question,
            degraded: !isValidTurnsInput(args.turns),
            prevTurnsCount: args.turns?.length ?? 0,
          },
          recordsDir,
        )) ?? undefined;
      const result = await handleBrainstormFollowup(args, config, { record });
      finishOnError(record, result);
      return result;
    },
  );

  return server;
}

/**
 * 安全网：handler 的校验失败/早退路径可能未调用 record.finish()，
 * 导致记录文件缺 done 行。此处对 isError 结果补写 error 终态。
 * finish() 自带 closed 幂等标志，handler 已正常 finish 时这里是空操作。
 */
function finishOnError(
  record: RecordSession | undefined,
  result: unknown
): void {
  if (record && result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
    record.finish({ status: "error" });
  }
}

/** 简化的 turns 有效性判定，仅供记录 meta 标注 degraded 用（完整判定在 handler）。 */
function isValidTurnsInput(turns: unknown): boolean {
  return (
    Array.isArray(turns) &&
    turns.length > 0 &&
    turns.every(
      (t) =>
        t !== null &&
        typeof t === "object" &&
        typeof (t as { round?: unknown }).round === "number" &&
        typeof (t as { content?: unknown }).content === "string"
    )
  );
}