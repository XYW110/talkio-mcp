# design — MCP 与后台 API 凭证控制

## 0. 架构总览

单一 HTTP 监听器内新增**鉴权门（auth gate）**，位于请求路由之前（`src/index.ts` 现有 `http.createServer` 回调最前部）：

```
请求 → authGate()
  ├─ 静态资源（非 /sse、/messages、/api/*）→ 放行（公开壳子 + 登录页）
  ├─ /sse、/messages  → 校验 MCP token 池
  ├─ /api/auth/check  → 校验 admin token 池（登录页自检）
  └─ /api/*           → 校验 admin token 池
校验 = 从请求解析凭证（Authorization: Bearer 优先，?token= 兜底）→ timingSafeEqual 与池内哈希比对
未配置 TALKIO_ADMIN_TOKEN → fail-closed：受保护面一律 401
```

两个凭证池完全隔离：admin token 打 `/sse` 拒绝、MCP token 打 `/api` 拒绝（AC6）。

## 1. 凭证来源与存储

**Admin token（静态）**
- env `TALKIO_ADMIN_TOKEN`（沿用 `TALKIO_*` 前缀约定），`.env` / compose environment 注入。
- 只读使用，无落盘；轮换 = 改 env + 重启容器。

**MCP tokens（动态，管理面控制）**
- 新模块 `src/auth/tokens.ts`（纯逻辑 + IO，无 HTTP 依赖，可单测）。
- 存储文件：experts.json 同目录 `mcp-tokens.json`（与 records 目录同约定；容器内与 experts.json 同一 bind mount 层级，可写）；`TALKIO_MCP_TOKENS_FILE` 覆盖路径；加入 `.gitignore`。
- 结构：

```jsonc
{
  "version": 1,
  "tokens": [
    {
      "id": "mtok_xxxx",        // 随机 id，URL 路径用
      "name": "cursor-桌面",     // 用户起的名字
      "tokenHash": "sha256hex", // SHA-256(plaintext)，明文永不落盘
      "createdAt": "ISO8601",
      "lastUsedAt": "ISO8601 | null"
    }
  ]
}
```

- 生成：`crypto.randomBytes(24).toString("base64url")`，格式 `mtok_<43字符>`；创建响应返回明文，之后任何接口不可再取。
- 写盘：tmp 文件 + `rename` 原子替换（写失败仅 `[auth]` warn，不影响主请求——对齐 records 的"永不影响调用"红线）。
- `lastUsedAt` 更新：内存命中即更新 + 60s 节流持久化，避免每请求写盘。

## 2. 鉴权中间件（`src/auth/middleware.ts`）

- `resolveCredential(req)`：`Authorization: Bearer <t>` → `?token=`（URLSearchParams）→ null。`?token=` 兜底是为了浏览器 `EventSource`（无 header 能力，`/api/chat` GET SSE 必需）与不支持 header 的 MCP 客户端。
- `verify(credential, pool)`：常量时间比对（`crypto.timingSafeEqual`，长度不等直接 false）；admin 池 = env 单值，MCP 池 = tokens store 哈希查表。
- 401 响应：`{ "error": "unauthorized" }` + `WWW-Authenticate: Bearer`；`/api` 走 JSON，`/sse`/`/messages` 直接 res.writeHead(401) 结束（不进 transport）。
- 失败日志：`[auth] 401 path=... reason=missing|bad-token|pool=api|pool=mcp`（不含 token 内容）。

## 3. 管理 API 增量（`src/admin/api.ts`）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/auth/check` | admin token 自检（登录页用），200 `{role:"admin"}` / 401 |
| GET | `/api/tokens` | 列表（id/name/createdAt/lastUsedAt/指纹后4位），不含哈希与明文 |
| POST | `/api/tokens` `{name}` | 生成，响应 `{id,name,createdAt,plaintext}`（明文仅此一次） |
| DELETE | `/api/tokens/:id` | 吊销，即时生效（每请求查内存，无缓存失效问题） |

实现挂在现有 `handleApi` 路由链（与 `/api/config` 同层，天然处于 admin gate 之后）。

## 4. admin-web 增量

