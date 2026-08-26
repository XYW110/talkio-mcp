# talkio-mcp-expert-council

一个 MCP (Model Context Protocol) 服务器，为任意兼容 MCP 的 AI 客户端（Claude Desktop、Snow CLI 等）提供「专家团」能力：并行多视角咨询与多轮头脑风暴（辩论 / 接龙）。

## 特性

- **`list_experts`** — 列出当前可用专家的 id、名称、provider 与模型。调用其他工具前先用它确认专家 id。
- **`consult_experts`** — 向一组 AI 专家并行咨询同一个问题，返回结构化的多视角咨询报告。单个专家失败不会阻塞其他专家，失败项以 ⚠️ 标注。
- **`brainstorm`** — 组织专家围绕主题进行多轮对话（**debate** 辩论 / **relay** 接龙），专家可见彼此观点并相互质疑、补充、深化，最终可选产出总结。
- **多 Provider 支持** — OpenAI、Anthropic，以及任意 OpenAI 兼容 API（DeepSeek、Moonshot、Qwen 等，纯配置接入，无需新代码）。
- **可扩展专家系统** — 通过 `experts.json` 自定义专家角色（系统提示词、模型、温度等），随附 5 个预置专家模板。
- **双传输模式** — Stdio（本地，默认）与 HTTP/SSE（远程）。
- **密钥安全** — API Key 仅通过环境变量注入，绝不写入配置文件。
- **容器化部署** — 多阶段 Dockerfile + docker-compose 一键启动。

## 快速开始

要求 Node.js >= 18（推荐 20 LTS）。

```bash
npm install
npm run build
```

## 配置说明

### experts.json

专家与 Provider 定义文件，默认读取仓库根目录的 `experts.json`（可用 `--config <path>` 或环境变量 `TALKIO_EXPERTS_CONFIG` 覆盖）。

```jsonc
{
  "defaults": {
    "provider": "openai", // 专家未指定 provider 时使用的缺省值
    "model": "gpt-4o-mini",
    "temperature": 0.7,
    "maxTokens": 2048,
    "timeoutMs": 120000 // 单次 AI 调用超时（毫秒）
  },
  "providers": {
    "openai": {
      "type": "openai", // openai | anthropic | openai-compatible
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY" // 指向环境变量名，不直接写 key
    },
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "deepseek": {
      "type": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "experts": [
    {
      "id": "architect", // 唯一 id，工具调用时按 id 选择专家
      "name": "架构师",
      "icon": "🏛️",
      "systemPrompt": "你是一位资深软件架构师……",
      "provider": "openai", // 引用 providers 中的 key，可省略走 defaults
      "model": "gpt-4o", // 专家级字段覆盖 defaults
      "temperature": 0.7,
      "enabled": true
    }
  ]
}
```

### 环境变量（API Key）

