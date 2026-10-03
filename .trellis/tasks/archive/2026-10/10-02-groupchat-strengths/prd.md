# PRD — 吸收 AgentMore 群聊优点：流式实况 + 主持人插话 + 专家记忆沉淀

## Goal

借鉴 AgentMore 群聊的三个核心体验（见 `research/agentmore-groupchat-analysis.md`），翻译到 talkio-mcp 的 MCP 工具调用模型中，让"专家团"从黑盒一次性报告升级为**过程可观测、方向可干预、专家可成长**的协作系统：

1. **P1 过程实时可见** → brainstorm 轮内每张卡发言完成即发流式通知（卡粒度）；
2. **P2 主持人中途插话** → brainstorm 支持预置插话（绑定轮次），下轮全体回应；
3. **P3 专家记忆沉淀** → 专家跨会话经验记忆（末轮提炼、后续注入）。

## 已定决策（用户拍板，2026-10-02）

1. **Q1=A 记忆默认开**：`remember` / `memory` 参数缺省 `true`。依据：无记忆文件时注入零字节（不破坏现状），记忆在参与讨论后自然生长；介意者显式传 `false`，README 写明关闭方法。
2. **Q2=A 全量实施**：R1-R5 一次做完（分轨提交、独立回滚），不拆分任务。

## 已确认事实（代码证据）

- 流式通知：`src/utils/notify.ts` 的 `StreamEvent` 联合类型目前仅 3 种（`consult.card` / `brainstorm.round` / `brainstorm.vote`），载体为 MCP logging 通知（fire-and-forget、绝不阻塞业务、无订阅不降级——AC 哲学见注释）。
- 轮粒度通知发点：`src/orchestrator/dialogue.ts:993`（`absorbRound` 之后）；测试 `test/orchestrator.test.ts:629` 按 `e.type === "brainstorm.round"` 过滤断言——**新增事件类型对既有测试零破坏**。
- debate 轮内并行 / relay 顺序发言的收敛点：`src/orchestrator/dialogue.ts:967-987`（askExpert → turns.push，catch 产出 ⚠️ 缺席 turn）。
- prompt 注入矩阵：claim-0（第 2 轮起注入、可推翻、不可投票）、证据库 `[E1..En]`、匿名化副本（debate，`anonymizeTurnCopies`）。主持人插话必须复用"公开块"语义（类似 claim-0），且不得污染投票解析（`parseVotedForAlias` 只认 `专家[A-Z]` 代号形态）。
- 会话记录：`src/records/store.ts` 的 `RecordEvent` 为 JSONL additive 契约（缺省不写键是红线，见 `.trellis/spec/backend/records-persistence.md`）。
- 专家调用无状态：`askExpert`（dialogue.ts:623）只带 systemPrompt + 单条 user 消息，PII 经 `redactPII` 后出站（隐私红线）。
- 目录约定：records = `<experts.json 所在目录>/records`（`src/index.ts:306`，`TALKIO_RECORDS_DIR` 可覆盖）；memory 目录沿用同级约定。
- 专家对象有稳定 `expert.id`（`src/types.ts`），是天然的 memory 文件名。
- 测试基建：vitest + `vi.mock("../src/providers/registry.js")` 注入 stub adapter（`test/orchestrator.test.ts` 既有模式）；mock provider（`TALKIO_MOCK_PROVIDER=1`）供冒烟。

## Requirements

- **R1 卡粒度流式通知（P1）**：brainstorm 每张卡发言结算（含 ⚠️ 缺席）后，立即发 `brainstorm.turn` 事件：`{ type, round, total, card, expertName, ok }`；既有 `brainstorm.round` 轮末事件保持不变。通知实现沿用 fire-and-forget 契约（不阻塞、不抛错、无订阅不降级）。
- **R2 主持人插话（P2）**：`brainstorm` 新增可选参数 `interjections: Array<{ afterRound: number; message: string }>`：
  - 校验：`afterRound` ∈ [1, rounds-1]，message 非空；违规返回输入校验错误（zod refine / handler 早退），消息复用既有错误文案风格；
  - 注入：第 `afterRound` 轮结束后，下一轮全部专家的 prompt 注入「🎙️ 主持人插话」块（实名公开，与 claim-0 同为"不可投票的非专家发言"），并附一行指令要求下轮优先回应插话；
  - 呈现：报告实录在对应轮后渲染主持人块；JSONL 新增 `interjection` 事件（additive）；
  - 边界：不参与互评投票候选、不进入匿名别名体系；relay 模式同样生效（relay 逐轮注入 transcript，插话块进入 running transcript）。
