# talkio-mcp-expert-council — Implementation Plan

## 1. Overview

Build from empty directory (only `temp/` reference client, `.trellis/`, `AGENTS.md` exist). All project files are new. Order: scaffold → config → providers → orchestrator → tools → server → tests → validate.

## 2. Dependencies & Setup

```powershell
npm init -y
npm install @modelcontextprotocol/sdk zod dotenv
npm install -D typescript @types/node tsx vitest
```

- `@modelcontextprotocol/sdk` (>= 1.x): `McpServer`, `StdioServerTransport`, `SSEServerTransport`.
- `zod`: config + tool-arg validation.
- `dotenv`: local dev key loading.
- `tsx`: dev runner (`npm run dev`); build via `tsc`.
- `vitest`: unit tests (fast, ESM-friendly).
- **No fetch library** — Node 18+ global `fetch` + `AbortController`.

`package.json` scripts:

```jsonc
{
  "type": "module",
  "bin": { "talkio-mcp": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`: `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `outDir: dist`, `rootDir: src`, `strict: true`, `declaration: false`, `resolveJsonModule: true`.

## 3. Implementation Steps

### Step 1 — Project scaffold

- Files: `package.json`, `tsconfig.json`, `.gitignore` (`node_modules/`, `dist/`, `.env`, `experts.local.json`), `.env.example`, `experts.json` (5-expert template from design §4).
- Verify: `npm install` completes.

### Step 2 — Types + config loading

- Files: `src/types.ts`, `src/config.ts`.
- `types.ts`: `ExpertConfig`, `ProviderConfig`, `AppConfig`, `ChatMessage` (mirror design §4/§5).
- `config.ts`: zod schemas; `loadConfig(configPath?)` — reads `experts.json` (path overridable via `--config` flag or `TALKIO_EXPERTS_CONFIG` env), merges `defaults` into each expert, resolves provider references, checks referenced env vars exist (warn, not fail — provider may be unused), exports singleton.
- Risks: none; pure data.
- Verify: `npm run typecheck`.

### Step 3 — Provider abstraction

- Files: `src/providers/adapter.ts`, `src/providers/openai-compatible.ts`, `src/providers/openai.ts`, `src/providers/anthropic.ts`, `src/providers/registry.ts`, `src/utils/retry.ts`.
- `retry.ts`: `fetchWithRetry(url, init, { timeoutMs, retries: 1 })` — `AbortController` timeout; retry only on 429/5xx/`TypeError` network failures with 1s→2s backoff; redact `Authorization`/`x-api-key` from thrown errors.
- `openai-compatible.ts`: `POST {baseUrl}/chat/completions`, body `{ model, messages, temperature, max_tokens }`, parse `choices[0].message.content` + `usage`.
- `openai.ts`: thin factory reusing openai-compatible (kept separate for clarity/future responses-API support).
- `anthropic.ts`: `POST {baseUrl}/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`; split `system` messages into top-level `system` string; parse `content[0].text` + `usage`.
- `registry.ts`: `getAdapter(type: string): ProviderAdapter`; map `{ "openai", "openai-compatible", "anthropic" }`; throw on unknown.
- Verify: `npm run typecheck`; unit tests with mocked `globalThis.fetch` (`test/providers.test.ts`): request shape, auth headers, response parsing, timeout abort, no-retry on 401.

### Step 4 — Orchestrators

- Files: `src/orchestrator/parallel.ts`, `src/orchestrator/dialogue.ts`.
- `parallel.ts`: `runConsultation(question, context, experts, resolveAdapter)` → `Promise.allSettled` over experts; returns `{ expert, result | error }[]`; per-call `timeoutMs` from expert config.
- `dialogue.ts`: implement `runDialogue` per design §6 — seed round, mode loop (debate parallel / relay sequential), transcript truncation (~12k chars), optional summarizer call. Return `{ turns, summary? }`.
- Prompt templates as exported consts (unit-testable): `SEED_INSTRUCTION`, `DEBATE_INSTRUCTION`, `RELAY_INSTRUCTION`, `SUMMARIZER_SYSTEM`.
- Verify: `test/orchestrator.test.ts` with stub adapter returning canned text — assert turn count, ordering (relay), transcript inclusion, failure placeholders, truncation behavior.

### Step 5 — MCP tools

- Files: `src/tools/consult-experts.ts`, `src/tools/brainstorm.ts`, `src/utils/format.ts`.
- Register via `server.registerTool(name, { title, description, inputSchema: <zod shape> }, handler)` (SDK high-level API).
- `consult-experts.ts`: resolve expert subset (validate ids exist → invalid-params error listing valid ids), run `runConsultation`, format Markdown report (design §3.1). All-failed → `{ isError: true, content: [...] }`.
- `brainstorm.ts`: validate caps (`rounds ≤ 5`, `experts ≤ 6`), run `runDialogue`, format transcript + summary (design §3.2).
- `format.ts`: pure string builders — `formatConsultReport`, `formatTranscript`, `formatErrorSection`.
- Verify: typecheck; unit-test `format.ts` snapshot-style.

### Step 6 — Server + transports + CLI entry

- Files: `src/server.ts`, `src/index.ts`.
- `server.ts`: `createServer(config)` — `new McpServer({ name: "talkio-mcp-expert-council", version })`, register both tools (Step 5), return server.
- `index.ts`: parse argv (`--transport stdio|sse`, `--port`, `--host`, `--config`) with minimal hand-rolled parser (avoid extra dep); stdio → `server.connect(new StdioServerTransport())`; sse → tiny `http` server wiring `SSEServerTransport` (`/sse` + `/messages` per SDK docs), default bind `127.0.0.1:3100`, console warning when `--host` is non-loopback. Shebang `#!/usr/bin/env node`; log to **stderr only** in stdio mode (stdout is protocol).
- Risks: **stdout pollution breaks stdio MCP** — never `console.log` in stdio mode; route all diagnostics through `console.error`.
- Verify: `npm run build`; smoke test below.

