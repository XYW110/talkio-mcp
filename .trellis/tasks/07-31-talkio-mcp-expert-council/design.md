# talkio-mcp-expert-council — Design

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client                           │
│         (Claude Desktop / Snow CLI / etc.)              │
└──────────────┬──────────────────────────────────────────┘
               │  JSON-RPC (stdio or HTTP/SSE)
┌──────────────▼──────────────────────────────────────────┐
│                   MCP Server                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Transport Layer                       │  │
│  │   StdioServerTransport │ SSEServerTransport       │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │               Tool Registry                        │  │
│  │   consult_experts  │  brainstorm                   │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │            Expert Orchestrator                     │  │
│  │  - persona loading (experts.json)                 │  │
│  │  - parallel single-round (consult_experts)        │  │
│  │  - multi-round dialogue (brainstorm)              │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │            Provider Abstraction                    │  │
│  │  ProviderAdapter interface: chat(messages, opts)  │  │
│  │  ┌──────────┐ ┌───────────┐ ┌──────────┐          │  │
│  │  │ OpenAI   │ │ Anthropic │ │ DeepSeek │  ...     │  │
│  │  │ Adapter  │ │ Adapter   │ │ Adapter  │          │  │
│  │  └──────────┘ └───────────┘ └──────────┘          │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Key design choices:**

- **Single `McpServer` instance** from `@modelcontextprotocol/sdk`, transport selected at startup via CLI flag (`--transport stdio|sse`) or env var.
- **No streaming to client**: MCP `tools/call` returns a single result; AI calls are made non-streaming (simple `chat()` interface) to keep orchestration simple. Token streaming is out of scope.
- **Adapter pattern** for providers (inspired by Talkio `src/services/provider-adapters/`): each adapter knows how to build request body, set auth headers, and parse response for its API format.

## 2. Module Layout

```
talkio_mcp/
├── package.json
├── tsconfig.json
├── experts.json              # user-editable expert definitions (template shipped)
├── .env.example              # API key env var template
├── Dockerfile                # multi-stage production image
├── docker-compose.yml        # SSE-mode one-command start example
├── .dockerignore             # node_modules, .env, etc.
├── src/
│   ├── index.ts              # CLI entry: parse args, load config, start transport
│   ├── server.ts             # McpServer setup, tool registration
│   ├── config.ts             # env + experts.json loading, validation (zod)
│   ├── types.ts              # shared TS types (ExpertConfig, ChatMessage, etc.)
│   ├── tools/
│   │   ├── consult-experts.ts    # consult_experts tool handler
│   │   └── brainstorm.ts         # brainstorm tool handler
│   ├── orchestrator/
│   │   ├── parallel.ts           # single-round parallel consultation
│   │   └── dialogue.ts           # multi-round debate / relay engine
│   ├── providers/
│   │   ├── adapter.ts            # ProviderAdapter interface + ChatParams/ChatResult
│   │   ├── openai.ts             # OpenAI chat-completions adapter
│   │   ├── anthropic.ts          # Anthropic messages adapter
│   │   ├── openai-compatible.ts  # base for DeepSeek / any OpenAI-compatible API
│   │   └── registry.ts           # provider name → adapter factory
│   └── utils/
│       ├── retry.ts              # fetch with timeout + exponential backoff
│       └── format.ts             # markdown report formatting
└── test/
    ├── config.test.ts
    ├── orchestrator.test.ts
    └── providers.test.ts
```

## 3. Data Flow

### 3.1 `consult_experts` (single-round parallel)

```
client → tools/call { name: "consult_experts", arguments: { question, experts?, context? } }
  → server.ts dispatches to tools/consult-experts.ts
    → config.ts resolves expert list (filter experts.json by names, or all enabled)
    → orchestrator/parallel.ts:
        for each expert: build messages = [system(expert.systemPrompt), user(question+context)]
        Promise.allSettled(expert => registry.get(expert.provider).chat(...))
    → format.ts renders Markdown report:
        ## 专家团咨询报告
        ### 🏛️ 架构师 (gpt-4o)
        <answer>
        ### 🔒 安全专家 (claude-sonnet)
        <answer>
        (+ ⚠️ section for failed experts with error message)
  → return { content: [{ type: "text", text: report }] }
```

- Parallel via `Promise.allSettled` — one expert's failure never blocks others.
- Per-call timeout (default 120s, configurable) via `AbortController`.

