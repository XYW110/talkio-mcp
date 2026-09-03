# design — 会话记录落盘

## 1. 文件格式（JSONL，一次会话一个文件）

路径：`<recordsDir>/<sessionId>.jsonl`；`sessionId = YYYYMMDD-HHmmss-<4位随机>`（文件名安全、按字典序≈时间序）。

逐行 JSON 事件流，首行必为 `meta`，末行必为 `done`：

```jsonc
// 第 1 行：会话元数据（写入点：会话开始时）
{"type":"meta","id":"...","tool":"consult_experts","startedAt":"2026-09-04T...","question":"...","context":"...","mode":"relay","rounds":3,"cards":[{"cardId":"...","cardName":"...","expertId":"...","expertName":"...","modelId":"...","provider":"..."}],"degraded":false}
// 中间：事件行（每个里程碑即写即刷，进程崩溃只丢尾部）
{"type":"card_result","ts":"...","cardId":"...","ok":true,"content":"...","error":null,"usage":{"promptTokens":91,"completionTokens":16}}
{"type":"turn","ts":"...","round":1,"expertId":"...","expertName":"...","icon":"🏛️","content":"...","usage":{...}}   // brainstorm / followup 逐轮
{"type":"round_end","ts":"...","round":1,"total":3}                                                                  // brainstorm 轮边界（对齐 notifier）
{"type":"summary","ts":"...","content":"..."}                                                                         // brainstorm summarize=true
// 末行：收尾
{"type":"done","ts":"...","status":"ok|all_failed|partial|error","report":"<最终 Markdown 报告全文>","usage":{"promptTokens":..,"completionTokens":..}}
```

- `done.usage` 为全会话求和（缺省字段不虚构）。
- `done.report` 存最终返回给客户端的 Markdown 全文——保证「记录 = 用户看到的」。

## 2. 模块：`src/records/store.ts`（新建）

```ts
export interface RecordCardRef { cardId; cardName; expertId; expertName; modelId; provider }
export interface RecordSession { append(event): void; finish(result): void; id: string }
export function resolveRecordsDir(explicit?: string): string
// 优先级：显式参数 > TALKIO_RECORDS_DIR > <experts.json 所在目录>/records（由调用方推导传入）
export function isRecordingEnabled(): boolean          // TALKIO_RECORDS !== "0"
export function startSession(opts: { recordsDir?, tool, meta... }): RecordSession | null
// disabled/IO 失败 → null（handler 侧直接跳过）；append/finish 内部吞错 + logger.warn
export function listSessions(recordsDir, limit): Promise<RecordMeta[]>   // 读每文件首行（cap 64KB）
export function readSession(recordsDir, id): Promise<unknown[] | null>   // 逐行 parse，忽略坏行
```

实现要点：
- `appendFile` 逐事件追加 + `mkdir(recursive)` 建目录；**全部 try/catch 吞错**（记录绝不影响主流程，PRD R3）。
- `id` 校验：`readSession` 拒绝包含 `/ \ ..` 的 id（admin API 防路径穿越）。

## 3. 接线点

### 3.1 server.ts

`createServer(config, options?: { recordsDir?: string })`：
- 启动时解析一次 `recordsDir`（index.ts 传 `<configDir>/records`；测试传 tmpdir；缺省回退 `TALKIO_RECORDS_DIR ?? <cwd>/records`）。
- 三个工具 handler 的闭包里调 `startSession(...)`，把 writer 以 `deps.record?: RecordSession` 传入 handlers。

### 3.2 consult-experts.ts

- 开始：`startSession({tool:"consult_experts", question, context, cards})`。
- 每张卡结果：`runConsultation` 返回后逐 item `append({type:"card_result", ...})`（含压缩后的全失败聚合项，error 语义与报告一致）。
- 结束：`finish({status: allFailed?"all_failed":"ok", report, usage 求和})`。

### 3.3 brainstorm.ts

- 开始：`startSession({tool:"brainstorm", topic, mode, rounds, cards})`。
- 逐轮：`runDialogue` 目前一次性返回 `{turns, summary}`；**不改引擎签名**，handler 在拿到结果后按 round 分组 `append` turn 行 + round_end 行 + summary 行（实录完整性由 done.report 兜底，引擎内流式写留待后续需要时再做）。
- 结束：`finish({status: turns.length? "ok":"all_failed", report, usage})`。

### 3.4 brainstorm-followup.ts

- 开始：`startSession({tool:"brainstorm_followup", question, degraded, cards, prevTurnsCount})`。
- 输入历史 turns 摘要存入 meta（仅条数与轮次范围，避免文件膨胀；全量以客户端回传为准，不落盘）。
- 结束：`finish({status, report, usage})`；新 turns 逐条 append。

### 3.5 usage 扩展（Q3 D）

- `askExpert`（dialogue.ts）返回类型 `string` → `{ content: string; usage?: Usage }`；dialogue 引擎、followup 两路径调用点改取 `.content`，turns 携带可选 `usage`。
- `DialogueTurn` 增加可选 `usage`；`formatTranscriptForPrompt` / `formatTranscript` 不受影响（只读 content）。
- followup 输入 zod schema 不含 usage → 客户端回传多余键被 strip，兼容。

### 3.6 admin API（api.ts）

`AdminApiOptions` 增加 `recordsDir?: string`；新增两条路由（在静态托管之前判断）：
- `GET /api/records?limit=N`（默认 50，上限 200）：目录 `readdir` 取 `.jsonl`，mtime 倒序，逐文件读首行 meta，返回 `{id, tool, startedAt, question|topic, cards, status, sizeBytes}`。
- `GET /api/records/:id`：id 白名单校验后 `readSession`，返回 `{id, events}`；404 for 不存在。
- `recordsDir` 未配置或不存在 → 返回空数组 / 404，不报错。

## 4. 配置与环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `TALKIO_RECORDS` | `0` 关闭记录 | 开启 |
| `TALKIO_RECORDS_DIR` | 记录目录覆盖 | `<experts.json 目录>/records` |

index.ts：`resolveStaticDir` 旁边新增 `resolveRecordsDir(cfgPath)`（configDir + "/records"），传给 `createServer` 与 `createAdminApi`。

## 5. 测试方案（vitest，沿用 mock provider）

1. `records.test.ts`：store 单测——JSONL 合法性（逐行 parse）、disabled→null、IO 失败吞错、id 路径穿越拒绝、listSessions 倒序。
2. `consult-brainstorm.test.ts` 增补：mock 模式跑三个 handler（显式 tmpDir），断言文件生成、meta/done 行齐全、card_result/turn 行数量正确、consult usage 出现。
3. admin API 测试：`createAdminApi` handler 直调（伪造 req/res），断言列表与详情、404。

## 6. 风险与权衡

- **不改 runDialogue 签名的代价**：brainstorm 只在整体结束后写盘，多轮中途崩溃会丢该次记录（done.report 也拿不到）。可接受：记录是附加能力，不承诺崩溃恢复；后续需要时把 append 下沉进引擎。
- **列表读首行**：记录量大时 list 仍是 O(n) 文件 IO，加 limit 缓解；SQLite 化留待记录量成为瓶颈时（PRD 非目标）。
