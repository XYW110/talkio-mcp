# Journal - xyw (Part 1)

> AI development session journal
> Started: 2026-07-31

---



## Session 1: Complete tests and merge teammate branches

**Date**: 2026-08-01
**Task**: Complete tests and merge teammate branches
**Branch**: `master`

### Summary

Resolved vitest and typecheck errors, merged all teammate branches (tests-docs-docker, test-fixer, build-smoke), and cleaned up the agent team environment. The project builds and passes tests successfully.

### Git Commits

| Hash | Message |
|------|---------|
| `0b8ba57` | (see git log) |
| `415d5bb` | (see git log) |
| `f66c407` | (see git log) |
| `320b10b` | (see git log) |
| `bbcaa73` | (see git log) |

### Status

[OK] **Completed**


## Session 2: Populate backend and frontend Trellis spec guidelines

**Date**: 2026-08-01
**Task**: Populate backend and frontend Trellis spec guidelines
**Branch**: `master`

### Summary

Completed the 00-bootstrap-guidelines task by filling 12 backend and frontend spec files with accurate codebase examples (using src/ and temp/ respectively). Setup Trellis conventions for future AI assistance. Merged teammate branches and archived the bootstrap task.

### Git Commits

| Hash | Message |
|------|---------|
| `9cbe5fc` | (see git log) |
| `1f88087` | (see git log) |
| `93251e3` | (see git log) |

### Status

[OK] **Completed**


## Session 3: 添加 list_experts 并修复 mock 凭据短路

**Date**: 2026-08-21
**Task**: 添加 list_experts 并修复 mock 凭据短路
**Branch**: `master`

### Summary

新增 list_experts 只读发现工具，修复 TALKIO_MOCK_PROVIDER 仍解析真实 API Key 导致 smoke 失败，补齐 Cursor 文档与三工具冒烟覆盖。

### Main Changes

- 新增 list_experts MCP 工具并在 server 注册
- 编排层 mock 模式在凭据解析前短路
- README 增加 Cursor 配置与工具用法

### Git Commits

| Hash | Message |
|------|---------|
| `4500240` | (see git log) |

### Testing

- [OK] npm test 42 passed
- [OK] node scripts/smoke-stdio.mjs PASS

### Status

[OK] **Completed**

### Next Steps

- Streamable HTTP 替换/并存旧 SSE
- Docker 默认回环或加简单 token
- brainstorm 进度通知


## Session 4: 默认专家筛选与首次调用成本

**Date**: 2026-08-27
**Task**: 默认专家筛选与首次调用成本
**Branch**: `master`

### Summary

规划并实现 consult/brainstorm 默认只选有 key 的启用专家（最多 3 人），brainstorm 默认 1 轮不总结；空参拦截。随后提交 Trellis 0.6.15 升级与 AGENTS.md 提问规则。

### Main Changes

- 抽出 src/tools/select-experts.ts，默认路径 enabled ∩ 有 key 再截 3 人
- consult/brainstorm 空参拦截；brainstorm 默认 rounds=1 summarize=false
- README 对齐新默认并补 parallel

### Git Commits

| Hash | Message |
|------|---------|
| `4c9afb0` | (see git log) |
| `653c705` | (see git log) |
| `d60fb65` | (see git log) |

### Testing

- [OK] npm test 57 passed；npm run typecheck 通过；node scripts/smoke-stdio.mjs PASS

### Status

[OK] **Completed**

### Next Steps

- list_experts 标注缺 key
- brainstorm 增加 context
- LICENSE / CI / npm 元数据


## Session 5: list_experts 标注缺 key

**Date**: 2026-08-27
**Task**: list_experts 标注缺 key
**Branch**: `master`

### Summary

实现 list_experts 的 ready/missingEnv/readyCount 契约，缺密钥专家仍列出。质量门补齐 README 特性条与用法区说明后归档。

### Main Changes

- ExpertSummary 增加 ready 与可选 missingEnv，复用 hasProviderKey
- Markdown 标注缺 env，payload 增加 readyCount
- README 特性条与用法区对齐就绪状态

### Git Commits

| Hash | Message |
|------|---------|
| `0d5147d` | (see git log) |
| `f4f1cc7` | (see git log) |

### Testing

- [OK] npm test 60 passed；npm run typecheck 通过；node scripts/smoke-stdio.mjs PASS

### Status

[OK] **Completed**

### Next Steps

- brainstorm 增加 context
- LICENSE / CI / npm 元数据


## Session 6: 会话记录落盘（session-records）
<!-- trellis-session: v=2 fp=a9f2177f3de5c52b -->

