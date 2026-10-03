# design — 渠道 API Key 网页直配（keys.json）

## 0. 架构总览

```
调用链（改动后）：
工具(consult/brainstorm/list_cards)
  → resolveCredentials(providerId)          [src/config.ts，改]
  → keysStore.get(providerId)               [src/keys/store.ts，新]
  → { baseUrl: providers[p].baseUrl, apiKey }（无 env 参与）

管理链（新增）：
UI ProvidersPage → PUT /api/keys/:pid  → keysStore.set(pid, apiKey)（热生效）
                 → GET  /api/keys      → 掩码列表（指纹尾4位 + updatedAt）
                 → DELETE?（PUT 空串 = 清除，不单独开 DELETE）
```

- keys 端点位于既有 admin token 门禁之后（`src/auth/middleware.ts` 对 `/api/*` 全拦，无需改动）。
- stdio 模式：loadConfig 时同样加载 keys.json（读文件，无 HTTP 面），行为一致。

## 1. 数据模型（src/keys/store.ts，新模块）

```jsonc
// keys.json（experts.json 同目录；TALKIO_KEYS_FILE 覆盖；gitignore）
{ "version": 1, "providers": { "custom": { "apiKey": "ah-...", "updatedAt": "ISO" } } }
```

- API：`load(path)`（损坏/缺失→空池，`[keys]` warn）、`get(pid): string | undefined`、`set(pid, apiKey | "")`（空串删除条目）、`fingerprint(): Record<pid, {suffix4, updatedAt}>`。
- 原子写 tmp+rename（照抄 token-store 模式）；写失败仅 warn（R1 红线：绝不影响主请求）。
- **明文永不回传**：store 对外只暴露 get（内部用）与 fingerprint（对外）。

## 2. 凭据解析切换（src/config.ts）

- `resolveCredentials`（:520-525）改：`apiKey = keysStore.get(provider.id)`；缺失 → `Provider X: missing key (请在管理后台配置)`。
- provider schema（:52-55）：`apiKeyEnv` 改为 `z.string().optional().passthrough()` 语义——**不再校验/不再使用**，遗留字段宽容忽略（保 0.2.0 回滚：旧镜像继续读 env，文件字段留着无害）。
- 启动告警（:494-497 的 env 缺失警告）改为 keys 缺失检查（启动时 `[keys]` 提示未配置的渠道）。

## 3. 热生效（R4，关键改造）

现状：`createServer(config)` 闭包捕获一次性 AppConfig；PUT /api/config 只写盘不重载（`restartHint: true`）。

改造：
- `src/index.ts`：构建 `state = { config, keys }` 可变持有者；`createServer(state)` 改签名——工具 handler 每次调用取 `state.config`/`state.keys` 当前值（consult/brainstorm/list_cards/followup/select-cards 均经 `ResolvedCard` 解析，改 select-cards/config 层即可，工具层少动）。
- `PUT /api/config`：写盘成功 → 校验 `loadConfig(newText)` → 通过则替换 `state.config`；失败则保留旧配置并 400（写盘成功但校验失败时回写旧文件，保证磁盘≈内存）。`restartRequired` 恒 false，`restartHint` 机制删除。
- `PUT /api/keys/:pid`：store.set（内存+落盘）即时生效。
- admin-web 对 restartRequired 的既有 UI 处理（如有）一并移除。

## 4. 管理 API（src/admin/api.ts，admin 门禁内）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/keys` | `[{providerId, fingerprint(尾4位), updatedAt, hasKey}]`——无明文无哈希 |
| PUT | `/api/keys/:pid` | `{apiKey: string}`；空串=清除；pid 不存在→404；写入即热生效 |

- probe（:239-253）不动：表单当前值直连探测；未填时前端可传已存指纹?——不，probe 语义保持"必须带明文"，UI 未保存的 key 先 probe 后保存。

## 5. list_cards（src/tools/list-cards.ts）

- `ready = keysStore.get(pid) 存在`；`missingEnv` 字段删除，新增 `missingReason?: "未配置 API Key（管理后台-渠道页）"`。
- 响应 shape 变更（missingEnv→missingReason）→ README + list-cards.test.ts 同步。

## 6. admin-web（ProvidersPage.tsx 为主）

- provider 卡片新增「API Key」区：已配置 → 掩码指纹（`…f4a2`）+ updatedAt + 「更换」「清除」；未配置 → 密码输入框。
- 「留空=不改」语义；保存调 `PUT /api/keys/:pid`（与 provider 元信息保存分开提交，避免整文件透传带明文）。
- 预设文案去 .env 引导（改「密钥仅存服务器 keys.json，后台直配」）；`/api/env/status` 调用及类型删除。
- ChatPage/其他页不受影响（凭据在服务端）。

## 7. 测试与迁移面

- 新增：`test/keys-store.test.ts`（load/set/clear/原子写/损坏容错/指纹）；`test/admin-keys.test.ts`（http 集成：401 门禁、掩码无明文、PUT 即时生效、无效 pid 404、空串清除）。
- 迁移（8 文件）：所有 `apiKeyEnv`+`process.env[...KEY]` fixture → 写临时 keys.json fixture（helper 注入）；断言 `missing env var` → `missing key`。
- 回归：stdio 冒烟（mock 模式需 keys.json 里放 dummy key——smoke-stdio.mjs 改为注入临时 keys 文件）、SSE 冒烟、admin-chat/records/usage（应无感）。
- 热生效用例：PUT /api/config 后无需重启，list_cards 立即反映新卡（覆盖 R4 的 configRef 改造，防"改了配置要重启"回归）。

## 8. 部署与现网迁移（AC6）

1. push → CI 绿发镜像；
2. panel-ops 升级容器（新镜像）；
3. **密钥迁移**：从容器 inspect 读 `CUSTOM_API_KEY` env 值 → `PUT /api/keys/custom`（admin token）→ 公网带 MCP token 真实 `consult_experts` 调用成功（服务不断供）；
4. compose 的 `CUSTOM_API_KEY` 条目**保留**（0.2.0 回滚锚点），README/部署说明记录该意图；
5. 回滚预案：`docker pull dockercom110/talkio-mcp:0.2.0` + compose 原样 up——旧镜像读 env，密钥立即可用。

## 9. 权衡记录

- **keys.json 明文落盘 vs 加密**：与 experts.json 同级安全（服务器文件权限 + admin 门禁），加密意义有限（密钥仍须在内存明文）；PRD 明示 out of scope。
- **PUT 空串=清除 vs DELETE**：少一个端点、前端少一套确认流；语义等价。
- **遗留 apiKeyEnv 宽容保留**：牺牲"干净 schema"换 0.2.0 无缝回滚；下个 major 再清理。
- **热生效改造**是本任务最大风险面（configRef 贯穿工具层）——以"PUT 后 list_cards 即时反映"集成用例兜底。
