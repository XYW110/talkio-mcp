# 专家 / 模型 / 角色卡：三概念解绑 + 网页编辑 + MCP 按角色卡调用

## Goal

「专家」「模型」「角色卡」是**三个独立的一等概念**，各自可独立管理，角色卡是把专家和模型配对出来的第三独立实体（有自己的身份，可增删改查、可命名）。

1. **专家（experts[]）**：只描述「我是谁、怎么说话」——不含 model/provider。
2. **模型（models[]）**：只描述「用哪个引擎」——挂在 Provider 下、与专家无关。
3. **角色卡（cards[]）**：专家 × 模型的绑定实体，有自己的 id 和 name（如「架构师 · GPT-4o 高速档」），可独立管理。

**网页端负责编辑这三个概念**；**MCP 侧只关心"选哪些角色卡"**——调用时给角色卡 id 即可，不再直接触碰专家/模型细节。

## Background

talkio_mcp 后端 `ExpertConfig` 强制 `provider` + `model`（缺则 exit(1)），
consult/brainstorm 直接使用 `expert.model`。参照项目 temp/（Talkio）是解耦的：
Identity（人设）不含 model/provider；Model 独立实体 `{ id, providerId, modelId, displayName, enabled }`
挂在 Provider 下，配对发生在会话创建 `createConversation({ modelId, identityId })`。

本任务：后端数据结构支撑解绑 + 前端提供专家/模型/绑定管理 UI。

## Confirmed Facts

- 后端 `src/types.ts:28` `ExpertConfig` 含必填 `provider`/`model`；`src/config.ts:46` zod schema 两者 optional，但 `mergeExpert` 缺省时推 fatalError → exit(1)。见 `src/config.ts:191`。
- `src/tools/consult-experts.ts:53` / `src/tools/brainstorm.ts:64` 直接经 selection 拿到 expert，随后 `src/orchestrator/parallel.ts:99` 用 `expert.model`、`src/orchestrator/dialogue.ts:143` 用 `expert.model` 调 adapter。
- `src/tools/select-experts.ts:31` `hasProviderKey` 依赖 `expert.provider`。
- `src/tools/list-experts.ts:37` `summarizeExpert` 输出含 `provider`/`model`。
- `src/admin/api.ts` 提供 `GET /api/config`（返回合并后 AppConfig）、`PUT /api/config`（JSON.parse 后写盘）、`POST /api/providers/probe`。
- admin-web `src/types.ts:11` `Expert` 含 `provider`/`model`；`src/App.tsx` 三层页面栈（settings→experts/provider→编辑浮层）；`src/components/ModelPicker.tsx` 探测拉取模型。
- 参照项目：`temp/src/types/index.ts:46` `Model`、`:62` `Identity`（不含 model）；`temp/src/pages/settings/ModelsPage.tsx` 独立模型管理页；`temp/src/components/shared/ModelPicker.tsx` 单选/多选弹窗。
- `experts.json` 当前 9 专家，均带 `provider`/`model`（见根目录 experts.json）。

## Requirements

### R1: 三个独立概念（数据结构）
`experts[]`、`models[]`、`cards[]` 三个并列数组并存于 `experts.json`；各自可独立增删改查。专家不含 provider/model；模型挂 Provider 下、与专家无关；角色卡是专家×模型的绑定实体（有 `id` + `name`）。

### R2: 角色卡（核心新实体）
`cards[]` 元素 `{ id, name, expertId, modelId, enabled }`。一张卡 = 一个专家 + 一个模型。卡可有默认标记（决定不指定时选哪张）。

### R3: MCP 工具签名改为按角色卡
- `consult_experts` / `brainstorm` 的参数从 **专家 id 列表** 改为 **角色卡 id 列表**（参数名改 `cards`）。
- `list_experts` 改名 `list_cards`，输出角色卡列表（含背后专家与模型信息）。

### R4: 网页端编辑三概念
主页新增入口卡片：**专家 / 模型 / 角色卡**（保留 Provider）。专家页只编辑人设；模型页按 Provider 分组可探测入库 + 手动增删；角色卡页选择专家+模型+命名+增删改查。

### R5: 老数据自动迁移
启动加载时，若 `experts.json` 是旧格式（专家带 provider/model / 有 defaults），自动迁移为 experts+models+cards。model 名直接建模型记录；每个专家生成一张角色卡（名 = 专家名 · 模型名）。迁移结果可立即使用，不丢数据。

### R6: MCP 调用消费绑定
调用给定角色卡 id → 解析出专家（人设/温度/超时）+ 模型（provider/modelId）→ 调用 provider adapter。无卡/卡无效 → 清晰报错。

## Acceptance Criteria

- [ ] AC1（R1）：`GET /api/config` 返回含 `experts[]`、`models[]`、`cards[]` 三段；专家对象不含 provider/model。
- [ ] AC2（R2）：可创建角色卡 `{ expertId, modelId, name }`；卡可启用/禁用。
- [ ] AC3（R3）：`consult_experts({ cards: [...] })` / `brainstorm({ cards: [...] })` 用对应卡解析出的专家+模型调用；`list_cards` 列出卡（显示专家名 + 模型名）。
- [ ] AC4（R4）：网页端三个入口卡片均可进入列表 + 编辑；专家编辑页不再出现模型选择。
- [ ] AC5（R5）：用旧格式 experts.json 启动 → 自动迁移成三段式，原 9 专家/模型/卡不丢；`configured` 状态正常。
- [ ] AC6（R6）：传入不存在的卡 id → 报错并列出可用卡；不存在的模型/provider 有清晰错误。
- [ ] AC7：`npm run build`、`npm run typecheck`、`npm test`、`node scripts/smoke-stdio.mjs` 全通过。

## Out of Scope

> 占位：本会话后端核心只做「数据结构改造 + MCP 按卡调用」；自定义 provider 真实端点/npm 发布/CI 等后续再定。

## Technical Notes

- 迁移逻辑放 `src/config.ts` loadConfig 内部：检测到旧格式（专家字段含 provider/model 或存在 defaults.provider/model）→ 生成 models/cards 后写回 experts.json（幂等，只迁一次）。
- 角色卡解析器：`src/types.ts` 增 `RuneConfig`/`CardConfig`，`AppConfig` 改为 `{ providers, experts, models, cards }`。
- MCP 侧统一走 `selectCardsForTool`（参照现有 `select-experts.ts`），输出「卡 → 专家+模型」解析后的调用目标。
- `src/orchestrator/parallel.ts` / `dialogue.ts` 由「expert.model」改为「model.providerId + model.modelId」解析 provider 与 model。
- 前端 `admin-web/src/types.ts` 增 `ModelConfig`/`CardConfig`；`App.tsx` 页面栈加 `models` / `cards` 路由；`Expert` 去掉 provider/model。
- MCP 工具注册点（`src/index.ts` / tools registration）同步改名：`list_experts`→`list_cards`、`consult_experts`/`brainstorm` 参数改 `cards`。

## Resolved / Deferred Notes

- R2 的「默认卡标记」：实现阶段用「卡顺序首位」或显式 `isDefault`（待实现时定，不影响需求语义）。
- 温度/超时等参数归属：放在专家（人设）上（专家定义「怎么说话」含语气参数；模型定义「引擎」）。若实现时发现需放卡上再议。
- 角色卡唯一性：不强制唯一（同一专家可多卡绑不同模型）。