- `api.ts`（统一封装单点）：
  - token 读写 `localStorage["talkio.adminToken"]`；
  - 所有请求自动附 `Authorization: Bearer`；
  - 响应 401 → 清 token、抛 `UnauthorizedError`，`App.tsx` 捕获切回 LoginView；
  - `chatEventSource` 追加 `?token=`（admin token，因为 `/api/chat` 属管理面）。
- 新增 `LoginView`：token 输入 → `GET /api/auth/check` → 成功存储进入；fail-closed 未配置时该请求同样 401，页面给出"服务器未配置 TALKIO_ADMIN_TOKEN"提示文案（依据状态码区分）。
- 新增 `TokensPage`（导航"访问令牌"）：列表（名称/创建时间/最近使用/指纹后4位）、生成对话框（明文一次性展示 + 复制按钮 + "关闭后无法再查看"警示）、删除二次确认——复用现有反馈系统/Modal 组件规范（遵守 `.trellis/spec/admin-web` 行内操作簇与 disabled 契约）。

## 5. 兼容性与迁移

- **stdio**：不经过 HTTP 层，零改动（AC 回归：smoke-stdio 必须仍绿）。
- **本地开发**：`.env.example` 增 `TALKIO_ADMIN_TOKEN=` 示例；README 写明 dev 起法。admin-web vite dev 代理请求同样带 header（同源封装天然覆盖）。
- **现有 MCP 客户端**：升级后必须带 token——README 给出 Cursor（`headers` 字段）、mcp-remote（`--header`）两种示例；URL query 兜底示例 `http://host:3100/sse?token=mtok_...`（并提示 query 凭证的日志泄漏面，建议仅作降级）。
- **现网部署升级**（fail-closed）：compose 注入 `TALKIO_ADMIN_TOKEN` 与重建容器**同一次**变更内完成（无中间裸奔/锁定窗口）；注意 1Panel compose API 会清 `.env` 的坑——token 直接内联 `environment:` 段。

## 6. 测试设计

- `test/token-store.test.ts`（纯逻辑）：生成→验证通过、错 token 拒绝、删除即时失效、持久化→新实例 reload 后仍可验证、明文不出现在落盘内容、tmp+rename 原子性（异常路径不产生半截文件）。
- `test/admin-auth.test.ts`（http 集成，起真实 listener，沿用 admin-*.test.ts 模式）：
  - 401：无凭证/错凭证 ×（/sse、/messages、/api/config）；
  - 放行：Bearer 头、`?token=` 兜底 ×（admin 面与 MCP 面）；
  - fail-closed：不设 env → 全 401 + 静态壳 200；
  - 两池隔离：admin token → /sse 401；MCP token → /api/config 401；
  - tokens CRUD：生成返回明文一次、列表不含明文/哈希、删除后立即 401；
  - `/api/auth/check`：200/401。
- 既有 `admin-chat/records/usage` 测试需注入 admin token fixture（统一在测试工具里设置 env + 带 header），否则 fail-closed 会打红——列入实施检查项。
- `scripts/smoke-sse.mjs`：带 token 的 SSE 握手 + `list_cards` 调用（供部署后公网冒烟与本地回归复用）。

## 7. 部署流（Q5=A）

1. 分轨提交（backend / admin-web / docs，沿用三向拆分惯例）→ push master；
2. CI 门禁绿 + Docker Hub 发布 latest → 服务器 pull 新镜像；
3. panel-ops 更新 compose（新镜像 + `environment:` 内联 `TALKIO_ADMIN_TOKEN=<生成值>`）→ `docker compose up -d` 重建；
4. 公网验证 AC7：无 token 401（/api/config、/sse）→ 后台登录 → 生成首个 MCP token → `scripts/smoke-sse.mjs` 对公网端点跑通 list_cards；
5. 回滚预案：镜像 tag 0.2.0 可随时 pull 回滚；compose 变更前先在面板备份原文件。

## 8. 权衡记录

- **`?token=` 兜底**：query 中的凭证可能进代理/历史日志——换取浏览器 EventSource 与弱客户端兼容；README 明示仅作降级，优先 header。
- **哈希而非加密存储**：token 不可逆查、泄漏面=文件读权限；明文一次性展示是标准 API-key 模式（对齐 GitHub/OpenAI 习惯）。
- **不做 token UI 轮换 admin token**：env+重启即轮换，UI 化收益低；记入 out of scope。
- **401 不区分"token 不存在/已删除"**：避免枚举探测。
