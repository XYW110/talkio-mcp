# Auth & Token Guidelines — 双 token 鉴权契约

来源：09-30-mcp-admin-auth 任务沉淀。HTTP 面凭证控制的全部可执行契约，改动 `src/auth/`、`src/index.ts` 门禁或 admin API 鉴权相关路由前必读。

## 双池隔离（AC6 红线）

| 池 | 凭证来源 | 保护面 | 互斥 |
| --- | --- | --- | --- |
| admin | env `TALKIO_ADMIN_TOKEN`（静态，改 env+重启即轮换） | `/api/*` 全部（含 `/api/auth/check`、`/api/chat`、`/api/tokens`） | admin token 打 `/sse` 必拒 |
| mcp | `mcp-tokens.json` 动态池（admin API 生成/吊销） | `/sse`、`/messages` | MCP token 打 `/api/*` 必拒 |

两池零交叉；测试锚点 `test/admin-auth.test.ts`（401×端点×凭证矩阵 + 两池隔离用例）。

## fail-closed（默认拒绝）

- `TALKIO_ADMIN_TOKEN` 未设置 → 受保护面一律 401（含合法 MCP token），静态壳照常 200（承载登录页）。
- 启动时 `logger.error` 输出配置指引；401 body `{"error":"unauthorized","reason":"admin_token_not_configured"}` —— `reason` 字段**仅** fail-closed 响应携带（登录页区分文案），常规错凭证保持纯 `{"error":"unauthorized"}`（防枚举）。

## MCP token 规则（`src/auth/tokens.ts`）

- 明文 `mtok_<base64url>`（`crypto.randomBytes(24)`），**仅创建响应返回一次**，任何列表/查询接口不得再吐明文或哈希（列表只回 `fingerprint` 后 4 位）。
- 落盘只存 SHA-256 hex（`mcp-tokens.json`，gitignored，`TALKIO_MCP_TOKENS_FILE` 可覆盖；默认 experts.json 同目录）。
- 校验：明文先 SHA-256 定长，再 `timingSafeEqual` 比较定长哈希 —— 禁止对原始明文做长度不设防的比较。
- 吊销即时生效：每请求查内存池，无缓存失效窗口。

## 凭证解析与传输兼容（`src/auth/middleware.ts`）

- 顺序：`Authorization: Bearer <t>` 优先 → `?token=` 查询参数兜底（浏览器 `EventSource` 无 header 能力，`/api/chat` GET SSE 与降级 MCP 客户端依赖此路）。
- 401：`/api` 返回 JSON + `WWW-Authenticate: Bearer`；`/sse`/`/messages` 直接 res 401 结束（不进 transport）。
- 静态豁免判定在 `classifyPath`（`/sse`、`/messages`、`/api/*` 之外全放行；注意 `/apis` 不得前缀误判）。

## IO 与日志红线

- 令牌池写盘失败 → `[auth]` warn，**绝不影响主请求**（对齐 records-persistence 红线）；tmp+rename 原子写。
- `lastUsedAt` 内存即时 + 60s 节流持久化（节流基准=上次成功落盘时刻）。
- `[auth]` 日志行只含 `path/reason/pool`，任何日志路径不得出现 token 值。

## 部署侧约定

- `mcp-tokens.json` 必须 bind mount 到宿主（compose `volumes`）且宿主文件 666（容器 talkio 用户写 lastUsedAt）；只挂 experts.json 单文件时 tokens 会落容器层、重建即丢。
- 1Panel 运维坑与 compose 注入方式见 panel-ops skill（`compose/operate` 必须带 `path` 字段；update 对内容未变是 no-op）。
