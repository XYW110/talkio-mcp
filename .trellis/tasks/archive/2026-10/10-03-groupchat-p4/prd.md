# PRD — P4 群聊感呈现 + 网页端接线

## Goal

补齐 AgentMore 群聊优点吸收的剩余部分（P4 群聊感呈现），并把上一任务（groupchat-strengths，已归档）的 MCP 侧能力接线到网页群聊与 admin-web：

1. **网页群聊接入记忆**——`POST /api/chat` 透传 `memoryDir`，网页发起的讨论同样享受记忆注入与末轮收获；
2. **实况时间线（P4 核心）**——ChatPage 消费 `brainstorm.turn` 事件，讨论进行中实时展示"谁已发言/谁缺席"的专家时间线（icon + 名字 + 状态点），替代当前纯进度条；
3. **记忆管理页**——admin-web 新增 MemoryPage：各专家记忆条数/内容展示、单专家清空（消费既有 `GET/DELETE /api/memory`）；
4. **（可选）网页发起时支持主持人插话**——表单可选填"第 1 轮后插话"，透传 `interjections`。

## 已确认事实（代码证据）

- `src/admin/api.ts` POST /api/chat 分支：`handleBrainstorm({topic, mode, rounds, summarize, cards}, baseConfig, {notifier, record})`——**缺 `memoryDir`**（对照 server.ts 的 MCP 注册已传）。
- SSE `progress` 事件已转发全部 StreamEvent（notifier 直接 broadcast），前端 `ChatPage.tsx:104` 只解构 `{round, total}`——`brainstorm.turn` 载荷（card/expertName/ok）在通道里但被忽略。
- admin-web 技术栈：React + Tailwind + lucide-react，页面在 `src/pages/`（RecordsPage/TokensPage 为列表页范式），路由与导航在 App.tsx；`api.ts` 集中封装 fetch（Bearer token）与 EventSource（`?token=` 兜底）。
- 记忆 API 契约（已实现已测）：`GET /api/memory` → `[{expertId, expertName, icon, count, entries:[{ts,text}]}]`（含 count=0 空态专家）；`DELETE /api/memory/:expertId` → `{ok, expertId}` / 404。
- 质量门：`npm run typecheck && npm test && npm run build && npm run build:web`。

## 需求

- **R1 后端接线**：POST /api.chat 传 `memoryDir`（无则记忆静默降级，与 MCP 面同语义）；请求体新增可选 `interjections`（校验规则与 brainstorm 工具一致，非法 400）。
- **R2 ChatPage 实况时间线**：进行中状态从"第 X/Y 轮"单行升级为专家实况流——每个 `brainstorm.turn` 追加一条"🟢 专家名 已发言 / 🔴 缺席"，round 事件渲染轮次分隔；`brainstorm.vote`/结束态处理不回归；实况区在 done 后折叠或保留（实现自选，优先信息密度）。
- **R3 MemoryPage**：导航入口 + 列表（icon、专家名、条数、逐条 ts+text）+ 单专家清空（confirm 后 DELETE，成功刷新）；空态友好文案；加载/错误态走既有 feedback 模式。
- **R4 文档**：README 群聊页提及记忆/实况行为；admin-web 无独立 README 则不新增文件。

## 边界（out of scope）

- 讨论中途（运行中）真·插话队列（需要 cancellation/状态化，保持 MCP 模型一致：插话仍为发起时预置）；
- 报告正文的聊天气泡化重排（Markdown 报告保持现状，实况时间线已提供群聊感）；
- 记忆编辑/手动新增（只读 + 清空）；
- 官网设计借鉴（research 已存档，门面任务另立）。

## 验收标准

- [ ] **AC1** 网页群聊（memoryDir 已装配的部署）发起 2 轮讨论：专家 A 的 `memory/<id>.jsonl` 在讨论后新增收获行；带记忆的专家 prompt 含记忆块（集成测试或冒烟级验证）。
- [ ] **AC2** ChatPage 进行中可见逐卡实况：3 卡 × 2 轮 → 实况区按时间序出现 6 条专家发言记录（含缺席红色态），轮次分隔清晰；done/error 路径无回归。
- [ ] **AC3** 非法 interjections（afterRound 越界/空 message）→ 400 与可读文案；合法值透传到 handleBrainstorm（prompt 含插话块）。
- [ ] **AC4** MemoryPage：无记忆（全空态）、有记忆、清空成功、清空 404 四态正确；未带 admin token 的 API 调用 401（api client 既有拦截）。
- [ ] **AC5** `npm run typecheck && npm test && npm run build && npm run build:web` 全绿；`smoke-stdio` 不回归。
- [ ] **AC6** MCP 面（stdio/SSE 工具调用）行为与上一任务完全一致（零回归，后端只加透传不改工具链）。
