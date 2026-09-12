# Session Records Persistence (JSONL)

> `consult_experts` / `brainstorm` / `brainstorm_followup` 工具调用的会话记录落盘契约。本模块是横切基础设施（文件 IO + admin API + env 装配），改动必须保持本文件同步。

---

## 1. Scope / Trigger

- 触发条件：任何改动 `src/records/store.ts`、三个工具 handler 的 `deps.record` 接线、`server.ts` / `index.ts` 的 recordsDir 装配、或 `admin/api.ts` 的 records 路由。
- **硬规则（PRD R3）：记录功能绝不影响工具主流程。** `startSession` 失败返回 `null`；`append` / `finish` 所有 IO 错误吞掉并以 `[records]` 前缀 warn 到 stderr logger。handler 可以无守卫地调用 `record?.append(...)`。

## 2. Signatures

```typescript
// src/records/store.ts
export function isRecordingEnabled(): boolean;              // TALKIO_RECORDS !== "0"
export function resolveRecordsDir(explicit?: string): string; // explicit > TALKIO_RECORDS_DIR > <cwd>/records
export function sumUsage(a?: UsageRecord, b?: UsageRecord): UsageRecord | undefined;
export function isValidSessionId(id: string): boolean;      // /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/
export async function startSession(
  input: StartSessionInput,
  recordsDir: string | undefined,
  logger?: Logger
): Promise<RecordSession | null>;
export async function listSessions(
  recordsDir: string,
  limit?: number                                             // 默认 50，clamp 到 [1, 200]
): Promise<Array<Record<string, unknown> & { sizeBytes: number }>>;
export async function readSession(recordsDir: string, id: string): Promise<unknown[] | null>;
export async function deleteSession(recordsDir: string, id: string): Promise<boolean>; // 先 stat 再 rm force；非法/不存在 → false（rm force 不区分「已删」与「本就不存在」）
export async function deleteSessions(recordsDir: string, ids: string[]): Promise<number>; // 返回实际删除数（逐个 deleteSession，非法 id 静默跳过）
export async function clearSessions(recordsDir: string): Promise<number>; // 清空全部：只删 *.jsonl，逐文件 catch，单个失败不中断；返回删除数

export interface RecordSession {
  readonly id: string;        // YYYYMMDD-HHmmss-<4 hex>
  append(event: RecordEvent): void;   // 永不 throw
  finish(result: RecordFinish): void; // 写入 done 行后关闭
  flush(): Promise<void>;     // 仅测试/优雅退出用；主流程不调用
}
```

工具 handler 侧约定（三个工具一致）：

```typescript
// handler deps 增加 record 注入；list_cards 不记录
export function createXxxTool(deps?: { notifier?: StreamNotifier; record?: RecordSession });
// server.ts 在 tool 闭包中 startSession，结果作为 deps.record 传入 handler
```

## 3. Contracts

### JSONL 文件格式（`<recordsDir>/<sessionId>.jsonl`）

- 第 1 行：`meta`（必有）→ 最后 1 行：`done`（必有）→ 中间为事件行，顺序即发生顺序。
- 除 `meta` 外每行自动注入 `ts: <ISO string>`；`done` 行额外注入 `type: "done"`。

| type | 字段 | 写入方 |
| ---- | ---- | ---- |
| `meta` | `type, id, tool, startedAt, prompt, context?, mode?, rounds?, degraded?, prevTurnsCount?` | `startSession` |
| `cards` | `cards: RecordCardRef[]` | consult/brainstorm/followup 选卡后 |
| `card_result` | `cardId, ok, content?, error?, usage?` | consult 每张卡 |
| `turn` | `round, expertId, expertName, icon, content, usage?` | brainstorm/followup 每轮 |
| `round_end` | `round, total` | brainstorm/followup 每轮结束 |
| `summary` | `content` | brainstorm/followup 启用总结时 |
| `done` | `status, report?, usage?`（+`ts`） | finish；`status ∈ ok/partial/all_failed/no_cards/error` |

### 环境变量 / 目录装配

| 键 | 语义 | 默认 |
| -- | ---- | ---- |
| `TALKIO_RECORDS` | `=0` 时完全禁用记录（`startSession` 返回 `null`） | 启用 |
| `TALKIO_RECORDS_DIR` | 记录目录（未显式传参时） | `<cwd>/records` |

`index.ts` 装配：`recordsDir = path.resolve(dirname(<experts.json 绝对路径>), "records")`，显式传给 `createServer` / `createAdminApi`（优先级高于 env）。

### Admin API（`src/admin/api.ts`）

