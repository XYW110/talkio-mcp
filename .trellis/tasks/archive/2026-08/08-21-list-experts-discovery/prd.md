# 添加专家发现能力（list_experts）

## Goal

让 MCP 客户端能发现当前可用专家，而不是猜测 id。同时修复 `TALKIO_MOCK_PROVIDER=1` 仍去解析真实 API Key、导致 smoke 失败的问题。

## Requirements

- 新增只读 MCP 工具 `list_experts`，返回启用/全部专家的 id、名称、图标、provider、model、temperature、enabled。
- 不返回 systemPrompt 全文，避免工具结果过长。
- `TALKIO_MOCK_PROVIDER=1` 时，编排层必须在解析凭据前短路，不要求真实 API Key。
- smoke 必须覆盖 `list_experts`、`consult_experts`、`brainstorm`，且 mock 模式下 `consult_experts` 不得 `isError`。
- README 增加 Cursor 配置示例，并说明先调 `list_experts` 再选专家。

## Acceptance Criteria

- [x] `tools/list` 包含 `list_experts`、`consult_experts`、`brainstorm`
- [x] `list_experts` 返回当前启用专家的 id 列表（默认模板至少含 architect/security/performance/reviewer/product）
- [x] `TALKIO_MOCK_PROVIDER=1` 且无 API Key 时，`consult_experts` 与 `brainstorm` 返回 mock 报告且 `isError` 不为 true
- [x] `node scripts/smoke-stdio.mjs` 退出码 0
- [x] README 含 Cursor `mcp.json` 示例

## Out of Scope

- Streamable HTTP 替换 SSE
- brainstorm 进度通知
- GitHub Actions CI
- 发布 npm 包
