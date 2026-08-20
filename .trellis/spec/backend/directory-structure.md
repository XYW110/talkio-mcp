# Directory Structure

> 后端代码在项目中的组织方式。

---

## 概述

本项目是一个 TypeScript ESM 项目，使用 `tsconfig.json`（`strict: true` + `noUncheckedIndexedAccess`）编译。所有源码位于 `src/` 目录下，由 `tsc` 编译到 `dist/`。

---

## 目录布局

```
talkio-mcp-expert-council/
├── src/
│   ├── index.ts              # CLI 入口，解析 argv、加载配置、启动 MCP server
│   ├── server.ts             # MCP 服务器工厂（创建 server + 注册工具）
│   ├── config.ts             # 配置加载：dotenv → experts.json → zod 校验 → defaults 合并
│   ├── types.ts              # 共享类型定义（AppConfig, ExpertConfig, ProviderConfig 等）
│   ├── providers/
│   │   ├── adapter.ts        # 抽象层接口（ProviderAdapter, ChatParams, ChatResult）
│   │   ├── registry.ts       # Adapter 工厂注册表（type 名 → adapter 实例，含 mock 模式）
│   │   ├── openai.ts         # OpenAI adapter（复用 openai-compatible）
│   │   ├── anthropic.ts      # Anthropic adapter（专用实现，system 拆分 + x-api-key）
│   │   └── openai-compatible.ts  # 通用 OpenAI 兼容 adapter（DeepSeek/Moonshot/Qwen 等）
│   ├── orchestrator/
│   │   ├── parallel.ts       # 单轮并行咨询引擎（consult_experts 工具）
│   │   └── dialogue.ts       # 多轮对话引擎（brainstorm 工具，辩论/接龙模式）
│   ├── tools/
│   │   ├── list-experts.ts    # list_experts MCP 工具定义（发现专家 id）
│   │   ├── consult-experts.ts # consult_experts MCP 工具定义
│   │   └── brainstorm.ts     # brainstorm MCP 工具定义
│   └── utils/
│       ├── retry.ts          # fetch 封装：AbortController 超时 + 指数退避重试
│       └── format.ts         # 纯字符串构建器（Markdown 报告格式化，无 IO/无 LLM 调用）
├── test/
│   ├── config.test.ts        # loadConfig + resolveProviderCredentials 契约测试
│   ├── orchestrator.test.ts  # runConsultation + runDialogue 编排测试
│   ├── list-experts.test.ts  # list_experts 发现工具测试
│   └── providers.test.ts     # fetchWithRetry 重试策略 + adapter 实现测试
├── scripts/
│   └── smoke-stdio.mjs       # Stdio 冒烟测试脚本
├── experts.json              # 默认专家/Provider 配置文件
├── package.json              # 包配置（type: module, 构建/测试/运行脚本）
├── tsconfig.json             # TypeScript 编译配置
├── Dockerfile                # 多阶段构建容器镜像
└── README.md                 # 项目文档
```

---

## 模块职责

| 模块          | 路径                           | 职责                                                                                                                          |
| ------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 入口          | `src/index.ts`                 | CLI argv 解析（`--transport`/`--port`/`--host`/`--config`），创建 server，连接 stdio 或 SSE 传输                              |
| 服务器        | `src/server.ts`                | 创建 MCP 服务器，注册 `list_experts`、`consult_experts` 和 `brainstorm` 三个工具                                              |
| 配置          | `src/config.ts`                | 加载 `experts.json`，zod 校验，defaults 合并，API key 惰性解析                                                                |
| 类型          | `src/types.ts`                 | 运行时类型定义（`AppConfig`/`ExpertConfig`/`ProviderConfig`/`ProviderCredentials`）                                           |
| Provider 抽象 | `src/providers/adapter.ts`     | `ProviderAdapter` 接口定义（`chat(params, creds): Promise<ChatResult>`）                                                      |
| Provider 注册 | `src/providers/registry.ts`    | 按 type 名获取 adapter，支持 `TALKIO_MOCK_PROVIDER` 环境变量切换 mock                                                         |
| 编排引擎      | `src/orchestrator/parallel.ts` | 单轮并行咨询（`Promise.allSettled`），失败不阻塞整体；`TALKIO_MOCK_PROVIDER=1` 时必须在 `resolveProviderCredentials` 之前短路 |
| 对话引擎      | `src/orchestrator/dialogue.ts` | 多轮辩论/接龙，Panel 预算控制，可选总结；mock 短路规则与 parallel 相同                                                        |
| 工具          | `src/tools/list-experts.ts`    | `list_experts` MCP 工具 schema 与 handler                                                                                     |
| 工具          | `src/tools/consult-experts.ts` | `consult_experts` MCP 工具 schema 与 handler                                                                                  |
| 工具          | `src/tools/brainstorm.ts`      | `brainstorm` MCP 工具 schema 与 handler                                                                                       |
| 重试          | `src/utils/retry.ts`           | 带超时与指数退避重试的 `fetch` 封装，密钥脱敏                                                                                 |
| 格式化        | `src/utils/format.ts`          | 纯函数生成 Markdown 报告，无副作用                                                                                            |

---

## 命名约定

- **文件命名**：camelCase，`.ts` 扩展名（如 `config.ts`、`openai-compatible.ts`、`consult-experts.ts`）
- **导入路径**：ESM 风格，带 `.js` 后缀（如 `import { loadConfig } from "./config.js"`）
- **TypeScript 接口**：`PascalCase`（如 `AppConfig`、`ProviderAdapter`、`ConsultationItem`）
- **类型别名**：`PascalCase`（如 `ProviderType`）
- **函数/变量**：`camelCase`（如 `loadConfig`、`fetchWithRetry`、`runConsultation`）
- **常量**：`UPPER_SNAKE_CASE` 或 `PascalCase`（如 `DEFAULT_TIMEOUT_MS`、`MOCK_MARKER`、`SEED_INSTRUCTION`）
- **测试文件**：`<模块名>.test.ts`（如 `config.test.ts`、`providers.test.ts`）

---

## 示例

- **配置加载模块**：`src/config.ts`（294 行）—— 清晰的「文件读取 → JSON 解析 → zod 校验 → defaults 合并 → 语义检查」流水线，是模块职责单一的典范。
- **Provider 抽象层**：`src/providers/adapter.ts`（35 行）—— 极简接口定义，各实现（`openai.ts`、`anthropic.ts`、`openai-compatible.ts`）独立且可测试。
- **编排引擎**：`src/orchestrator/parallel.ts`（165 行）—— `callExpert` 与 `runConsultation` 分离，并行/串行切换清晰，错误隔离。
