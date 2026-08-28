/**
 * 分级日志模块 —— 对应 design.md §1（observability 任务）。
 *
 * MCP 服务器运行在 stdio 或 SSE 模式下；stdio 下 stdout 是 JSON-RPC 协议
 * 通道，任何普通日志**禁止**写 stdout（会破坏协议解析），一律走 stderr。
 * 因此本模块所有级别都写 process.stderr，不做 info→stdout 的分流。
 *
 * 设计约束（避免破坏既有测试与对外文案）：
 * - 输出保留各调用方的前缀（如 `[config] …`、`[retry] …`），不在本层加前缀。
 * - 不添加时间戳前缀，避免破坏对完整文本行的断言（如迁移提示）。
 * - 无效级别缺省降级为 `info`。
 */

export type LogLevel = "silly" | "debug" | "info" | "warn" | "error";

/** 级别 → 数值档位（数字越大越严重）。 */
const LEVEL_ORDER: Record<LogLevel, number> = {
  silly: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** 统一写 stderr；逐参转换为纯文本，避免对象被 console 增强格式化。 */
function write(args: unknown[]): void {
  const line = args
    .map((a) =>
      typeof a === "string"
        ? a
        : a instanceof Error
          ? a.message
          : safeStringify(a)
    )
    .join(" ");
  process.stderr.write(line + "\n");
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

export interface Logger {
  silly(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** 当前 logger 是否启用某级别（供调用方决定是否做昂贵的组装）。 */
  isEnabled(level: LogLevel): boolean;
}

/**
 * 解析用户传入的级别字符串；无效 / 缺省统一降级为 "info"。
 * 大小写不敏感（如 "INFO" / "Info" 均合法）。
 */
export function normalizeLevel(value: string | undefined): LogLevel {
  if (!value) return "info";
  const v = value.toLowerCase();
  if (v === "silly" || v === "debug" || v === "info" || v === "warn" || v === "error") {
    return v;
  }
  return "info";
}

/**
 * 创建一个 logger：仅输出档位 ≥ 阈值级别的日志。
 * 默认阈值 info —— 与改造前的可见行为一致（现有打点默认全可见）。
 */
export function createLogger(level: LogLevel = "info"): Logger {
  const minOrder = LEVEL_ORDER[level];
  const enabled = (lvl: LogLevel): boolean => LEVEL_ORDER[lvl] >= minOrder;
  const out = (lvl: LogLevel) =>
    (...args: unknown[]): void => {
      if (enabled(lvl)) write(args);
    };

  return {
    silly: out("silly"),
    debug: out("debug"),
    info: out("info"),
    warn: out("warn"),
    error: out("error"),
    isEnabled: enabled,
  };
}

/**
 * 模块级默认 logger（info）。供不接收外部 logger 注入的模块直接使用；
 * 需要按 CLI 级别收敛时才在入口处另建实例注入。
 */
export const defaultLogger: Logger = createLogger("info");