# 技术设计：admin-web snowapp 全量改造

## 1. 文件结构（目标态）

```
admin-web/
  scripts/gen-tokens.mjs              # 生成脚本（node，无依赖）
  src/styles/snowapp-tokens.json      # 快照（单一真源，从 Penpot 导出于 2026-09-13）
  src/styles/tokens.generated.css     # 生成产物（提交入库，import 即用）
  src/theme/ThemeProvider.tsx         # preset+mode 状态、localStorage、html 属性写入
  src/components/ui.tsx               # 现有组件（API 不变，皮肤对齐）
  src/components/controls.tsx         # 新组件：Button/TextInput/SelectInput/Chip/Pill/NavTab
  src/components/feedback.tsx         # 新组件：Timeline/DiffLines/Pill 可合并进 controls，按内聚定
  src/components/overlays.tsx         # DrawerSheet/DetailPanel
  index.html                          # 防 FOUC 内联 script + 移除写死 data-theme
  tailwind.config.js                  # 扩展映射（surface-2/3/chrome、border-strong、accent-ink）
  src/index.css                       # 删手写变量块，保留基础样式，@import 生成的 token
```

## 2. Token 管道契约

### 快照 JSON schema
```json
{
  "_source": "Penpot file 'snowapp', exported 2026-09-13 via MCP",
  "presets": ["snow", "cream", ...12],
  "sets": { "snow-light": { "bg.base": {"type":"color","value":"#EEF2F7"}, ... }, ...24 }
}
```
快照由 `research/snowapp-tokens-2026-09-13.txt`（原始 `set|type|name|value` 行）一次性转换生成；转换逻辑放 `gen-tokens.mjs --from-research` 或直接手写 JSON（二选一，以脚本为准保证可复现）。

### 变量映射（生成规则，逐 token）
| token | CSS 变量 |
|---|---|
| bg.base | --canvas |
| surface.base / surface.solid / surface.hover | --surface-island / --surface-island-strong / --bg-hover |
| surface.active / surface.2 / surface.3 / surface.chrome | --bg-active / --surface-2 / --surface-3 / --surface-chrome |
| text.primary/secondary/muted/faint | --text-primary/secondary/tertiary/muted |
| accent.base / accent.contrast | --accent-ink / --on-solid |
| border.base / border.strong | --border-color / --border-strong |
| semantic.{success,danger,info,warning}.{bg,fg} | --accent-{green,red,blue,amber}{,-bg,-text}（三段命名，见下） |
| island.shadow.base | --island-shadow |
| island.shadow.soft | --island-shadow-soft |
| focus.ring（color 或 shadow 取 color） | --focus-ring |
| selection.bg | --selection-bg |
| radius.sm/md/lg/xl | --radius-sm/md/lg/xl |
| gap.island | --gap-island |

语义三段式：`--accent-green = semantic.success.fg`（实心用 fg）、`--accent-green-bg = semantic.success.bg`、`--accent-green-text = semantic.success.fg`。
注意：与现状不同点——现状 DEFAULT 用了独立实心色（#3b82f6 等）；改为 fg 后实心按钮/勾选框颜色会随 preset 走，更贴合体系。info 的 DEFAULT 取 `semantic.info.fg`。

### 阴影合成
每层 `[{offsetX} {offsetY} {blur} {spread} {color}]`，`inset:true` 时加 `inset` 前缀，多层逗号连接。

### 选择器组织
```css
[data-preset="snow"][data-theme="light"] { --canvas: ...; ... }
/* 24 块；radius/gap 各 preset 相同但仍随块生成，保证单一真源 */
```
`:root` 级兜底块（= snow-light 值）放最前，防属性缺失时无样式。

### 生成脚本
`node scripts/gen-tokens.mjs`：读 `src/styles/snowapp-tokens.json` → 写 `src/styles/tokens.generated.css`。含内置校验：24 套齐全、每套 ≥28 token、snow-light 抽查 `--canvas:#EEF2F7`、shadow 含 spread。package.json 加 `"tokens": "node scripts/gen-tokens.mjs"`，build 前置（`"build": "npm run tokens && tsc --noEmit && vite build"` 按现有 build 脚本融合）。

