# admin-web 对齐 Penpot snowapp 设计体系全量改造

## Goal

把 admin-web 前端从手写单 preset（snow light+dark、dark 不可达）升级到 Penpot `snowapp` 设计体系：24 套 token（12 preset × light/dark）+ 主题运行时 + 组件库补齐 + 三档响应式 shell，使页面观感与 Penpot snowapp 文件一致。

## Background

- 设计真源：Penpot 文件 `snowapp`（OpenDesign 已弃用）。24 个 token set（12 preset × light/dark，每 set 28~33 token）+ 18 个本地组件 + 3 个响应式 shell。
- admin-web 现状：React + Vite + Tailwind，`index.css` 手写 snow light/dark 两套 CSS 变量；Tailwind 语义色映射齐全；`ui.tsx` 有 8 个基础组件；`index.html` 写死 `data-theme="light"`，暗色模式无任何入口（不可达）。
- token 全量导出快照已存：`research/snowapp-tokens-2026-09-13.txt`（含 FALLBACKS 与变量映射规则）。
- 组件规格：`research/components-inventory.md`。

## Requirements

### R1 Token 管道（单一真源）
- 把 Penpot 导出的 24 套 token 固化为仓库内快照 JSON（含导出日期与来源注释）。
- 提供生成脚本：JSON → `tokens.generated.css`（按 `[data-preset="{preset}"][data-theme="{mode}"]` 选择器组织），`npm run tokens` 一键再生成。
- 变量命名保持 admin-web 现有契约（`--canvas`、`--surface-island`、`--accent-blue` 等）以复用 Tailwind 映射，并新增 `--surface-2`、`--surface-3`、`--surface-chrome`、`--border-strong`、`--accent-ink`、`--gap-island`、`--selection-bg`。
- 缺失 token 按 research 文件的 FALLBACKS 回退；focus.ring 为 shadow 类型时取其 color。
- `index.css` 手写变量块删除，改由 generated CSS 提供（基础样式：字体、滚动条、focus-visible、.island 皮肤保留在 index.css）。

### R2 主题运行时
- `<html>` 属性：`data-preset`（12 选 1）+ `data-theme`（light/dark），默认 `snow` / `light`。
- ThemeProvider：读写 localStorage（key `snowapp.theme`，JSON `{preset, mode}`），防 FOUC 的内联 script 注入 index.html。
- 切换 UI：桌面端 PcSidebar 底部（preset 下拉 + light/dark 分段控件）；移动端顶栏入口。切换即时生效（纯 CSS 变量切换，无刷新）。

### R3 组件库补齐（ui.tsx 扩展 + 皮肤对齐）
- 新增：Button（primary/ghost/danger-text/icon 四变体）、TextInput、SelectInput、Chip、Pill、BreadcrumbStrip、SettingsRow、Timeline、DiffLines、DrawerSheet、DetailPanel、IslandHeader、NavTab。
- 现有组件（NavBar/Card/ChevronRow/Toggle/SelectCheckbox/MultiSelectToolbar/SectionLabel/EmptyState）保持 API 不变，皮肤改用新 token（如 border-strong、surface-2）。
- 所有页面现有硬编码样式类（按钮、input、pill）替换为统一组件。

### R4 三档响应式 shell
- 桌面 ≥1280：左侧栏岛 + 内容岛（现状保留，皮肤对齐 top-bar/nav-tab 语义）。
- 平板 768~1279：保持左侧栏但收窄为图标栏（或两行顶栏布局，取实现简单者），内容岛单列。
- 移动 <768：顶栏岛 + 单列内容 + 返回导航；编辑浮层在窄屏为全屏。触控目标 ≥40px。

## Acceptance Criteria

- [ ] AC1 `npm run tokens` 从快照 JSON 生成 `tokens.generated.css`，含 24 个选择器块；snow-light 块中 `--canvas:#EEF2F7` 等抽查值与 Penpot 一致。
- [ ] AC2 页面可通过 UI 切换 12 preset × 2 模式共 24 种主题，刷新后保持（localStorage）；默认 snow/light。
- [ ] AC3 暗色模式实际可达：任选 3 个 preset 的 dark 模式截图验证无「近黑文字配深底」不可读问题。
- [ ] AC4 ui.tsx 新增 ≥10 个组件且 8 个旧组件 API 未破坏（type-check 通过）。
- [ ] AC5 三档视口（1280/800/390）下布局可用：平板档导航可达、移动档触控目标 ≥40px。
- [ ] AC6 `npm run build` 与 `tsc --noEmit` 通过；现有页面功能回归（专家/Provider/模型/角色卡 CRUD 页、会话记录、用量、群聊）。

## Constraints

- 不改后端 `src/`；只动 `admin-web/`（含 vite 配置、构建脚本）。
- 不引入新运行时依赖（主题切换用原生属性 + CSS 变量；不下 Zustand/MUI）。
- Tailwind 语义类名保持向后兼容（页面代码大范围换类名不可接受，只替换按钮/input/pill 这类 R3 指定替换点）。
- Penpot 侧不回写；快照单向导出。
