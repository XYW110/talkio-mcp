# Implement: admin-web snow-app 风格改造

## 执行清单（顺序）

1. [x] `index.css`：写入亮/暗两套 token（CSS 变量）、body 13px/1.5、细滚动条、focus-visible 2px 外圈；`tailwind.config.js` 扩展语义色板映射到变量。
2. [x] `App.tsx` 壳改造：桌面端画布+侧栏岛+内容岛；手机端画布+顶栏岛+内容岛；根节点挂 `data-theme="light"`（暗色验证时手动改 dark）。PcSidebar 换岛皮肤 + active 左侧 2px 色条。
3. [x] `components/ui.tsx`：NavBar/SectionLabel/Card/ChevronRow 等公共组件换 token 皮肤（手机端 NavBar 并入顶栏岛风格）。
4. [x] 逐页替换硬编码色值并归一字号/圆角：ExpertsPage → ExpertEditPage → ProvidersPage → ModelsPage → CardsPage → RecordsPage → ChatPage。
5. [x] ErrorBanner / 状态标签（amber/blue/red 徽标）换状态成对 token 色。
6. [x] 全局 `grep` 清零残留旧色（neutral-200 之外的白底 bg-white、blue-600 按钮等），确认暗色下无白底残留。
7. [x] 验证（见下），然后 `trellis-check` 质量检查。

## 验证命令

- `cd admin-web && npm run build`（tsc + vite build 通过）
- 仓库根 `npx vitest run test/admin-records.test.ts test/admin-chat.test.ts`（确认未动到后端逻辑）
- 手动：`npm run dev` 打开桌面/手机宽度，遍历 7 页 + 编辑浮层；`document.documentElement.dataset.theme='dark'` 检查暗色。

## 风险与回滚点

- 高风险文件：`App.tsx`（布局壳）、`ChatPage.tsx`（最近新增，勿动逻辑）。
- 每步独立可 build，出问题按页回退；整体回滚 = revert 前端 commit。

## start 前检查

- [x] prd.md 收敛（无 open question）
- [x] design.md / implement.md 就绪
- [ ] 用户对最终规划摘要的明确批准