**Date**: 2026-09-04
**Task**: 会话记录落盘（session-records）
**Branch**: `master`

### Summary

为 consult_experts/brainstorm/brainstorm_followup 三个 MCP 工具新增 JSONL 会话持久化：src/records/store.ts（startSession/append/finish/flush 单 tail-promise 串行化写入）、三工具 deps.record 接线、server/index 装配 recordsDir、admin API GET /api/records(+/:id)。修复 brainstorm-followup 中 askExpert 返回 {content,usage} 的两处损坏调用点。修复同秒创建会话排序断言偶发失败（改为文件名倒序断言）。spec 新增 records-persistence.md（7 节完整契约）。147 测试全通过。

### Git Commits

| Hash | Message |
|------|---------|
| `7d480e5` | feat(records): add JSONL session persistence for consult/brainstorm/followup + admin API |
| `a57f266` | docs(spec): 记录会话记录落盘契约（records-persistence） |

### Status

[OK] **Completed**

## Backlog 决议：竞品对比后的改进方向（2026-09-13）

基于竞品对比（block/mcp-council-of-mine、llm-council MCP 版、spranab/brainstorm-mcp、wan-huiyan/agent-review-panel、feiskyer/mcp-ai-hub）头脑风暴后，用户选定两个方向，**待当前 snow-ui-restyle 任务收尾后再开新 Trellis 任务**：

1. **议事质量包**：debate 模式第 2 轮前插入互评投票轮（每人写"最认同谁的观点+理由"，借鉴 Council of Mine）+ 互看 transcript 时匿名化卡名（A/B/C 代号，借鉴 llm-council）+ 可选 `judgeCard` 参数指定裁决者卡替代"第一张卡当 summarizer"。三者改动集中在 `src/orchestrator/dialogue.ts`，可打包为一个任务。
2. **Token 用量聚合页**：admin-web 新增聚合视图，数据源为 records JSONL 中已有的 per-call/per-session usage（`src/records/store.ts` sumUsage），按卡片/模型/日期聚合，可选价格表换算成本。

备选未选：服务端会话 sessionId 续写（brainstorm_followup 免传 turns）、Admin API 鉴权 + per-provider 并发限流。另注：theodorstorm/brainstorm-mcp 已归档（agent 协调原型），真正对标 brainstorm 的是 spranab/brainstorm-mcp。


## Session 7: 议事增强 P1——投票透明化与推理策略（council-enhancement）

**Date**: 2026-09-13
**Task**: council-enhancement（P1：投票聚合落盘 + reasoningStrategy）
**Branch**: `master`

### Summary

基于竞品深抓研究（tavily 5 项目，沉淀于任务 research/competitor-deep-dive.md）落地 P1：brainstorm 互评投票改为每会话一条聚合 vote 事件（voterCardId/votedForAlias/reason，理由截断 200 字），报告新增「投票明细」小节，admin Records 兼容新旧两种 vote shape 渲染；ExpertConfig 增可选 reasoningStrategy（systematic/adversarial/backward），经 strategy.ts 的 applyReasoningStrategy 统一注入 system prompt，缺省路径逐字节不变（toBe 引用断言）。实现中发现并替换了 HEAD 1378969 遗留的旧版逐专家 vote 事件，顺带修复 vote-prompt-fix 会话 2 处坏断言。190 测试通过后检查（pass-with-notes，仅 P3），按 PRD 实际展示层级修订 D3 措辞（报告用别名、admin 用真实卡名）。

### Git Commits

| Hash | Message |
|------|---------|
| `98ec22e` | feat(council): 投票聚合落盘、投票明细报告与推理策略注入 |
| `90c97ca` | feat(admin-web): 投票明细渲染与专家推理策略编辑 |
| `a7bbc40` | chore(task): council-enhancement 任务文档与竞品研究沉淀 |
| `dd21081` | docs(spec): 前后端共享值域常量约定与 admin 保存无校验已知限制 |

### Testing

- [OK] npm test 190 passed（14 文件）；npm run typecheck 通过；npm --prefix admin-web run build 通过

### Status

[OK] **Completed**（已归档 archive/2026-09/）

### Next Steps

- 真实模型跑一次 vote 开启的 brainstorm，观察 votedForAlias 文本解析命中率
- P2/P3 方向见 Session 8 与 prd-draft.md


## Session 8: 议事增强 P2——信号路由选卡、工具开关与模型分级（council-enhancement-p2）

