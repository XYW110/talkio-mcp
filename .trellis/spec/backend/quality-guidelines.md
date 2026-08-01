# Quality Guidelines

> 质量保证：测试、类型检查和代码规范。

---

## 概述

本项目强依赖 TypeScript 的静态检查与 Vitest 进行单元测试和集成测试，确保质量。由于本系统不具有复杂的状态与数据库，测试重点在于：
- 配置项加载逻辑。
- 模拟 HTTP 的网络重试逻辑。
- 对接不同大模型 API (Provider Adapters) 的契约验证。
- 核心编排器 (`orchestrator/parallel.ts` 和 `orchestrator/dialogue.ts`) 的数据流扭转。

---

## 最佳实践

### 1. 严格的类型约束

在 `tsconfig.json` 中，必须开启严格模式以及对未初始化索引访问的检查，这强制开发者编写防御性代码。

**例子**:
```json
// tsconfig.json 配置片段
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

这导致在代码中访问数组或对象时必须判空：
```typescript
// src/orchestrator/parallel.ts
const expert = expertsToCall[index];
if (!expert) {
  // 必须处理 undefined 的情况
  throw new Error("Unexpected undefined expert");
}
// 或使用非空断言：const expert = expertsToCall[index]!;
```

### 2. 纯函数测试与 Mock

使用 Vitest 进行测试。对于包含副作用（如 `fetch`，文件读取等）的模块，必须使用 `vi.mock`。

**例子 (来源于 `test/providers.test.ts`)**:
```typescript
// test/providers.test.ts: 测试重试机制
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithRetry, TimeoutError } from '../src/utils/retry.js';

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should retry on 500 error and eventually succeed', async () => {
    const fetchMock = vi.fn();
    // 模拟前两次返回 500，第三次返回 200
    fetchMock.mockResolvedValueOnce(new Response('Error', { status: 500 }))
             .mockResolvedValueOnce(new Response('Error', { status: 500 }))
             .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    
    // 挂载全局 fetch
    global.fetch = fetchMock;

    const res = await fetchWithRetry('http://example.com', {}, 3, 100);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
```

### 3. 依赖提升 (vi.hoisted)

在对使用了 ES 模块依赖进行深度 Mock 时，应当使用 `vi.hoisted` 提前创建 mock 实例，保证 `vi.mock` 中的变量可用。

**例子 (来源于 `test/orchestrator.test.ts`)**:
```typescript
// test/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest';

// 使用 vi.hoisted 提前创建 mock adapter，以便后续断言
const { mockAdapter } = vi.hoisted(() => {
  return {
    mockAdapter: {
      chat: vi.fn().mockResolvedValue({ content: "mocked response" })
    }
  };
});

vi.mock('../src/providers/registry.js', () => ({
  getAdapter: () => mockAdapter,
  isMockProviderEnabled: () => true
}));

// ... 接着编写对 runConsultation 的测试 ...
```

### 4. npm 脚本契约

必须保持 `package.json` 中的标准构建和校验脚本，确保 CI/CD 流程能一致运行。

**例子 (来源于 `package.json`)**:
```json
"scripts": {
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest"
}
```