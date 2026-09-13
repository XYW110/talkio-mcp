# Research: 多专家议事类竞品深入抓取（2026-09-13）

> 来源：tavily-hikari 搜索 + tavily_extract 深抓（advanced depth）。目的：为「议事质量与透明度 / Provider 扩展 / 智能选卡」改造收集已验证的机制设计。

## 1. block/mcp-council-of-mine（Block/Square，TS）

- URL: https://github.com/block/mcp-council-of-mine
- 形态：MCP 议事会服务，与本项目 consult_experts/brainstorm 同赛道，**最接近的同构项目**。
- 机制：
  - 9 个固定 archetype 人设成员：发表意见 → 互相投票 → 投票附理由 → 1 次综合。一场完整议事 ≈ 28 次 LLM 调用（9 意见 + 9 投票 + 9 理由 + 1 综合）。
  - **全透明议事**：每张票与投票理由对 agent 和用户可见，无隐藏投票；`conduct_voting()` / `get_results()` / `view_debate()` 均可取到结构化结果。
  - **文件持久化**：`debates/` 目录 + `YYYYMMDD_HHMMSS.json` 时间戳文件，完整保留意见、逐票、理由。
  - 模型调用走 **MCP sampling（`ctx.sample()`）**：服务端不持 API key，模型与成本由客户端控制；要求客户端支持 sampling。

## 2. BeehiveInnovations/zen-mcp-server（Python，已更名 PAL MCP）

- URL: https://github.com/BeehiveInnovations/zen-mcp-server
- 形态：自我定位 "Provider Abstraction Layer"，**Provider 层最强参照**。
- 机制：
  - 一套服务对接 Gemini / OpenAI / Anthropic / Grok / Azure / Ollama / OpenRouter / DIAL / 本地模型；`.env` 中有凭据的 provider 自动激活。
  - 工具分工：`chat`（协作决策/多轮）、`consensus`（多模型辩论）、`precommit`（提交前校验）、`clink`（CLI-to-CLI 桥接外部 AI CLI）。
  - **按工具启用/禁用**：工具越多上下文占用越大，用户只开需要的（`version`/`listmodels` 不可禁用）。
  - **模型智力评分**：intelligence 分级表驱动 auto 模式的模型选择建议。

## 3. theodorstorm/brainstorm-mcp（Node，已归档）

- URL: https://github.com/theodorstorm/brainstorm-mcp
- 形态：与本工具重名但方向不同——「AI agent 之间的 Slack」：多 agent 实例加入项目、点对点/广播消息、共享资源、long-polling。
- **已归档**，由 Borg MCP 接替。仅作方向澄清记录：它做 agent 间协调基础设施，不做创意发散流程，对本项目参考价值有限。

## 4. wan-huiyan/agent-review-panel（Claude Code skill）

- URL: https://github.com/wan-huiyan/agent-review-panel
- 形态：多评审员对抗式评审 + 最高裁决者，与 brainstorm 的 debate+judge 流程同构，**抗同质化机制最细**。
- 机制：
  - 4–6 评审员并行评审后 1–3 轮辩论，最终 supreme judge 出结论。
  - **差异化推理策略**：每个评审员强制使用不同策略（系统枚举、对抗模拟、反向推理等），从机制上防观点同质化。
  - **信号→专家自动路由**：内容自动检测 10 组技术信号（SQL/Data、Auth/Security、Infra、ML、API、Frontend、Cost、Pipeline…）挑选人设；130+ 专家库。
  - **多轮运行取并集**（`--runs 3`）：轮换人设跑 N 遍、去重发现项、输出稳定性评分 `[K/N RUNS]`。
  - Precise/Exhaustive 双模式（代码要行号引用，方案允许更宽的风险识别）。

## 5. feiskyer/mcp-ai-hub（Python，已更名 conferllm）

- URL: https://github.com/feiskyer/mcp-ai-hub
- 形态：LiteLLM 统一 100+ Provider 的 MCP 桥；小项目（10 star），**配置层轻量参照**。
- 机制：YAML 配置 + Pydantic 校验；stdio/SSE/HTTP 三传输；自定义端点/代理支持。

## 6. 对照结论（本项目已有 vs 可吸收）

| 机制 | 本项目现状 | 来源 | 可吸收度 |
|---|---|---|---|
| 多专家并行咨询 | consult_experts（parallel） | — | 已有 |
| 辩论/接龙 + 匿名互评 | brainstorm vote（debate 专属） | — | 已有 |
| 裁决者卡 | brainstorm judgeCard | — | 已有 |
| 追问 + 上下文压缩 | brainstorm_followup + context-compressor | — | 已有 |
| JSONL 会话落盘 | records store（cards/card_result/finish） | council-of-mine | **升级：vote 事件与投票理由落盘** |
| 投票理由结构化 | vote 仅汇入报告 | council-of-mine | **高** |
| 差异化推理策略 | 无 | agent-review-panel | **高**（expert 卡加字段即可起步） |
| 信号→专家自动选卡 | 手动选卡/默认卡 | agent-review-panel | 中高 |
| 按工具开关省上下文 | 全量注册 | PAL MCP | 中 |
| 模型分级驱动推荐 | 无 | PAL MCP | 中 |
| 多轮运行并集+稳定性分 | 无 | agent-review-panel | 低（成本高，可选项） |
| Provider 广度 | openai/anthropic/openai-compatible/mock | PAL MCP | 中（按需加原生 adapter/preset） |
| MCP sampling 模式 | 不适用（服务端持 key） | council-of-mine | Out of scope |
| agent 间协调基础设施 | 不在同赛道 | brainstorm-mcp | 不适用 |

详细改造方案见同目录上级 `prd-draft.md`。
