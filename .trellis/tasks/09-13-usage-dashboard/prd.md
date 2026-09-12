# PRD: admin-web Token 用量聚合页

## Goal / 用户价值

records JSONL 中已逐事件记录了每次 LLM 调用的 token usage（turn / card_result / done 行），meta 行也带有每张卡的 modelId/provider 快照，但后台没有聚合视图，用量数据"只落盘、不可见"。新增一个用量聚合页，把沉睡的数据变成可见的成本/消耗仪表，这是竞品（对比过的一批议事类 MCP）都不具备的现成数据红利。

## Requirements

- R1（聚合 API）：admin API 新增 `GET /api/usage?days=N`（N 默认 30，上限 90）。扫描 records 目录内 mtime 在时间窗内的 JSONL，解析 meta + usage 事件行，返回：总量、按天、按卡片、按模型四组聚合。
- R2（聚合页）：admin-web 新增"用量"页（snow token 风格，导航加入口）：顶部总量卡（prompt/completion/会话数/调用数），下方按天列表（简易条形，无图表库）、按卡片排行、按模型排行三块。
- R3（成本换算，可选轻量）：页内提供本地价格表（localStorage 保存，形如 `{modelId: {input, output}}`，单位 元/百万 token），命中模型时显示估算成本；未命中不显示，不进后端。
- R4（健壮性）：单文件解析失败跳过并计数（响应带 `skipped` 字段）；usage 字段缺失按缺省不计入；接口在 records 未启用时返回空结构而非 404。
- R5（零回归）：不改动 records 写入格式与既有 API；新增路由 additive。

## Acceptance Criteria

- AC1: `GET /api/usage?days=30` 返回 `{ days, total, sessionCount, callCount, byDay, byCard, byModel, skipped }`，数值与手工汇总 fixture 一致。
- AC2: 用量页在桌面/手机布局下正常呈现，暗色主题无残留问题（token 合规）。
- AC3: 含损坏 JSONL fixture 时接口不 500，skipped ≥ 1。
- AC4: `npm test` 全量通过（新增聚合单测 + API 路由测试）；`admin-web npm run build` 通过。
- AC5: 价格表 localStorage 化，刷新后保留；清空 localStorage 后页面无报错。

## Key Decisions（用户已拍板）

- D1: 数据源完全复用现有 records JSONL，不改记录格式（meta.cards 已含 modelId/provider）。
- D2: 成本换算放前端 localStorage，不做后端价格配置。

## Out of Scope

- 不做图表库引入（纯 div 条形）；不做导出；不做 records 之外的实时统计；不做后端价格表管理。
