# design — 吸收 AgentMore 群聊优点

## 0. 架构总览

三个特性独立成层，全部遵循仓库既有的「前缀拼接 + 空串零改动」prompt 组装模式与 JSONL additive 契约：

```
brainstorm(topic, interjections?, remember?, memory?) ──┐
consult_experts(memory?) ───────────────────────────────┤
brainstorm_followup(memory?) ───────────────────────────┘
   │
   ├─ R1 notify.ts: StreamEvent += brainstorm.turn ──── dialogue.ts 轮循环内每卡 settle 即发
   ├─ R2 dialogue.ts: interjectionPrefix（空串拼接）─── format.ts 报告渲染 + store.ts interjection 事件
   └─ R3 src/experts/memory.ts（新模块）────────────── 编排层注入 memoryPrefix / 末轮 harvest 指令 + 剥离
                    │
                    └─ admin/api.ts: GET/DELETE /api/memory（复用既有 admin 鉴权）
```

## 1. R1 卡粒度流式通知

`src/utils/notify.ts`：

```typescript
export type StreamEvent =
  | { type: "consult.card"; ... }          // 不变
  | { type: "brainstorm.round"; ... }      // 不变
  | { type: "brainstorm.vote" }            // 不变
  | { type: "brainstorm.turn"; round: number; total: number;
      card: string; expertName: string; ok: boolean };  // 新增
```

发点：`runDialogue` 轮循环内（dialogue.ts:967-987 现为逐卡顺序 await——debate 语义上"轮内并行"实为顺序收敛，通知即逐卡 settle 后发）。成功与 ⚠️ 缺席都发（`ok` 区分），在 `turns.push` 之后、下一卡调用之前。runs>1 时事件不带 run 字段（通知是瞬态观测，非 JSONL 契约；round 已含 run 内语义）。

不订阅通知的客户端零影响（`sendLoggingMessage` 已有 catch 兜底，见 notify.ts 注释 AC6）。

## 2. R2 主持人插话

### Schema（src/tools/brainstorm.ts）

```typescript
interjections: z.array(z.object({
  afterRound: z.number().int(),
  message: z.string().min(1),
})).optional().describe("主持人插话：第 afterRound 轮结束后注入，下一轮全体专家须优先回应"),
```

### 校验（handler 早退，零 LLM 调用）

- `afterRound` 必须满足 `1 ≤ afterRound ≤ rounds - 1`（rounds 为 clamp 后实际值；rounds=1 时任何插话都非法——无下一轮可回应）；
- 违规返回 `isError` 文案：`interjections[${i}].afterRound 必须在 1 ~ ${rounds - 1} 之间（当前 rounds=${rounds}，插话需要存在下一轮来回应）`，风格对齐 `blankInputError`。

### 注入（dialogue.ts，前缀拼接模式）

新常量（**不动** `SEED/DEBATE/VOTE/SUMMARIZER` 既有四常量）：

```typescript
export const INTERJECTION_HEADER = "【🎙️ 主持人插话（第{N}轮后）】";
export const INTERJECTION_NOTE =
  "（这是主持人在上一轮结束后插入的话，不是专家发言，不可投票；下一轮发言请优先回应：补充信息、修正方向或说明异议。）";
```

- 块头形态刻意避开「专家X」与独立大写字母（对齐 `dialogue-prompts.md` 票文解析白名单安全约定）→ `parseVotedForAlias` 天然不命中，复用 claim-0 的"结构保证排除"，不改 `VOTE_INSTRUCTION`。
- 注入位置：轮循环组装 userContent 时，`interjectionPrefix + evidencePrefix + claim0Prefix + 主体`（插话是最新指令，置于最前保证显著；claim-0 语义不变）。
- 生效轮：`afterRound < round ≤ rounds` 的每一轮（持续在场，直至下一条插话替换？**否**——多条插话累加在场：round R 的 prefix = 所有 `afterRound < R` 的插话块按 afterRound 升序拼接。主持人的话不该被"撤回"）。
- debate round 1 盲答不受影响（afterRound ≥ 1 → 首次注入最早 round 2）✓；relay 同一注入点。

