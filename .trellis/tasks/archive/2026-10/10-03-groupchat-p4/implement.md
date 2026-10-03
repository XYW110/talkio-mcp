# Implement Notes — 10-03-groupchat-p4

## 执行记录（2026-10-03）

按 PRD R1–R4 全量落地，三个分轨提交：

### R1 /api/chat 接线（commit 1）
- `src/admin/api.ts` POST 分支：body 新增 `interjections` 解析（形态过滤 + 区间校验，文案与工具层逐字一致）；`handleBrainstorm` deps 补 `memoryDir`。
- `test/admin-chat-wiring.test.ts`（新增 5 测）：vi.mock 捕获 (args, deps)——memoryDir 透传、interjections 合法透传 / 非数组 400 / rounds=1 无间隙 400 / 空 message 400。

### R2 ChatPage 实况时间线（commit 2）
- `timeline: TimelineItem[]`（turn | round）状态 + seqRef 稳定键 + timelineEndRef 自动滚底；
- progress 监听器分支消费 `brainstorm.turn`（卡粒度）与 `brainstorm.round`（轮边界分隔行）；
- 头像 = 专家名首字符（info/ok/warn 三色哈希，字面量类名防 purge）；缺席态红徽标；
- done 后保留时间线（回看谁缺席），新一轮 start() 重置。

### R3 MemoryPage（commit 2）
- 新页面仿 TokensPage 范式：NavBar + 刷新 + 专家卡列表（icon/名称/条数 Pill/逐条 日期+正文）+ 单专家清空（confirm danger → DELETE → toast + 刷新）；
- 空态：全空 EmptyState（引导文案）+ 有配置无记忆专家尾注；
- App.tsx：Page 类型 / MENU_ITEMS（Sparkles 图标，会话记录之后）/ content 分支三处接线。
- types.ts：ExpertMemory/ExpertMemoryEntry + RunBrainstormBody.interjections + ChatSessionEvent 补 brainstorm.turn；api.ts：listMemory/clearMemory。

### R4 README（commit 3）
- admin-web 亮点列表补「发起群聊（实况时间线+插话+共享记忆）」与「专家记忆页」两条。

## 验证（全绿）

typecheck ✅ / vitest **337/337**（+5 接线）/ build ✅ / build:web ✅ / smoke-stdio PASS ✅

## 踩坑

- admin-web 未装依赖时 `npm run build:web` 报 TS7026（JSX.IntrinsicElements 缺失）——纯环境问题（React types 未解析），`npm --prefix admin-web ci` 后消失，非代码回归。
