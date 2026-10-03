# Auth & Token Guidelines — 双 token 鉴权契约

来源：09-30-mcp-admin-auth 任务沉淀；渠道 Key 直配章节来自 09-30-provider-keys-ui。HTTP 面凭证控制的全部可执行契约，改动 `src/auth/`、`src/keys/`、`src/index.ts` 门禁或 admin API 鉴权相关路由前必读。

## 双池隔离（AC6 红线）

| 池 | 凭证来源 | 保护面 | 互斥 |
| --- | --- | --- | --- |
| admin | env `TALKIO_ADMIN_TOKEN`（静态，改 env+重启即轮换） | `/api/*` 全部（含 `/api/auth/check`、`/api/chat`、`/api/tokens`、`/api/keys`） | admin token 打 `/sse` 必拒 |
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

## 渠道 Key 直配（keys.json，09-30-provider-keys-ui）

### 1. Scope / Trigger

渠道 API Key 从 env 迁到 `keys.json` 独立存储 + admin 后台网页直配。改动 `src/keys/`、`resolveProviderCredentials`（`src/config.ts`）、`/api/keys` 路由或凭据解析链前必读。

### 2. Signatures

- `src/keys/store.ts`：`initKeysStore(path?)` 装配 → `getKeysStore()` 进程级单例（未装配时 fail-closed 空池）；`set(providerId, key)`（空串=清除）、`get()`（**内部专用**，业务面只准走 `fingerprint(providerId)` → 尾 4 位 + updatedAt）；tmp+rename 原子写，写失败 `[keys]` warn 不上抛。
- `resolveProviderCredentials`（`src/config.ts`）：只读 `getKeysStore()`，缺 key 抛 `Provider X: missing key（管理后台-渠道页可配置）`——env 读 key 路径已**彻底移除**（src/ 零 `process.env` 渠道 key 读取）。
- `src/index.ts`：keys 路径解析 `TALKIO_KEYS_FILE` > experts.json 同目录；`createServer(configRef)` / `createAdminApi({configRef, keys})` 共享持有者。

### 3. Contracts

- `GET /api/keys` → `[{providerId, hasKey, fingerprint?(尾4位), updatedAt?}]`。**掩码红线：尾 4 位之外的任何明文片段不得出现在响应或日志**（测试用片段级扫描 `expectNoKeyFragment`，不是整串 grep）。
- `PUT /api/keys/:pid` body `{key: string}`：写入即热生效（内存单例原位变更，无重启、无 restartRequired 概念）；空串=清除；日志只记「尾4位」或「已清除」动作。
- 存储 `keys.json`（gitignored，模板 `keys.json.example`）；`apiKeyEnv` 仅 deprecated 宽容 passthrough（0.2.0 回滚锚），compose `env_file` 保留为回滚锚、不再是配置面。
- config 热生效：`PUT /api/config` **validate-then-write-then-swap**——`validateExpertsFile` 纯校验先行（zod 全量），校验过才写盘 + `configRef.config` 原位替换；工具 handler 每次调用取当前值。注意：disabledTools 的工具注册面（tools/list 可见性）仍启动静态，需重启。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 未鉴权打 `/api/keys` | 401（authGate `/api/*` 前缀自动覆盖，无需单独注册） |
| 未知 providerId | 404 |
| body.key 非字符串 | 400 |
| 空串 | 清除（hasKey=false，指纹字段消失） |
| PUT /api/config 非法配置 | 400 + **磁盘不落脏数据、内存不变**（不采用"写盘失败回写旧文件"——loadConfig 含 `process.exit(1)`，禁止在校验路径复用） |
| keys.json 落盘失败 | `[keys]` warn，主请求不受影响（对齐 records-persistence） |

### 5. Good / Base / Bad Cases

- Good：PUT 生效后 `list_cards` ready 立即翻转、consult 可用（`test/server-tools.test.ts` 热生效锚）。
- Base：空串清除后 GET 该项 `hasKey:false` 且无 fingerprint 字段。
- Bad：GET 响应含尾 4 位之外片段；日志打印 key 值；任何新增代码读 env 取渠道 key。

### 6. Tests Required

- `test/admin-keys.test.ts`：401、掩码**片段级**断言、PUT 即时生效/清除/404/400、config 热替换 + 非法不落盘内存不变。
- `test/keys-store.test.ts`：文件 IO 语义 + 写失败 warn 文案无明文（含片段级断言）。
- `scripts/smoke-sse.mjs`：真实 listener 级无凭证 401 + `KEY_HEAD` 片段 grep=0。

### 7. Wrong vs Correct

```typescript
// Wrong：读 env 取渠道 key / 响应吐 key / 先写盘再校验
const key = process.env.OPENAI_API_KEY;
res.end(JSON.stringify({ key }));
writeFile(cfgPath, body); validateExpertsFile(body); // loadConfig 有 process.exit(1)，晚了

// Correct：单例 + 尾4位指纹 + validate-then-write-then-swap
const key = getKeysStore().get(providerId);
res.end(JSON.stringify({ providerId, hasKey: !!key, fingerprint: key?.slice(-4) }));
const v = validateExpertsFile(body); if (!v.ok) return badRequest(...);
await writeFile_atomic(cfgPath, v.text); configRef.config = v.config;
```
