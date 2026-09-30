# talkio-mcp-expert-council

一个 MCP (Model Context Protocol) 服务器，为任意兼容 MCP 的 AI 客户端（Claude Desktop、Snow CLI 等）提供「专家团」能力：并行多视角咨询与多轮头脑风暴（辩论 / 接龙）。

## 特性

- **`list_cards`** — 列出当前可用角色卡（专家+模型的绑定）的 id、名称、专家名、模型名、Provider，以及是否已配置 API Key。调用其他工具前先用它确认角色卡 id 与就绪状态。**不再有 `list_experts`**，专家和模型已解绑为独立概念。
- **`consult_experts`** — 向一组角色卡并行咨询同一个问题，返回结构化的多视角咨询报告。单张卡失败不会阻塞其他卡，失败项以 ⚠️ 标注。支持 `select: "auto"` 信号路由选卡。
- **`brainstorm`** — 组织多张角色卡围绕主题进行多轮对话（**debate** 辩论 / **relay** 接龙），卡片可见彼此观点并相互质疑、补充、深化。进阶能力：
  - **证据包锚定** — `evidence` 传入代码/数据/文档引文，编号 [E1..En] 注入各轮供专家引用，减少凭空立论；
  - **互评投票** — `vote: true` 时每位专家匿名互评最认同的观点（仅 debate）；
  - **裁决者综合** — `judgeCard` 指定专门的角色卡执行最终综合，替代第一张卡；
  - **多轮运行并集** — `runs: 2~3` 对同一主题完整重跑 N 次（每次轮换匿名别名）并去重合并，结论标注稳定性 `[K/N RUNS]`；
  - **信号路由选卡** — `select: "auto"` 按主题内容自动匹配擅长领域的角色卡。
- **`brainstorm_followup`** — 对上一轮 brainstorm 实录继续追问：全体各答一轮，或指定单卡深化。
- **会话记录** — 每次工具调用落盘 JSONL 到 `records/`，便于事后审计与回放，写入失败不影响调用本身。
- **多 Provider 支持** — OpenAI、Anthropic，以及任意 OpenAI 兼容 API（DeepSeek、Moonshot、Qwen 等，纯配置接入，无需新代码）。
- **三概念体系** — **专家**（人设/参数）与**模型**（引擎）解绑为独立一等概念，通过**角色卡**绑定专家+模型。`experts.json` 分三段存储。
- **双传输模式** — Stdio（本地，默认）与 HTTP/SSE（远程）。
- **密钥安全** — API Key 仅通过环境变量注入，绝不写入配置文件。
- **HTTP 面鉴权** — 双 token 体系（管理后台静态令牌 + MCP 动态访问令牌），未配置时 fail-closed 全部 401，详见「鉴权与令牌」。
- **容器化部署** — 多阶段 Dockerfile + docker-compose 一键启动。

## 快速开始

要求 Node.js >= 18（推荐 20 LTS）。

### 1. 安装依赖

```bash
# 后端
npm install

# 管理后台 admin-web
cd admin-web && npm install && cd ..
```

### 2. 编译后端

```bash
npm run build
```

### 3. 类型检查与单元测试

```bash
npm run typecheck
npm test
```

### 4. 首次运行（Mock 模式，无需 API Key）

设置环境变量 `TALKIO_MOCK_PROVIDER=1`，即可使用 Mock Provider 运行，无需真实 API Key：

```powershell
# PowerShell
$env:TALKIO_MOCK_PROVIDER="1"
node dist/index.js --transport stdio
```

另起一个终端执行冒烟测试：

```bash
node scripts/smoke-stdio.mjs
```

看到 `PASS: smoke-stdio 全部断言通过` 即表示后端 stdio 链路正常。