## 3. ThemeProvider 契约

```tsx
type Preset = 'snow'|'cream'|'dracula'|'forest-green'|'github'|'google'|'gruvbox'
            |'midnight-blue'|'nord'|'rose-pink'|'solarized'|'tokyo-night';
type Mode = 'light'|'dark';
useTheme(): { preset, mode, setPreset, setMode }
```
- 初始化：读 localStorage `snowapp.theme`（非法值回退 snow/light）→ 写 `document.documentElement.dataset.preset/mode`。
- index.html `<head>` 内联防 FOUC script（读同 key，落两个 dataset 属性），`<html>` 初始不写死 data-theme。
- 组件挂载点：`PcSidebar` 底部保存区上方（桌面）；移动端在自管导航页之外、由 App 渲染的浮动 ⚙ 入口 + DrawerSheet 内放同款控件（复用 SelectInput + 分段按钮）。
- Provider 挂在 `main.tsx`，App 包 `useTheme` 消费。

## 4. 组件设计要点（皮肤规格速记）

- **Button** `variant: primary|ghost|danger-text|icon`：primary=accent-ink 底/on-solid 字/radius-lg/hover 用 filter brightness 或叠 surface 层；ghost=透明底 hover:bg-hover；danger-text=danger.fg 字透明底；icon=方形 40px。
- **TextInput/SelectInput**：h-10 (40px)、bg-surface-island-strong、border border-line、rounded-lg、focus 换 `outline: 2px solid var(--focus-ring)`（全局 :focus-visible 已有）。
- **Chip**：bg-surface-2、rounded-full、px-2.5 py-0.5、12px。**Pill**：bg-{semantic}.bg + text-{semantic}-text。
- **NavTab**：active=bg-accent-ink text-on-solid rounded-full；inactive=text-ink-mid hover:bg-hover。
- **BreadcrumbStrip**：`Home › Current`，分隔符 text-faint。SettingsRow：56px 高、label 左控件右、行间 hairline 分隔。
- **Timeline**：横向 dots+labels，dot 用 accent 色系状态色。**DiffLines**：ctx/del/add 行，del 底 danger.bg 字 danger.fg、add 底 success.bg 字 success.fg、ctx 默认。
- **DrawerSheet**：fixed 底部滑入（移动端），bg-surface-island-strong、顶部圆角 radius-xl、顶部拖拽条（32×4 rounded-full bg-border-strong）、遮罩 bg-black/30。**DetailPanel**：右滑 slide-over，宽 ≤420px，IslandHeader+body+footer 三段。
- 现有 `nav-item-active`（左侧 2px 色条）保留用于侧栏列表项；top-bar/nav-tab 胶囊只在新皮肤处使用。

## 5. 响应式断点策略

沿用 Tailwind `md`(768) 单断点 + 新增 `lg`(1024)/`2xl` 视口验证点：
- **≥1024（桌面）**：现 PcSidebar 248px 保留。
- **768~1023（平板）**：PcSidebar 收窄为 64px 图标栏（icon + title 隐藏，title 走 tooltip/aria-label），保存按钮缩为图标。
- **<768（移动）**：维持现有顶栏岛 + 页内 NavBar 返回模式；编辑浮层已全屏，控件触控目标统一 ≥40px（Button h-10、Toggle 46×28 保持、行高 py-3≈44px）。

## 6. 兼容与回滚

- 变量契约向后兼容：旧类名（bg-island、text-ink、bg-info-bg 等）不动，只换底层值 → 页面无需大改。
- 风险点：semantic DEFAULT 从固定色改为 preset fg 后，Info 实心色在某些 preset（如 gruvbox fg=#83A598）对比度可能偏低 → check 阶段用 AC3 抽查，必要时对 fg 做 darken 不做（保持真源），改为勾选框/选中态改用 accent-ink。
- 回滚：改动集中在 admin-web 前端，`git revert` 单提交可回；generated CSS 可随时由脚本重生成。

## 7. 明确不做

- 不做 Penpot → 仓库的自动同步（无 CI 通道；快照 + 脚本即可）。
- 不做深色系统偏好跟随（prefers-color-scheme）——用户显式选择。
- 不改后端、不改 MCP。
