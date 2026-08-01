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