| 路由 | 语义 |
| ---- | ---- |
| `GET /api/records?limit=N` | meta 摘要列表（含 `sizeBytes`），按文件名倒序（≈最新在前）；`limit` 非法值回退 50 |
| `GET /api/records/:id` | `{ id, events }` 完整事件流；`:id` 先 `decodeURIComponent` 再 `isValidSessionId` 校验 |
| `DELETE /api/records` | body `{ ids?: string[] }`：非空 ids → 批量删；无 body / 空 body / 空 ids → 清空全部。返回 `{ ok, deleted }`（实际删除数）。未配置 recordsDir → 404 |

## 4. Validation & Error Matrix

| 条件 | 行为 |
| ---- | ---- |
| `TALKIO_RECORDS=0` | `startSession` → `null`，不建目录、不写文件 |
| `recordsDir` 是文件（`mkdir recursive` 抛 EEXIST） | `startSession` 捕获 → warn `[records]` → `null` |
| `append`/`finish` 写入失败 | tail promise 捕获 → warn `[records]`（不影响主流程） |
| `finish` 后再 `append`/`finish` | 静默忽略（`closed` 标志） |
| `listSessions` 目录不存在 / meta 行损坏 | 返回 `[]` / 跳过该文件 |
| `readSession` id 不合法（含路径穿越 `../x`） | `null` → API 404 |
| `readSession` 文件不存在 | `null` → API 404 |
| `readSession` 存在坏 JSON 行 | 静默跳过，返回其余合法行 |
| `admin` 未配置 `recordsDir` | 列表 `200 []`；详情 `404`；DELETE `404 记录未启用` |
| DELETE `ids` 非数组 / body JSON 非法 | `400`（消息为具体错误） |
| DELETE `ids` 含非法 / 路径穿越 / 不存在的 id | 静默跳过，不计入 `deleted`（`deleteSession` 先 `stat` 再 `rm force`，不存在返回 `false`） |
| DELETE 无 body / 空 body / 空 ids | 视为清空全部；`clearSessions` 只删 `*.jsonl`，逐文件 catch，单个失败不中断 |

## 5. Good / Base / Bad Cases

- **Good**：完整工具调用 → meta → cards → N 个 turn/card_result → (round_end/summary) → done，usage 汇总非空。
- **Base**：记录目录不可写 → 主流程完全正常，仅 stderr 出现 `[records]` warn；admin 列表为空。
- **Bad**（禁止）：在 handler 里 try/catch 包裹 `record.append` 后把错误上抛/中断主流程；或用 `await` 阻塞工具返回等待记录落盘（`append` 是同步 fire-and-forget）。

### Wrong vs Correct

```typescript
// ❌ Wrong：让记录影响主流程
const events = JSON.stringify(record);   // record 不可序列化，且放在主路径上

// ✅ Correct：handler 无守卫调用，store 内部兜底
record?.append({ type: "card_result", cardId, ok, content, error, usage });
```

## 6. Tests Required

- `test/records.test.ts`：`startSession+append+finish` 后逐行 JSON.parse 校验行序（meta 首行 / done 末行）；禁用 → `null`；IO 失败 → `null`；`sumUsage` 不虚构零字段；`listSessions` 排序断言用**文件名倒序**（同秒创建时序不可靠，禁止断言创建顺序）；`readSession` 坏行跳过 + 非法 id → `null`。读文件前必须 `await flush()`。
- `test/admin-records.test.ts`：列表/详情/404/路径穿越 `..%2F` / 无 recordsDir → `[]`；DELETE 批量删（含未知/穿越 id 静默跳过不计数）、无 ids 清空、空 ids 视清空、未配置 recordsDir → 404。桩 `makeReqRes` 的 body 派发在 `on("end")` 触发（依赖 `readBody` 固定 data→end 注册顺序；若改 `readBody` 顺序需同步）。
- `test/consult-brainstorm.test.ts`（record wiring）：以 `startSession` 传入 `deps.record`，断言 consult 的 meta/cards/card_result/done、brainstorm 的 turn/round_end/summary/done 数量。

## 7. Common Mistakes

- **`askExpert` 返回值形状**：`dialogue.ts` 的 `askExpert` 返回 `{ content: string; usage?: UsageRecord }`（不是 string）。任何新调用点必须解构 `.content` / `.usage` —— 漏改会在 typecheck 暴露，但若用 `String(await askExpert(...))` 会静默产出 `[object Object]` 记录。
- **同秒会话排序**：session id 时间戳前缀精确到秒，同一秒内多个会话的顺序由 4 位随机 hex 决定——测试与 UI 均不得假设"后创建 = 列表在前"。
- **flush 语义**：写入是单条 tail-promise 链串行化；只有 `flush()` 能确定性等待全部落盘（测试读文件前必调）。不要在主流程 `await flush()`——主流程从不等待记录。
