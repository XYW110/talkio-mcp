# Research: SP 聚合与证据锚定（2026-09-27 先导调研）

承接 `archive/2026-09/09-26-debate-evidence-grounding/research.md`（鞅定理/MAST/ReConcile 底座）与本会话 2026-09-27 检索。

## 方案 A：无地面真值的聚合升级

### 落选路线：置信度加权

- [CISC: Confidence Improves Self-Consistency in LLMs](https://www.alphaxiv.org/abs/2502.06233)（arXiv:2502.06233）：口头置信度加权多数投票，有效但——
- [LLM 置信度估计与校准综述](https://www.researchgate.net/publication/382633391_A_Survey_of_Confidence_Estimation_and_Calibration_in_Large_Language_Models)：LLM 系统性过自信，口头概率与正确率相关性弱。
- [MARGIN: Runtime Confidence Calibration for Multi-Agent](https://arxiv.org/html/2605.22949v2)：需运行时校准层，超出编排级范围。
- 结论：一阶置信度信号弱 → 转向二阶信息。

### 选定路线：Surprisingly Popular（二阶信息）

- **Prelec, Seung & McCoy (2017)** SP 算法：[Wisdom of the crowd — Surprisingly popular](https://en.wikipedia.org/wiki/Wisdom_of_the_crowd)。收集一阶答案 + 二阶预测（"别人会怎么答"），选**实际支持率超出预测支持率**最多的答案；多数答案错误时 SP 常能纠偏。
- 多 LLM 验证：**Beyond Majority Voting: LLM Aggregation by Leveraging Higher-Order Information**（Ai et al., [OpenReview](https://openreview.net)）提出 Optimal Weight 与 **Inverse Surprisingly Popular（ISP）**，在多 LLM 集成上超过多数投票（~23 引用）。
- 前提核对：[Why Crowd Wisdom Strategies Fail for LLM Truthfulness](https://www.researchgate.net) 指出 SP/多数投票需**有限选项集**——talkio 互评投票恰好是 n-1 个别名选一，前提满足（PRD D1）。
- 无监督真值评估的理论支撑：[Eliciting Informative Text Evaluations with LLMs（GPPM）](https://arxiv.org/html/2405.15077v1)、[Truthfulness Without Supervision: Peer Prediction](https://openreview.net/forum?id=EW62GvCzP9)、[Informed Truthfulness in Multi-Task Peer Prediction](https://www.alphaxiv.org/overview/1603.03151)。
- 对症性：从众多数是"被预期到的多数"（预测已吸收，超额≈0）；知情少数派候选者被系统性低估 → SP 边际最大。**直接攻击本项目的原始失败模式（少数服从多数=回声）**。

## 方案 B：证据锚定的 MCP 场景落地

- [PROClaim: Courtroom-Style Multi-Agent Debate with Progressive RAG](https://arxiv.org/html/2603.28488v1)：法庭式辩论 + 渐进 RAG 的 claim 核验，准确/可解释/可审计。
- [DebateCV: Debate-driven Claim Verification](https://dl.acm.org/doi/10.1145/3774904.3792993)：专业事实核查流程启发的多智能体辩论核验框架。
- [FC-MAD](https://www.sciencedirect.com/science/article/pii/S2405959526000883)：claimant/skeptic/judge 互补角色的可解释事实核查（skeptic 角色 ≈ 本项目已有的魔鬼代言人）。
- 共同前提：自带检索层。talkio 无检索基建 → **MCP 场景中调用方 AI 即检索层**（持有文件/搜索/测试能力），证据以参数传入、编号引用（MADRA 的"检索供给"变为"调用方供给"）。
- 本地检索/向量库：涉及文件访问范围与 PII 安全边界，明确排除待独立评审（PRD D5）。

## 映射到实现（2026-09-27 代码核对）

| 文献机制 | 落地点 | 成本 |
| --- | --- | --- |
| SP 二阶预测 | VOTE_INSTRUCTION 加预测行 + 选票解析 predictions + `surprisinglyPopular` 纯函数 + 报告双轨 | 0 新调用 |
| 证据库编号引用 | brainstorm `evidence` 参数 + buildEvidenceLibrary 注入块 + [En] 引用纪律 | 0 新调用 |
| 引用可核查性 | 报告「证据引用统计」（[En] 正则扫描 per-expert） | 0 新调用 |
