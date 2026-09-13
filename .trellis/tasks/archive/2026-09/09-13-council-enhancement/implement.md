# Implement: council-enhancement P1

## 执行清单（顺序）

1. [x] P1-B 类型层：`src/types.ts` ExpertConfig 增 `reasoningStrategy?`；`src/config.ts` zod 可选枚举校验（缺省不写入）。
2. [x] P1-B 策略注入：新增 `REASONING_STRATEGY_INSTRUCTIONS` 常量表 + `applyReasoningStrategy()`（建议 `src/orchestrator/strategy.ts`）；接入 `dialogue.ts` askExpert 与 `consult-experts.ts` prompt 构建。default/缺省返回原串引用。
3. [x] P1-A 结构化投票：`dialogue.ts` vote 环节产出 `VoteBallot[]`/`RoundVotes`；每轮 vote 完成即 `record.append({type:"vote",...})`；报告新增「投票明细」小节（不开 vote 输出不变）。
4. [x] `src/records/store.ts`：RecordEvent 联合增 vote 事件类型。
5. [x] admin：`RecordsPage.tsx` SessionDetailView 渲染 vote（按轮分组，未知 type 容错）；`ExpertEditPage.tsx` 增推理策略下拉（清空=删除字段）。
6. [x] 测试：`test/consult-brainstorm.test.ts` 增补 vote 落盘/报告明细/策略注入/缺省快照断言。
7. [ ] 验证（见下），然后 `trellis-check`。

## 验证命令

- `npm test`（全量）与 `npm run typecheck`
- `npm --prefix admin-web run build`
- 手动：`npm run dev -- --transport sse` 打开 admin，确认 ExpertEditPage 策略下拉可保存；Records 页打开含 vote 的旧/新会话均正常渲染。

## 红线

- MCP 工具入参零变更；不开 vote 的 JSONL 无 vote 行；缺省专家 system prompt 逐字节不变；experts.json 旧文件可加载且序列化不新增缺省字段。

## start 前检查

- [x] prd.md 收敛（Q1=A、Q2=A 已拍板）
- [x] design.md / implement.md 就绪
- [x] 用户批准（Q1 A；Q2 A）