### 呈现

- **报告**（format.ts）：`formatBrainstormReport` / `formatTranscript` 增加可选参数 `interjections`，在第 `afterRound` 轮小节末尾渲染：

  ```markdown
  **🎙️ 主持人（第 1 轮后插话）:**

  <message>
  ```

  无插话 → 零字节输出（零改动原则）。
- **JSONL**（store.ts）：`RecordEvent` 追加 `| { type: "interjection"; afterRound: number; message: string }`；写入时机 = 轮末 `round_end` 之后（对齐"轮结束后插入"语义）；runs>1 时带 `run` 字段（同 turn 事件惯例）。

## 3. R3 专家记忆

### 新模块 `src/experts/memory.ts`

哲学对齐 `records-persistence.md`：**记忆功能绝不影响工具主流程**——全部 IO 吞错 + `[memory]` 前缀 warn。

```typescript
export interface MemoryEntry { ts: string; topic: string; memory: string; }
export function resolveMemoryDir(explicit?: string): string;
//   explicit > TALKIO_MEMORY_DIR > <cwd>/memory；index.ts 计算 <cfgPath dir>/memory 传入
export function loadExpertMemories(dir: string, expertId: string): Promise<MemoryEntry[]>;
//   读 <dir>/<expertId>.jsonl 全量，行级 catch 跳过坏行；文件不存在 → []
export function appendMemory(dir: string, expertId: string, entry: MemoryEntry, logger?: Logger): void;
//   appendFileSync 单行 JSON（<4KB，O_APPEND 原子）；IO 错误吞掉 + [memory] warn；目录不存在先 mkdirSync recursive
export function buildMemoryBlock(entries: MemoryEntry[]): string;
//   取最近 3 条、每条截 120 chars、合计 ≤400 chars（超限从最旧丢起）；
//   空数组 → ""（零改动）；格式：标题 + "- [日期] 记忆（关于 <topic 截断>）"
export interface HarvestedMemory { body: string; memoryLine: string | null; }
export function parseMemoryLine(content: string): HarvestedMemory;
//   匹配**最后一个**行首「记忆[：:]」行（对齐 spec 对「预测：」行的教训：模型复述指令会触发提前匹配，
//   取最后一条最稳）；命中 → 剥离该行（正文 trimEnd 尾部空行）；未命中 → 原文引用 + null
```

### 写入路径（harvest，仅 brainstorm）

- 新指令常量 `MEMORY_HARVEST_INSTRUCTION`：

  ```
  （附加要求）请在发言的最后一行以「记忆：」开头，用不超过 50 字提炼一条对你这位专家今后处理同类主题最有用的经验
  （立场修正 / 方法论 / 证据线索）；确实没有值得记的就省略这一行。
  ```

- 注入条件：`remember !== false` 且当前轮为**该 run 的最后一轮**（`round === rounds`）且目标为议事卡；追加在该卡 DEBATE/RELAY 指令之后（与 `DEVILS_ADVOCATE_INSTRUCTION` 同一注入位次，两者可叠加）。
- 剥离：`askExpert` 返回后、`turns.push` 前 `parseMemoryLine` —— **所有下游（transcript / 报告 / JSONL turn / 匿名副本 / 投票注入 / 概要压缩）自动干净**，零额外处理。
- 落盘：轮循环结束后统一对成功剥离出 `memoryLine` 的 turns 执行 `appendMemory`（entry = `{ ts: ISO, topic: opts.topic 截 80, memory: redactPII(memoryLine 截 120) }`）；失败静默（模块内已吞）。
- runs>1：每个 run 的最后一轮都 harvest（同主题多次重跑的经验天然去重靠读取窗口，见边界）。

### 注入路径（memory，三工具）