**Date**: 2026-09-13
**Task**: council-enhancement-p2（P2-A/B + P3-B tier；Q1=A/Q2=B/Q3=A 已拍板）
**Branch**: `master`

### Summary

新增 src/tools/signal-routing.ts（10 个内置信号组 + 中英双语关键词表 + matchSignals/selectCardsBySignals，general 卡永远可候选）；consult_experts/brainstorm 增 optional `select:"auto"` 参数（显式 cards 优先并注明忽略、零命中回退默认卡并在 notes 注明、缺省路径逐字节不变）；config.disabledTools 支持禁用非核心工具（核心 list_cards/consult_experts/brainstorm 禁用即 loadConfig 报错，followup 可禁用不注册，server.ts 另有注册守卫兜底）；ModelConfig.tier（1-100 可选正整数）仅用于 admin ModelsPage/ModelPicker 稳定排序展示。admin CardsPage 增信号标签 chip 编辑（SIGNAL_GROUPS 前端副本与后端互指注释）。216 测试通过，检查 pass-with-notes（3 条 P3：general-only notes 措辞、admin 保存无 zod 校验的预先存在限制、server.ts 缩进）。runs 并集与 provider preset 留 backlog。

### Git Commits

| Hash | Message |
|------|---------|
| `0527411` | feat(council): 信号路由自动选卡、工具开关与模型分级 |
| `8bc0680` | feat(admin-web): 信号标签编辑与模型分级排序 |
| `000cdfb` | chore(task): council-enhancement-p2 任务文档（信号路由选卡/工具开关/tier） |

### Testing

- [OK] npm test 216 passed（16 文件）；npm run typecheck 通过；npm --prefix admin-web run build 通过

### Status

[OK] **Completed**（已归档 archive/2026-09/）

### Next Steps

- backlog：P3-A runs 并集+稳定性标注（建议等 P1 投票真实使用反馈）、P3-C provider preset
- admin API 保存配置无 zod 校验的即时反馈（spec 已记录该限制）


## Session 9: 投票轮 prompt 修复接手收尾——AC4 真实验证（vote-prompt-fix）

**Date**: 2026-09-13
**Task**: vote-prompt-fix（接手并行会话的 in_progress 任务做 AC4 闭环后归档）
**Branch**: `master`

### Summary

接手 vote-prompt-fix：其代码改动（VOTE_INSTRUCTION 禁自投+限长、own 标注行头前移）已随 1378969/98ec22e 入库（与 council-enhancement P1 同文件交织），缺的是 AC4 修复后真实验证。用 npx tsx 直调 handleBrainstorm 以与修复前 peer-review-judge 验证完全一致的参数（同 topic、debate 2 轮、性能专家+情感顾问、judgeCard=安全专家、vote=true）真实跑通：**零自投**（修复前双双自投）、票文约 90 字无标题（修复前 500+ 字多级标题）、own 标注误认未复现，AC4 通过。证据追加至 scripts/vote-report.md「修复后真实验证」节 + 任务目录 ac4-after-run.md 全实录。遗留 P3：专家A 用裸代号「B」导致 votedForAlias 解析显示「未识别代号」占位（可放宽正则接受 bare A-Z 作后续小改进）。

### Git Commits

| Hash | Message |
|------|---------|
| `be945f4` | docs(vote): vote-prompt-fix 修复后 AC4 真实验证证据（零自投+票文限长达标） |
| `98ec22e` | (fix 代码本体，随 council P1 提交) |
| `1378969` | (投票特性本体，并行会话提交) |

### Testing

- [OK] AC4 真实验证通过（同参数对比：零自投 + 票文限长达标）；修复代码已包含在 216 测试全绿的回归范围内

### Status

[OK] **Completed**（已归档 archive/2026-09/）

### Next Steps

- P3 小改进：votedForAlias 解析放宽接受裸代号（A/B/C）
- P3-A runs 并集立项时可直接引用本次验证的投票质量基线


## Session 10: snowapp 主题全量改造 + P3 runs 并集 + Provider 预设 + lucide 图标
<!-- trellis-session: v=2 fp=689042297596adbf -->

**Date**: 2026-09-13
**Task**: snowapp 主题全量改造 + P3 runs 并集 + Provider 预设 + lucide 图标
**Branch**: `master`

### Summary

