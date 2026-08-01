# 前端开发规范 (Frontend Specifications)

**状态**: 🟢 Filled (已填充)
**目标包**: `temp/src/`
**最后更新**: 基于真实的架构分析进行更新 (Tauri 2 + React 19 + Zustand)

本目录包含了项目前端代码编写和组织的核心规范。这些文档基于实际代码库 (`temp/`) 提炼而成，并结合了项目核心约定 (`claude-code-rules.md`) 确立的标准。

## 规范清单 (Available Guidelines)

1. [目录结构 (Directory Layout)](./directory-structure.md)
   - 描述前端应用的代码组织层级和命名规则（例如 UI、Shared 拆分，PascalCase / kebab-case 规则）。
2. [组件指南 (Component Guidelines)](./component-guidelines.md)
   - 基于 shadcn/ui 的 React 19 组件最佳实践，单一职责原则。
3. [Hooks 指南 (Hook Guidelines)](./hook-guidelines.md)
   - 如何抽象、封装与复用业务副作用与状态。
4. [状态管理 (State Management)](./state-management.md)
   - Zustand 的运用及全局与局部（Context）状态的拆解方案。
5. [类型安全 (Type Safety)](./type-safety.md)
   - 杜绝 `any` 的强依赖类型体系及接口边界防护。
6. [代码质量与测试 (Quality & Testing)](./quality-guidelines.md)
   - 第三规则、错误处理红线及提交流程。

## 使用须知 (How to use)

开发新功能前，请务必了解相关指南，确保代码模式与现有系统对齐。严禁违背团队定下的**“禁止隐形耦合”**与**“禁止使用 any”**等危险红线。