### 3.2 `brainstorm` (multi-round dialogue)

```
client → tools/call { name: "brainstorm", arguments: { topic, mode, rounds?, experts? } }
  → tools/brainstorm.ts → orchestrator/dialogue.ts
    → round 1: all experts answer topic in parallel (seed round)
    → rounds 2..N:
        debate mode: each expert sees all previous round answers,
                     prompted to 质疑/补充/反驳 others' points
        relay mode:  experts speak sequentially; each sees the running
                     transcript and must deepen the previous speaker's idea
    → final round optionally asks one "summarizer" (first expert or dedicated
      summarizer config) to synthesize consensus & disagreements
  → Markdown transcript + summary returned
```

Dialogue state is an in-memory array of `{ round, expertId, expertName, content }` entries, injected into prompts as formatted transcript. Nothing is persisted (per Out of Scope).

## 4. Expert Configuration Schema (`experts.json`)

```jsonc
{
  "$schema": "./experts.schema.json", // optional, for editor IntelliSense
  "defaults": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "temperature": 0.7,
    "maxTokens": 2048,
    "timeoutMs": 120000
  },
  "providers": {
    "openai": {
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "deepseek": {
      "type": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "experts": [
    {
      "id": "architect",
      "name": "架构师",
      "icon": "🏛️",
      "systemPrompt": "你是一位资深软件架构师……",
      "provider": "openai",
      "model": "gpt-4o",
      "temperature": 0.7,
      "enabled": true
    },
    {
      "id": "security",
      "name": "安全专家",
      "icon": "🔒",
      "systemPrompt": "你是一位应用安全专家……",
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "temperature": 0.5,
      "enabled": true
    }
  ]
}
```

Validation with **zod** at startup; fail fast with a clear error listing invalid entries. Expert-level fields override `defaults`. `apiKeyEnv` names the env var holding the key — keys never live in `experts.json`.

Shipped template includes 5 experts (exceeds the ≥3 acceptance criterion): 架构师, 安全专家, 性能专家, 代码审查员, 产品思维专家.

## 5. Provider Abstraction

```ts
// providers/adapter.ts
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ProviderAdapter {
  chat(
    params: ChatParams,
    creds: { apiKey: string; baseUrl: string }
  ): Promise<ChatResult>;
}
```

- **`openai-compatible.ts`**: implements `chat()` against `POST {baseUrl}/chat/completions`. `openai.ts` and DeepSeek both reuse it (DeepSeek, Moonshot, Qwen, etc. are OpenAI-compatible — new providers become config-only, no code).
- **`anthropic.ts`**: implements `chat()` against `POST {baseUrl}/v1/messages` with `x-api-key` + `anthropic-version` headers; maps `system` message to top-level `system` param.
- **`registry.ts`**: `type` string → adapter singleton. Unknown type → startup error.

Non-streaming only (single `chat()` method) — simpler than Talkio's streaming adapters; fits MCP request/response model.

## 6. Multi-Round Dialogue Orchestration

`orchestrator/dialogue.ts`:

```ts
interface DialogueTurn {
  round: number;
  expertId: string;
  expertName: string;
  icon: string;
  content: string;
}

async function runDialogue(opts: {
  topic: string;
  experts: ExpertConfig[];
  mode: "debate" | "relay";
  rounds: number; // default 2, max 5
  summarize: boolean; // default true
}): Promise<{ turns: DialogueTurn[]; summary?: string }>;
```

- **Debate**: each round, every expert receives the full transcript of prior rounds (formatted as `【name】: content`) plus instruction: "针对上述观点,提出你的质疑、补充或反驳,并完善你自己的立场". Turns within a round run in parallel.
- **Relay**: experts speak one at a time in configured order; each sees transcript so far plus instruction: "在前一位专家的观点基础上深化和发展".
- **Transcript budget**: truncate oldest turns when transcript exceeds ~12k chars to stay within context windows (mark truncation in output).
- **Summary**: final call with a fixed summarizer system prompt over the full transcript.
- Total AI calls = `rounds × experts (+1 summary)`; cap `rounds ≤ 5`, `experts ≤ 6` to bound cost/latency. Exceeding caps → tool argument validation error.

## 7. Error Handling & Timeouts

