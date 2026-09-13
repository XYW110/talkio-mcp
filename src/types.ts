/**
 * 共享类型定义 —— 对应 design.md（experts.json schema：providers / experts / models / cards）。
 *
 * 说明：
 * - 这里的类型是「已合并 defaults、可用于运行时」的形态（必填字段齐全）。
 * - experts.json 原始文件形态由 src/config.ts 中的 zod schema 描述，
 *   校验 + defaults 合并后产出本文件中的类型。
 */

import type { ChatMessage, ChatParams, ChatResult, ProviderAdapter, ThinkingLevel } from "./providers/adapter.js";
import type { SignalId } from "./tools/signal-routing.js";

export type { ChatMessage, ChatParams, ChatResult, ProviderAdapter, ThinkingLevel };

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

/** 单个专家配置（defaults 已合并完成）—— 只定义「谁、怎么说话」，不含 model/provider */
export interface ExpertConfig {
  /** 唯一标识，被角色卡（CardConfig.expertId）引用 */
  id: string;
  /** 展示名称 */
  name: string;
  /** 展示图标（emoji） */
  icon: string;
  /** 专家人设 system prompt */
  systemPrompt: string;
  /** 采样温度 */
  temperature: number;
  /** 单次响应最大 token 数 */
  maxTokens: number;
  /** 单次 AI 调用超时（毫秒） */
  timeoutMs: number;
  /** 是否启用 */
  enabled: boolean;
  /** 是否为内置专家（随系统分发，不可删除，仅可启停/编辑） */
  builtin: boolean;
  /**
   * 可选推理策略（P1-B，council-enhancement）：注入到 system prompt 末尾的
   * 差异化指令；缺省 / "default" 时不追加任何内容（system prompt 逐字节不变）。
   */
  reasoningStrategy?: "systematic" | "adversarial" | "backward" | "default";
}

/** 单个模型配置 —— 只定义「用什么引擎」，挂在 Provider 下、与专家无关 */
export interface ModelConfig {
  /** 内部唯一标识，被角色卡（CardConfig.modelId）引用 */
  id: string;
  /** 引用的 providers 表键名 */
  providerId: string;
  /** 真实模型名（传给 provider adapter 的 model 参数） */
  modelId: string;
  /** 展示名称 */
  displayName: string;
  /** 是否启用 */
  enabled: boolean;
  /** 思考强度（reasoning 模型专用；undefined = 不传额外参数，使用模型默认行为） */
  thinkingLevel?: ThinkingLevel;
  /**
   * 可选模型分级（P3-B，council-enhancement）：正整数，仅用于 admin 展示排序
   * （tier 降序在前，无 tier 在后保持原序）；不参与任何选卡/prompt 逻辑。
   */
  tier?: number;
}

/** 角色卡 —— 专家 × 模型的绑定实体（第三个独立概念） */
export interface CardConfig {
  /** 唯一标识，供 consult_experts/brainstorm 的 cards 参数引用 */
  id: string;
  /** 卡片展示名称（如「架构师 · GPT-4o 高速档」） */
  name: string;
  /** 引用的 experts 表键名 */
  expertId: string;
  /** 引用的 models 表键名 */
  modelId: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否默认卡（决定不指定 cards 时优先选哪张） */
  isDefault?: boolean;
  /**
   * 可选信号标签（P2-A，council-enhancement）：值为 SIGNAL_GROUPS 内置信号组枚举，
   * select:"auto" 时按问题文本命中的信号组筛选候选卡；声明 general 的卡任意话题可参与。
   * 空数组视为未声明。
   */
  signals?: SignalId[];
}

/**
 * 应用级配置：loadConfig 的最终产物。
 * providers 表按名索引，experts / models / cards 保持文件中的顺序。
 */
export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  experts: ExpertConfig[];
  models: ModelConfig[];
  cards: CardConfig[];
  /**
   * 可选工具开关（P2-B，council-enhancement）：disabledTools 中列出的工具不注册
   * （tools/list 不可见）。核心保护名单（list_cards/consult_experts/brainstorm）
   * 在 loadConfig 校验拒绝；缺省 = 全部工具可用。
   */
  disabledTools?: string[];
}

/** experts.json 文件的整体形态（校验前为 unknown，校验后见 config.ts 的 zod 推断） */
export interface ExpertsFile {
  experts: ExpertConfig[];
  models: ModelConfig[];
  cards: CardConfig[];
}

/** 调用 adapter 时传递给它的凭据（与 design §5 的 creds 参数一致） */
export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}