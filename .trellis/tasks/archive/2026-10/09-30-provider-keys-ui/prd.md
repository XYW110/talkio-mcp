# PRD — 渠道 API Key 网页直配（keys.json）

## 目标

移除 provider（渠道）密钥的环境变量方案：密钥改由网页管理后台直接配置，存独立 `keys.json`，保存后**无需重启即时生效**。终结"配个 key 要进服务器改 env / 重编 compose"的现状。

## 已定决策（用户拍板，2026-09-30）

1. **独立存储**：密钥存 experts.json 同目录 `keys.json`（`TALKIO_KEYS_FILE` 可覆盖），不进 experts.json；`/api/config` 保持原样透传、零掩码改动。
2. **彻底移除 env 支持**：新代码不读 `process.env` 渠道密钥。**已确认后果**：现网 `CUSTOM_API_KEY` env 注入的密钥在新镜像下失效——部署时迁移（读容器 env → 写入 keys.json → 真实调用验证）；compose 里 env 条目**保留不动**，作为 0.2.0 回滚锚点（旧镜像读 env、新镜像读 keys.json，互不干扰）。
3. **掩码回显**：`GET /api/keys` 只回指纹（尾 4 位）与 updatedAt；编辑"留空=不改"；probe 用表单当前输入值。
4. **部署沿用上轮口径**：CI 发镜像 → panel-ops 升级 + 现网 key 迁移 + 公网真实验证。

## 已确认事实（代码证据）

- 凭据链现状：experts.json provider 只存 `apiKeyEnv` 变量名（`src/config.ts:52-55`）；调用时 `process.env[provider.apiKeyEnv]` 解析、缺失即抛 `missing env var`（`src/config.ts:520-525`）。
- `GET /api/config` 文件原样透传（`src/admin/api.ts:182-190`）；`PUT` 写盘 + 内置专家保护 + `restartRequired`（`src/admin/api.ts:191-235`）。
- **进程内配置不热载**：`restartHint: true`（`src/index.ts:171`）→ UI 保存后须重启才生效。"网页直配"必须补热重载。
- `POST /api/providers/probe` 已接受表单明文 apiKey 直连探测（`src/admin/api.ts:239-253`）。
- `GET /api/env/status` 依赖 env 方案（`src/admin/api.ts:256+`），随 env 移除一并废除。
- `list_cards` 的 `ready`/`missingEnv` 语义基于 env（`src/tools/list-cards.ts:34-56`）。
- 测试面：8 个测试文件依赖 `apiKeyEnv`/`process.env` fixture（config / list-cards / select-cards / orchestrator / consult-brainstorm / brainstorm-runs / brainstorm-followup / context-compressor），需成批迁移。
- admin-web：ProvidersPage 预设含 apiKeyEnv 建议值与 .env 提示文案（`admin-web/src/pages/ProvidersPage.tsx:24-41`）。
- 鉴权门（上任务 `src/auth/middleware.ts`）在 HTTP 层拦截 `/api/*`，新增 keys 端点自动受 admin token 保护。
- stdio 与 HTTP 共用 `loadConfig` 产物：keys.json 在 stdio 模式同样生效（无 UI，手工/脚本编辑文件后重启 stdio 进程生效，文档写明）。

## 需求

- **R1 keys.json 存储**：`{"version":1,"providers":{"<providerId>":{"apiKey":"...","updatedAt":"ISO"}}}`；tmp+rename 原子写；gitignore；损坏/缺失=空池 fail-closed（调用报 missing key）；IO 失败只 `[keys]` warn 不影响主请求（对齐 records 红线）。
- **R2 凭据解析切换**：`hasProviderKey`/凭据解析改读 keys store，**不读 env**；experts.json 遗留 `apiKeyEnv` 字段宽容忽略（zod passthrough，保 0.2.0 回滚兼容）。
- **R3 keys 管理 API**（admin 门禁内）：`GET /api/keys`（掩码列表）、`PUT /api/keys/:providerId` `{apiKey}`（空串=清除，写入即热生效）、无效 providerId 404。
- **R4 热生效**：keys 与 experts.json 保存后进程内立即生效，`restartRequired` 恒 false；config/keys 改为可变持有者，工具调用取当前值。
- **R5 防泄漏**：任何响应与日志无明文（GET 只回尾 4 位指纹）；probe 请求体明文不落日志。
- **R6 list_cards 语义**：`ready`=keys 有 key；`missingEnv` → `missingReason`（指引后台配置）；README 同步。
- **R7 admin-web**：ProvidersPage 重做 key 字段——已配置显示指纹+清除按钮、未配置空输入、留空=不改、保存即生效提示；预设去掉 .env 引导；移除 /api/env/status 调用。
- **R8 文档**：README「密钥安全」章节反转改写 + 迁移指引；.env.example 清理渠道 key 示例（保留 TALKIO_ADMIN_TOKEN）；spec 更新。

## 边界（out of scope）

- 密钥加密落盘（明文 JSON + 文件权限模型，与 experts.json 同级）。
- 每模型/每卡粒度密钥（粒度=provider）。
- 轮换审计历史；MCP token 体系不动。

## 验收标准

- **AC1** 后台填 key 保存后**无需重启**，consult_experts/brainstorm 即可用该渠道调用成功。
- **AC2** `GET /api/keys` 只含指纹/updatedAt，任何响应与日志 grep 无明文。
- **AC3** 清除 key 后该渠道调用报 missing key，`list_cards` 该卡 `ready:false` + `missingReason` 指引。
- **AC4** 新代码 grep 无 `process.env` 读 key 路径；experts.json 遗留 `apiKeyEnv` 不报错且被忽略；0.2.0 回滚路径可用。
- **AC5** keys 端点未授权 401（复用 admin 门禁）。
- **AC6** 服务器部署后：env key 迁入 keys.json，公网带 MCP token 的真实 consult 调用成功（服务不断供）。
- **AC7** 全量质量门绿：typecheck + 全部测试（迁移后 fixture）+ build + build:web + stdio/SSE 双冒烟。