- 读取时机：工具 handler 开始时对全部已选卡 `Promise.all(loadExpertMemories)` 一次，本次调用内复用（避免每轮重复 IO）。
- 注入点（编排层，前缀拼接）：`memoryPrefix + interjectionPrefix + evidencePrefix + claim0Prefix + 主体`：

  ```
  【你的历史经验（仅供你参考，可能过时，不必提及）】
  - [2026-10-02] 记忆（关于 XX 主题）：……
  ```

  - brainstorm：轮循环组装处（所有轮，含 seed 盲答轮——记忆是专家自身状态，不属于"他人观点"，不破坏盲答隔离）；
  - consult：`buildTargetMessages`（parallel.ts）；
  - followup：追问 prompt 组装处。
- `memory: false`（三工具参数，默认 true）或无记忆文件 → `buildMemoryBlock` 返回 ""，prompt 逐字节还原（`applyReasoningStrategy` default 分支同款语义）。
- 记忆只进该专家自己的 prompt，不进共享 transcript / 匿名副本 —— 辩论匿名机制零影响。

### Schema 增量

- brainstorm：`remember: z.boolean().optional()`（默认 true）、`memory: z.boolean().optional()`（默认 true）、`interjections`；
- consult / followup：`memory: z.boolean().optional()`（默认 true）。

## 4. Admin API（src/admin/api.ts，复用既有鉴权 gate）

- `GET /api/memory` → `{ experts: Array<{ expertId, expertName, entries: number, lastTs: string | null, items: MemoryEntry[] }> }`；expertName 从 config 关联（文件孤儿 → expertId 兜底）；
- `DELETE /api/memory/:expertId` → 删除 `<dir>/<expertId>.jsonl`（不存在 → 404 JSON）；响应 `{ deleted: true }`；
- 错误/鉴权契约与 records 路由一致（401 由既有 gate 保证）。

## 5. 装配（src/index.ts + src/server.ts）

- `ServerOptions` 增 `memoryDir?: string`；index.ts 计算 `path.resolve(path.dirname(path.resolve(cfgPath)), "memory")` 传入（SSE 分支同样透传）；
- handler deps 增 `memoryDir`（`startSession` 同款闭包注入模式）；`loadConfig` 不涉及。

## 6. 测试计划

| 文件 | 覆盖 |
| --- | --- |
| `test/memory-store.test.ts`（新） | resolve 覆盖链 / append+load 往返 / 坏行容错 / buildMemoryBlock 截断与空串 / parseMemoryLine（最后行优先、未命中零改动、50 字截断）/ redactPII 生效 |
| `test/orchestrator.test.ts`（扩展） | AC1 turn 事件序列与缺席标记；AC2 插话注入/报告/JSONL/投票安全；AC4 harvest 剥离+落盘；AC5 注入块出现条件；AC6 无特性 prompt 逐字节快照（stub 记录 messages，对照基线） |
| `test/server-tools.test.ts`（扩展） | AC3 插话参数校验错误文案；remember/memory 参数透传 |
| `test/admin-memory.test.ts`（新） | AC7 GET/DELETE/404/401（复用 admin 测试注入 env + Bearer 模式） |
| 既有全量 | 零回归（无新参数路径逐字节不变） |

## 7. 风险与对策

- **输出格式漂移**（专家把「记忆：」写进正文/开头）→ 只认最后一个行首标记 + 剥离后 trimEnd；解析失败静默跳过（不记不报错）。
- **记忆污染匿名** → 记忆仅进私有 prompt；专家若在发言中主动提及历史经验，属正常行为（AgentMore 同语义）。
- **并发追加** → appendFileSync 单行 <4KB POSIX 原子；同进程多工具调用天然串行（stdio 单流）。
- **文件无限增长** → 读取窗口截断（3 条/400 chars）+ DELETE API + README 说明；不做语义去重（边界外）。
- **指令常量新增不修改** → 四个既有指令常量零触碰，规避 spec「修改文案 = 行为变更」的连锁测试成本。
