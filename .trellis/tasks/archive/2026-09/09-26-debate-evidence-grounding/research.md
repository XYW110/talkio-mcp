# Research: 多智能体辩论的趋同失败与证据锚定（2026-09-26 网络调研）

## 问题假设（用户提出）

1. 辩论可能退化为"少数服从多数"——多数票反映的是回声而非独立判断。
2. 专家会把发起 AI（主理 AI/调用方）的内容当作权威上下文引用，而非待检验对象。

## 文献证据

### 失败模式一：趋同/回音室（已证实）

- **Should we be going MAD? A Look at Multi-Agent Debate Strategies for LLMs**（Smit et al., ICML 2024, [arXiv:2311.17371](https://arxiv.org/abs/2311.17371)）：
  系统实测发现智能体在多轮辩论后趋向附和多数意见（即使多数是错的）；朴素 MAD 不稳定优于简单基线；效果强依赖拓扑、智能体数与轮数。
- **Why Do Multi-Agent LLM Systems Fail?**（MAST 失败分类学, NeurIPS 2025, [arXiv:2503.13657](https://arxiv.org/abs/2503.13657)）：
  明确收录"谄媚式附和（sycophantic agreement）"与"锚定初始答案"两类失败——对应问题假设 2。

### 失败模式二：辩论本身不提升期望正确率（理论结果）

- **Debate or Vote: Which Yields Better Decisions in Multi-Agent LLMs?**（Choi et al., NeurIPS 2025 Spotlight, [arXiv:2508.17536](https://arxiv.org/abs/2508.17536)，[代码](https://github.com/deeplearning-wisc/debate-or-vote)）：
  - 多数投票单独贡献了 MAD 在 7 个 NLP 基准上的绝大部分收益。
  - 辩论中智能体信念轨迹构成**鞅过程（martingale）**：没有针对性干预时，辩论不提升期望正确率。
  - **给信念更新加"朝修正方向偏置"的干预能显著提升辩论有效性**——证据/论据正是这个偏置的载体。
  - 简单集成（ensembling）始终强且稳。

### 干预手段：证据锚定有效

- **MADRA: Multi-Agent Debate with Retrieval Augmented**（2023, [综述](https://www.emergentmind.com)）：辩论 + 检索证据显著降幻觉。
- **DRAG: Debate-Augmented RAG**（ACL 2025, [代码](https://github.com/Huenao/Debate-Augmented-RAG)）：反向组合——用辩论校验 RAG 证据。
- **ReConcile**（ACL 2024, [arXiv:2309.13007](https://arxiv.org/abs/2309.13007)）：圆桌 + 按实测准确率加权的投票 + 说服性论据，显著超过朴素辩论/投票。
- **ChatEval**（ICLR 2024, [arXiv:2308.07201](https://arxiv.org/abs/2308.07201)）：异质角色（批评者/法官）比同质角色抗趋同。
- **Du et al.**（ICML 2024, [arXiv:2305.14325](https://arxiv.org/abs/2305.14325)）：多智能体辩论改善事实性与推理的前提是各智能体独立初始化。

## 对本项目的映射（2026-09-26 代码核对）

| 文献结论 | 项目现状 | 缺口 |
| --- | --- | --- |
| 独立初始化是辩论有效前提 | debate 有并行独立首轮（seed round） | ✅ 已有 |
| 匿名抗位置偏差 | 别名制 + aliasRotation + 禁自投 | ✅ 已有 |
| 发起方内容是锚定源 | `consult_experts.context` 注入为"背景信息:"（权威背书）；`brainstorm` 无 context 参数，调用方初步分析混在 topic 里 | ❌ P1 目标 |
| 证据是修正偏置的载体 | 指令只要求"观点与理由"，无论据/来源要求 | ❌ P2 目标 |
| 投票按论据质量 | VOTE_INSTRUCTION 只要求"最认同"+理由，无论据引用要求 | ❌ P2 目标 |
| 允许无共识输出 | SUMMARIZER_SYSTEM 要求总结共识与分歧，但票选机制隐含"必须选出一个" | ⚠️ P2 补强 |

## 结论

"加论据论点"方向正确且是文献中最有效的干预之一，但需三件套配合：**修正信号（论据/证据）+ 独立首轮（已有）+ 论据化聚合（投票标准）**。发起方内容必须从"背景事实"降级为"可推翻的 claim-0"。
