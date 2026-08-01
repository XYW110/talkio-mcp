# Error Handling

> 错误处理与容错机制。

---

## 概述

作为 MCP 服务器，容错至关重要。一个专家的 API 失败（如超时、限流）绝不能导致整个咨询请求崩溃。
我们采用「隔离失败，优雅降级，强制抛出致命错误」的策略。

---

## 最佳实践

### 1. 致命错误：启动时抛出并退出

如果是配置缺失（如 `experts.json` 无效、找不到文件）或者关键环境变量未设置，应用应在早期快速失败。

**例子 (来源于 `src/config.ts`)**:
```typescript
// src/config.ts: 致命错误退出
export async function loadConfig(configPath: string): Promise<AppConfig> {
  try {
    const rawContent = await fs.readFile(configPath, "utf8");
    // ...
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to load config from ${configPath}: ${error.message}`);
    } else {
      console.error(`Failed to load config from ${configPath}:`, error);
    }
    // 关键配置加载失败，直接退出进程
    process.exit(1); 
  }
}
```

### 2. 隔离容错：部分失败不阻塞整体流程

在并行咨询中，使用 `Promise.allSettled` 代替 `Promise.all`。将结果包装成具有明确成功/失败状态的对象。

**例子 (来源于 `src/orchestrator/parallel.ts`)**:
```typescript
// src/orchestrator/parallel.ts: 定义隔离的返回类型
export interface ConsultationItem {
  expertId: string;
  ok: boolean;
  content: string; // 成功时为内容，失败时为空或保留错误信息
  error?: string;  // 失败时的错误信息
}

// 并行发起调用，不会因单个失败抛出异常
const results = await Promise.allSettled(
  expertsToCall.map(exp => callExpert(exp, query, appConfig, timeoutMs, systemPrompt))
);

// 提取结果，失败项标记为 ok: false
const consultationResults: ConsultationItem[] = results.map((res, index) => {
  const expert = expertsToCall[index]!;
  if (res.status === "fulfilled") {
    return res.value; // 内部 callExpert 已处理为 ConsultationItem 格式
  } else {
    // 理论上 callExpert 不会 reject，这里仅做兜底
    return {
      expertId: expert.id,
      ok: false,
      content: "",
      error: res.reason instanceof Error ? res.reason.message : String(res.reason)
    };
  }
});
```

### 3. 网络请求：带超时的指数退避重试

由于调用第三方大模型 API 是不稳定的操作，必须封装超时与重试机制。

**例子 (来源于 `src/utils/retry.ts`)**:
```typescript
// src/utils/retry.ts: 自定义 TimeoutError 与重试机制
export class TimeoutError extends Error {
  constructor(message: string = "Request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export async function fetchWithRetry(url: string, options: RequestInit, ...): Promise<Response> {
  // ... 
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      // 成功直接返回
      if (response.ok) return response; 
      
      // 4xx 不重试，抛出异常
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }
      
      // 其他错误抛出进入 catch 逻辑准备重试
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
         lastError = new TimeoutError(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      // 计算指数退避时间后重试...
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError; // 最终失败抛出
}
```

### 4. 显式的依赖验证

在运行功能前，需校验所需的依赖（如环境变量）是否存在。

**例子 (来源于 `src/config.ts`)**:
```typescript
// src/config.ts
export function resolveProviderCredentials(providerId: string, providerCfg: ProviderConfig): ProviderCredentials {
  const envVarName = providerCfg.apiKeyEnv;
  if (!envVarName) {
    // 直接抛出错误，不要静默失败
    throw new Error(`Provider [${providerId}] missing apiKeyEnv in config`);
  }
  // ...
}
```