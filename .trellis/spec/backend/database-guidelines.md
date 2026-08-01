# Database & Configuration Guidelines

> 配置管理与数据持久化规范。

---

## 概述

本项目**不使用任何数据库**。

所有的持久化状态均通过文件系统读取，且应用本身是**无状态**的（处理请求，生成报告，不保存中间数据）。

配置管理依赖双层结构：
1. **配置文件**（`experts.json`）：管理声明式的结构化数据（专家定义、Provider 特性、默认参数）。
2. **环境变量**：注入敏感的凭证（API Keys）及运行时开关。

---

## 最佳实践

### 1. 结构化配置 (JSON)

- 配置统一位于 `experts.json`（或通过 `--config` 指定）。
- 运行时必须使用 `zod` 进行严格的 Schema 校验。
- 允许定义 `defaults`，供后续专家定义继承/覆盖，减少冗余。

**例子 (来源于 `src/types.ts` 和 `src/config.ts`)**:
```typescript
// src/types.ts: 严格校验 Schema
export const ExpertConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().optional(),
  systemPrompt: z.string().optional(),
  description: z.string().optional(),
});
export type ExpertConfig = z.infer<typeof ExpertConfigSchema>;

// src/config.ts: 解析合并
const rawContent = await fs.readFile(configPath, "utf8");
const rawJson = JSON.parse(rawContent);
const validated = AppConfigSchema.parse(rawJson); // 校验
// 处理 defaults 合并逻辑 ...
```

### 2. 凭证 (API Keys) 不入配置，走环境变量

- 绝不允许将 API Key 写入 `experts.json`。
- 凭证应动态从环境变量（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或任意自定义环境变量名）读取。

**例子 (来源于 `src/config.ts`)**:
```typescript
// src/config.ts: resolveProviderCredentials
export function resolveProviderCredentials(providerId: string, providerCfg: ProviderConfig): ProviderCredentials {
  const envVarName = providerCfg.apiKeyEnv; // 例如 "OPENAI_API_KEY"
  if (!envVarName) {
    throw new Error(`Provider [${providerId}] missing apiKeyEnv in config`);
  }
  
  const apiKey = process.env[envVarName]; // 动态获取
  if (!apiKey) {
    throw new Error(`Provider [${providerId}] is misconfigured: Environment variable ${envVarName} is not set.`);
  }
  
  return { apiKey, baseURL: providerCfg.baseURL };
}
```

### 3. 支持配置文件热重载（通过惰性读取）

- 由于 MCP server 是长驻进程，配置和环境变量只在每次请求到达时（或者由客户端传入）动态验证。
- 但本项目中 `experts.json` 也是可以根据需要随时重读的。

### 4. 避免将内部敏感信息泄露到客户端

- 发生错误时，不要返回完整的 URL、Bearer Token 等信息给 MCP 客户端，以免引发安全风险。

**例子 (来源于 `src/utils/retry.ts`)**:
```typescript
// src/utils/retry.ts: 日志脱敏
const cleanUrl = url.replace(/:\\/\\/[^/]+@/, "://***:***@"); // 去除 Basic Auth
console.error(`[fetchWithRetry] 最终失败: ${cleanUrl} - ${lastError.message}`);
```
