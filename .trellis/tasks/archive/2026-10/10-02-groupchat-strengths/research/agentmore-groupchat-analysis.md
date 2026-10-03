# Research — AgentMore 群聊体验优点分析（来源：分享页实测）

> 来源：`https://agentmore.chatglm.cn/shareFile/6a5deee15c469787836eacb0`
> （AgentMore 官网单文件 HTML，React + Tailwind 全内联，14MB，2026-10-02 实测）

## AgentMore 是什么（官网口径）

智谱清言旗下「多 Agent 云端协作平台」，核心主张：**出方案干实事，从构思到落地全流程打通**——把"说一句"变成"做完一摊"。核心功能四件套：人设记忆 / 自主任务执行 / 多 Agent 协作 / 文件交付。

## 群聊功能的体验优点（对标 talkio-mcp 的 brainstorm/consult）

### P1 过程实时可见（白盒协作）

AgentMore 群聊里多 Agent 讨论过程**逐条实时可见**，人可以旁听全程。用户不是等一个黑盒结果，而是看得到谁在发言、说了什么、谁在回应谁。

**talkio-mcp 现状**：`brainstorm.round` 通知只有轮粒度（每轮结束 1 条），轮内每张卡的发言完成无任何信号；`consult.card` 只有结算粒度。宿主 AI（主理 AI）转述进度时只能说"讨论中"，无法给出"谁已发言"。

### P2 主持人中途插话（方向可干预）

群聊里人可以**随时插话**，给讨论纠偏、补充约束、改变方向，Agent 会即时回应插话内容并调整后续发言。

**talkio-mcp 现状**：brainstorm 一次性传参后全程失控——topic/context/evidence 在发起时锁定，中途无法介入；唯一手段是等整场结束再 `brainstorm_followup`，纠偏滞后一整场。

### P3 人设记忆沉淀（越用越懂你）

AgentMore 官网原话（人设记忆功能卡片内展示的真实记忆条目）：
> "昨晚我悄悄变强了一点……CSS 继承的坑也记下了"

Agent 的经验会**跨会话沉淀**，下次对话能引用历史经验，形成"成长感"。

**talkio-mcp 现状**：专家完全无状态——同一张卡今天学到的教训（"这个团队的风格是 X"、"上次关于 Y 的结论是 Z"），下次调用全部归零。system prompt 是静态的。

### P4 群聊感呈现（次要点）

头像、表情 icon、发言时间线的排版让讨论"像一场真实的圆桌"。talkio-mcp 报告已有 `icon + 实名` 行头与轮次分节，此项差距最小，**本任务不做重点**（避免摊子过大），仅在报告微调中顺带。

## 语义差异（为什么不能照抄，要翻译成 MCP 工具模型）

| AgentMore 群聊 | talkio-mcp（MCP 工具调用模型） |
| --- | --- |
| 人 ↔ Agent 实时对话 | 主理 AI 一次工具调用，结束后才拿到报告 |
| 人在界面上看逐条消息 | 宿主客户端订阅 MCP logging 通知 |
| 人随时打字插话 | 调用参数只能在发起时给定 |
| 平台托管的持久 Agent | 无状态函数 + 本地 JSONL |

**翻译结论**：
- P1 → 扩展 `StreamEvent`，新增卡粒度 `brainstorm.turn` 事件（MCP logging 通知，宿主可实时转述）；
- P2 → `brainstorm` 新增 `interjections` 参数：预置的「主持人插话」（绑定触发轮次），轮间注入为公开块并要求下轮全体回应——MCP 模型下"中途插话"的可行等价物（真正的运行中打断需要 cancellation + 状态化，超出本任务边界）；
- P3 → 专家记忆文件 `memory/<expertId>.jsonl`：末轮让每张卡输出「记忆：」行（写入前 redactPII），后续所有工具调用的该专家 prompt 注入其历史经验（限额）。

## 官网设计层面的可借鉴点（本次任务的副产品认知，供后续门面任务用）

文字即图形的 Hero（字母内嵌手绘贴纸）、单一品牌蓝 `#49b3fc` + 淡蓝底 `#f5fbfe` 的克制配色、"AgentMore VS 普通对话"七维对比表（整列品牌色高亮）、`prefers-reduced-motion` 动效降级、14MB 单文件自包含交付。→ 若日后为 talkio-mcp 做官网/落地页，直接引用本节。