三任务全链路：①snowapp-restyle——OpenDesign 弃用转 Penpot，24 套 token 快照+生成脚本、主题运行时（12 preset×light/dark、防 FOUC、localStorage）、13 新组件、三档 shell，实机双主题截图验收；②council-enhancement-p3——brainstorm runs?:1|2|3 多轮并集（别名列轮换/合并调用/[K/N RUNS] 稳定性）、records run 字段、Provider 7 预设、真实 LLM 冒烟，兼容红线 runs=1 逐字节等价有测试锚定；③lucide-icons——chrome emoji 全量换 lucide-react，gzip +4.35KB，experts.json 用户数据 icon 保留。坑：ZCode hook cwd 相对路径两次踩（stub 恢复）、子代理并发限制需重试、RecordsPage/ProvidersPage 双任务同文件改提交合并为一笔

### Git Commits

| Hash | Message |
|------|---------|
| `4b6fd71` | feat(admin-web): snowapp 主题体系全量改造——24 套 token 管道 + 主题运行时 + 组件库补齐 + 三档响应式 |
| `affd0c2` | chore(task): snowapp-restyle 规划与研究产物（Penpot token 快照/组件清单/spec 契约） |
| `dc75086` | feat(p3): brainstorm runs 多轮并集——zod 参数/别名列轮换/合并调用/records run 字段/稳定性报告 + 测试 |
| `c618652` | feat(admin-web): P3 前端配套 + lucide 图标切换——R{n} 徽标、Provider 7 预设、chrome emoji→lucide-react |
| `e74addd` | docs(trellis): P3/lucide 任务产物 + records runs 契约 spec |

### Status

[OK] **Completed**

## Session 11: 辩论反锚定与论据锚定——claim-0 盲答 + 论据化投票

**Date**: 2026-09-26
**Task**: 09-26-debate-evidence-grounding（已归档 archive/2026-09/）
**Branch**: `master`

### Summary

网调研（Debate-or-Vote 鞅定理 / MAST 谄媚锚定失败模式 / ReConcile 论据化投票）立项并全链路交付：brainstorm 增可选 context（发起方初步分析）——debate 首轮盲答不注入、第≥2轮以 claim-0 块（可推翻/非候选人）前置于实录，relay 随轮注入；consult_experts 背景信息标签改 claim-0 框架；SEED/DEBATE/VOTE/SUMMARIZER 指令论据化（主张+依据+来源、点名论据反驳、按论据质量投票、票数分裂输出无共识）；报告增 claim-0 小节（仅 context 存在时）。231 tests + typecheck 全绿；真实 LLM 埋毒验证（ac8-after-run.md，毒饵=编造 QPS 3 倍数据）五项全过：首轮毒饵未被吞、次轮逐条反驳 claim-0、票文引用具体论据、总结无共识条款生效。观察：DeepSeek V4 Flash 自投漏网 1 例（解析层兜底为未识别代号）；推理文本泄露进 content 属该模型既有现象。spec 新增 backend/dialogue-prompts.md（claim-0 三语义 + 注入矩阵 + 兼容红线）。坑：shell hook cwd gotcha 又踩一次（stub 恢复法有效，见记忆）。

### Git Commits

| Hash | Message |
|------|---------|
| `2eb4c0f` | feat(backend): 辩论反锚定与论据锚定——claim-0 盲答注入 + 指令论据化 |
| `100e58b` | docs(trellis): debate-evidence-grounding 任务文档 + dialogue-prompts spec |

### Next Steps

- P3 候选（research.md 映射表）：投票加权/校准（ReConcile 式）、检索证据接入（MADRA）、查证轮/强制魔鬼代言人、votedForAlias 裸代号解析
- 自投漏网观察：若复发率高，考虑 VOTE_INSTRUCTION 措辞强化或解析层显式拒绝本人别名票

### Status

[OK] **Completed**

## Session 12: 辩论质量 P3——魔鬼代言人轮换 + 票文解析强化

**Date**: 2026-09-27
**Task**: 09-27-debate-quality-p3（已归档 archive/2026-09/）
**Branch**: `master`

### Summary

Q1=A/Q2=A 拍板三项编排级增强：①debate 第≥2轮每轮轮换一名魔鬼代言人（targets[(round-2)%n]，DEVILS_ADVOCATE_INSTRUCTION 用"你"称呼匿名安全，零新增调用），DialogueResult.devilsAdvocates → 报告小节（缺省零字节）；②parseVotedForAlias 两级匹配（全称优先 + 裸代号回退：邻接字母数字排除 + 别名白名单防误报，共享 collectAliasMentions 单一正则源），vote-prompt-fix 遗留缺陷闭环；③isSelfVoteBallot → VoteBallot.selfVote → 报告"⚠️ 自投（无效票）"三态 + JSONL additive 字段，自投复发从"未识别"变为可见。248 tests + typecheck 绿；真跑（ac6-after-run.md）：轮换小节/强质疑形态（含质疑自方前轮论据——"即使认同也要反驳"被执行）/三票全解析零自投 全过；票数分裂时总结器合理区分互评分裂与主题共识。已知限制："A/B 测试"斜杠单字母 2 卡场景会误命中（PRD 未要求防护，记 spec）。检查代理探针发现并修复解析断言区分度缺口（voter=专家B 的 API/OWASP 负向用例）。排除项：ReConcile 加权（缺地面真值）、MADRA 检索（缺证据源设计）——若立项需先出设计调研。

