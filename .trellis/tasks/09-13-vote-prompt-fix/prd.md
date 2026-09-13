# PRD: 投票轮 prompt 修复（禁自投 + 限长 + own 标注前移）

## Goal / 用户价值

peer-review-judge 真实议事验证（scripts/vote-report.md，2026-09-13）发现投票轮三个观感缺陷，本任务做 prompt 级修复，让互评投票产生真实可用的仲裁依据，而不是退化成"第三轮发言"。

## 背景与已确认事实

- 真实验证中两位专家都投给了自己（匿名制下自投=无效票，投票价值归零）。
- 每张票 500+ 字带多级标题，投票段比一轮辩论还长。
- own 标注（"这是你自己的发言"）追加在长发言内容末尾，模型显著忽视——第 2 轮性能专家把"编译器比喻"（自己第 1 轮的观点）当别人的观点质疑。

## Requirements

- R1（禁自投）：`VOTE_INSTRUCTION`（src/orchestrator/dialogue.ts）明确约束："不得投票给自己的观点（标注为你自己发言的那条是你本人的）"，要求投给除自己之外的专家。
- R2（限长）：`VOTE_INSTRUCTION` 要求投票精炼（如"150 字以内，直接给出最认同的专家代号与核心理由，不要展开论述、不要使用标题"）。
- R3（own 标注前移）：own 标注从"内容尾部追加"改为"行头标注"（`【专家A · 你的发言】`），在 `formatTranscriptForPrompt` 与 `anonymizeTurnCopies`（压缩路径输入）两处同步。
- R4（零回归）：不传 vote 的默认路径行为不变；现有 183 测试中受影响的断言仅因标注位置/文案变化而更新，语义不变。

## Acceptance Criteria

- AC1: VOTE_INSTRUCTION 文本含禁自投与限长约束（单测断言关键词）。
- AC2: own 标注出现在行头（单测断言渲染格式 `【专家A · 你的发言】`）。
- AC3: 默认路径（无 vote）报告与 prompt 不变；`npm test` 全量通过。
- AC4: 修后再跑一次真实议事（同 topic 同卡），两位专家均未投自己，票文短于上一轮验证版本。

## Key Decisions（用户已拍板）

- D1: 轻量任务 PRD-only；prompt 级改动，不动架构。
- D2: 修后必须闭环真实验证（AC4），不省这次 token。

## Out of Scope

- 投票结构化输出/确定性计票；多 run 合并；投票失败重试。
