# Implementation Plan — list_experts

## 1. Mock credential short-circuit

`src/orchestrator/parallel.ts` 与 `src/orchestrator/dialogue.ts` 的 `resolveProvider` 必须先检查 `isMockProviderEnabled()`，再调用 `resolveProviderCredentials`。mock 凭据使用占位 `apiKey: "mock"` 与 provider `baseUrl`。

## 2. list_experts tool

- Rewrite `src/tools/list-experts.ts` to match existing tool style (zod raw shape, no unused imports).
- Register in `src/server.ts`.
- Optional `includeDisabled` boolean; default false.

## 3. Tests and smoke

- Unit: mock short-circuit without env key; list_experts selection.
- Smoke: list tools includes `list_experts`; call it; call consult_experts; call brainstorm with rounds=1, summarize=false.

## 4. Docs

README: feature bullet, Cursor config, tool usage table.
