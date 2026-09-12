# Implement: admin-web Token 用量聚合页

## 执行清单（顺序）

1. [x] `src/records/store.ts`：`aggregateUsage(dir, days)` 纯函数 + 单测（fixture：正常×2、损坏×1、窗外×1，含 unknown 桶断言）。
2. [x] `src/admin/api.ts`：`GET /api/usage` 路由（days 钳制、空结构分支）；API 测试。
3. [x] `admin-web/src/types.ts` / `api.ts`：响应类型 + `getUsage(days)` 客户端方法。
4. [x] `admin-web/src/App.tsx`：导航"用量"入口（桌面 + 手机）。
5. [x] `admin-web/src/pages/UsagePage.tsx`：页面实现（统计岛卡 / 按天条形 / 双排行 / localStorage 价格表浮层），全程 token 语义类。
6. [ ] 全量验证，然后 `trellis-check`。

## 验证命令

- `npm test`（含新增聚合/API 用例）
- `cd admin-web && npm run build`
- 手动：SSE 模式起服务，构造几条 records（或用真实记录），检查 7/30/90 天切换、暗色主题、价格表浮层。

## 风险与回滚点

- 风险点：大记录目录下接口耗时——mtime 预过滤在前，单文件全文解析在后；90 天窗口内文件量正常 < 数百，不引入流式解析复杂度。
- `App.tsx` 是布局壳，仅加一个导航项与路由分支，勿动岛布局结构。
- 回滚：单 commit revert；新路由 additive。

## start 前检查

- [x] prd.md 收敛（无 open question）
- [x] design.md / implement.md 就绪
- [x] 用户对最终规划摘要的明确批准（2026-09-13，Q1:A / Q2:A）
