# 前端目录结构 (Directory Layout)

本项目（Talkio）的前端基于 Tauri 2 + React 19 + TypeScript + Vite 架构构建。为了保持高度的代码整洁与可维护性，遵循按功能/角色划分的扁平化与领域化结合的树形结构。

## 目录分层与核心模块 (Core Modules)

在 `src/` 下，主要包含以下核心目录：

- **`assets/`**: 静态资源（如图标、全局样式入口）。
- **`components/`**: 核心 React 组件层。
  - **`ui/`**: 基础无状态 UI 组件（基于 shadcn/ui，如 `button.tsx`, `dialog.tsx` 等）。
  - **`shared/`**: 跨业务复用的公共组件（如 `ConfirmDialogProvider.tsx`, `ChatInput.tsx` 等）。
  - **`[domain]/`**: 按照业务领域划分的组件（如推测存在的 `chat/`, `chat-list/` 等功能组件）。
- **`contexts/`**: React Context 声明与 Provider 组件，处理局部共享状态（如 `MobileNavContext.tsx`）。
- **`hooks/`**: 抽离的自定义 React Hooks，处理特定业务逻辑与副作用（如 `useChatPanelState.ts`, `useKeyboardHeight.ts`, `useDatabase.ts`）。
- **`i18n/`**: 多语言国际化配置与文案字典（如 `index.ts` 入口）。
- **`lib/`**: 纯函数库与工具类（如 `utils.ts` 中基于 tailwind-merge 的 `cn()` 样式合并工具）。
- **`services/`**: 与外部系统交互的服务层封装（如 `provider-adapters/` 大模型 API 适配器, `tts/` 语音合成）。
- **`storage/`**: 持久化存储与数据库交互封装（如 `kv-store.ts`, 以及结合 Tauri 的 SQLite 交互层）。
- **`stores/`**: 全局状态管理层，基于 Zustand 实现（如 `chat-store.ts`, `settings-store.ts`, `identity-store.ts`）。
- **`types/`**: 全局 TypeScript 类型定义与声明文件（如 `global.d.ts`, `index.ts`）。

## 文件命名规范 (Naming Conventions)

根据团队 `claude-code-rules.md` 中的“命名即文档”约束，遵守以下命名规则：

1. **React 组件文件 (.tsx)**: 
   - 业务或容器组件统一使用 `PascalCase`（例如：`temp/src/components/shared/ChatInput.tsx`，`App.tsx`）。
   - 基础 UI 库组件（如 shadcn 衍生）通常小写/短横线（例如：`temp/src/components/ui/button.tsx`）。
2. **TypeScript 源文件 (.ts)**:
   - 包含 Class 类声明的文件使用 `PascalCase`（如果有）。
   - 普通工具、Hooks、Stores 等一律使用 `kebab-case`（如 `settings-store.ts`）或 `camelCase`（如 `useChatPanelState.ts`）。
3. **样式文件 (.css)**: 使用 `kebab-case` 命名，统一在 `src/index.css` 作为入口。

## 目录依赖关系与禁止隐形耦合 (Dependency Rules)

- 严禁 **循环依赖** 及 **隐形耦合**：业务组件（`components/`）只能依赖 `hooks/`、`stores/` 或底层 UI 组件；严禁跨组件目录的直接兄弟级私有状态引用。
- UI 组件 (`ui/`) 必须是纯展示型，不应该引入全局状态（`stores/`）。