# implement — 09-30-mcp-admin-auth

执行顺序按依赖排列；每步后跑对应验证。分轨提交点用 📦 标注（backend / admin-web / docs 三向拆分惯例）。

## 步骤

1. **token store 纯逻辑** — `src/auth/tokens.ts`：类型、生成（`mtok_<base64url>`）、SHA-256 哈希、`timingSafeEqual` 校验、tmp+rename 原子写、`TALKIO_MCP_TOKENS_FILE` 覆盖、60s 节流 lastUsedAt 持久化。
2. **token store 单测** — `test/token-store.test.ts`（见 design §6 用例清单）。验证：`npx vitest run test/token-store.test.ts`。
3. **鉴权门 + HTTP 接线** — `src/auth/middleware.ts` + `src/index.ts` 请求回调最前部：静态豁免、`/sse`|`/messages` 校验 MCP 池、`/api/auth/check` 与 `/api/*` 校验 admin 池、fail-closed（env 未设→401+启动 ERROR）、401 JSON + `WWW-Authenticate`、`[auth]` warn 日志（无 token 内容）。
4. **管理 API /api/tokens + /api/auth/check** — `src/admin/api.ts` 路由链追加（design §3 契约）。
5. **http 集成测试** — `test/admin-auth.test.ts`（design §6 全用例）；同步修复既有 `test/admin-chat/records/usage` 测试：测试工具统一注入 admin token env + 请求头（fail-closed 会打红它们）。验证：`npx vitest run test/admin-auth.test.ts test/admin-chat.test.ts test/admin-records.test.ts test/admin-usage.test.ts`。
6. **stdio 回归** — `TALKIO_MOCK_PROVIDER=1 node scripts/smoke-stdio.mjs` 必须仍绿（AC：stdio 零影响）。
7. 📦 **backend 提交** — src + test + scripts（先 `npm run typecheck && npm test && npm run build`）。
8. **admin-web 接入** — `api.ts` 单点（token 存取/Bearer 注入/401 拦截登出/`chatEventSource` 加 `?token=`）、`LoginView`、`TokensView`（生成对话框明文一次性 + 复制 + 删除确认，复用反馈系统与 Modal 规范，遵守 .trellis/spec/admin-web 组件契约）、路由与导航入口。
9. 📦 **admin-web 提交** — `npm run build:web` 绿。
10. **文档** — README「鉴权与令牌」章节（机制表、.env 示例、Cursor/mcp-remote/Snow 客户端配置示例、`?token=` 降级与泄漏提示、fail-closed 说明）、`.env.example` 增 `TALKIO_ADMIN_TOKEN=`、`docker-compose.yml` 注释示例、`.gitignore` 增 `mcp-tokens.json`。
11. 📦 **docs 提交**。
12. **全量质量门** — `npm run typecheck && npm test && npm run build && npm run build:web`。
13. **推送与部署（Q5=A）** — push master → CI 绿 + Docker Hub latest → panel-ops：备份 compose → 更新镜像 + `environment:` 内联 `TALKIO_ADMIN_TOKEN=<新生成>` → `docker compose up -d` → 公网验证：无 token 401（/api/config、/sse）→ 网页后台登录 → 生成首个 MCP token → `scripts/smoke-sse.mjs` 对公网端点带 token 跑通 list_cards。
14. **journal + 归档** — `task.py archive 09-30-mcp-admin-auth --skip-branch-validation` + journal Session 追加 + archive 提交。

## 风险文件与回滚

- `src/index.ts`（入口回调改动，stdio/SSE 共用文件——第 6 步 stdio 回归必须过）；`admin-web/src/api.ts`（全站请求单点）。
- 回滚：git revert 对应提交；服务器 `docker pull dockercom110/talkio-mcp:0.2.0` + compose 还原备份。

## 验证命令汇总

```bash
npm run typecheck && npm test && npm run build   # backend 门禁
npm run build:web                                # admin-web 门禁
TALKIO_MOCK_PROVIDER=1 node scripts/smoke-stdio.mjs                    # stdio 回归
TALKIO_ADMIN_TOKEN=dev node scripts/smoke-sse.mjs                      # 本地 SSE 鉴权冒烟
```

## task.py start 前检查

- [x] prd.md 收敛（决策全部落定、无阻塞问题）
- [x] design.md / implement.md 就绪
- [ ] implement.jsonl / check.jsonl 各含 ≥1 条真实 spec/research 条目（内联工作流可豁免，但先补 spec 条目）
