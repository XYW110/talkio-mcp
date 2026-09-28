# 前端组件指南 (Component Guidelines)

前端组件库高度依赖 React 19 和 **shadcn/ui** 生态构建。我们通过明确区分 UI 组件、业务组件与功能级 Provider，保持代码的高复用与单向数据流。

## UI 组件库与样式管理 (UI Library & Styling)

- **核心规范**：基础 UI 库使用 Tailwind CSS 与 `shadcn/ui` 为基底进行二次开发，样式通过 `tailwind-merge` 和 `clsx` 在 `cn()` 工具函数中进行合并处理。
- **真实代码示例**：
  在 `temp/src/lib/utils.ts` 中定义的类名合并工具：
  ```typescript
  import { type ClassValue, clsx } from "clsx"
  import { twMerge } from "tailwind-merge"

  export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
  }
  ```
  在基础组件中应用（参考 `temp/src/components/ui/button.tsx`）。
- **主题化**：通过 `temp/src/index.css` 定义 CSS Variables 令牌（如 `--background`, `--primary`, `--radius` 等 iOS 风格的设计令牌），配合 Tailwind 配置驱动暗黑/明亮模式。

### Convention: admin-web 设计 token（snow-app 悬浮岛体系）

**What**：admin-web（React + Tailwind 3.4，无组件库）的颜色/字号一律走 `admin-web/src/index.css` 中的 CSS 变量 token，经 `admin-web/tailwind.config.js` 映射为语义色名（`canvas` / `island` / `island-strong` / `bg-hover` / `bg-active` / `ink` / `ink-dim` / `line` / 状态成对色 `ok|warn|bad|info` 的 `-bg`/`-text` 变体）。暗色主题仅通过 `:root[data-theme="dark"]` 覆盖变量实现，组件层零改动自动生效；禁止在 tsx 里写 Tailwind 原生色板类（`bg-white`、`gray-*`、`blue-600` 等）或 hex 字面量。

**Why**：token 层保证亮/暗主题一处切换、视觉一致性（13px 基准、岛阴影、active 左 2px 色条等），且 grep 原生色板类即可机械验证暗色无白底残留。

**Example**：
```tsx
// Good：语义 token，亮暗自动适配
<p className="text-[13px] text-info-text">…</p>
<span className="rounded bg-ok-bg px-1.5 text-ok-text">就绪</span>

// Bad：硬编码色，暗色下白底残留
<p className="text-blue-600">…</p>
<div className="bg-white rounded-xl">…</div>
```

**Gotcha（Tailwind alpha 修饰符在 var() 色上静默失效）**：token 色板映射的是原始 `var(--…)` 字符串，Tailwind 无法注入 alpha 通道，`text-info-text/80` 这类写法会被**静默降级**为无透明度（编译产物只有 `color: var(--accent-blue-text)`）。需要半透明时用 `opacity-*` 工具类或在 index.css 里新增带 alpha 的专用变量。检查手段：对 `src/**/*.tsx` grep `-(bg|text|border)-[a-z-]+/[0-9]+` 应为零命中。

**布局约定**：页面外壳统一用 `.island`（radius 16 + `--island-shadow`）悬浮岛类；桌面端「画布 + 侧栏岛 + 内容岛」，手机端「顶栏岛 + 内容岛」，画布呼吸边距 10px；侧栏 active 项用 `.nav-item-active`（inset 2px 左色条）。