### Git Commits

| Hash | Message |
|------|---------|
| `db3aeb3` | feat(backend): 辩论质量 P3——魔鬼代言人轮换 + 裸代号票文解析 + 自投显式标记 |
| `db2d3eb` | docs(trellis): debate-quality-p3 任务产物 + dialogue-prompts spec 增补 P3 契约 |

### Next Steps

- 投票加权/MADRA 检索立项前需先回答：校准信号从哪来 / 证据源是什么（独立设计调研）
- 若自投再复发且频率升高：VOTE_INSTRUCTION 措辞实验或计票层显式丢弃 selfVote 票
- "A/B 测试"误命中如实际出现，考虑把裸代号回退收紧为"投票关键词邻近"（投/选/支持 + 字母）

### Status

[OK] **Completed**

## Session 13: SP 二阶聚合 + 证据锚定协议

**Date**: 2026-09-27
**Task**: 09-27-sp-evidence-aggregation（已归档 archive/2026-09/）
**Branch**: `master`

### Summary

先导调研（Prelec SP / Beyond Majority Voting ISP / CISC-MARGIN 置信度加权落选 / PROClaim-DebateCV-FC-MAD）后 Q1=A/Q2=A 拍板：①brainstorm 增 evidence 参数（证据包 E1..En 注入各轮 + [En] 引用纪律 + 报告证据库/引用统计小节，单条 2000/总量 8000 截断）；②VOTE_INSTRUCTION 增二阶预测行，surprisinglyPopular 纯函数（margin=实际-预测得票率，唯一 argmax，缺预测/并列优雅降级），报告「聚合结果」双轨三态（分歧=趋同警报）+ JSONL spWinner/predictions additive。269 tests + typecheck 绿（check 代理独立手算 10 个 SP 探针用例含 2 个分母鉴别反例，并补齐 2 处 spec 缺口）。真跑（ac8-after-run.md）：E1 毒饵（"P99 200→20ms 来源不明"）被三专家独立识破、[En] 引用密集、预测行齐全、SP 计算成功且与多数一致；专家B 自投被 P3 机制正确标记。真跑发现解析边界：模型复述指令含「预测：」触发提前分割→票面未识别（如实暴露）——改进候选（取最后标记/行首）记 spec。R10 高光：总结器区分"多数倾向"与"共识"，拒绝强行归并。至此用户最初问题（少数服从多数 + 发起方锚定）的完整对策链落地：盲答→claim-0→论据化→魔鬼代言人→证据锚定→SP 聚合。

### Git Commits

| Hash | Message |
|------|---------|
| `4eb7669` | feat(backend): SP 二阶聚合 + 证据锚定协议 |
| `8e539b9` | docs(trellis): sp-evidence-aggregation 任务产物 + dialogue-prompts spec 增补证据库/SP 契约 |

### Next Steps

- 预测标记误分割改进：取最后一个「预测：」标记或强制行首（真跑实际发生，记 spec）
- 预测段去重集合对 ≥4 专家丢失多重性——若默认卡上限调大需改为加权分布
- 本地检索/向量库证据源：需独立安全评审（文件访问范围/PII）后再立项
- SP 双轨分歧态的真跑样本尚未观察到（两次真跑均一致态）——可设计从众场景专项验证

### Status

[OK] **Completed**

## Session 14: talkio-mcp 服务器部署迁移至 1Panel 编排

**Date**: 2026-09-28
**Task**: none（用户拍板 1B 不建任务，纯运维直执行）
**Branch**: `master`

### Summary

旧部署为 `docker run` 单容器（`dockercom110/talkio-mcp:latest`，3100，挂 `/opt/talkio/experts.json`，`--env-file /opt/talkio/.env`），不受 1Panel 管理。按用户要求删除并按 1Panel 推荐方式重部署为「容器编排」：`/opt/1panel/docker/compose/talkio-mcp/`（docker-compose.yml 镜像版 + experts.json 666），经 `POST /containers/compose`（from=path）注册，容器 `talkio-mcp-talkio-mcp-1`。验证全绿：CUSTOM_API_KEY 注入（启动日志无 config 警告）、`/` 200、`/api/config` 200、公网 SSE + initialize/initialized/tools/list 全 202；旧容器已 `docker rm`；`/opt/talkio/` 留作配置备份（2A）；`aitodo` 容器未触碰。

