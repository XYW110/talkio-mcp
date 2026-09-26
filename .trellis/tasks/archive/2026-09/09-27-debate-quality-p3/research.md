# Research: P3 三项的依据（2026-09-27）

承接 `archive/2026-09/09-26-debate-evidence-grounding/research.md` 的文献底座（Debate-or-Vote 鞅定理 / MAST / ReConcile / MAD），本任务三项的针对性依据：

## 1. 魔鬼代言人轮换（Q2=A：零成本编排级）

- **MAD 论文**（Liang et al. 2023，"Encouraging Divergent Thinking in LLMs through Multi-Agent Debate"）：对抗性角色设置（judge + 强制对立立场）是其抗"思维退化（thought degeneration）"的核心机制。
- **Debate-or-Vote**（NeurIPS 2025 Spotlight, arXiv:2508.17536）：辩论要产生收益，必须给信念更新注入"朝修正方向的偏置"——每轮强制一名专家做最强反驳即编排层的修正偏置，且不加轮数/调用（对比其反例：无干预辩论 = 鞅，期望正确率不变）。
- **ChatEval**（ICLR 2024, arXiv:2308.07201）：异质角色比同质角色抗趋同。
- 现状衔接：`reasoningStrategy=adversarial` 是按专家静态配置的；魔鬼代言人是**按轮动态轮换**，二者互补不冲突。

## 2. 裸代号票文解析

- 已知缺陷（vote-prompt-fix 遗留 P3，见 `archive/2026-09/09-13-vote-prompt-fix/task.json` notes 与 journal Session 10 Next Steps）：`parseVotedForAlias` 只匹配 `专家[A-Z]`，票文写裸代号 "B" 时显示"未识别代号"。
- 2026-09-26 真跑（claim-0 任务 AC8）再次出现该形态风险：票文混排拉丁字母（API/QPS/OWASP）频度高，裸字母匹配必须防误报——仅接受**独立大写字母**（前后无字母数字）且落在已知别名集合内。

## 3. 自投显式标记

- 基线：vote-prompt-fix 后（2026-09-13）真跑零自投；但 2026-09-26 真跑自投复发 1 例（专家B 投专家B，票文含"我投专家B"），解析层当前把它显示为"未识别代号"——与真未识别不可区分，掩盖质量问题。
- 结论：零自投不是 prompt 可保证的（模型指令遵循波动）；解析层把"检测到只提及本人别名"显式标为**自投（无效票）**，让质量回归可见（对比 vote-prompt-fix 的 pre/post 基线方法）。

## 明确不做（Q1=A 排除项）

- **ReConcile 式投票加权**：需各模型实测准确率作校准信号，开放咨询无地面真值，无从计算。
- **MADRA 检索证据**：需证据源基建（检索什么、从哪检索），须先出独立设计。
