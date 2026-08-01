# 类型安全规范 (Type Safety)

本项目强制使用 TypeScript 确保端到端的开发安全。根据 `claude-code-rules.md`，团队实施了极其严格的类型规范。

## 严格红线：禁止使用 any (The "No Any" Rule)

- **核心约束**：代码库中绝对禁止出现 `any` 类型。必须利用 TypeScript 的类型系统正确推断或显式声明所有的入参、出参和泛型。
- **回退方案**：如果在极少数情况下，第三方库返回的动态结构无法提前穷举或预测，**必须且只能使用 `unknown` 类型**。
- **运行时验证**：对于 `unknown` 的变量，在使用前必须通过类型守卫 (Type Guards) 机制进行缩小验证（如 `typeof val === "object" && val !== null` 或 Zod 解析等机制）。

## 类型组织结构 (Type Organization)

1. **集中定义目录**：核心领域模型（Domain Models，如 `Conversation`, `Message`, `Identity`, `Model` 等概念）集中声明在 `temp/src/types/index.ts`。
2. **全局环境声明**：对于全局挂载的变量（例如 Vite 的 `import.meta.env` 增强，或 Tauri 的 window 方法注入），定义在 `temp/src/types/global.d.ts` 内，通过 `/// <reference />` 或 TypeScript 编译器自动收纳。
3. **真实代码引用结构**：
   在组件或 Hooks 中引用核心类型时：
   ```typescript
   // 引用自 temp/src/hooks/useChatPanelState.ts
   import type { Conversation, ConversationParticipant, Identity, Message, Model } from "../types";
   import type { SelectedMember } from "../components/shared/AddMemberPicker";
   ```
   **原则**：
   - 跨模块的核心类型：从 `types/` 下以 `type` 模式进行导入 (`import type {...}`).
   - 与组件强绑定的独有类型（如上方 `SelectedMember` 属性）：直接在该组件源文件内部定义，按需 export，以保持内聚。

## API 与网络边界安全 (API/Boundary Type Safety)

- 在与服务层通讯（如大模型 API、Tauri 后端命令 invoke）的交界处（对应 `temp/src/services/provider-adapters/types.ts` 等），要求所有输入输出（Payload & Response）明确标注静态类型。