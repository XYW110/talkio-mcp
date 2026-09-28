# admin-web 全站易用性与视觉优化

## Goal

对 admin-web 全站（8 页 + 共享组件 + 全局壳）做一轮易用性、优雅度与美观度优化：把原生 `window.confirm/alert` 换成统一的样式化反馈系统，修复 3 个交互真 bug，统一浮层与列表模式，补充微交互与可访问性细节。全部基于既有 snowapp token 体系（24 preset × light/dark），不改后端、不改 `temp/` 桌面端。

## Scope

- **In**: `admin-web/src/**`（App 壳、8 页面、components/ui.tsx、components/controls.tsx、components/overlays.tsx、components/ModelPicker.tsx、theme/*、index.css）。
- **Out**: 后端 `src/`、`temp/`（Tauri 桌面端）、`admin-web/scripts/gen-tokens.mjs` 与 `snowapp-tokens.json` 快照（token 值不改）。

## Requirements

### R1 统一反馈系统（最大体验缺口）

- R1.1 新增应用内 **Toast**（success / error 两级起步）：保存成功显示绿色「已保存」+ 重启提示（替换现在用红色错误横幅报喜的错位）；错误横幅保留红色并支持手动关闭；success 自动消退（3~4s），error 常驻待关闭。
- R1.2 新增样式化 **ConfirmDialog**（promise 化 `useConfirm`），替换 admin-web 全部 `window.confirm`（删除/清空确认，约 14 处）：标题 + 危险操作说明 + 取消/确认（确认钮红色实心）。
- R1.3 校验类 `window.alert`（表单校验、上限提示）替换为 error Toast 或行内错误，不再弹原生框。
- R1.4 App 保存按钮增加 busy 态（请求中禁用 + 视觉反馈），防双击重复提交。
- R1.5 清除 admin-web `src/` 内所有 `window.confirm` / `window.alert` 调用（验收时 grep 为 0）。

### R2 真 bug 修复

- R2.1 ChatPage 讨论总结标题渲染出字面 `### 讨论总结`（`<h2>### 讨论总结</h2>`）→ 去掉 `###`。
- R2.2 ModelsPage `ModelRow` 的 Toggle 外层 `<span onClick>` 调 `onToggle` 且内部 checkbox `onChange` 也调 `onToggle`，一次点击双触发（净效果为开关不动）→ 只保留一处触发，外层仅 stopPropagation。
- R2.3 CardsPage 角色卡 id 渲染成字面反引号 `` `{card.id}` ``（桌面卡与移动行两处）→ 去掉反引号；id 是 MCP 调用参数，补充「复制 id」能力（点击复制 + toast 反馈）。
- R2.4 ModelPicker：列表行 `hover:bg-island-strong` 在同色面板上不可见 → 改 `hover:bg-hover`；补浮层动画与 Esc 关闭、apiKey 输入 autoFocus。

### R3 空态与工具条

- R3.1 `EmptyState` 增加可选 `action` 按钮；专家/Provider/模型/角色卡空态直接给「新建 XX」主按钮（不再让用户找右上角 ＋）。
- R3.2 列表为空时隐藏 `MultiSelectToolbar`（现在空列表下仍显示一排禁用按钮）。

### R4 浮层统一

- R4.1 overlays.tsx 新增通用 **Modal**（遮罩 + 居中面板 + 开场动画 + Esc 关闭 + role=dialog/aria-modal），Provider 编辑 / Model 编辑 / Card 编辑 / 用量价格表 / ModelPicker 迁移到该外壳，替换各自手写的 `fixed inset-0 ... bg-black/30`。
- R4.2 ExpertEditPage 关闭时有未保存改动 → 走 ConfirmDialog 二次确认（其余浮层关闭即弃，成本低可不拦）。

### R5 一致性清理

- R5.1 RecordsPage：多选工具条/勾选框改为复用 `MultiSelectToolbar` / `SelectCheckbox`（现在手写重复实现）；行内 `style={{borderBottom: 1px solid var(--border-color)}}` 换成 `border-line` class（详情 InfoRow、按天条形等同理）。
- R5.2 ChatPage 角色卡选择勾选框复用 `SelectCheckbox`。
- R5.3 列表主文案字号统一 14px（Records 列表现为 16px，与其它列表不一致）。

### R6 微交互与细节打磨

- R6.1 ExpertEdit 系统提示词 textarea：自动增高 + 字数统计。
- R6.2 Toggle 增加 `peer-focus-visible` 键盘焦点圈；NavBar 返回按钮补 hover 态（桌面端）。
- R6.3 总览桌面菜单卡 hover 轻浮起（shadow 过渡）+ 图标着色；全局 primary 按钮按下反馈（active 微缩放，幅度克制）。
- R6.4 全局 `Ctrl/Cmd+S` 触发保存（dirty 时）。
- R6.5 ChatPage 报告卡头部加「复制」按钮（复制总结全文）。
- R6.6 App 首屏 loading 从裸文字升级为品牌化加载态（旋转图标 + 文案）。
- R6.7 index.css 新增动画统一挂 `prefers-reduced-motion: reduce` 降级。

### R7 主题与红线约束

- R7.1 所有新 UI 只用既有 token 变量 / 既有 tailwind 语义类（bg-hover、text-ink-dim…），禁止硬编码 hex；不改动 tokens.generated.css 与生成脚本。
- R7.2 不引入新依赖（继续 react + lucide-react + tailwind 现有栈）。
- R7.3 不破坏既有组件 API（ui.tsx / controls.tsx 现有导出签名保持向后兼容，只做增量）。

## Acceptance Criteria

- [ ] AC1 `cd admin-web && npm run build` 绿（tokens 生成 + tsc + vite 全过）。
- [ ] AC2 `grep -rn "window.confirm\|window.alert" admin-web/src/` 结果为 0。
- [ ] AC3 保存流程：点保存 → 按钮 busy → 成功后绿色 Toast「已保存」+ 重启提示（非红色横幅）；失败红色 Toast/横幅。
- [ ] AC4 任一删除/清空操作弹出样式化 ConfirmDialog，确认后执行；Esc/取消不执行。
- [ ] AC5 ChatPage 总结标题无 `###` 字面量；报告可一键复制。
- [ ] AC6 ModelsPage 行内启用开关一次点击即生效（单次状态翻转）。
- [ ] AC7 CardsPage id 无反引号字面量，复制 id 可用。
- [ ] AC8 四个配置页空态显示「新建」动作按钮；空列表不显示多选工具条。
- [ ] AC9 五个模态（Provider/Model/Card 编辑、价格表、ModelPicker）有开场动画、Esc 可关。
- [ ] AC10 浏览器实测：桌面 1280 + 移动 390 两档宽度 × snow/light + 至少一套深色 preset（如 dracula/dark）截图走查，主要页面无布局破碎、无低对比不可读、无 token 漏配（背景白块/黑块）。
- [ ] AC11 键盘可达：Tab 可聚焦 Toggle 与按钮且有可见焦点圈；Ctrl+S 保存生效。

## Notes

- 用户已确认：创建 Trellis 任务（Q1 A）+ 范围仅 admin-web 全站 8 页（Q2 A）。
- 设计规范基线：snowapp 24 主题已生产验证（见 .trellis/spec/frontend/theming-tokens.md），本轮只消费 token 不新增 token。
- 原生弹窗替换是本轮唯一「行为级」改动：确认文案沿用现有 confirm 文案，语义不变。