Key 只通过环境变量提供，`experts.json` 中 `apiKeyEnv` 指定变量名。本地开发可在根目录创建 `.env`（已通过 dotenv 自动加载，且被 gitignore）：

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
```

缺 key 的 Provider 在调用时惰性报错（`Provider X: missing env var Y`），不影响其他专家返回。

## MCP 客户端配置

### Claude Desktop

编辑 `claude_desktop_config.json`，加入（stdio 模式）：

```json
{
  "mcpServers": {
    "talkio-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/talkio_mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### Cursor

在 Cursor 的 MCP 配置（通常是项目 `.cursor/mcp.json` 或用户级 `mcp.json`）中加入：

```json
{
  "mcpServers": {
    "talkio-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/talkio_mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

接入后先调用 `list_experts` 查看专家 id 与就绪状态，再把 id 传给 `consult_experts` / `brainstorm`。缺 key 的专家仍可显式指定，但该项会失败。

### Snow CLI

在 Snow CLI 的 MCP 配置中加入（本地开发用 `node dist/index.js`；发布到 npm 后才可用 `npx talkio-mcp`）：

```json
{
  "mcpServers": {
    "talkio-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/talkio_mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## 工具用法

### list_experts — 列出可用专家

只读发现工具，不调用任何 AI Provider。默认只返回 `enabled: true` 的专家。

| 参数              | 类型    | 必填 | 说明                           |
| ----------------- | ------- | ---- | ------------------------------ |
| `includeDisabled` | boolean | 否   | 是否包含未启用专家，默认 false |

示例：

```json
{
  "includeDisabled": false
}
```

### consult_experts — 专家团咨询

并行咨询多个专家，返回 Markdown 咨询报告。

未指定 `experts` 时，只选已启用且对应 API Key 已配置的专家，按 `experts.json` 顺序最多 3 位；缺 key 的专家会在报告末尾说明原因，不会发请求。显式传入 `experts` 时按名单调用（缺 key 的该项失败，不影响其他人）。

| 参数       | 类型     | 必填 | 说明                                                  |
| ---------- | -------- | ---- | ----------------------------------------------------- |
| `question` | string   | 是   | 要咨询的问题（去空白后不能为空）                      |
| `context`  | string   | 否   | 背景信息（代码片段、约束等）                          |
| `experts`  | string[] | 否   | 专家 id 列表；缺省使用有 key 的启用专家（最多 3 位）  |
| `parallel` | boolean  | 否   | 是否并行调用专家（默认 true）；false 时按顺序逐个调用 |

示例：

```json
{
  "question": "这个订单系统如何做水平扩展？",
  "context": "当前单体架构，峰值 QPS 2000，MySQL 主从",
  "experts": ["architect", "performance"]
}
```

### brainstorm — 多轮头脑风暴

专家围绕主题多轮对话，输出讨论实录与可选总结。

未指定时默认最多 3 位有 key 的启用专家、1 轮、不总结。显式传入 `experts` / `rounds` / `summarize` 时按调用方指定（`experts` 上限仍为 6）。

| 参数        | 类型            | 必填 | 说明                                                            |
| ----------- | --------------- | ---- | --------------------------------------------------------------- |
| `topic`     | string          | 是   | 讨论主题（去空白后不能为空）                                    |
| `mode`      | debate 或 relay | 否   | 辩论（默认）或接龙                                              |
| `rounds`    | integer         | 否   | 轮数，1-5，默认 1                                               |
| `experts`   | string[]        | 否   | 专家 id 列表（上限 6 位）；缺省为有 key 的启用专家（最多 3 位） |
| `summarize` | boolean         | 否   | 是否产出总结，默认 false                                        |

示例：

```json
{
  "topic": "AI Agent 在客服场景的落地路径",
  "mode": "debate",
  "rounds": 3,
  "summarize": true
}
```

## SSE 模式

SSE 传输用于远程 / 多客户端接入，默认绑定 `127.0.0.1:3100`：

```bash
node dist/index.js --transport sse --port 3100
```

需要对外暴露时显式指定 `--host`（注意：SSE 模式无认证，请仅在可信网络中绑定非回环地址）：

```bash
node dist/index.js --transport sse --port 3100 --host 0.0.0.0
```

客户端连接地址：`http://127.0.0.1:3100/sse`

## Docker 部署

### 构建镜像

```bash
docker build -t talkio-mcp .
```

### 运行容器

单环境变量注入：

```bash
docker run -e OPENAI_API_KEY=sk-... -p 3100:3100 talkio-mcp
```

使用 env 文件：

```bash
docker run --env-file .env -p 3100:3100 talkio-mcp
```

挂载自定义专家配置（只读）：

```bash
docker run --env-file .env -p 3100:3100 \
  -v $(pwd)/experts.json:/app/experts.json:ro \
  talkio-mcp
```

容器默认以 SSE 模式启动（`--transport sse --port 3100 --host 0.0.0.0`）。需要 stdio 模式可覆盖 CMD：

```bash
docker run -i --env-file .env talkio-mcp --transport stdio
```

### docker compose

```bash
docker compose up
```

`docker-compose.yml` 默认：构建当前目录镜像、映射 `3100:3100`、加载 `.env`、只读挂载 `./experts.json`、`restart: unless-stopped`。

## 开发说明

```bash
npm run dev        # tsx 直接运行 src/index.ts（无需构建）
npm test           # vitest 单元测试（config / providers / orchestrator）
npm run typecheck  # tsc --noEmit 类型检查
npm run build      # 编译到 dist/
node scripts/smoke-stdio.mjs   # stdio 冒烟测试（TALKIO_MOCK_PROVIDER=1，无需真实 key）
```

## License

MIT