> 提示：`--transport` 支持 `stdio`（默认）和 `sse`。SSE 模式默认监听 `127.0.0.1:3100`，详情见下方 [SSE 模式](#sse-模式)。

### 5. 配置真实 API Key（可选）

本地开发可在项目根目录创建 `.env`（已被 `.gitignore` 忽略，不会提交）：

```bash
cp .env.example .env
# 编辑 .env，填入你实际拥有的 provider 密钥
```

`experts.json` 中每个 provider 的 `apiKeyEnv` 字段对应 `.env` 里的变量名。修改后重启服务器生效。

## 常见命令速查

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `npm install` | 安装后端依赖 | 在根目录执行 |
| `cd admin-web && npm install` | 安装 admin-web 依赖 | 需要先安装根目录依赖 |
| `npm run build` | 编译 TypeScript 后端 | 输出到 `dist/` |
| `npm run typecheck` | 仅做类型检查 | 不输出产物 |
| `npm test` | 运行单元测试 | 基于 vitest |
| `npm run dev` | 以 tsx 热重载方式启动后端 | 适合本地开发 |
| `node dist/index.js --transport stdio` | 运行编译后的后端 | 默认 stdio 模式 |
| `node scripts/smoke-stdio.mjs` | Mock 模式冒烟测试 | 无需 API Key |
| `npm run dev:web` | 启动 admin-web 开发服务器 | 默认 http://localhost:5173 |
| `npm run build:web` | 构建 admin-web 生产包 | 输出到 `admin-web/dist/` |

## 管理后台 admin-web

`admin-web/` 是基于 React + Vite 的可视化管理界面，用于维护 **专家（Expert）/ 模型（Model）/ 角色卡（Card）** 三段式配置。亮点：

- 新增 Provider 时内置 **7 个预设**（Ollama / LM Studio / vLLM / OpenRouter / DeepSeek / Moonshot / 智谱），一键填充 `baseUrl` 与 `apiKeyEnv`；
- 角色卡可勾选**信号组**（配合 MCP 侧 `select: "auto"` 路由选卡）；
- 会话记录页面中 `runs > 1` 的多轮运行以 **R{n} 徽标**区分运行序号；
- **令牌管理**：内置登录页（`TALKIO_ADMIN_TOKEN`）与「访问令牌」页（MCP 动态令牌生成/吊销），见「鉴权与令牌」。

### 开发模式

```bash
# 从项目根目录启动 admin-web 开发服务器
npm run dev:web
# 等价于
cd admin-web && npm run dev
```

默认地址：http://localhost:5173

### 生产构建

```bash
npm run build:web
# 等价于
cd admin-web && npm run build
```

构建产物输出到 `admin-web/dist/`，该目录已加入 `.gitignore`。

### 与后端集成

- SSE 模式下，后端可直接托管 `admin-web/dist/` 的静态资源。
- 开发时前端 Vite dev server 与后端 SSE 服务分别运行，通过配置的 API 地址通信。
- 桌面端为网格布局，移动端为类 iOS 单列布局，建议在不同视口下都检查一遍。

## 配置说明

### experts.json

专家、模型、角色卡与 Provider 定义文件，默认读取仓库根目录的 `experts.json`（可用 `--config <path>` 或环境变量 `TALKIO_EXPERTS_CONFIG` 覆盖）。旧格式（专家带 provider/model）会在启动时自动迁移成三段式并备份 `.bak`。

```jsonc
{
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
    }
  },
  "experts": [
    {
      "id": "architect", // 唯一 id
      "name": "架构师",
      "icon": "🏛️",
      "systemPrompt": "你是一位资深软件架构师……",
      "temperature": 0.7,
      "enabled": true // 专家本身不含 provider/model
    }
  ],
  "models": [
    {
      "id": "openai-gpt-4o", // 内部 id：${providerId}-${modelSlug}
      "providerId": "openai", // 引用 providers 中的 key
      "modelId": "gpt-4o", // 传给上游 API 的模型名
      "displayName": "GPT-4o",
      "enabled": true
    }
  ],
  "cards": [
    {
      "id": "architect-openai-gpt-4o", // 角色卡 id，MCP 调用时用这个
      "name": "架构师 · GPT-4o",
      "expertId": "architect", // 引用 experts 中的 id
      "modelId": "openai-gpt-4o", // 引用 models 中的 id
      "enabled": true,
      "isDefault": true // 可选，默认卡
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

# 管理后台登录令牌（SSE 模式必需；未设置时 /api/*、/sse、/messages 全部 401，fail-closed）
TALKIO_ADMIN_TOKEN=change-me-to-a-long-random-string
```

缺 key 的 Provider 在调用时惰性报错（`Provider X: missing env var Y`），不影响其他专家返回。

## 鉴权与令牌

HTTP 面（SSE 模式）采用**双 token 体系**，两个凭证池完全隔离、互不通用；stdio 模式为进程内传输，不经 HTTP 层，完全不受影响。

| 面 | 端点 | 凭证 | 来源 |
| --- | --- | --- | --- |
| 管理后台 | `/api/*`（含 `/api/auth/check`、`/api/tokens`） | admin token | env `TALKIO_ADMIN_TOKEN`（静态，改 env + 重启即轮换） |
| MCP 接入 | `/sse`、`/messages` | MCP 访问令牌 | 管理后台「访问令牌」页动态生成/吊销（可多个） |
| 静态壳子 | 其余路径（SPA / 登录页） | 无需凭证 | — |

**机制**：凭证解析 `Authorization: Bearer` 优先，`?token=` 查询参数兜底（浏览器 EventSource 无 header 能力；query 中的凭证可能进入代理/访问日志，**仅作降级手段**）。比对使用常量时间比较（timingSafeEqual），日志只记 `[auth] 401 path=… reason=…`，绝不输出 token 内容。

**fail-closed**：`TALKIO_ADMIN_TOKEN` 未设置时，`/api/*`、`/sse`、`/messages` 对一切请求返回 401，启动日志输出 ERROR 与配置指引；静态登录页仍可访问。

### 管理后台登录

浏览器打开 `http://<host>:3100/` → 输入 `TALKIO_ADMIN_TOKEN` → 登录。令牌持久化在浏览器 localStorage，任何接口返回 401 会自动登出回登录页。

### MCP 访问令牌（动态生成）

登录后台 →「访问令牌」→ 生成：

- 明文格式 `mtok_<随机串>`，**仅在生成响应展示一次**（关闭弹窗后不可再查看），请立即复制保存；
- 服务端只存 SHA-256 哈希，落盘到 experts.json 同目录 `mcp-tokens.json`（可用 `TALKIO_MCP_TOKENS_FILE` 覆盖路径；该文件已 gitignore，重启不丢）；
- 「最近使用」时间在令牌被使用时更新（60s 节流落盘）；吊销**即时生效**（使用该令牌的客户端立即 401）。

### MCP 客户端带令牌接入

远程 SSE 模式下，MCP 客户端必须携带 MCP 访问令牌：

**Cursor**（支持自定义 headers）：

```json
{
  "mcpServers": {
    "talkio-mcp": {
      "url": "http://<host>:3100/sse",
      "headers": {
        "Authorization": "Bearer mtok_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

**mcp-remote**（`--header` 透传）：

```bash
npx mcp-remote http://<host>:3100/sse --header "Authorization: Bearer mtok_xxxxxxxxxxxxxxxx"
```

**Snow CLI**（远程接入；所用版本支持 headers 字段则优先 header，否则用 URL query 兜底）：

```json
{
  "mcpServers": {
    "talkio-mcp": {
      "url": "http://<host>:3100/sse?token=mtok_xxxxxxxxxxxxxxxx"
    }
  }
}
```

**URL query 兜底**（仅当客户端完全不支持 header 时使用）：

```
http://<host>:3100/sse?token=mtok_xxxxxxxxxxxxxxxx
```

> ⚠️ query 中的凭证可能进入反向代理 / 访问日志，优先使用 header 方式，query 仅作降级。

### 本地开发

```bash
# .env 设一个开发 token 即可
echo "TALKIO_ADMIN_TOKEN=dev" >> .env
node dist/index.js --transport sse
# 冒烟自检（自动起 mock 服务验证 401/放行/带令牌 list_cards）
TALKIO_ADMIN_TOKEN=dev node scripts/smoke-sse.mjs
```

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

接入后先调用 `list_cards` 查看角色卡 id 与就绪状态，再把 id 传给 `consult_experts` / `brainstorm` 的 `cards` 参数。缺 key 的角色卡仍可显式指定，但该项会失败。

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

## 隐私脱敏

本 MCP 是给 Agent 调用的，隐私采用**三层策略**：协议层引导 + 规则层自动掩码 + 错误层脱敏。返回给客户端的报告**不脱敏**（用户自己的数据原样保留）。

### 协议层：调用方 Agent 预替换无规律 PII

姓名、地名、精确地址、机构名等**无固定格式**的 PII，无法用正则识别，由调用方 Agent 在调用前替换为占位符。`consult_experts` / `brainstorm` 的工具描述中已写明该约定：

| 原信息 | 替换为 | 示例 |
|---|---|---|
| 人名 / 称呼 | `[人名]` | "张三建议…" → "[人名] 建议…" |
| 地名 / 地址 | `[地名]` | "住在北京市海淀区" → "住在 [地名]" |
| 机构 / 公司名 | `[机构]` | 可选，按需替换 |

占位符会被原样透传给 LLM，用于保持语境；它们不是 PII，不会被二次替换。

### 规则层：发往 LLM 前的自动掩码

即使调用方忘记替换，`consult_experts` 的 `question`/`context`、`brainstorm` 的 `topic`/转写/总结在发往 LLM 前会自动掩码以下**有明确格式**的 PII：

| 类型 | 掩码为 |
|---|---|
| 大陆手机号（11 位，1 开头第二位 3-9） | `[手机号]` |
| 18 位身份证号（末位 X/x） | `[身份证号]` |
| 邮箱地址 | `[邮箱]` |
| 银行卡号（16-19 位连续数字） | `[银行卡号]` |
| 微信号（微信/weixin/vx 前缀 + 账号） | `微信号 [微信号]`（保留前缀文字） |

采用**克制**策略：只替换明显是 PII 的 token，防止误伤 15 位订单号、400 客服号等普通文本。

### 错误层：错误信息脱敏

provider 抛错、编排错误回显等包含用户输入的错误文案，同样经过上述规则掩码，避免二次泄漏。

### 不脱敏输出

返回给 MCP 客户端的咨询报告 / 讨论实录保持原文——你的数据归你。如果要连同返回结果一起脱敏，可在调用方侧对响应做同样处理。

## 日志与诊断

所有日志一律写入 **stderr**（`stdio` 传输下 stdout 是 MCP 协议通道，任何诊断都不得走 stdout），且**不带时间戳前缀**，保证每行都是完整文本、便于解析。

### 日志级别

启动时用 `--log-level <level>` 控制输出阈值（默认 `info`）：

| 级别 | 说明 |
| --- | --- |
| `silly` | 全量调试 |
| `debug` | 调试细节 |
| `info`  | 常规信息（默认） |
| `warn`  | 警告 |
| `error` | 仅错误 |

级别大小写不敏感；无效或缺失的值回落为 `info` 并打一条 `[cli]` 警告。

### 汇总行（typeline）

每次咨询 / 头脑风暴结束后，logger 会输出一行 `[summary]` 汇总（仅进日志，**绝不写入返回报告**）：

```text
[summary] consult cards=3 ok=2 failed=1 avg_ms=1842 total_ms=4021
[summary] brainstorm rounds=2 turns=4 summary=yes ok=4 failed=0 total_ms=9375
```

consult 行：`cards`=实际咨询卡数，`ok`/`failed`=成功 / 失败条数，`avg_ms`=平均时长，`total_ms`=总时长。brainstorm 行：`rounds`=轮数，`turns`=对话条数，`summary`=是否产出总结，`ok`/`failed`=成功 / 失败条数，`total_ms`=总时长。

### 错误压缩

当**全部**角色卡都咨询失败时，返回报告会压缩为**一条**失败项：文案形如

```text
全部 3 张卡咨询失败（均为 provider 调用失败）: [首个错误摘要]
```

首个错误匹配超时（`超时` / `timed out` / `timeout` / `TimedOut`）时追加 `（含超时）`。部分失败不压缩，各失败项原样保留。

## 会话记录（records）

`consult_experts` / `brainstorm` / `brainstorm_followup` 每次调用都会落盘一份 JSONL 会话记录，便于事后审计与回放：

- **位置** — `<experts.json 所在目录>/records/<sessionId>.jsonl`（可用环境变量 `TALKIO_RECORDS_DIR` 覆盖）；
- **结构** — 第 1 行固定为 `meta` 事件（所选卡片快照），最后一行固定为 `done`，中间为里程碑事件（卡片结果、对话 turn、轮次边界、总结）；`runs > 1` 时事件额外带 `run` 字段区分运行序号；
- **隐私** — 落盘的是已经过 PII 掩码后的文本（与发给 LLM 的一致），不会新增暴露面；
- **可靠性** — 记录写入失败只在 stderr 打 `[records]` 警告，绝不影响工具调用本身。

## 工具用法

### list_cards — 列出可用角色卡

只读发现工具，不调用任何 AI Provider。默认只返回 `enabled: true` 的角色卡。每张卡带 `ready` 与解析出的专家名/模型名；缺 key 时仍列出，并标明缺哪个环境变量（`missingEnv`），不会从发现列表删除。

| 参数              | 类型    | 必填 | 说明                             |
| ----------------- | ------- | ---- | -------------------------------- |
| `includeDisabled` | boolean | 否   | 是否包含未启用角色卡，默认 false |

示例：

```json
{
  "includeDisabled": false
}
```

### consult_experts — 角色卡咨询

并行咨询多张角色卡（每张卡解析为对应的专家人设 + 模型引擎），返回 Markdown 咨询报告。

未指定 `cards` 时，只选已启用且对应 API Key 已配置的角色卡，按 `experts.json` 顺序最多 3 张；缺 key 的卡会在报告末尾说明原因，不会发请求。显式传入 `cards` 时按名单调用（缺 key 的该项失败，不影响其他卡）。传入不存在的卡 id 时返回错误并列出全部可用卡。

| 参数       | 类型     | 必填 | 说明                                                  |
| ---------- | -------- | ---- | ----------------------------------------------------- |
| `question` | string   | 是   | 要咨询的问题（去空白后不能为空）                      |
| `context`  | string   | 否   | 主理 AI 的初步分析/背景（claim-0，可能有误）：供专家独立参考与质疑，不作为权威事实 |
| `cards`    | string[] | 否   | 角色卡 id 列表；缺省使用有 key 的启用角色卡（最多 3 张） |
| `parallel` | boolean  | 否   | 是否并行调用（默认 true）；false 时按顺序逐个调用     |
| `select`   | "auto"   | 否   | 传 `auto` 时按问题内容信号路由自动选卡（内置中英关键词信号组，见 [信号路由](#信号路由选卡)） |

示例：

```json
{
  "question": "这个订单系统如何做水平扩展？",
  "context": "当前单体架构，峰值 QPS 2000，MySQL 主从",
  "cards": ["architect-openai-gpt-4o", "performance-deepseek-deepseek-chat"]
}
```

### brainstorm — 多轮头脑风暴

多张角色卡围绕主题多轮对话，输出讨论实录与收敛总结（默认产出）。

未指定时默认最多 3 张有 key 的启用角色卡、1 轮、debate 模式、产出总结。显式传入 `cards` / `rounds` / `summarize` 时按调用方指定（`cards` 上限仍为 6）。

| 参数        | 类型            | 必填 | 说明                                                              |
| ----------- | --------------- | ---- | ----------------------------------------------------------------- |
| `topic`     | string          | 是   | 讨论主题（去空白后不能为空）                                      |
| `context`   | string          | 否   | 发起方初步分析（claim-0，可能有误）：debate 第 1 轮各专家**盲答**不注入，第 2 轮起以「主理 AI 初步判断」块注入供质疑推翻；relay 随每轮注入；报告单列该块，不参与互评投票 |
| `evidence`  | string[]        | 否   | 证据包（代码片段/数据/文档引文/实测输出），编号 [E1..En] 注入各轮供专家引用；区别于 `context`（发起方主张） |
| `mode`      | debate 或 relay | 否   | 辩论（默认，并行）或接龙（串行）                                  |
| `rounds`    | integer         | 否   | 轮数，1-5，默认 1                                                 |
| `cards`     | string[]        | 否   | 角色卡 id 列表（上限 6 张）；缺省为有 key 的启用角色卡（最多 3 张） |
| `summarize` | boolean         | 否   | 是否产出收敛总结，**默认 true**                                   |
| `vote`      | boolean         | 否   | 互评投票（默认 false）：全部内容轮结束后、综合之前，每位专家匿名互评最认同的观点；仅 debate 生效，relay 下忽略 |
| `judgeCard` | string          | 否   | 裁决者角色卡 id：由该卡（而非第一张卡）执行最终综合；该卡若同时参与议事会被剔除；无效时回退第一张卡并在报告注明 |
| `select`    | "auto"          | 否   | 传 `auto` 按主题内容信号路由自动选卡；缺省按 cards/默认卡逻辑      |
| `runs`      | 1 / 2 / 3       | 否   | 多轮运行：对同一主题完整重跑 N 次对话（每次轮换匿名别名）并去重合并结论，每条结论标注稳定性 [K/N RUNS]；>1 时成本按倍数增长，建议配合 vote + debate 使用（默认 1） |

示例：

```json
{
  "topic": "AI Agent 在客服场景的落地路径",
  "context": "我倾向先用规则引擎兜底，再逐步上 LLM",
  "evidence": ["客服峰值 QPS 2000，人工坐席 80 人", "现网 LLM P95 延迟 3.2s"],
  "mode": "debate",
  "rounds": 3,
  "vote": true,
  "summarize": true
}
```

### brainstorm_followup — 实录追问

服务器无状态：把上一次 brainstorm 返回的 `turns` 结构原样传回，即可带着历史上下文继续追问。两种粒度：

- **不传 `card`**：全体选定卡各答一轮（debate 并行 / relay 串行，默认 relay）；
- **传 `card`**：仅该卡深化（1 次 LLM 调用，1 条新 turn），可反复调用逐卡追问。

`turns` 为空或格式无效时**降级**为无上下文追问并在报告标注（`⚠️ 未使用历史上下文`），不会因此报错。

| 参数       | 类型            | 必填 | 说明                                                     |
| ---------- | --------------- | ---- | -------------------------------------------------------- |
| `question` | string          | 是   | 追问问题（去空白后不能为空）                             |
| `turns`    | DialogueTurn[]  | 是   | 上一次 brainstorm 返回的实录 turns（`round`/`expertId`/`expertName`/`icon`/`content`） |
| `cards`    | string[]        | 否   | 参与追问的卡 id 列表（缺省=启用且有 key，最多 3 张；传 `card` 时忽略） |
| `card`     | string          | 否   | 指定单张卡 id 深化（仅该卡作答 1 条 turn）               |
| `mode`     | debate 或 relay | 否   | 仅全体追问时有效（缺省 relay）                            |

### 信号路由选卡

`consult_experts` 与 `brainstorm` 均支持 `select: "auto"`：对问题/主题文本做中英双语关键词子串匹配，命中信号组后只选声明了对应信号的角色卡。内置信号组：`sql-data`（数据/SQL）、`security`（安全）、`infra`（基础设施）、`ml`（机器学习）、`api`（接口设计）、`frontend`（前端）、`cost`（成本）、`pipeline`（CI/流水线）、`writing`（文案写作）、`general`（通用）。角色卡的信号组在 `experts.json` 的 `card.signals` 中声明，admin-web 编辑卡时可勾选。

## SSE 模式

SSE 传输用于远程 / 多客户端接入，默认绑定 `127.0.0.1:3100`：

```bash
node dist/index.js --transport sse --port 3100
```

需要对外暴露时显式指定 `--host`（HTTP 面已启用鉴权：`/api/*` 校验 `TALKIO_ADMIN_TOKEN`，`/sse`、`/messages` 校验 MCP 访问令牌，未配置 admin token 时 fail-closed 全部 401，详见「鉴权与令牌」）：

```bash
node dist/index.js --transport sse --port 3100 --host 0.0.0.0
```

客户端连接地址：`http://127.0.0.1:3100/sse`（远程需带令牌，见「MCP 客户端带令牌接入」）

## Docker 部署

Dockerfile 采用多阶段构建，镜像内同时包含**后端（`dist`）**与**管理界面前端（`admin-web/dist`）**。容器以 SSE 模式启动后，一个端口同时提供：

- 管理界面：`http://<服务器IP>:3100/`
- MCP SSE 端点：`http://<服务器IP>:3100/sse`
- 管理 API：`http://<服务器IP>:3100/api/*`

### 从 Docker Hub 拉取

CI 已把镜像发布到 Docker Hub（`latest` 跟随 `master`，版本号来自 `v*` tag）：

```bash
docker pull dockercom110/talkio-mcp:latest
docker run --env-file .env -p 3100:3100 dockercom110/talkio-mcp
```

需固定版本部署（便于回滚）时用版本号标签：

```bash
docker pull dockercom110/talkio-mcp:0.2.0
```

### 构建镜像

```bash
docker build -t talkio-mcp .
```

### 运行容器

注入 API 密钥与管理后台令牌（`TALKIO_ADMIN_TOKEN` 未设置时 HTTP 面 fail-closed，全部 401）：

```bash
docker run -e OPENAI_API_KEY=sk-... -e TALKIO_ADMIN_TOKEN=<强随机字符串> -p 3100:3100 talkio-mcp
```

使用 env 文件（推荐，从 `.env.example` 复制后填真实密钥）：

```bash
cp .env.example .env   # 填入真实密钥与 TALKIO_ADMIN_TOKEN
docker run --env-file .env -p 3100:3100 talkio-mcp
```

不配置密钥时，可用 mock 模式快速验证部署：

```bash
docker run -e TALKIO_MOCK_PROVIDER=1 -p 3100:3100 talkio-mcp
```

挂载自定义专家配置（可写；管理界面保存配置会回写该文件）：

```bash
docker run --env-file .env -p 3100:3100 \
  -v $(pwd)/experts.json:/app/experts.json \
  talkio-mcp
```

> ⚠️ **配置写入权限**：容器以非 root 的 `talkio` 用户运行。管理界面保存配置需写宿主机挂载的 `experts.json`；若保存报错，请先 `chmod 666 experts.json`（或让容器以 root 运行）。若只需只读部署（改文件 + 重启容器），可在 `-v` 末尾加 `:ro`。

容器默认以 SSE 模式启动（`--transport sse --port 3100 --host 0.0.0.0`）。需要 stdio 模式可覆盖 CMD：

```bash
docker run -i --env-file .env talkio-mcp --transport stdio
```

### docker compose

```bash
cp .env.example .env   # 可选；不配密钥也可用 mock 模式，但务必设置 TALKIO_ADMIN_TOKEN
docker compose up -d
```

`docker-compose.yml` 默认：构建当前目录镜像、映射 `3100:3100`、加载 `.env`（缺失不报错）、可写挂载 `./experts.json`、`restart: unless-stopped`。修改配置后需重启容器生效：

```bash
docker compose restart
```

> ⚠️ 公网部署务必注入 `TALKIO_ADMIN_TOKEN`（写在 `.env` 或 compose 的 `environment:` 段；1Panel 的 compose API 会清掉 `.env` 文件时直接内联 `environment:`）。部署/升级与令牌注入应在**同一次变更**内完成，避免出现无凭证窗口。MCP 令牌落盘在 experts.json 同目录 `mcp-tokens.json`，与 experts.json 同一挂载层级，重建容器不丢。

> 管理界面已打进镜像，部署时无需再构建或单独托管前端。

### 镜像内置的默认专家配置

镜像内的 `/app/experts.json` 由仓库中脱敏的 `experts.default.json` 在构建时生成（保留全部内置专家人设，provider 指向 OpenAI 官方端点）。因此：

- 只注入 `OPENAI_API_KEY` 即可开箱运行，或用 `TALKIO_MOCK_PROVIDER=1` 跑 mock；
- 想使用自己的专家 / 模型 / 角色卡，把本地 `experts.json` 挂载进容器覆盖即可（见上一节）；
- 仓库只跟踪脱敏模板，本地真实 `experts.json` 继续被 `.gitignore` 忽略，既不会被提交，也不会进入镜像构建上下文。

### 自动发布到 Docker Hub

`.github/workflows/docker-publish.yml` 负责自动化：

1. **质量门禁** — `npm ci` → `npm run typecheck` → `npm test`，任一失败即终止，绝不发布坏镜像；
2. **构建推送** — 用多阶段 `Dockerfile` 构建 `linux/amd64` 镜像并推送到 `dockercom110/talkio-mcp`。

触发规则与产出标签：

| 触发方式 | 产出标签 |
| --- | --- |
| push 到 `master` | `latest` |
| push tag `v0.2.0` | `0.2.0`、`0.2` |
| 手动 workflow_dispatch | 按当前 ref 规则同上 |

首次使用需在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加两个 secret：

| Secret | 内容 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（Account Settings → Personal access tokens，权限选 **Read & Write**） |

发布版本：

```bash
git tag v0.2.0
git push origin v0.2.0   # 推送 tag 后自动跑门禁、构建并发布版本号标签
```

> workflow 依赖仓库 secrets，fork 仓库不会自动发布，需在 fork 中自行配置同名 secret。

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