**字号比例**：全局正文基准 13px/1.5，任意值字号收敛到 `12 / 13 / 14 / 16 / 20` 五档（辅助文字/正文/强调/小标题/标题）。当前 pages/*.tsx 尚存 `text-[10px]/[11px]/[15px]/[17px]/[18px]` 共 58 处历史债务（snow-ui-restyle 按"按需归一"放行），后续触碰相关页面时顺带收敛，不强制一次性清理。

### Common Mistake: overflow-hidden 卡片内的行内操作簇被窄列裁剪（09-28 adminweb-ux-polish 实测）

**Symptom**：模型列表行（`Card` + 行内 Toggle + 删除按钮，`lg:grid-cols-3`）在桌面 1280 下「删除」按钮 DOM 存在但**不可见**——被 `Card` 的 `overflow-hidden` 裁掉，列表删除功能静默不可达。

**Cause**：行内 `flex` 布局里操作簇（`shrink-0` 的 Toggle 46px + 删除 ~50px + chevron 16px + checkbox 20px）合计 ~150px 固定宽；三列网格每组仅 ~290px，主内容 `min-w-0` 收缩到极限后操作簇溢出卡片右缘被裁剪。

**Fix**：含行内操作簇的分组行卡片网格最多 `md:grid-cols-2`（两列 ~440px 即可容纳）；或把文字按钮降为 icon-only。

**Prevention**：对「卡片 + overflow-hidden + 行内固定宽操作簇」组合，用 boundingBox 探针验收（Playwright `locator.boundingBox()` 比对卡片右缘），截图走查必含**单条数据**场景（此时列宽最窄、最易暴露）。

### Don't: 禁用态只靠外层点击守卫（真正 disabled 才是契约）

**Problem**：
```tsx
// Bad：外层 div 判断 disabled 后忽略点击，但内部 SelectCheckbox（真 <button>）
// 点击仍会直达回调，绕过守卫；且 aria-disabled 与实际行为矛盾
<div role="button" onClick={() => { if (!disabled) toggle(); }}>
  <SelectCheckbox checked={checked} onClick={toggle} />
</div>
```

**Why it's bad**：嵌套可交互元素各自可达，外层守卫只拦住冒泡路径拦不住子元素自己的激活；键盘 Enter 直达子按钮同样绕过。

**Instead**：
```tsx
// Good：禁用语义下沉到组件本身（ui.tsx SelectCheckbox 增量 disabled?: boolean）
<SelectCheckbox checked={checked} onClick={toggle} disabled={disabled} />
```

**Why**：原生 `disabled` 同时阻断指针与键盘路径，`disabled:cursor-not-allowed` 补视觉；外层守卫只保留「阻止冒泡到行点击」这一职责。ChatPage 运行中锁选卡即此用法。

## 组件分层职责 (Component Hierarchy & Responsibilities)

落实 `claude-code-rules.md` 中的**“单一职责”**（Single Responsibility）原则：

1. **基础展示组件 (Presentational UI)**
   - **特点**：无自身业务副作用，所有数据与回调依靠 `props` 传入。
   - **位置**：`temp/src/components/ui/`（例如 `button.tsx`）。
   - **约束**：绝对禁止在 UI 组件内部引入全局状态（Zustand Store）或大模型 API。
2. **跨业务共享组件 (Shared Components)**
   - **特点**：封装了通用业务交互或组合了多个基础 UI（如包含复杂布局的头部栏、通用对话框）。
   - **位置**：`temp/src/components/shared/`。
   - **示例**：`ChatInput.tsx`（封装输入、发送按钮与文本域扩展逻辑）、`ConfirmDialogProvider.tsx`（提供全局确认交互拦截）。
3. **上下文提供者 (Context Providers)**
   - **特点**：包裹特定路由或全局以分享作用域状态（非持久化或非跨域状态）。
   - **示例**：`temp/src/contexts/MobileNavContext.tsx` 隔离移动端导航状态，减轻全局 store 负担。

## 属性设计与结构 (Prop Design)

- 使用 TypeScript 定义清晰的 `Props` interface，不要使用 any，遵循团队**“禁止 any 用 unknown”**红线。
- 对于包裹其他元素的组件，应正确继承如 `React.HTMLAttributes<HTMLDivElement>`，并把 `className` 作为可选属性暴露，使用 `cn(基础类, className)` 进行注入。

## 生命周期与副作用 (Lifecycles & Effects)

- 减少 `useEffect` 的滥用。优先考虑通过事件回调（Event Handlers）处理动作，或使用状态派生（Derived State）解决数据同步。
- 若必须使用副作用监听（例如 Tauri 的底层窗口事件或生命周期绑定），务必提供相应的 `cleanup` 函数（`return () => { ... }`），防止由于热更新或卸载引发内存泄漏。