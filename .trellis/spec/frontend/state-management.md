# 状态管理规范 (State Management)

Talkio 客户端存在复杂的跨视图多级状态（应用设置、聊天记录、多端身份等），本项目统一采用 **Zustand** 进行全局与域级的状态管理，并结合 React Context 覆盖局部视图状态。

## 核心状态方案：Zustand (Global State with Zustand)

我们在 `temp/src/stores/` 下维护了应用的核心状态体系。
- **Store 划分**：依据单一职责，状态被拆分在不同文件中，例如：
  - `chat-store.ts`：管理当前聊天会话的状态机（如正在生成的标识、输入内容缓存等）。
  - `identity-store.ts`：管理 Persona 与多模型身份相关的元数据。
  - `settings-store.ts`：管理应用外观偏好、底层配置开关。
  - `provider-store.ts`：管理 API 供应商信息。
- **真实代码示例 (状态声明)**：
  （以应用状态为例的类似实现，参考 `temp/src/stores/settings-store.ts`）
  ```typescript
  import { create } from "zustand";
  import { persist } from "zustand/middleware";
  
  export interface SettingsState {
    theme: "light" | "dark" | "system";
    setTheme: (theme: SettingsState["theme"]) => void;
  }
  
  export const useSettingsStore = create<SettingsState>()(
    persist(
      (set) => ({
        theme: "system",
        setTheme: (theme) => set({ theme }),
      }),
      { name: "settings-storage" }
    )
  );
  ```

## 本地持久化与本地数据库 (Local Persistence & Database)

对于具有大体积或严格持久化要求的聊天与配置数据，依托 Tauri 的原生能力和键值存储进行保障。
- **KV 存储**：对于轻量的应用级偏好与短存 token，使用 `temp/src/storage/kv-store.ts`。
- **数据库集成**：针对聊天记录等大型核心业务数据，结合 `tauri-plugin-sql` / SQLite 进行读写。前端通过 Hooks 封装获取，如 `temp/src/hooks/useDatabase.ts`（暴露 `useConversations`, `useMessages` 等抽象接口）。

## 局部状态回退：React Context (Local State with Context)

并不是所有状态都应该送入 Zustand。对于强关联视图生命周期或隔离域的状态，优先使用 Context。
- **典型范例**：
  `temp/src/contexts/MobileNavContext.tsx` —— 封装移动端环境下的路由或导航栏收纳状态。
  `temp/src/components/shared/ConfirmDialogProvider.tsx` —— 拦截用户动作并暴露异步触发确认框的能力。
- **原则**：只有当状态需要在组件树中跨越多层级传递（Prop Drilling 超过两层），且不属于全局业务数据时，才使用 Context Provider。