### Gotchas（本次踩坑，已沉淀 panel-ops skill）

1. **1Panel compose 创建会覆盖 `.env`**：`POST /containers/compose`（任意 from）的 `newComposeEnv` 用请求 `env` 字段重写 workdir/`.env`——预置好 83 字节的 .env 被清成 0 字节，容器起后 provider 密钥缺失。对策：密钥直接内联 compose `environment:`（磁盘与 1Panel 记录天然同步，无 UI 覆盖坑）。
2. **`sed -i` 断 bind mount**：写入测试用 `echo >>` + `sed -i '$ d'`，文件是单行无尾换行 JSON → 整行被删（0 字节）；且 `sed -i` 走临时文件 rename，把容器内 bind mount 的旧 inode（仍含 "test" 尾巴）与宿主路径拆开。恢复：`cp /opt/talkio/experts.json`（同 inode 截断写）+ `compose up -d --force-recreate` 重解析挂载。教训：**bind mount 的活配置文件禁止 append/sed 测试**。
3. compose API 语义：from=path 的 `path` 是 **yml 文件完整路径**（name 从父目录名派生）；创建即异步 `up`（先释放端口再创建）；search 返回的 env/文件内容实时读盘，磁盘为真，`compose/update` 对内容未变化的请求是 no-op（不写 env、不重建）。

### Git Commits

| Hash | Message |
|------|---------|
| 见下方 chore 提交 | journal + panel-ops skill gotchas |

### Next Steps

- （可选）编排 UI 若显示陈旧内容，重开编排页即可（from=path 实时读盘）
- 生产数据仍是「无卷」形态（experts.json 即全部状态）；若未来加 SQLite 记录持久化需补 data 卷
- 1Panel 编排 env 输入框显示为空属预期（密钥在 environment: 里）

### Status

[OK] **Completed**

---

## Session 15: admin-web 全站易用性与视觉优化

**Date**: 2026-09-28
**Task**: 09-28-adminweb-ux-polish（用户 Q1A/Q2A 拍板：建任务 + 仅 admin-web 全站 8 页）
**Branch**: `master`

### Summary

对 admin-web 全站做易用性/优雅度优化：新增 feedback.tsx 反馈层（Toast 队列 + promise 化 ConfirmDialog）替换全部原生 window.confirm/alert（15+13 处）；overlays.tsx 增量导出通用 Modal 统一 5 个手写浮层（Esc 栈管理、双档宽动画）；修 3 个真 bug（ChatPage 标题字面 ###、ModelsPage 开关双触发、CardsPage id 反引号）+ 1 个走查新发现（模型页 3 列网格裁剪行内删除按钮 → 改 2 列）；空态动作按钮、复制 id/总结、Ctrl+S、保存 busy、ExpertEdit 关闭拦截 + 自动增高 + 字数、Records/Chat 手写控件换共享组件、prefers-reduced-motion 降级。流程：trellis-implement → trellis-check（PASS-with-notes，1 P1 修复：SelectCheckbox 增量 disabled 堵运行中绕过）→ Edge headless + playwright-core 截图走查（桌面 1280 + 移动 390 × snow/light + dracula/dark，26 张 PNG 全审）→ 双提交归档。

### Gotchas

1. **IAB 截图/点击会整体卡死**：ZCode 内置浏览器 screenshot 30s 超时连发、force click 也挂、tab 列表清空。对策：本机 Edge headless + playwright-core（scratch 目录 npm i playwright-core，executablePath 指向 msedge.exe）全流程可控，交互/截图/boundingBox 探针都稳。
2. **后端 records 目录取「配置文件所在目录/records」**：`--config`/`TALKIO_EXPERTS_CONFIG` 指到 $TEMP 时 records 落空（env TALKIO_RECORDS_DIR 被 createServer 显式参数盖掉）。要看真实记录：草稿配置放仓库根（untracked scratch-experts.json），records/ 自然命中。
3. 模型行「删除」被裁剪属 DOM 在/视觉无——必须在**单条数据**（列宽最窄）场景做截图走查才能暴露；已沉淀 component-guidelines（overflow-hidden 行内操作簇 + SelectCheckbox disabled 契约两条）。

