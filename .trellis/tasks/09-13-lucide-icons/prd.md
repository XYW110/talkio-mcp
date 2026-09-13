# admin-web 图标体系切换到 Lucide（lucide-react）

## Goal

把 admin-web **界面 chrome** 里的 emoji 图标（导航菜单、按钮、空状态、设置齿轮、品牌区等）统一替换为 [lucide-react](https://lucide.dev) 矢量图标，颜色随主题 token（`currentColor`），与 snowapp 主题体系联动。用户贴的链接是 Vue 版指南，但本项目是 React → 使用 **lucide-react** 包（同一图标库官方 React 封装，按需 tree-shaking）。

## Requirements

- R1 新增依赖 `lucide-react`（本项目首个图标库依赖；snowapp 任务的「不引入新运行时依赖」约束不跨任务适用，用户本需求显式要求）。
- R2 替换范围（界面 chrome，emoji → Lucide 语义映射）：
  - App.tsx 菜单/侧栏：🏠→House、🤖→Bot、🔌→Plug(Zap)、🧠→Brain、🎴→IdCard(或 Layers)、🗂️→FolderClock、📊→ChartNoAxesColumn(或 BarChart3)、🚀→Rocket、💬→MessageCircle、⚙️→Settings
  - ui.tsx：EmptyState 的 emoji prop 语义保留但示例调用处传 Lucide 节点；NavBar 返回箭头 ‹ → ChevronLeft；ChevronRow 的 › → ChevronRight
  - 其余页面内 chrome emoji（按钮、标签、页头）全量扫描替换；每个映射选语义最贴近的 Lucide 图标，实现者可微调但须在报告中列出映射表
- R3 样式约束：图标颜色一律继承文字色（不加 fill/stroke 色值）；尺寸对齐现有字号（nav 16px、菜单卡 24px、空状态 40px 左右）；线条粗细默认。
- R4 **不在范围**：`experts.json` 的 `icon` 字段（用户数据，21 个专家的 emoji 会进 MCP 报告与角色卡，改数据≠改 UI）；ChatPage 消息正文里的 emoji。

## Acceptance Criteria

- [ ] AC1 `grep -rP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" admin-web/src --include="*.tsx"` 对 chrome UI 的命中清零（用户数据 icon 字段、测试文案除外，报告列出残留清单）。
- [ ] AC2 24 套主题下图标颜色随文字色联动（任选 snow-light/gruvbox-dark 两主题截图验证）。
- [ ] AC3 `npm run typecheck`、`npm test`、`npm --prefix admin-web run build` 全过；bundle 增量 ≤ 30KB gzip（tree-shaking 生效）。
- [ ] AC4 页面布局无错位（图标尺寸统一后 nav/卡片/空状态目测正常）。

## Constraints

- 等待 `council-enhancement-p3` 的实现代理完成后再动手（同批文件冲突：RecordsPage/ProvidersPage/App.tsx）。
- 不改后端；不引入 lucide-react 之外的图标/动画依赖。
