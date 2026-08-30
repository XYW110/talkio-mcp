// Shared types mirroring the MCP server's experts.json shape (三段结构：experts / models / cards).

export interface ProviderConfig {
  type: "openai" | "anthropic" | "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string;
}

export type ProviderMap = Record<string, ProviderConfig>;

export interface Expert {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs?: number;
  enabled: boolean;
  builtin?: boolean;
}

export interface ModelConfig {
  id: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  enabled: boolean;
}

export interface CardConfig {
  id: string;
  name: string;
  expertId: string;
  modelId: string;
  enabled: boolean;
  isDefault?: boolean;
}

export interface ConfigFile {
  providers: ProviderMap;
  experts: Expert[];
  models: ModelConfig[];
  cards: CardConfig[];
}

export interface ProbeRequest {
  baseUrl: string;
  apiKey: string;
}

export interface ProbeModel {
  id: string;
  ownedBy?: string;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  issueCount?: number;
  restartRequired?: boolean;
}

export interface EnvVarStatus {
  name: string;
  configured: boolean;
}
