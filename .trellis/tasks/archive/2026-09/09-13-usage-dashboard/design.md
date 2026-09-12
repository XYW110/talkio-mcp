# Design: admin-web Token 用量聚合页

## 边界与改动面

| 文件 | 改动 |
|---|---|
| `src/records/store.ts` | 新增 `aggregateUsage(dir, days)` 纯函数（可单测） |
| `src/admin/api.ts` | 新增 `GET /api/usage` 路由（recordsDir 缺省返回空结构） |
| `admin-web/src/api.ts` / `types.ts` | 客户端方法 + 响应类型 |
| `admin-web/src/App.tsx` | 导航加"用量"入口（桌面侧栏 + 手机顶栏） |
| `admin-web/src/pages/UsagePage.tsx` | 新页面 |
| `test/admin-records.test.ts`（或新 `test/admin-usage.test.ts`） | 聚合函数 + API 路由测试 |

不改动：records 写入格式、既有 /api/records* 路由、MCP 侧。

## 契约

### GET /api/usage?days=N

```ts
// 响应
{
  days: number;            // 实际采用的时间窗
  total: Usage;            // { promptTokens?, completionTokens? }
  sessionCount: number;    // 时间窗内会话文件数
  callCount: number;       // 带 usage 的事件数（turn + card_result）
  byDay:  Array<{ date: string; usage: Usage }>;             // date=YYYY-MM-DD（meta.startedAt 本地日）
  byCard: Array<{ cardId: string; cardName: string; modelId: string; provider: string; usage: Usage; sessions: number; calls: number }>; // usage 降序
  byModel: Array<{ modelId: string; provider: string; usage: Usage; calls: number }>;  // usage 降序
  skipped: number;         // 解析失败/损坏文件数
}
// records 未启用：全部为空数组/0，HTTP 200（不是 404）
```

归并规则复用 `sumUsage`（不发明零字段）。

### 聚合实现（aggregateUsage）

1. 列目录 jsonl，按文件 mtime 过滤时间窗（与 listSessions 同风格）。
2. 逐文件读全文（记录文件小，≤几百 KB），逐行 JSON.parse：首行 `type==="meta"` 取 startedAt 与 `cards[]`（含 modelId/provider 快照）；`turn`/`card_result` 行有 usage 则累计，cardId 维度优先用事件自带 cardId（card_result）或 cards 快照反查（turn 无 cardId，按 expertId→cards 快照匹配，未命中归入 `unknown` 桶）。
3. 任一行 parse 失败 → 整文件计入 skipped 并跳过（简单、可预测）；单文件失败不影响其余。
4. 纯函数不碰 HTTP；API 路由只做参数钳制（days = clamp(round(N), 1, 90)，非法/缺省 → 30）与 JSON 输出。

## 页面设计（UsagePage）

- 顶部：3 张统计岛卡（总 token、会话数/调用数、时间窗选择 7/30/90 天下拉，改变触发 refetch）。
- 中部：按天条形列表（每行 日期 + 横向 div 条，宽度 = 当日 total/最大日 total 比例，token 数值右对齐）。
- 下部：两列排行（卡片 / 模型），行 = 名称 + provider 徽标 + token 数 + calls；卡片行内若命中本地价格表则追加估算成本。
- 价格表交互：页内"价格表"按钮开浮层，textarea 编辑 JSON（`{ "<modelId>": {"input": 元/M, "output": 元/M} }`），存 localStorage `talkio-price-table`；解析失败 toast 并不保存。
- 样式全部走 token 语义类（bg-canvas/island/text-ink 等），禁止硬编码色（spec component-guidelines 约定）。

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| days 非数字/越界 | clamp 到 [1,90]，缺省 30 |
| recordsDir 未配置 | 200 + 空结构 |
| 单文件 JSON 损坏 | skipped+1，其余正常 |
| turn 行 expertId 无法映射卡 | 归入 byCard 的 `unknown` 桶（cardId="unknown"） |
| usage 字段缺失 | 该事件不计入 callCount 的 usage 合计，但 callCount 照常 +1 |

## Tests Required

- 聚合单测：临时目录 fixture（2 个正常文件 + 1 个损坏文件 + 1 个窗外文件），断言 total/byDay/byCard/byModel/skipped 精确值（含 expertId 反查命中与 unknown 桶两分支）。
- API 测试：200 空结构（无 recordsDir）；days 非法钳制；正常返回体形状。
- 前端：`npm run build` 通过；UsagePage 用 mock api 手动验证渲染（暗色切换检查）。

## Wrong vs Correct

```ts
// Wrong：前端拉全量 /api/records 逐会话请求详情再聚合（N+1 请求）
const list = await api.listRecords(200);
for (const s of list) await api.getRecord(s.id);

// Correct：后端一次聚合返回
const usage = await api.getUsage(30);
```