| Layer                       | Strategy                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Startup                     | zod-validate `experts.json`; missing referenced provider / empty experts → exit with clear stderr message                       |
| Missing API key             | Detected lazily per provider; expert calls fail with `Provider X: missing env var Y` — other experts still return               |
| Per-AI-call                 | `AbortController` timeout (default 120s); 1 retry with exponential backoff for 429/5xx/network errors; no retry for 401/403/400 |
| Expert failure (consult)    | `Promise.allSettled`; failed expert rendered as `⚠️ name: error message` section; tool call still succeeds                      |
| Expert failure (brainstorm) | Failed turn recorded in transcript as `⚠️ (name 本轮缺席)` and dialogue continues                                               |
| All experts failed          | Tool returns `isError: true` with aggregated error text                                                                         |
| Tool args                   | zod schemas on `inputSchema`; invalid args → MCP standard invalid-params error                                                  |

## 8. Security Considerations

- **API keys only via environment variables** (`apiKeyEnv` indirection); `.env` loaded with `dotenv` for local dev; `.env` and `experts.local.json` gitignored.
- **No key echo**: error messages and logs must never include `Authorization` headers or key material; redact in `retry.ts` error wrapper.
- **SSE transport** binds `127.0.0.1` by default; `--host` required to expose; no auth (documented — Out of Scope), so warn on non-loopback bind.
- **Prompt injection surface**: `question`/`topic` from the MCP client is interpolated into prompts; this is inherent to the tool's purpose. Document that expert system prompts should instruct experts to treat user content as data.
- **Dependency hygiene**: pin `@modelcontextprotocol/sdk`; run `npm audit` in validation.

## 9. MCP Tool Schemas

### `consult_experts`

```jsonc
{
  "name": "consult_experts",
  "description": "向一组 AI 专家并行咨询同一个问题,返回结构化的多视角咨询报告",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": { "type": "string", "description": "要咨询的问题" },
      "context": {
        "type": "string",
        "description": "可选背景信息(代码片段、约束等)"
      },
      "experts": {
        "type": "array",
        "items": { "type": "string" },
        "description": "可选,专家 id 列表;缺省使用所有启用的专家"
      }
    },
    "required": ["question"]
  }
}
```

### `brainstorm`

```jsonc
{
  "name": "brainstorm",
  "description": "组织 AI 专家围绕主题进行多轮头脑风暴(辩论或接龙),输出讨论实录与总结",
  "inputSchema": {
    "type": "object",
    "properties": {
      "topic": { "type": "string" },
      "mode": {
        "type": "string",
        "enum": ["debate", "relay"],
        "default": "debate"
      },
      "rounds": { "type": "integer", "minimum": 1, "maximum": 5, "default": 2 },
      "experts": { "type": "array", "items": { "type": "string" } },
      "summarize": { "type": "boolean", "default": true }
    },
    "required": ["topic"]
  }
}
```

## 10. Docker Deployment (R6)

**Dockerfile** — multi-stage build:

```
# Stage 1: builder — node:20-alpine, npm ci, tsc build → dist/
# Stage 2: runtime — node:20-alpine, copy dist/ + package.json + experts.json
#   - npm ci --omit=dev (production deps only)
#   - NODE_ENV=production, non-root user
#   - ENTRYPOINT ["node", "dist/index.js"]
#   - Default CMD: ["--transport", "sse", "--port", "3100"]
#   - EXPOSE 3100
```

**docker-compose.yml** — SSE-mode one-command start:

```yaml
services:
  talkio-mcp:
    build: .
    ports: ["3100:3100"]
    env_file: .env # API keys injected via env
    volumes:
      - ./experts.json:/app/experts.json:ro # user-editable config mount
    restart: unless-stopped
```

**`.dockerignore`**: `node_modules`, `.env`, `temp/`, `dist/`, `.git`

**README section**: container usage — `docker build`, `docker run` with `-e KEY=VALUE` flags or `--env-file`, config file mounting via `-v`.

## 11. Resolved Decisions (carried from PRD)

1. Server calls AI APIs directly, holding keys in env vars — zero client config.
2. `experts.json` for persona config; keys via env override only.
3. `consult_experts` = single-round parallel; `brainstorm` = multi-round dialogue.
4. Docker deployment included: multi-stage Dockerfile + compose example + README docs.

## 12. Non-Goals (per PRD Out of Scope)

No GUI, no persistence, no auth, no mobile. Token streaming to MCP client deferred.
