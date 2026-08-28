# Design — 专家 / 模型 / 角色卡 三概念解绑

## 1. 数据模型（experts.json 新结构）

```jsonc
{
  "providers": {
    "openai": { "type": "openai", "baseUrl": "...", "apiKeyEnv": "OPENAI_API_KEY" }
  },
  "experts": [
    { "id": "architect", "name": "架构师", "icon": "🏛️", "systemPrompt": "...", "temperature": 0.7, "maxTokens": 2048, "timeoutMs": 120000, "enabled": true }
  ],
  "models": [
    { "id": "gpt4o", "providerId": "openai", "modelId": "gpt-4o", "displayName": "GPT-4o", "enabled": true }
  ],
  "cards": [
    { "id": "architect-gpt4o", "name": "架构师 · GPT-4o", "expertId": "architect", "modelId": "gpt4o", "enabled": true, "isDefault": true }
  ]
}
```

说明：
- `defaults`（旧顶层 provider/model/temperature…）废弃。
- 专家吸收温度/超时/maxTokens（人设语气与调用参数都在专家上）。
- 模型只有 `id`(内部键) + `providerId` + `modelId`(真实模型名) + `displayName` + `enabled`。
- 角色卡的 `expertId`/`modelId` 引用上面的内部 `id`（不是真实模型名）。

## 2. 后端类型（src/types.ts）

```ts
export interface ExpertConfig {
  id: string; name: string; icon: string; systemPrompt: string;
  temperature: number; maxTokens: number; timeoutMs: number; enabled: boolean;
}   // 去掉 provider/model

export interface ModelConfig {
  id: string; providerId: string; modelId: string; displayName: string; enabled: boolean;
}

export interface CardConfig {
  id: string; name: string; expertId: string; modelId: string; enabled: boolean; isDefault?: boolean;
}

export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  experts: ExpertConfig[];
  models: ModelConfig[];
  cards: CardConfig[];
}
```

## 3. 配置加载与迁移（src/config.ts）

- zod schema 改为新三段；专家 schema 去掉 provider/model 字段。
- **迁移函数 `migrateLegacyConfig(rawJson)`**：检测旧格式信号 → 生成新结构：
  - 信号：专家对象含 `provider`/`model` 字段，或顶层存在 `defaults.provider`/`defaults.model`。
  - 步骤：遍历旧专家，按 (provider, model) 去重生成 models（内部 id = `${provider}-${model}` slug）；每个专家生成一张 card（id = `${expertId}-${modelId}`, name = `${专家名} · ${displayName}`, isDefault = 仅第一张或保持每专家一张）。
  - 写回 experts.json（幂等：新格式不再迁移）。
- 校验：
  - cards 引用的 expertId/modelId 必须存在 → 否则 exit(1)。
  - models 引用的 providerId 必须在 providers 表 → 否则 exit(1)。
  - experts/models/cards 至少各有一条？至少 cards 非空（无卡则 MCP 无可用目标）。experts/models 可空（理论上）。
  - API key 缺失仍只警告不退出。

## 4. MCP 工具改造

### list_experts → list_cards（src/tools/list-cards.ts）
- 输出每张卡：`{ id, name, expertName, expertIcon, provider, model, temperature, enabled, ready, missingEnv? }`。
- ready 判定：卡的 model → provider → apiKeyEnv 已配置 或 mock 模式。

### consult_experts / brainstorm（参数改 cards）
- schema：`experts` → `cards: array(string).optional()`。
- 选择逻辑 `selectCardsForTool(config, cardIds, { defaultLimit })`：
  - 默认（未传）：enabled 的卡 ∩ 其 model 的 provider 有 key → 截最多 3 张（consult）；brainstorm 同。
  - 显式传：按 cardId 取 enabled 卡；找不到/未启用 → ignored。
- 解析「卡 → 调用目标」`resolveCard(card, config)`：返回 `{ expert, providerName, modelId }`；缺引用返回 null。

### orchestrator（parallel.ts / dialogue.ts）
- `callExpert` / `askExpert` 改签名：接收解析后的目标 `{ expert, providerName, modelId }`。
- `resolveProvider` 用 `providerName`（来自 model.providerId）而非 expert.provider。
- `ChatParams.model` 用解析出的 `modelId`，`temperature/maxTokens/timeoutMs` 用专家的。

### select-experts.ts → 重构为 select-cards.ts
- `hasProviderKey(config, providerName)`：改按 providerName 查（不再依赖 expert.provider）。
- `ExpertSelection` → `CardSelection { selected: ResolvedCard[]; ignored; skippedMissingKey; truncated }`。

## 5. 前端（admin-web）

- `types.ts`：增 `ModelConfig`/`CardConfig`；`Expert` 去 provider/model；`ConfigFile` 加 models/cards。
- `App.tsx`：页面栈增 `{name:"models"}` `{name:"cards"}`；主页增两张 ChevronRow 入口卡（模型、角色卡）。
- `pages/ExpertsPage/ExpertEditPage`：删除「模型」分区（provider下拉、model选择行、temperature/maxTokens/timeoutMs 保留在专家）。即 ExpertEditPage 去掉 provider/model 相关 UI 与 ModelPicker。
- 新增 `pages/ModelsPage.tsx`：按 Provider 分组列模型；行式列表（displayName + modelId + provider + enabled toggle + 删除）；新建（选 provider + 手填 modelId/displayName，或探测入库）。
- 新增 `pages/CardsPage.tsx`：列角色卡（name + 专家名 + 模型名 + enabled + 删除）；编辑页/弹窗选专家下拉 + 选模型下拉 + 命名。
- `App.tsx` 的 `deleteProvider`：删除 provider 时同步清掉引用它的 models，以及引用那些 models 的 cards。
- `upsertModel` / `upsertCard` 状态管理仿现有 `upsertExpert`。

## 6. 调用链总览（改后）

```
consult_experts({ cards: ["architect-gpt4o"] })
  → selectCardsForTool → resolveCard → { expert, providerName:"openai", modelId:"gpt-4o" }
  → runConsultation(targets)
  → callExpert(target) → resolveProvider(providerName) → adapter.chat({ model:"gpt-4o", ... })
```

## 7. 兼容性与回滚

- 旧 experts.json 自动迁移并写回；迁移前建议用户已有 git 备份（不动 git）。
- 迁移是幂等的；新格式文件不会被二次迁移。
- 回滚：迁移后想回旧版需手动恢复旧 experts.json（git checkout）。本任务不做双向迁移。

## 8. 风险

- MCP 工具改名/改参数是**破坏性变更**：现有调用方（smoke 脚本、Claude 旧提示）若仍传 `experts` 会失败。需同步改 smoke 脚本与 README。
- 迁移写盘有风险：迁移前先备份 `.bak`（写前 `copyFile(experts.json, experts.json.bak)`）。
