# PRD: admin-web 改造为 snow-app 悬浮岛风格

## Goal / 用户价值

将 admin-web 的视觉风格从「iOS 平铺白底」改造为参考项目 snow-app（MayDay-wpf/snow-app）的「灰画布 + 悬浮岛」工作台风格，提升桌面管理后台的层次感与信息密度，同时保持全部现有功能与交互逻辑不变。

## 背景与已确认事实

- admin-web 技术栈：React + TypeScript + Tailwind CSS 3.4，无组件库；全局样式仅 `admin-web/src/index.css`（tailwind 三件套 + body 字体/背景）。
- 现有布局（`admin-web/src/App.tsx:436-548`）：手机端 iOS 分组列表 + 桌面端左侧固定侧边栏（PcSidebar, w-60）+ 内容区；页面共 7 个（总览/专家/Provider/模型/角色卡/会话记录/群聊），另有 ExpertEditPage 全屏编辑浮层。涉及文件约 2967 行（8 个 tsx）。
- 参考项目 snow-app 的风格要点（已读其源码 `snow-tokens.css` / `snow-preset-cream.css` / `snow-preset-google.css`，留在仓库根目录）：
  - 灰蓝画布 `--app-bg: #eef2f7`，四周 10px 呼吸边距；顶栏/侧栏/内容区各自为独立圆角"岛"（radius 16px），半透明白表面 + 淡阴影 + 顶部内描边高光。
  - 设计 token 体系：CSS 变量（灰阶中性色取自 Tailwind 灰、状态色 bg/text 成对：绿/红/蓝/琥珀）、基准字号 13px / 行高 1.5、系统字体栈。
  - active 项左侧 2px 色条、hover 浅灰底、focus-visible 2px 外圈、细滚动条。
  - 主题预设机制（google / cream）通过 `data-theme-preset` 属性覆盖 token 实现。

## Requirements

- R1: 引入 snow-app 式设计 token 层（CSS 变量），Tailwind 具体色值改为引用 token（或建立 Tailwind 色板映射），全局基准字号 13px。
- R2: 桌面端（md+）布局改为「灰画布 + 顶栏岛 + 侧栏岛 + 内容岛」的悬浮岛结构，含呼吸边距、圆角、岛阴影。
- R3: 导航项、按钮、输入框、列表行的 hover/active/focus 状态按 snow-app 规范调整（active 左侧 2px 色条等）。
- R4: 所有页面（含编辑浮层、Chat、Records）视觉跟随新 token，不改变任何功能行为与数据流。
- R5: 功能零回归：现有 CRUD、保存、错误提示逻辑不动，仅动样式层。

## Acceptance Criteria

- AC1: 桌面端打开 admin-web 可见灰画布 + 悬浮岛（侧栏/内容），圆角与阴影符合 token 定义。
- AC2: 全局正文 13px、行高 1.5；状态标签使用成对 bg/text token 色。
- AC3: 侧栏 active 项有左侧 2px 色条；hover 为浅灰底；focus-visible 有 2px 外圈。
- AC4: 手机端为「顶栏岛 + 内容岛」结构，无 iOS 返回 NavBar 残留风格。
- AC5: 在 `<html data-theme="dark">` 下整站呈现暗色主题，无白底残留、文字可读。
- AC6: 遍历 7 个页面 + 专家编辑浮层，功能行为与改造前一致（新增/编辑/删除/保存/错误提示正常）。
- AC7: admin-web 构建与相关测试通过。

## Key Decisions（用户已拍板）

- D1: 主题基调采用 snow-app 默认灰蓝（#eef2f7 画布 + 白岛 + 黑主色），不做 cream/google 预设。
- D2: 手机端与桌面端都改造；手机端放弃 iOS 风格，改为 snow-app 风格（无侧栏，顶栏岛 + 内容岛）。
- D3: 顺带实现暗色主题 token（`data-theme="dark"`，参考 snow-app 的 dark 值），亮暗切换入口后续可用；token 架构本次即支持。

## Out of Scope

- 不引入任何新 UI 框架/组件库。
- 不改动后端（src/admin/api.ts）与 MCP 侧代码。
- 不做主题切换器 UI（仅保证 token 层支持 data-theme 切换）。
- 不做 cream / google 主题预设。
- 不改数据结构与 API。
