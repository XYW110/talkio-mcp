# PRD — MCP 与后台 API 凭证控制

## 目标

为 talkio-mcp 的 HTTP 面（MCP SSE 端点 + 管理 API + 静态后台）加凭证控制，终结公网裸奔：当前任何人拿到 `http://111.229.147.203:3100` 即可消耗服务器配置的 LLM token 费用、改写 `experts.json`、读取会话记录。本地 stdio 部署不受影响。

## 已定决策（用户拍板，2026-09-30）

1. **双 token 体系**：管理后台走 `.env` 静态 token（`TALKIO_ADMIN_TOKEN`）登录；MCP token 与 admin token 不同，由网页管理后台动态**生成/删除**（可多个，明文仅生成时展示一次，服务端只存 SHA-256 哈希）。
2. **作用域**：`/sse`+`/messages` 用 MCP token；全部 `/api/*` 用 admin token；静态壳子公开承载登录页。两池互不通用。
3. **机制**：应用层鉴权（`Authorization: Bearer` 优先，浏览器 EventSource 场景 `?token=` 查询参数兜底）。
4. **fail-closed**（Q4=A）：`TALKIO_ADMIN_TOKEN` 未配置时拒绝全部 `/api/*` 与 MCP 端点，启动打 ERROR 提示配置方法；静态壳不受影响。
5. **部署落地**（Q5=A）：代码合入并推送 master → CI 发布镜像 → panel-ops 更新服务器 compose（注入 admin token、重建容器）→ 公网 401/带 token 双验证 + 后台生成首个 MCP token + 带 token 的真实 MCP 调用。

## 已确认事实（代码证据）

- 单一 `node:http` 监听器承载三层面（`src/index.ts:160-235`）：
  1. `GET /sse` + `POST /messages` — MCP SSE 传输（`SSEServerTransport`）；
  2. `/api/*` — 管理 API（`src/admin/api.ts`），含写操作：`PUT /api/config`（回写 experts.json）、`DELETE /api/records`、`POST /api/chat`、`POST /api/providers/probe`；读操作：`GET /api/config`、`/api/env/status`、`/api/records[/:id]`、`/api/usage`；
  3. 静态 SPA — `admin-web/dist`（`src/admin/api.ts:479-481`，`/sse`、`/messages` 之外兜底）。
- 全仓无入站鉴权逻辑；`Authorization: Bearer` 仅用于出站 LLM provider 调用（`src/providers/*.ts`、`src/admin/api.ts:119` probe 转发）。
- 密钥不泄漏：`/api/config` 只回显 `apiKeyEnv` 变量名，真实 key 经 env 注入（`/api/env/status` 明确"避免展示 key 明文"）。
- 现网部署：上海轻量 111.229.147.203:3100，1Panel compose（`/opt/1panel/docker/compose/talkio-mcp`），防火墙 3100 对 0.0.0.0/0 开放，实测无凭证 200 全绿（裸奔确认）。
- env 约定既有前缀 `TALKIO_*`（`TALKIO_MOCK_PROVIDER`、`TALKIO_RECORDS_DIR`、`TALKIO_EXPERTS_CONFIG`）；CLI 参数走 `--xxx`。
- stdio 模式是进程内传输，不经 HTTP 监听器，天然不受影响（需求：不得破坏）。
- admin-web 有统一 fetch 封装（`admin-web/src/api.ts`，加 `Content-Type` 单点）与 `api.chatEventSource(sessionId)` 单点（`ChatPage.tsx:97` 用 EventSource）——鉴权头与 401 处理可在单点接入。
- 测试基建：vitest，`test/admin-*.test.ts` 已有 http 级集成测试模式（起真实 listener）。
- MCP 客户端兼容性：Cursor / mcp-remote 支持自定义 headers；浏览器 `EventSource` 无法设置 header。

## 需求

- **R1 后台登录**：全部 `/api/*` 要求 admin token；admin-web 增加登录页（token 输入 → `GET /api/auth/check` 校验 → localStorage 持久化）；统一封装为所有请求附 `Authorization: Bearer`；任何 401 自动登出回登录页。
- **R2 MCP 凭证管理**：admin API 新增 `GET /api/tokens`（列表，不含明文）、`POST /api/tokens {name}`（生成，明文仅响应一次）、`DELETE /api/tokens/:id`（吊销，即时生效）；token 记录含 id、名称、创建时间、lastUsedAt、哈希指纹。
- **R3 MCP 端点鉴权**：`/sse`、`/messages` 校验 MCP token（Bearer header 或 `?token=`）；无效返回 401。
- **R4 存储**：MCP token 持久化到 experts.json 同目录的 `mcp-tokens.json`（`TALKIO_MCP_TOKENS_FILE` 可覆盖），原子写、重启不丢、gitignore；明文不落盘。
- **R5 fail-closed**：`TALKIO_ADMIN_TOKEN` 未设置 → 全部受保护端点 401 + 启动 ERROR 日志（含配置指引）；`.env.example` 增加示例。
- **R6 兼容性**：stdio 模式零影响；本地开发在 `.env` 设一个开发 token 即可（文档写明）；MCP 客户端按 header 配置（Cursor headers / mcp-remote --header）。
- **R7 安全细节**：token 比对用 `timingSafeEqual`；日志绝不输出 token；`[auth]` warn 记录失败尝试（路径+原因）。
- **R8 文档**：README「鉴权与令牌」章节 + 客户端配置示例 + 部署说明更新。

## 边界（out of scope）

- 多用户账户体系、OAuth 2.1（MCP 官方授权框架）、admin token 的 UI 轮换（改 env+重启即轮换）。
- stdio 模式的任何改动。
- MCP token 细粒度权限（按工具/只读）；MVP 所有 MCP token 权限一致。

## 验收标准

- **AC1** 未带/带错凭证访问 `/sse`、`/messages`、任意 `/api/*` → 401；静态壳子可访问（展示登录页）。
- **AC2** admin token 登录后台后：配置读写、MCP token 生成/删除、记录与用量查看全部正常；401 后自动回登录页。
- **AC3** 后台生成的新 MCP token 可驱动 MCP 客户端完成 `list_cards` / `consult_experts` / `brainstorm`；`DELETE` 后该 token 立即 401。
- **AC4** 明文 token 仅在生成响应出现一次；落盘为 SHA-256 哈希；重启后旧 token 仍有效。
- **AC5** `TALKIO_ADMIN_TOKEN` 未设置时：受保护端点全部 401，启动日志出现 ERROR 与配置指引（fail-closed）。
- **AC6** admin token 不能访问 `/sse`/`/messages`，MCP token 不能访问 `/api/*`（两池隔离）。
- **AC7** 现网部署后：公网无 token 401、带 admin token 200、后台生成首个 MCP token、带 token 的真实 MCP 调用成功。
- **AC8** `npm run typecheck`、`npm test`、`npm run build`、`npm run build:web` 全绿；新增单测覆盖 token store（生成/验证/吊销/持久化）与鉴权 gate（401/放行/fail-closed/两池隔离）。