### Git Commits

| Hash | Message |
|------|---------|
| 36b1564 | feat(admin-web): 全站易用性与视觉优化——反馈系统/Modal 统一/交互修复 |
| 见下 | docs(trellis): 任务产物归档 + component-guidelines 两条前端经验 |

### Next Steps

- （可选 P3）confirm() 并发重入会覆盖 resolveRef（现无触发路径）；非 localhost 部署时 clipboard 需权限
- ModelPicker 目前无页面引用（迁移后保持可用），若将来接入模型页可直接用
- 专家页空态动作按钮因线上有数据未截到实图（代码已双重验证），全清数据后可见

### Status

[OK] **Completed**

---

## Session 16: v0.2.0 打包发布 + 服务器部署

**Date**: 2026-09-28
**Task**: none（用户拍板 Q1A 不建任务纯运维直执行；Q2A bump+tag）
**Branch**: `master`

### Summary

admin-web UX 优化落库后发布 v0.2.0 并部署上海 1Panel 编排。本地质量门全绿（typecheck + 269 tests）→ bump package.json 0.1.0→0.2.0（a95cd0c）→ `git push origin master v0.2.0`（17 个提交 + 仓库首个版本 tag）→ CI docker-publish 双 run 成功（master→latest 2m01s；v0.2.0→0.2.0/0.2 1m52s）→ 服务器 `cd /opt/1panel/docker/compose/talkio-mcp && docker compose pull && up -d --force-recreate` → 冒烟全绿：容器日志无密钥警告（SSE 模式 + 管理界面启用）、127.0.0.1:3100 root/config 200、公网 111.229.147.203:3100 root/config 200 + `GET /sse` 返回 endpoint 事件、公网 JS 产物哈希 `index-IVSNUfB4.js` 与本地 v0.2.0 构建一致（端到端证明新版本已上线）。

### Gotchas

1. **本机到 Docker Hub 全不通**（hub.docker.com / registry-1.docker.io 均 curl 000）：验证发布只能靠 CI success + 服务器侧实际拉取（pull 出 6 分钟前构建的镜像 8af280109eb8 即铁证），本地 curl 判 000 不代表发布失败。
2. 1Panel `compose/search` 的 name 过滤不可靠（传 talkio 仍返回 aitodo 首项）——要精确取条目时全量拉回按 name 匹配，或直接 TAT `cat` 编排文件（磁盘为真）。
3. pull+recreate 后旧镜像变 dangling `<none>`（f5f0552d9e80，10 天前版），留作回滚便利，确认稳定后 `docker image prune` 清理。

### Git Commits

| Hash | Message |
|------|---------|
| a95cd0c | chore(release): v0.2.0（含 36b1564 feat admin-web + ac7c50c docs） |
| 见下 | chore: record journal |

### Next Steps

- 稳定跑几天后 `docker image prune` 清 dangling 旧镜像
- 若要固定版本部署（compose 写 :0.2.0 而非 :latest），改 compose 一行 + `up -d --force-recreate`；回滚同理
- aitodo 容器与编排本次未触碰

### Status

[OK] **Completed**

## Session 17: 09-30-mcp-admin-auth 双 token 鉴权上线

**Date**: 2026-09-30
**Task**: 09-30-mcp-admin-auth（SSE/API 凭证控制，规划→实现→检查→部署全流程）
**Branch**: `master`

### Summary

admin token（env TALKIO_ADMIN_TOKEN 静态）+ MCP token（后台动态生成/吊销、明文一次性、SHA-256 落盘 mcp-tokens.json）双池鉴权，fail-closed。实现代理 3 提交（2513751 backend / 9f31beb admin-web / f2e1dbf docs），检查代理 AC1-6/8 全 PASS（289 tests + typecheck + build + build:web + stdio/SSE 双 smoke）。部署：push → CI 绿 → 服务器 compose 注入 token + mcp-tokens.json 挂载（预建 666）→ image pull → 重建。公网 AC7 实测全绿：无 token /api/config 与 /sse 401、静态壳 200、admin auth-check/config 200、生成 token 后 `scripts/smoke-sse.mjs` 公网真实 MCP 调用（SSE 握手 + list_cards）PASS；孤儿 token 吊销即失效现场验证。

### Gotchas