- **R3 专家记忆写入（P3-a）**：brainstorm（含 runs>1 的每个 run）最后一轮，每张议事卡的 prompt 末尾追加「记忆提炼」软指令：要求最后一行以「记忆：」开头，输出 1 条 ≤50 字的、对该专家未来同类任务有用的经验；解析剥离后：
  - 正文 = 剥离记忆行后的内容（transcript / 报告 / JSONL / 互评注入一律用剥离后正文，避免污染）；
  - 记忆行 → `redactPII` → append 到 `memory/<expertId>.jsonl`（单行 JSON：`{ ts, topic, memory }`）；
  - 解析失败（无该行 / 超限）→ 静默跳过（logger.debug），绝不报错；
  - `remember: false`（brainstorm 参数，默认 true）时全程不追加该指令、不写文件。
- **R4 记忆注入（P3-b）**：brainstorm / consult_experts / brainstorm_followup 的每张卡 prompt，注入该专家已有记忆（最近 ≤3 条、合计 ≤400 chars，标题「你的历史经验（仅供你参考）」）：
  - 无记忆 / `memory: false`（三工具新增参数，默认 true）→ prompt 逐字节不变（零改动原则，对齐 `applyReasoningStrategy` 的 default 分支语义）；
  - 注入位置：system prompt 之后、用户内容之前，独立 user 消息或前缀块（design 定夺）；
  - 记忆只进该专家自己的 prompt，不进共享 transcript、不进匿名副本——不影响辩论匿名机制。
- **R5 存储与管理**：memory 目录 = `<experts.json 所在目录>/memory`，`TALKIO_MEMORY_DIR` 可覆盖；`.gitignore` 增 `memory/`；admin API 新增 `GET /api/memory`（按专家列出条数/最近时间/内容）、`DELETE /api/memory/:expertId`（清空该专家记忆）——遵循既有 admin 鉴权与 JSON 错误契约。
- **R6 文档**：README 工具参数表更新（`interjections` / `remember` / `memory`）、流式事件表补 `brainstorm.turn`、JSONL 事件契约补 `interjection`、memory 目录与 env 说明、`.env.example` 增 `TALKIO_MEMORY_DIR=`。

## 边界（out of scope）

- 真正的运行中打断（MCP cancellation + 有状态会话）——interjections 是预置插话，不是实时中断；
- consult 的记忆写入（单轮盲答无交互，经验价值低；只注入不写入）；
- 记忆的语义去重 / 相似合并（只按时间窗口截断）；
- admin-web 记忆管理界面（API 先行，界面留给后续任务）；
- 官网/落地页制作（research 文件已沉淀素材，另立任务）。

## Acceptance Criteria

- [ ] **AC1** 3 卡 2 轮 debate（mock/stub）：`brainstorm.turn` 事件共 6 条，`(round, card)` 序列与 turns 一一对应，缺席卡 `ok:false`；`brainstorm.round` 仍为 2 条且顺序不变；不传 notifier 时行为与现状完全一致。
- [ ] **AC2** `interjections: [{afterRound:1, message:"聚焦成本"}]` + 2 轮 debate：第 2 轮每张卡 prompt 含「主持人插话」块与原文；报告实录第 1 轮后渲染 🎙️ 主持人块；JSONL 含 `interjection` 事件；投票轮 prompt 中主持人块不产生新别名（`parseVotedForAlias` 不命中）。
- [ ] **AC3** `afterRound: 0` / `afterRound: rounds` / 空 message → 工具返回输入校验错误（isError 文案指出合法范围），零 LLM 调用。
- [ ] **AC4** stub adapter 让末轮回答末尾带「记忆：xxx」：`memory/<expertId>.jsonl` 新增对应行（redactPII 生效）；turns 正文不含「记忆：」行；报告与 JSONL 干净。
- [ ] **AC5** 无「记忆：」行 / `remember:false` → 不写文件、无报错；既有 memory 文件存在时注入块出现在该专家 prompt（≤3 条 ≤400 chars），其余专家 prompt 不含该块。
- [ ] **AC6** `memory:false` 或无记忆文件 → prompt 逐字节等于现状（对照快照测试）。
- [ ] **AC7** admin API：`GET /api/memory` 返回各专家条数与内容；`DELETE /api/memory/:expertId` 清空后文件删除、注入立即消失；未带 admin token 401（复用既有鉴权测试模式）。
- [ ] **AC8** `npm run typecheck && npm test && npm run build` 全绿；stdio 冒烟（`TALKIO_MOCK_PROVIDER=1 node scripts/smoke-stdio.mjs`）不回归；新增测试覆盖 R1-R5。
