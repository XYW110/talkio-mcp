# implement — admin-web 全站易用性与视觉优化

执行顺序按依赖分层：反馈层 → 浮层外壳 → 页面替换 → 打磨。每步后跑 `npm run build` 保持绿。

## 前置

```bash
cd "D:\Work\Project\ToolProject\talkio_mcp"   # 勿在子目录收尾（shell hook 相对路径坑）
npm --prefix admin-web run build              # 基线必须先绿
```

## Step 1 反馈层（新文件 + App 接线）

- [ ] 新建 `admin-web/src/components/feedback.tsx`：`FeedbackProvider`（toast 队列 + confirm 单实例）+ `useFeedback`，按 design.md 2.1/2.2 契约。
- [ ] `index.css`：加 `snowapp-pop-in` / `snowapp-toast-in` keyframes 与 `.modal-panel` / `.toast-item` 类；`prefers-reduced-motion` 降级。
- [ ] App.tsx：挂 Provider；删 `ErrorBanner`，error 走 sticky toast；save() 加 `saving` busy；Ctrl/Cmd+S；首屏 loading 品牌化。
- [ ] 验证：`npm --prefix admin-web run build` 绿；手动 dev 下保存成功出绿 toast。

## Step 2 Modal 外壳 + 浮层迁移

- [ ] overlays.tsx 增量导出 `Modal`（design 2.3，移动 bottom-sheet / 桌面居中，Esc + 动画 + aria）。
- [ ] 迁移：ProviderEditOverlay、ModelEditOverlay、CardEditOverlay、UsagePage 价格表、ModelPicker（ModelPicker 同时修 hover `bg-hover`、apiKey autoFocus）。
- [ ] ExpertEditPage 关闭拦截：dirty → confirm。
- [ ] 验证：build 绿；双档宽（≥sm / <sm）各浮层开关正常。

## Step 3 页面替换（confirm/alert 清零 + 空态 + bug 修复）

- [ ] 全部 `window.confirm` → `await confirm({danger:true,…})`（调用函数改 async）；全部 `window.alert` → `toast("error",…)`；App.deleteExperts 内置提示同改。
- [ ] EmptyState 加 `action` prop；四配置页空态接「新建」按钮；空列表隐藏 MultiSelectToolbar（含 RecordsPage 换用共享组件时一并处理）。
- [ ] R2 bug：ChatPage `###` 删除 + 报告复制按钮；ModelsPage Toggle 单触发；CardsPage id 反引号删除 + 复制按钮（桌面卡 + 移动行）。
- [ ] RecordsPage：MultiSelectToolbar/SelectCheckbox 复用、inline borderBottom → border-line、16px→14px。
- [ ] ChatPage 勾选框换 SelectCheckbox。
- [ ] 验证：`grep -rn "window.confirm\|window.alert" admin-web/src` = 0；build 绿。

## Step 4 打磨细节

- [ ] ExpertEdit textarea 自动增高 + 字数统计。
- [ ] Toggle `peer-focus-visible` 焦点圈；NavBar 返回 hover；primary 按钮 `active:scale-[0.98]`；总览菜单卡 hover 浮起 + 图标着色。
- [ ] 验证：build 绿；Tab 键走查焦点圈可见。

## Step 5 终检（自查门）

```bash
npm --prefix admin-web run build
grep -rn "window.confirm\|window.alert" admin-web/src   # 期望 0 匹配
grep -rn "style={{" admin-web/src/pages                  # 仅允许非 border 类内联（如 slider 宽度、条形图宽）
git -C "D:\Work\Project\ToolProject\talkio_mcp" status   # 确认只动 admin-web/** 与任务目录
```

## Review gates

- G1（Step 3 后）：confirm/alert 清零 + 三个 bug 修复 diff 逐条对照 PRD R2。
- G2（Step 5 后）：全量 trellis-check + 浏览器双档宽双主题截图走查（AC10）。

## 回滚点

- 每步一个逻辑可独立 revert 的 diff 集；全程在 master 工作树，不加分支，最终按「admin-web / 任务文档」两个提交落盘。
