# Logging Guidelines

> 结构化日志。

---

## 概述

作为 MCP 协议服务器，通常运行在 Stdio 或 SSE 模式下。
如果是 Stdio 模式，标准输出 (`stdout`) 用于 JSON-RPC 通信，**绝对禁止**向 `stdout` 输出普通日志，否则会破坏 MCP 协议解析。
因此，必须向标准错误 (`stderr`) 输出日志。

---

## 最佳实践

### 1. 记录关键生命周期与严重错误

日志不必过度啰嗦，但应保留用于调试追踪的必要线索。

**例子 (来源于 `src/index.ts`)**:
```typescript
// src/index.ts: 简单的自定义 log 函数，始终向 stderr 输出
function log(msg: string) {
  console.error(`[talkio-mcp] ${msg}`);
}

async function main() {
  log("Starting talkio-mcp server...");
  try {
    const config = await loadConfig(configPath);
    log(`Loaded config with ${Object.keys(config.experts).length} experts.`);
    
    // ... 启动服务器逻辑 ...
    
  } catch (error) {
    console.error("Fatal error during startup:", error);
    process.exit(1);
  }
}
```

### 2. 避免在工具逻辑中污染 Stdout

在工具实现中（如 `src/tools/consult-experts.ts`），所有的内部调试信息（如果有的话）必须使用 `console.error`。

**例子**:
```typescript
// src/tools/consult-experts.ts 中不要使用 console.log
export async function handleConsultExperts(request: ConsultExpertsRequest, config: AppConfig) {
  // console.log("Received request", request); // ❌ 绝对禁止 (破坏 Stdio MCP 协议)
  console.error("[consult-experts] Received request with query:", request.query); // ✅ 允许，走 stderr
  // ...
}
```

### 3. 日志脱敏

当发生网络错误时，如果要在日志中输出 URL，必须确保将 URL 上的凭证（例如 Basic Auth 信息）移除后再输出，防止敏感信息泄漏。

**例子 (来源于 `src/utils/retry.ts`)**:
```typescript
// src/utils/retry.ts
// 仅在到达最大重试次数后输出 Error 级别日志
if (attempt === maxRetries) {
    const cleanUrl = url.replace(/:\\/\\/[^/]+@/, "://***:***@");
    console.error(`[fetchWithRetry] 最终失败: ${cleanUrl} - ${lastError?.message}`);
}
```