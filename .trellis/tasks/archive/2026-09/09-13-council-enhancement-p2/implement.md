# Implement: council-enhancement P2

## 执行清单（顺序）

1. [x] 类型与校验：`src/types.ts`（CardConfig.signals、ModelConfig.tier、AppConfig.disabledTools）+ `src/config.ts` zod（枚举/正整数/数组校验，缺省不出键）+ 核心工具保护校验（禁用核心/未知工具时 loadConfig 报错）。
2. [x] 信号路由：新建 `src/tools/signal-routing.ts`（SIGNAL_GROUPS / SIGNAL_KEYWORDS / matchSignals / selectCardsBySignals，按 design.md §1 签名）。
3. [x] 选卡接入：`select-cards.ts` 的 selectCardsForTool 增 `select` 选项；`consult-experts.ts` / `brainstorm.ts` 加 optional `select:"auto"` 参数并透传；notes 注明命中/回退/忽略（design.md §1）。
4. [x] 工具开关：`src/server.ts` 注册前检查 disabledTools（design.md §2）。
5. [x] admin：`types.ts`（Card.signals / Model.tier / SIGNAL_GROUPS 副本 + 中文显示名）、`CardsPage.tsx` 信号标签编辑、`ModelsPage.tsx` + `ModelPicker.tsx` tier 稳定排序。
6. [x] 测试：`test/signal-routing.test.ts`（新）+ consult-brainstorm / config / server 级增补（design.md §5）。
7. [x] 验证（见下），然后 `trellis-check`。（npm test 216 通过 / typecheck / admin-web build 均通过）

## 验证命令

- `npm test`（全量）、`npm run typecheck`
- `npm --prefix admin-web run build`
- 手动（可选）：`npm run dev -- --transport sse` 后 MCP inspector 确认 select 参数可见、disabledTools=[brainstorm_followup] 时 tools/list 不含它。

## 红线

- 不传 select 时选卡与报告输出与现状完全一致；显式 cards 优先于 auto（忽略并注明）；缺省字段不写入 experts.json；旧文件直接加载；tier 不进入任何选卡/prompt 逻辑；SIGNAL_GROUPS 值域前后端同步（互指注释）。

## start 前检查

- [x] prd.md 收敛（D1/D2/D3 已拍板）
- [x] design.md / implement.md 就绪
- [x] 用户批准（Q1 A；Q2 B；Q3 A）
