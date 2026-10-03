# implement — 09-30-provider-keys-ui

执行顺序按依赖排列；📦 = 三向拆分提交点（backend / admin-web / docs），每提交独立可构建。

## 步骤

1. **keys store** — `src/keys/store.ts`：load（损坏→空池 warn）/get/set（空串清除）/fingerprint/tmp+rename 原子写/`TALKIO_KEYS_FILE` 覆盖；`.gitignore` 增 `keys.json`；`keys.json.example`（脱敏示例）。
2. **store 单测** — `test/keys-store.test.ts`（8 用例：round-trip/清除/原子写无 tmp 残留/损坏容错/指纹稳定）。
3. **凭据切换** — `src/config.ts`：resolveCredentials 改 keys store（不再读 env）、provider schema `apiKeyEnv` 宽容 passthrough、启动 `[keys]` 缺失提示；`missing env var` 文案→`missing key (管理后台-渠道页)`。
4. **热生效改造** — `src/index.ts` `state={config,keys}` 持有者 + `createServer(state)` 签名调整（select-cards/config 层取当前值，工具层最小 diff）；`PUT /api/config` 写盘→loadConfig 校验→替换 state（失败回写旧文件+400）；`restartRequired/restartHint` 移除。
5. **keys 管理 API** — `GET /api/keys` + `PUT /api/keys/:pid`（空串清除、无效 pid 404、admin 门禁自动覆盖）；删除 `/api/env/status` 端点。
6. **list_cards** — `ready` 改 keys 判定；`missingEnv`→`missingReason`；README 响应示例同步。
7. **测试迁移 + 新集成** — 8 个存量测试文件 fixture 迁 keys.json helper；`test/admin-keys.test.ts`（401/掩码无明文/PUT 即时生效/404/空串清除/热生效 config 用例）。
8. **stdio/SSE 冒烟** — smoke-stdio.mjs 注入临时 keys.json（dummy key）；`npm run typecheck && npm test && npm run build` + 双冒烟全绿 → 📦 **backend 提交**。
9. **admin-web** — ProvidersPage key 字段（掩码/更换/清除/留空=不改/即存即生效提示）、预设文案去 .env、删 env/status 调用与类型；`npm run build:web` 绿 → 📦 **admin-web 提交**。
10. **docs** — README「密钥安全」章节反转（网页直配 + keys.json + 迁移指引 + 0.2.0 回滚说明）、.env.example 清渠道 key 示例（留 ADMIN_TOKEN/占位注释）→ 📦 **docs 提交**。
11. **push → CI → panel-ops 升级**；**现网 key 迁移**：容器 inspect 读 `CUSTOM_API_KEY` → `PUT /api/keys/custom` → 公网真实 consult 调用验证（服务不断供）。
12. **journal + spec 更新**（auth-tokens spec 增 keys 端点契约；「密钥安全」红线声明反转）+ 归档。

## 风险文件

- `src/config.ts`（凭据解析，stdio+HTTP 共用）、`src/index.ts`（state 持有者 + 门禁接线上次刚动过）、8 个测试文件。
- 回滚：git revert；线上 `0.2.0` 镜像 + compose env 未动 = 密钥即刻回退可用。

## 验证命令

```bash
npm run typecheck && npm test && npm run build && npm run build:web
TALKIO_MOCK_PROVIDER=1 TALKIO_ADMIN_TOKEN=dev node scripts/smoke-stdio.mjs
TALKIO_ADMIN_TOKEN=dev node scripts/smoke-sse.mjs            # 本地
node scripts/smoke-sse.mjs http://111.229.147.203:3100 <mcp_token>   # 部署后公网
curl -s -H "Authorization: Bearer <admin>" http://…/api/keys | grep -c <明文片段>   # 必须 0
```

## start 前检查

- [x] prd/design/implement 就绪，jsonl 上下文 curated
- [ ] 终审摘要获用户批准（批后 task.py start）
