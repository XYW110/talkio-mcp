# Design: council-enhancement P2

前置阅读：`prd.md`（R1-R8、红线）、`../09-13-council-enhancement/research/competitor-deep-dive.md`。

## 1. 信号路由（P2-A）

### 常量表（新文件 `src/tools/signal-routing.ts`）

```ts
/** 内置信号组：id 即 CardConfig.signals 的合法值 */
export const SIGNAL_GROUPS = [
  "sql-data", "security", "infra", "ml", "api",
  "frontend", "cost", "pipeline", "writing", "general",
] as const;
export type SignalId = (typeof SIGNAL_GROUPS)[number];

/** 关键词 → 信号组（中英双语，子串匹配，小写化后比对） */
export const SIGNAL_KEYWORDS: Record<SignalId, string[]> = {
  "sql-data": ["sql", "数据库", "表结构", "索引", "查询优化", "migration", "schema"],
  "security": ["安全", "鉴权", "权限", "加密", "漏洞", "注入", "auth", "security", "secret"],
  "infra":    ["部署", "运维", "容器", "k8s", "kubernetes", "docker", "devops", "infra", "服务器"],
  "ml":       ["模型", "训练", "推理", "embedding", "向量", "机器学习", "llm", "prompt", "rag"],
  "api":      ["接口", "api", "rest", "graphql", "rpc", "webhook", "集成"],
  "frontend": ["前端", "ui", "界面", "组件", "react", "vue", "css", "页面", "样式"],
  "cost":     ["成本", "费用", "预算", "计费", "token 用量", "省钱", "cost", "billing"],
  "pipeline": ["流水线", "ci", "cd", "构建", "发布", "pipeline", "workflow"],
  "writing":  ["文案", "写作", "文档", "博客", "翻译", "润色", "readme", "文档结构"],
  "general":  [], // 兜底信号组：卡可声明 general 表示「任意话题可参与」
};

export function matchSignals(text: string): SignalId[]  // 返回命中的信号组（保持表序）
export function selectCardsBySignals(config, text, limit): CardSelectionResult // 命中→交集筛选→文件序截断；零命中→null（由调用方回退默认）
```

- `general` 语义：声明了 `general` 的卡在任何 auto 查询中都是候选（不要求关键词命中其专属信号）。
- 匹配对 `text` 做 `toLowerCase()`；关键词表里英文统一小写，中文原样。

### 选卡接入（`src/tools/select-cards.ts`）

- `CardConfig` 加 `signals?: SignalId[]`（types.ts + config.ts zod：`z.array(z.enum(SIGNAL_GROUPS)).optional()`；空数组视为未声明）。
- 新增公开函数 `selectCardsForTool(config, cards, { defaultLimit, select })`：`select === "auto"` 且未传显式 cards 时走信号路径；显式 cards 优先（select 被忽略，notes 注明「显式卡列表优先，已忽略 auto」——AC2 取「忽略」而非报错，保持工具宽容性）。
- 信号路径零命中（无交集卡且无 general 卡）：回退现有默认卡逻辑，notes 加「信号未命中，已回退默认卡」；命中时 notes 列出命中信号组与命中卡数。

### 工具参数（consult-experts.ts / brainstorm.ts）

- 两工具 zod shape 各加：
  ```ts
  select: z.enum(["auto"]).optional()
    .describe("选卡策略：auto=按问题内容信号路由自动选卡；缺省按 cards/默认卡逻辑")
  ```
- handler 将 `select` 透传给 `selectCardsForTool`。MCP inputSchema 为 optional，向后兼容。

## 2. 工具开关（P2-B）

- `src/types.ts` AppConfig 增 `disabledTools?: string[]`；`src/config.ts` zod：`z.array(z.string()).optional()`。
- `src/server.ts` 注册循环处（现为逐个 registerTool）：注册前检查 `config.disabledTools`；核心保护名单常量：
  ```ts
  const PROTECTED_TOOLS = ["list_cards", "consult_experts", "brainstorm"];
  ```
  `loadConfig`（config.ts）校验：disabledTools 含 PROTECTED 成员或未知工具名（不在「全部已知工具名」表内）→ 抛 zod 级清晰错误（中文，指明违规项）。
- 禁用 brainstorm_followup：不注册，MCP 客户端 tools/list 不可见、调用返回未知工具（SDK 默认行为）。
- 默认缺省字段 = 全开。

## 3. 模型分级 tier（P3-B，仅展示）

- `ModelConfig` 增 `tier?: number`（zod `z.number().int().positive().max(100).optional()`）。
- admin-web `src/types.ts` Model 加 `tier?: number`；ModelsPage 与 ModelPicker 列表排序：有 tier 按 tier 降序在前（同 tier 保持原序），无 tier 在后保持原序（稳定排序）。
- 仅排序展示，不改任何请求/选卡数据流。

## 4. admin CardsPage signals 编辑

- 卡编辑表单增「信号标签」区：`SIGNAL_GROUPS` 十个 chip 开关（选中=高亮），映射到 `card.signals`；全部取消 = `undefined`（落盘删键）。
- admin-web 侧常量副本放在 `admin-web/src/types.ts`（`SIGNAL_GROUPS` 数组 + 中文显示名映射），**与后端值域需人工保持同步**（在两处常量注释里互指）。

## 5. 测试设计

- 新增 `test/signal-routing.test.ts`：matchSignals 中英命中/大小写/general 兜底；selectCardsBySignals 交集筛选、文件序、limit 截断、零命中 null。
- `test/consult-brainstorm.test.ts` 增补：select:"auto" 命中/回退 notes；显式 cards+auto 被忽略；不传 select 输出与现状一致（回归断言沿用现有用例即可，另加一条显式断言）。
- `test/config.test.ts` 增补：signals/tier/disabledTools 校验（合法/非法/缺省不出键）；禁用核心工具报错；禁用未知工具报错。
- `test/server-tools.test.ts`（若无现成 server 级测试文件，可在现有 server 相关测试内增补）：disabledTools 含 followup 时 tools/list 不含它，缺省含。

## 6. 风险与对策

- **行为回归**：select 缺省路径完全旁路新代码（仅透传 undefined）；AC1 回归断言兜底。
- **admin/后端信号值域漂移**：两处常量互指注释 + check 阶段 grep 比对。
- **disabledTools 校验时机**：必须在 loadConfig（启动即失败），不能延迟到注册时才报。
