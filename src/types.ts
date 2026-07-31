/**
 * 共享类型定义 —— 对应 design.md §4（experts.json schema）与 §5（Provider Abstraction）。
 *
 * 说明：
 * - 这里的类型是「已合并 defaults、可用于运行时」的形态（必填字段齐全）。
 * - experts.json 原始文件形态由 src/config.ts 中的 zod schema 描述，
 *   校验 + defaults 合并后产出本文件中的类型。
 */

import type { ChatMessage, ChatParams, ChatResult, ProviderAdapter } from "./providers/adapter.js";

export type { ChatMessage, ChatParams, ChatResult, ProviderAdapter };

/** provider 适配器类型名（registry 中注册的三个实现） */
export type ProviderType = "openai" | "anthropic" | "openai-compatible";

/** experts.json 中 providers.<name> 的运行时形态（apiKey 已从环境变量解析的结果见 ResolvedProvider） */
export interface ProviderConfig {
  /** provider 适配器类型，决定使用哪个 adapter */
  type: ProviderType;
  /** API 基础地址（不含末尾斜杠的规范化由 adapter 处理） */
  baseUrl: string;
  /** 环境变量名（间接引用，绝不存放真实密钥） */
  apiKeyEnv: string;
}

/** 单个专家配置（defaults 已合并完成） */
export interface ExpertConfig {
  /** 唯一标识，供 consult_experts/brainstorm 的 experts 参数引用 */
  id: string;
  /** 展示名称 */
  name: string;
  /** 展示图标（emoji） */
  icon: string;
  /** 专家人设 system prompt */
  systemPrompt: string;
  /** 引用的 providers 表键名 */
  provider: string;
  /** 模型名 */
  model: string;
  /** 采样温度 */
  temperature: number;
  /** 单次响应最大 token 数 */
  maxTokens: number;
  /** 单次 AI 调用超时（毫秒） */
  timeoutMs: number;
  /** 是否启用（disabled 的专家不参与默认咨询） */
  enabled: boolean;
}

/**
 * 应用级配置：loadConfig 的最终产物。
 * providers 表按名索引，experts 保持文件中的顺序。
 */
export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  experts: ExpertConfig[];
}

/** experts.json 文件的整体形态（校验前为 unknown，校验后见 config.ts 的 zod 推断） */
export interface ExpertsFile {
  defaults?: Partial<Pick<ExpertConfig, "provider" | "model" | "temperature" | "maxTokens" | "timeoutMs">>;
  providers: Record<string, ProviderConfig>;
  experts: ExpertConfig[];
}

/** 调用 adapter 时传递给它的凭据（与 design §5 的 creds 参数一致） */
export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}