### Step 7 — Smoke + integration testing

- Stdio smoke: run SDK inspector or a 20-line Node script using SDK `Client` + `StdioClientTransport` spawning `node dist/index.js` → assert `listTools()` returns both tools; call `consult_experts` with a **mock provider** (`TALKIO_MOCK_PROVIDER=1` env switches registry to echo adapter — keeps CI keyless).
- Manual real-key test (optional, local): set `OPENAI_API_KEY`, run `npx @modelcontextprotocol/inspector node dist/index.js`, exercise both tools.
- Verify: `npm test` green; smoke script exits 0.

### Step 8 — Docs + packaging polish

- Files: `README.md` (usage with Claude Desktop / Snow CLI MCP config snippets), `experts.json` comments review.
- `package.json`: `files: ["dist", "experts.json"]`, `engines: { node: ">=18" }`.
- Verify: `npm pack --dry-run` shows expected file list.

### Step 9 — Docker support (R6)

- `Dockerfile`: multi-stage build — `node:20-alpine` builder (`npm ci && npm run build`) → runtime stage copies `dist/` + `package.json` + `experts.json`, `npm ci --omit=dev`, non-root user, `ENTRYPOINT ["node", "dist/index.js"]`, `CMD ["--transport", "sse", "--port", "3100"]`, `EXPOSE 3100`.
- `docker-compose.yml`: SSE-mode service with `build: .`, `ports: ["3100:3100"]`, `env_file: .env`, volume-mount `./experts.json:/app/experts.json:ro`.
- `.dockerignore`: `node_modules`, `.env`, `temp/`, `dist/`, `.git`.
- `README.md` Docker section: build/run commands, env injection (`-e` / `--env-file`), config mounting (`-v`).
- Verify: `docker build -t talkio-mcp .` succeeds; `docker compose up` starts SSE server on :3100.

## 4. File-by-File Summary

| File                                                                          | Step | Purpose                          | Risk                                                            |
| ----------------------------------------------------------------------------- | ---- | -------------------------------- | --------------------------------------------------------------- |
| `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `experts.json` | 1    | scaffold                         | low                                                             |
| `src/types.ts`, `src/config.ts`                                               | 2    | config + validation              | low                                                             |
| `src/providers/*`, `src/utils/retry.ts`                                       | 3    | AI HTTP calls                    | med — header/format drift per provider; covered by mocked tests |
| `src/orchestrator/*`                                                          | 4    | consultation & dialogue engines  | med — prompt/token budget                                       |
| `src/tools/*`, `src/utils/format.ts`                                          | 5    | MCP tool handlers                | low                                                             |
| `src/server.ts`, `src/index.ts`                                               | 6    | MCP wiring + transports          | **high — stdout pollution kills stdio**; logs → stderr          |
| `test/*`                                                                      | 3–7  | vitest unit tests + smoke script | low                                                             |
| `README.md`                                                                   | 8    | usage docs                       | low                                                             |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore`                           | 9    | container deployment             | low                                                             |

## 5. Validation Commands

```powershell
npm run typecheck     # after every step
npm run build         # after steps 3, 4, 5, 6
npm test              # after steps 3, 4, 5, 7
node dist/index.js --transport stdio   # manual: should idle waiting on stdin (Ctrl+C to exit)
```

Smoke test (Step 7): `node scripts/smoke-stdio.mjs` → expects `consult_experts` + `brainstorm` in tool list and a mock consultation report.

## 6. Rollback Points

- After Step 1: pure scaffold — safe to `git init` checkpoint.
- After Step 3: provider layer independently testable; if Anthropic format drifts, disable by removing provider from template `experts.json` (adapter stays).
- After Step 6: stdio-only is a shippable MVP; SSE (Step 6 second half) can be deferred/reverted independently by removing the `--transport sse` branch.
- No existing code is modified — worst case rollback = delete new files; `temp/` reference client untouched.

## 7. Testing Strategy

- **Unit (vitest, no network):** config schema/merge, retry policy (mock fetch: 429→retry, 401→no retry, timeout abort), adapter request/response mapping, orchestrator turn logic with stub adapter, report formatting.
- **Integration (mock provider):** `TALKIO_MOCK_PROVIDER=1` echo adapter + SDK stdio client smoke script — full MCP round trip without API keys.
- **Manual (real keys):** MCP inspector against OpenAI/DeepSeek/Anthropic as available; verify multi-provider report.
- **Acceptance mapping:** criteria 1–2 → smoke script; 3–4 → integration + manual; 5–6 → `experts.json` template (5 experts); 7 → template ships 3 provider configs.

## 8. Assumptions

- Node >= 18 (global fetch); target Node 20 LTS.
- `@modelcontextprotocol/sdk` high-level `McpServer.registerTool` API (≥1.0); if SDK version differs, fall back to low-level `Server.setRequestHandler` for `tools/list`/`tools/call` — adjust Step 5/6 accordingly.
- DeepSeek (and other OpenAI-compatible providers) need no dedicated adapter code.
