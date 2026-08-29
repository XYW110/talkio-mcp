# Implement — 专家 / 模型 / 角色卡 三概念解绑

## 实现顺序（后端先行，再前端，最后联调）

### Phase A：后端数据模型 + 迁移
- [ ] A1 `src/types.ts`：`ExpertConfig` 去 provider/model；增 `ModelConfig`、`CardConfig`；`AppConfig` 增 models/cards。
- [ ] A2 `src/config.ts`：zod schema 改三段；专家 schema 去 provider/model；增 `migrateLegacyConfig`（检测旧格式→生成 models/cards→备份+写回）。
- [ ] A3 `src/index.ts`：注册处（若有直接读 AppConfig 的地方）适配新结构。

### Phase B：MCP 工具按角色卡
- [ ] B1 新增 `src/tools/list-cards.ts`（替代 list-experts.ts），输出卡 + 专家名/模型名/ready；注册处把 `list_experts` 改名 `list_cards`。
- [ ] B2 `src/tools/select-experts.ts` → 重构为 `select-cards.ts`：`selectCardsForTool` + `resolveCard` + `hasProviderKey(providerName)`。
- [ ] B3 `src/tools/consult-experts.ts` / `brainstorm.ts`：schema 参数改 `cards`；handler 走 selectCardsForTool + resolveCard。
- [ ] B4 `src/orchestrator/parallel.ts` / `dialogue.ts`：`callExpert`/`askExpert` 改为接收解析目标 `{expert, providerName, modelId}`；`resolveProvider` 用 providerName。
- [ ] B5 `src/utils/format.ts`：报告头显示卡名/模型名（必要时）。

### Phase C：前端
- [ ] C1 `admin-web/src/types.ts`：增 ModelConfig/CardConfig；Expert 去 provider/model；ConfigFile 加 models/cards。
- [ ] C2 `App.tsx`：页面栈加 models/cards；主页两张新入口卡；deleteProvider 级联清理 models→cards。
- [ ] C3 `ExpertEditPage.tsx`：删除模型区（provider下拉/model行/ModelPicker），保留 temperature/maxTokens/timeoutMs。
- [ ] C4 新增 `ModelsPage.tsx`：按 Provider 分组列模型 + 新建（探测或手填）+ 删除 + 启停。
- [ ] C5 新增 `CardsPage.tsx`：列角色卡 + 选择专家 + 选择模型 + 命名 + 编辑/删除 + 启停。
- [ ] C6 `App.tsx` / `ExpertsPage` 传递 models/cards 数据到编辑页。

### Phase D：样本数据 / 校验 / 文档
- [ ] D1 重写 `experts.json`（迁移后形态）作为新基线：9 专家 → 9 模型记录 + 9 张卡。
- [ ] D2 迁移后的 `experts.json` 可用：无 defaults、无 provider/model。
- [ ] D3 更新 `README.md`：list_cards / consult_experts(cards) / brainstorm(cards) 参数表。
- [ ] D4 更新 `scripts/smoke-stdio.mjs`：调用改用 `cards: [...]`。
- [ ] D5 清理失效引用（list-experts.ts 删除或替换为 list-cards.ts）。

## 验证命令

```powershell
npm --prefix admin-web run build   # 或 npm run build:web（前端 TS + 构建）
npm run build                       # 根目录 tsc 编译
npm run typecheck                   # 若有此脚本
npm test                            # 单测
node scripts/smoke-stdio.mjs        # 冒烟：用 cards 调用
```

每个 Phase 结束跑一次 `npm run build` 保编译通过；前后端联调后跑 smoke。

## 风险文件 / 回滚点

- `src/config.ts`（schema + 迁移，最容易 break 启动）
- `src/tools/consult-experts.ts` / `brainstorm.ts` / `select-experts.ts`（工具签名破坏性变更）
- `experts.json`（迁移写回前先 `.bak`）
- `scripts/smoke-stdio.mjs`（调用方式变更）

## 完成后检查清单

- [ ] 启动后 curl `GET /api/config` 确认三段结构
- [ ] `list_cards` 可用
- [ ] `consult_experts({cards:["..."]})` 走对 provider/model（TALKIO_MOCK_PROVIDER=1 验证解析链）
- [ ] 网页端三个入口卡可用（专家无模型区、模型页 CRUD、角色卡页 CRUD）
- [ ] 全量验证命令通过