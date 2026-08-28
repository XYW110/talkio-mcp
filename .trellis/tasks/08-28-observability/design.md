# Design — 可观测性与错误压缩

## 1. Logger 模块（新增 src/utils/log.ts）

```ts
export type LogLevel = "silly" | "debug" | "info" | "warn" | "error";

export interface Logger {
  silly(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  // 是否启用某级别（供调用方决定是否做耗时工作）
  isEnabled(level: LogLevel): boolean;
}

export function createLogger(level: LogLevel = "info"): Logger;
export function normalizeLevel(value: string | undefined): LogLevel;
```

- 实现要点
  - 内部维护 `minLevelOrder`，`silly=0 … error=4`，`levelOrder >= minLevelOrder` 才输出。
  - `info` 及其以上写 `stdout`（沿用现有行为，测试的 `[config]` 迁移提示走 info）；`warn`/`error` 写 `stderr`。
  - 输出格式沿用现有文本（如 `[config] …`、`[retry] …`），**不改变对外文案**，只做级别归属。
  - 加时间戳前缀（如 `[2026-08-28T20:00:00+08:00] `）—— 仅当不破坏现有测试对文本匹配时启用；若测试按子串断言，需保留核心子串。
- `normalizeLevel`：无效/缺省返回 `"info"`；匹配已知级别（大小写不敏感）。

## 2. CLI 接线（src/index.ts / src/server.ts）

- `src/index.ts` 解析 `--log-level` 参数（等效现有 `--config` 的解析方式），归一化后：
  - 用 `createLogger(level)` 生成 logger；
  - 将 logger 注入 `loadConfig(configPath, { logger })`（`config.ts` 的加载函数可选接 logger，缺省用全局默认）；
  - `createServer(config, { logger })` 同样可选接 logger。
- 默认行为（不传 `--log-level`）：`info`，与现状一致 → 既有测试的 stderr 断言不受影响。

## 3. 打点替换（config.ts / providers/retry.ts）

| 现有位置 | 现状 | 改为 |
|---|---|---|
| `config.ts` 迁移提示 | `console.log("[config] 检测到旧格式配置…")` | `logger.info("[config] …")` |
| `config.ts` 致命错误 | `console.error` | `logger.error` |
| `config.ts` key 缺失警告 | `console.warn("警告: provider …")` | `logger.warn` |
| `providers/retry.ts` 429/5xx/网络错 | `console.warn`/`console.log` | `logger.warn` / `logger.debug` |

- 保持 `[config]` / `[retry]` 前缀与文案语义不变，避免破坏测试对该文本的断言。
- logger 需在 `loadConfig` 内部可访问（写入配置加载流程其实早于 parse，需把 logger 作为可选参数从上而下传入）。

## 4. 调用汇总 typeline（orchestrator/parallel.ts · dialogue.ts）

- `parallel.ts` 的 `callExpert` 内围绕 `adapter.chat` 计时：
  - recorded = `{ target, provider, model, ms, ok }`，随 `ConsultationItem` 一并收集。
- `runConsultation` / `runDialogue` 末尾调用 `logger.info(summaryLine)`，格式例如：
  ```
  [summary] consult cards=3 ok=2 failed=1 avg_ms=845 total_ms=2940
  [summary] brainstorm rounds=2 turns=4 summary=yes ok=4 failed=0 total_ms=5120
  ```
- 汇总行**只经 logger 输出**，不进返回值。

## 5. 错误压缩（parallel.ts 报告组装）

- 在 `runConsultation` 组装 `ConsultationItem[]` / 报告文本前：
  - 计算 `failed = items.filter(i => !i.ok)`。
  - 若 `failed.length === targets.length && failed.length > 0`（**全部失败**）：
    - 聚合为**单条** `ConsultationItem`，`ok:false`，error 形如：
      `"全部 N 张卡咨询失败（均为 provider 调用失败）: [首个 error 摘要]"`。
    - 语义：共性原因可从各 error 取共同前缀/统一归类（最简：取第一个 error）。
  - 否则：保持逐卡失败项（现状）。
- 报告文本（`consult-experts.ts`）对聚合后的 items 直接渲染，不感知聚合逻辑（聚合发生在 items 组装层）。

### 超时降级（本次最小实现）
- 复用现有 `timeoutMs` 异常路径：`adapter.chat` 超时抛错 → `callExpert` 现已 catch 并返回 ok:false。本次「降级」仅体现在：
  - 错误文案含 `超时` 字样即可被归类；
  - 全部失败聚合时，若首个 error 含 `超时`，则在摘要中标注「（含超时）」，`` 不引入独立字段。
- 不额外增加复杂的分级降级状态机（保持体积最小，符合「纯加固」）。

## 6. 测试改动（test/*.test.ts）

- `test/config.test.ts`：迁移提示文本断言需与 logger 输出格式保持一致（若加时间戳则改断言，否则不动）。优先**不加时间戳**，最小化测试改动。
- `test/providers.test.ts` / 其它 stderr 断言：若 `[retry]` 保留，通常无需改。
- `test/orchestrator.test.ts`：
  - 新增「全部目标卡失败 → 报告聚合为一条失败摘要」用例；
  - 复核「单卡失败不阻断」用例仍绿（部分失败逐卡）。
  - 新增「调用汇总 typeline 输出，且不进返回报告」用例（用注入 logger 捕获 info）。
- 预估：现有 84 → ~86（新增 2 个 orchestrator 用例）。

## 7. 冒烟 / README

- `scripts/smoke-stdio.mjs`：不新增断言（工具行为不变）。但需确认新 `--log-level` 不破坏 stdio 启动。
- `README.md`：新增「日志与诊断」小节：
  - `--log-level silly|debug|info|warn|error`（默认 info）；
  - 汇总行示例；
  - 错误压缩说明（全部失败聚合为一条）。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| logger 改文案破坏现有 stderr 用例 | 保持 `[config]`/`[retry]` 前缀与文本不变；时间戳默认不加 |
| `--log-level` 解析侵入 index.ts 影响既有参数 | 沿用 `--config` 的 optparse 风格，互不影响 |
| 全部失败聚合改动报告结构 | 聚合在 items 层，`consult-experts.ts` 渲染层不变；补测试锁定 |
| 汇总行进报告 | 只在 logger 输出，绝不写回 ConsultationItem |

## 9. 验收对照

- AC-1（warn 收敛）：`createLogger("warn")` 下 `info` 级 `[config]` 行不再输出。
- AC-2（汇总行）：`runConsultation` 后 logger.info 收到 `[summary]` 一行。
- AC-3（全失败聚合）：orchestrator 新用例断言报告仅 1 条失败项 + 总数。
- AC-5：`npm test` 全绿（~86）、typecheck/build 通过、smoke 14/14。