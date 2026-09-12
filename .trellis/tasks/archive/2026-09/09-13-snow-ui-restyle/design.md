# Design: admin-web snow-app 风格改造

## 架构与边界

纯前端样式改造，只动 `admin-web/src/` 下的表现层：

- `index.css` — 新增 token 层（CSS 变量，亮/暗两套）+ 基础元素样式（滚动条、focus-visible、body 字号 13px）。
- `tailwind.config.js` — 用 CSS 变量扩展 Tailwind 色板（`colors: { surface, canvas, ink, accent… }`），使现有 className 风格的页面可以逐步替换为 token 色而不引入 runtime 依赖。
- `App.tsx` — 布局壳改造：桌面端「画布 + 侧栏岛 + 内容岛」；手机端「画布 + 顶栏岛 + 内容岛」。加 `data-theme` 挂载点（默认 light）。
- `components/ui.tsx` — NavBar / SectionLabel / Card / ChevronRow / 等公共组件改为岛风格与 token 色（NavBar 在手机端改造成顶栏岛的一部分）。
- 各 Page（7 个 + ExpertEditPage）— 替换硬编码 Tailwind 色值为 token 语义色，调整卡片圆角/阴影/字号，不改逻辑。

## Token 设计（源自 snow-tokens.css）

亮色（`data-theme` 缺省 = light）：
- 画布 `--canvas: #eef2f7`；表面 `--surface: #ffffff`（岛）、`--surface-muted: #f8fafc`；hover `#f3f4f6` / active `#e5e7eb`
- 文字 `--ink: #111827 / #374151 / #6b7280 / #9ca3af`；边框 `#e5e7eb`
- 状态成对色：绿 #22c55e/#dcfce7/#166534、红 #ef4444/#fee2e2/#991b1b、蓝 #3b82f6/#dbeafe/#1d4ed8、琥珀 bg #fef3c7/text #92400e
- 圆角 6/8/12/16，岛阴影 `0 14px 34px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,0.72)`

暗色（`data-theme="dark"`，照抄 snow-app dark 值）：画布 #050505、岛 #111111/rgba(17,17,17,.78)、文字 #f5f5f5 系、状态色换亮色变体、阴影加深。

## 布局

- 桌面（md+）：`app-shell` = 画布 padding 10px + flex row，`gap 10px`；侧栏岛 w-[248px] radius-16；内容岛 flex-1（内部各页自带滚动）。保存按钮保持在侧栏岛底部。
- 手机（<md）：画布 padding 10px，纵向「顶栏岛（标题/返回）+ 内容岛」，去掉现有 iOS 返回 NavBar 蓝字样式与白底分组卡片观感（分组列表结构保留但换 token 皮肤）。

## 兼容与迁移

- Tailwind 色板映射采用「语义名 → var(…)」方式，旧的具体色（neutral-*, blue-600 等）逐文件替换；替换策略按页面逐个过，避免大爆炸。
- 暗色适配优先走 token：凡引用 token 的组件暗色自动生效；个别页面内残留硬编码色在实现清单中逐页清零。
- 无数据流/接口变更，回滚 = revert 前端提交。

## 权衡

- 不引入 tailwind dark class 机制，统一用 CSS 变量切换，避免同一处颜色两套写法。
- 13px 基准只作用于 body 默认字号，组件内已显式写死的 text-[Npx] 在逐页过时按需归一到 token 梯度（12/13/14/16/20）。
