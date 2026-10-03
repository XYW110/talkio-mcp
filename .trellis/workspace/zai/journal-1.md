# Journal - zai (Part 1)

> AI development session journal
> Started: 2026-10-02

---


## Session 1: 吸收 AgentMore 群聊优点（流式实况+主持人插话+专家记忆）

**Date**: 2026-10-02
**Task**: 10-02-groupchat-strengths
**Branch**: `master`

### Summary

研究 AgentMore 官网/群聊体验（分享页实测），提炼三大优点翻译到 MCP 工具模型并全量落地：R1 卡粒度流式通知 `brainstorm.turn`（谁已发言/是否缺席）；R2 主持人插话 `interjections`（预置轮间注入，下轮全体优先回应；块头避开别名形态保投票解析安全）；R3 专家记忆沉淀（末轮「记忆：」行收获 + 后续调用注入，`src/experts/memory.ts` 新模块 + admin GET/DELETE /api/memory）。全程遵守前缀空串拼接零改动红线（无新参数时 prompt 逐字节不变，快照测试锚定）。用户拍板：记忆默认开（Q1=A）、全量实施（Q2=A）。

踩坑记录：(1) 冒烟脚本依赖原作者本地 experts.json（含 deepseek 卡），fresh clone 必挂——构造匹配配置后全绿，非代码回归；(2) 「记忆：无」最初只在收获成功时剥离指令行 → 报告残留痕迹，改为指令行一律剥离、仅「无」不落盘；(3) makeTarget 的 expertId 是裸 id（"a"）非 "expert-a"，事件顺序断言下标需按 turn,turn,round 排列。

### Git Commits

> ⚠️ 修正（2026-10-03）：本会话原按逻辑拆分的 4 个提交实际未落库（哈希不存在，分支也未创建），成果仅存于工作区。2026-10-03 由主会话按流抢救提交如下。

| Hash | Message |
|------|---------|
| `2159900` | feat(groupchat): 群聊感全链路——轮粒度流式通知、主持人插话、专家记忆沉淀（R1-R3，含 /api/memory） |
| `3bad2b1` | docs(readme): 群聊实况时间线/主持人插话/专家记忆章节（R6） |

### Status

[OK] **Completed** — typecheck ✅ / vitest 332/332 ✅ / build ✅ / smoke-stdio PASS ✅；spec 沉淀 dialogue-prompts.md + records-persistence.md；research 落盘 task research/。

## Session 2: P4 群聊感呈现+网页端接线

**Date**: 2026-10-03
**Task**: 10-03-groupchat-p4
**Branch**: `master`

### Summary

补齐群聊优点吸收的剩余部分：/api/chat 透传 memoryDir + interjections 校验（网页群聊与 MCP 面同享记忆/插话）；ChatPage 消费 brainstorm.turn 渲染发言实况时间线（头像/缺席徽标/轮分隔/自动滚底，done 后保留）；新增 MemoryPage 专家记忆管理页（总览/清空，仿 TokensPage 范式）+ App 导航接线；README 同步。用户 Q1=A 全量实施。

踩坑：admin-web 依赖未装时 build:web 报 TS7026（React types 未解析），npm ci 后消失；确认/删除类 confirm 用 message 而非 body 字段（feedback.tsx ConfirmOptions 契约）。

### Git Commits

| Hash | Message |
|------|---------|
| `2159900` | feat(groupchat): /api/chat 接入 memoryDir 与 interjections（R1，并入后端流提交） |
| `563f940` | feat(admin-web): 群聊发言实况时间线 + 专家记忆管理页（R2/R3） |
| `3bad2b1` | docs(readme): 群聊实况/记忆页特性说明（R4） |

### Status

[OK] **Completed** — typecheck ✅ / vitest 337/337 ✅ / build ✅ / build:web ✅ / smoke-stdio PASS ✅
