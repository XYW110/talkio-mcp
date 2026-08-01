# talkio-mcp-expert-council

## Goal

构建一个 MCP (Model Context Protocol) 服务器，为 AI 客户端提供"专家团"咨询和头脑风暴能力。借鉴 Talkio 客户端的多模型群聊理念，将其转化为服务端 MCP 工具，让任何支持 MCP 的 AI 客户端（如 Claude Desktop、Snow CLI 等）都能调用一组预设的 AI 专家角色进行多角度问题分析和讨论。

## Background

Talkio 是一个 Tauri 2 + React 19 构建的桌面客户端，核心特色是"多模型群聊"——让多个 AI 模型在同一对话中扮演不同角色（Persona），围绕同一话题展开讨论、辩论。每个参与者拥有独立的系统提示词、温度参数和推理力度设置。

本项目将这一理念从客户端迁移到 MCP 服务端，使任何 MCP 兼容的 AI 工具都能获得"专家团"能力，而无需依赖特定客户端。

## Confirmed Facts

- Talkio 客户端使用 `@modelcontextprotocol/sdk` 作为 MCP 客户端连接外部工具服务器
- Talkio 的 Persona 系统包含：name, icon, systemPrompt, params (temperature), mcpToolIds, mcpServerIds
- Talkio 支持两种 MCP 传输模式：SSE (远程) 和 Stdio (本地)
- MCP 协议标准：JSON-RPC over stdio 或 HTTP/SSE
- 当前工作目录 `talkio_mcp` 是一个空项目，需要从零构建 MCP 服务器

## Requirements

### R1: MCP 服务器核心框架

- 使用 TypeScript + Node.js 构建 MCP 服务器
- 支持 Stdio 传输模式（本地调用）
- 支持 SSE/HTTP 传输模式（远程调用）
- 遵循 MCP 协议规范（tools/list, tools/call）

### R2: 专家角色系统

- 预定义一组专家角色（如：架构师、安全专家、性能专家、代码审查员、产品思维专家等）
- 每个专家拥有独立的系统提示词和参数配置
- 支持自定义专家角色的扩展机制

### R3: 专家团咨询工具

- 提供 `consult_experts` MCP 工具，接受问题描述和可选的专家列表
- 并行或串行调用多个 AI 模型获取不同专家视角的回答
- 汇总并格式化专家意见，呈现为结构化的咨询报告

### R4: 头脑风暴工具

- 提供 `brainstorm` MCP 工具，针对特定主题生成多角度观点
- 支持辩论模式（专家之间相互质疑和补充）
- 支持接龙模式（专家依次深化和发展观点）

### R5: 多 Provider 支持

- 支持配置多个 AI Provider（OpenAI, Anthropic, DeepSeek, 等）
- 每个专家可以绑定不同的 Provider 和模型
- 统一的 API 调用抽象层

### R6: Docker 部署支持

- 提供多阶段构建的 Dockerfile，产出精简的生产镜像
- 提供 docker-compose 示例（SSE 模式一键启动）
- README 包含容器化部署文档（环境变量注入、配置文件挂载）

## Acceptance Criteria

- [ ] MCP 服务器可以通过 Stdio 模式被 Snow CLI 等客户端连接
- [ ] `tools/list` 返回 `consult_experts` 和 `brainstorm` 工具定义
- [ ] `consult_experts` 调用后返回多个专家角色的独立回答
- [ ] `brainstorm` 调用后返回结构化的多角度讨论内容
- [ ] 支持至少 3 个预定义专家角色
- [ ] 支持自定义专家角色配置
- [ ] 支持至少 2 个 AI Provider 的配置

## Out of Scope

- 图形用户界面（GUI）
- 对话历史持久化存储
- 用户认证和权限管理
- 移动端支持

## Resolved Decisions

1. **AI 调用方式：选项 A — MCP 服务器直接调用 AI API**

   - 服务器持有 API Key，直接调用 OpenAI/Anthropic/DeepSeek 等 Provider
   - 客户端零配置，即插即用
   - 支持多轮专家对话（专家之间可以看到彼此的观点并回应）
   - API Key 通过环境变量或本地配置文件管理

2. **专家角色配置存储：选项 A — JSON 配置文件**

   - 用户编辑 `experts.json` 定义专家：name, systemPrompt, provider, model, temperature
   - 结构清晰，支持复杂配置，易于版本控制和共享专家模板
   - 提供默认的 `experts.json` 模板，降低上手门槛
   - API Key 等敏感信息仍通过环境变量覆盖

3. **专家对话模式：支持多轮专家对话**
   - 专家 A 回答后，专家 B 能看到 A 的回答并回应（赞同/质疑/补充）
   - 支持多轮迭代，直到达到指定轮数或收敛
   - 真正的"头脑风暴"体验，观点碰撞产生更深入的洞察
   - `consult_experts` 默认单轮并行（快速咨询），`brainstorm` 使用多轮对话（深度讨论）

## Open Questions

（无阻塞问题）

## Technical Notes

- TypeScript + Node.js MCP 服务器，使用 `@modelcontextprotocol/sdk` 高级 API
- 支持两种传输模式：Stdio（默认，MVP）和 SSE/HTTP
- 非流式 AI 调用（MCP `tools/call` 返回单次结果）
- API Key 仅通过环境变量管理，`experts.json` 中使用 `apiKeyEnv` 间接引用
- 非目标：无 GUI、无持久化、无认证、无移动端、无 Token 流式传输
