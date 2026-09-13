# Penpot snowapp 组件清单与规格（2026-09-13 实测）

来源：Penpot 文件 `snowapp`，本地组件库 18 个；尺寸来自 mainInstance 实测。
布局页（Layouts）：app-shell-desktop 1280×800 / app-shell-tablet 800×760 / app-shell-mobile 390×760。
桌面 shell 视觉：灰画布 + 三列悬浮岛（侧栏 Workspace 岛 / Queue 列表岛 / 聊天内容岛），顶部横向 top-bar 岛（brand + nav tabs + actions）。

## 组件规格速查

| 组件 | 尺寸 | 结构/规格 | admin-web 对应现状 |
|---|---|---|---|
| buttons | 460×48 | btn-Primary（实心 accent.base/contrast）、btn-Ghost（透明底 hover surface.hover）、btn-Danger text（danger.fg 文字按钮）、btn-icon | ❌ 无统一组件，各页自拼 className |
| text-input | 220×40 | 岛内输入框：surface.base 底 + border.base 1px + radius.md + focus ring | ❌ 各页自写 input |
| select-input | 220×40 | 同 text-input 外观 + 下拉 | ❌ 原生 select |
| toggle | 200×32 | toggle-on（accent 底）/toggle-off（surface.active 底），28×46 圆角滑块 | ✅ ui.tsx Toggle |
| chips | 240×32 | chip-namespace/chip-domain：surface.2 底 + radius.full + 12px 文字 | ❌ |
| pills | 300×32 | Success/Danger/Warning/Info 四色药丸（semantic.*.bg/fg 对） | ⚠️ 各页手写 rounded-full bg-*-bg |
| list-row | 320×110 | row-selected（active 左侧色条 + surface.hover 底）/row-resting | ✅ ChevronRow 近似 |
| nav-tab | 300×32 | tab-active（accent.base 实心胶囊 + contrast 文字）/tab-inactive（透明） | ⚠️ PcSidebar 用的是列表项非胶囊 tab |
| breadcrumb-strip | 320×32 | crumb-home › text › crumb-current | ❌ |
| breadcrumb-select | 360×40 | pick-home + pick-select（面包屑+下拉合体，用于路径选择） | ❌ |
| island | 320×110 | 悬浮岛容器：surface.base + island.shadow.base + radius.xl(16) | ✅ .island 类 |
| island-header | 360×110 | 岛头部：标题 + 副标题 + 分隔线 | ⚠️ 各页自拼 |
| top-bar | 640×48 | brand + nav-cluster + actions，48px 高岛 | ❌ 桌面端用左侧栏，非顶栏 |
| settings-row | 440×56 | row + separator：左标签右控件，56px 行高 | ⚠️ ExpertEditPage 等自拼 |
| detail-panel | 380×210 | header/sep-top/body/sep-bottom/footer 五段面板 | ❌（ExpertEditPage 近似全屏版） |
| drawer-sheet | 340×130 | 底部/侧边抽屉：surface.solid + 顶部圆角 + 拖拽条 | ❌ |
| timeline | 280×60 | dots + labels：状态时间线（pending→running→done） | ❌（RecordsPage 可用） |
| diff-lines | 300×70 | ctx/del/add 三行 diff 着色行 | ❌（审查/记录页可用） |

## 主题语义（Penpot 侧验证过的契约）

- 24 个 theme：`Theme / {preset} / {light|dark}`，每个 theme 只挂同名一个 set（flat 模型，互斥组合）。
- 激活主题 = 变量整体切换；CSS 侧等价于 `[data-preset="{preset}"][data-theme="{mode}"]` 选择器块。
- shadow token 一律字面量使用，不做绑定（Penpot 导出黑色 blob 的坑只影响 Penpot 导出，不影响 CSS）。

## admin-web 映射决策

- 语义色映射：ok/bad/info/warn → semantic success/danger/info/warning（bg/fg 成对）；DEFAULT 实心色用 fg 同族加深或 accent.base。
- 现有 Tailwind 语义类（bg-island、text-ink 等）保留，底层变量值换成 token 导出值，新增 surface-2/3/chrome、border-strong、accent-ink 类。
- 主题切换器放 PcSidebar 底部（桌面）+ 移动端顶栏 ⚙；localStorage key：`snowapp.theme`（JSON {preset, mode}），默认 snow/light。
