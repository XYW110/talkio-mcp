# 钩子函数规范 (Hook Guidelines)

自定义 React Hooks 在本架构中是桥接 UI 组件与外部副作用、本地数据库及全局状态的关键纽带。通过抽离 Hooks 解决逻辑复用问题。

## 复杂逻辑分离原则 (Separation of Concerns)

- **核心思路**：将复杂的副作用（窗口事件监听、数据库读写、复杂业务计算）抽象到独立的 Custom Hook 中。组件内部只负责调用 Hook 获取状态和操作方法，保障“视图与逻辑分离”。
- **遵循三次规则**：依据 `claude-code-rules.md` 中的“三次规则”（代码重复超过3次必须抽象）。如果某个相似的组件逻辑出现，应优先提取为 Hook。

## 自定义 Hook 编写标准与真实案例 (Writing Custom Hooks)

1. **命名规范**：必须以 `use` 开头，采用 `camelCase` 命名，文件名称须与核心方法一致（如 `useKeyboardHeight.ts`）。
2. **类型安全**：入参与返回值的类型要严格约束。
3. **真实代码示例与分析**：
   从 `temp/src/hooks/useChatPanelState.ts` 的结构可以看出，业务 Hook 主要负责聚合不同的 Store 数据并暴露处理逻辑：
   ```typescript
   import { useCallback, useMemo, useState } from "react";
   import { useConversations, useMessages } from "./useDatabase";
   import { useProviderStore } from "../stores/provider-store";
   import { useIdentityStore } from "../stores/identity-store";
   import { useChatStore, type ChatState } from "../stores/chat-store";
   import type { Conversation, Identity, Message, Model } from "../types";

   // 将各类零散的基础状态聚合成聊天面板视图所需要的综合状态与操作函数
   export function useChatPanelState(conversationId: string) {
     // ...
     return { conversations, messages, conv, identities, getModelById, getIdentityById /*, ...*/ };
   }
   ```
4. **副作用治理 (Side-effects)**:
   - 例如 `temp/src/hooks/useKeyboardHeight.ts` 封装键盘高度监听事件。
   - 所有类似 DOM 监听、Tauri Window API 调用的 Hooks 内部，其 `useEffect` 必须在卸载阶段完整 `removeEventListener` 或 `unlisten`。

## 性能与依赖考量 (Performance & Dependencies)

- 当 Hook 返回函数或引用类型数据（对象/数组）时，务必根据实际情况应用 `useCallback` 和 `useMemo`，以避免导致消费该 Hook 的子组件发生非预期的深度重渲染（如同 `useChatPanelState.ts` 顶层导入所示）。
- 在依赖数组中准确列出依赖项，避免闭包陷阱（Stale Closure）问题。