1. 1Panel `compose/operate` 必须带 `path` 字段（仅 name+operation 报 "no configuration file provided"）——panel-ops skill 文档需补记。
2. 1Panel `files/save` 只能写已存在文件（新建用 `POST /files`）；`compose/update` 返回 200 却可能不落盘——写完必须 readback 验证。
3. `containers/inspect` body 是 `{id, type:"container", detail:""}`（不是 container 字段）；`image/pull` 的 imageName 是数组。
4. `GET /api/tokens` 直接返回数组（无 tokens 包裹键）。
5. compose 改挂载/token 后必须 image pull + compose up（带 path）才重建；restart 不应用新配置。

### Git Commits

| Hash | Message |
|------|---------|
| 2513751 | feat(auth): 双 token 鉴权——admin 静态 env + MCP 动态令牌池、fail-closed 门禁 |
| 9f31beb | feat(admin-web): 登录页 + 访问令牌管理页 + 401 统一登出 |
| f2e1dbf | docs: 鉴权与令牌管理章节、客户端配置示例 |
| 见下 | docs(trellis): auth-tokens spec 沉淀 + journal |

### Next Steps

- 稳定后可 `docker image prune` 清 dangling 旧镜像
- admin token 轮换 = 改 compose env + compose up（带 path）
- minor 遗留：LoginView/TokensPage 两处 text-[11px] 超字号档位约定（下次顺手收敛）

### Status

[OK] **Completed**

## Session 18: 09-30-provider-keys-ui 渠道 Key 网页直配上线 + groupchat 成果抢救

**Date**: 2026-10-03
**Task**: 09-30-provider-keys-ui
**Branch**: `master`

### Summary

两段式收尾。(1) **工作区变更摸底**：发现 zai 并行会话（10-02 groupchat-strengths + 10-03 groupchat-p4）journal 记录的 4 个提交哈希是幻影（cat-file 查无、无分支无 stash），约 1800 行成果只以未提交改动存在——经用户拍板按流抢救提交（backend/admin-web/readme/trellis 四连），journal 哈希修正为真实值。(2) **keys-ui 实施**：trellis-implement 完成步骤 3-10（凭据切 keys 单例、validate-then-write-then-swap 热生效、GET/PUT /api/keys 掩码、8 测试文件迁 `test/helpers/keys.ts`、ProvidersPage 直配、README/.env.example 反转）→ trellis-check **PASS-with-notes**（自修复掩码断言强度：整串 grep→≥5 字符片段级 `expectNoKeyFragment`）→ spec 沉淀 auth-tokens.md「渠道 Key 直配」7 段式 → 三流提交。用户批 Q4A 后全流程部署：push → CI 绿 → 上海 1Panel 升级 latest + **state/ 目录挂载修复** → CUSTOM_API_KEY 迁入 keys.json → 公网 401 探测 + smoke-sse 远程三断言 + **真实 consult 全链路 PASS（DeepSeek V4 Flash，24.9s）**，服务不断供，compose env 留作 0.2.0 回滚锚。

踩坑记录：(1) 单文件 bind mount + tmp+rename 原子写 = **落盘静默失效**——PUT /api/keys 返回 ok 但宿主 keys.json 零增长，mcp-tokens.json 0 字节之谜同根因（rename 覆盖挂载点 inode 被拆）；改 state/ 目录挂载后 token/keys 持久化即恢复。(2) 并行会话 journal 哈希不可信，处置前必 cat-file 验证。(3) PUT /api/keys 请求体字段是 `apiKey`（不是 key）；MCP 工具注册名是 snake_case（consult_experts）。(4) POST /messages 需把 MCP token 以 `?token=` 拼到 endpoint 上（SSE endpoint 事件只给 sessionId）。

### Git Commits

| Hash | Message |
|------|---------|
| `2159900` | feat(groupchat): 群聊感全链路（R1-R3 抢救提交） |
| `563f940` | feat(admin-web): 群聊发言实况时间线 + 专家记忆管理页（P4 抢救提交） |
| `3bad2b1` | docs(readme): 群聊实况/插话/记忆章节 |
| `c48f271` | docs(trellis): zai journal 哈希修正 + 归档 2026-10 |
| `e67359e` | feat(keys): 渠道 API Key keys.json 直配（后端） |
| `4cc8927` | feat(admin-web): ProvidersPage 渠道密钥直配 |
| `6cd5296` | docs: 密钥安全章节反转 + auth-tokens spec 渠道 Key 契约 |

### Status

[OK] **Completed** — typecheck ✅ / vitest 362/362 ✅ / build ✅ / build:web ✅ / 双冒烟 PASS ✅ / CI 绿 / 现网迁移+公网真实 consult PASS ✅；P3 遗留：compose 陈旧注释、并发 PUT tmp 交错（理论）、401 矩阵可补 /api/keys 项。
