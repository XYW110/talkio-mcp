/**
 * fetch 封装：AbortController 超时 + 指数退避重试（design.md §7）。
 *
* 策略：
 * - 429 与 5xx、网络层 TypeError → 指数退避重试（默认最多 3 次尝试，1s → 2s）
 * - 400/401/403 等其他 4xx → 不重试，直接抛 HttpError（带状态码）
 * - 超时（AbortError）→ 抛 TimeoutError，不重试
 * - 抛出的错误信息绝不包含 Authorization / x-api-key 等密钥材料（design.md §8）
 *
 * 日志：走统一分级 logger（src/utils/log.ts）。重试提示为 info 级（默认可见）；
 * 调用方可注入 logger 以便按需收敛。注意避免此处 import 引向 log.ts 的循环依赖。
 */
import { defaultLogger, type Logger } from "./log.js";

/** HTTP 错误（带状态码，供上层判断是否重试/如何展示） */
export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string, bodySnippet?: string) {
    const snippet = bodySnippet ? `: ${redactSecrets(bodySnippet).slice(0, 300)}` : "";
    super(`HTTP ${status} ${statusText}${snippet}`);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

/** 超时错误 */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface FetchWithRetryOptions {
  /** 单次尝试超时（毫秒），默认 120s */
  timeoutMs?: number;
  /** 最大尝试次数（含首次），默认 3（即最多重试 2 次） */
  maxAttempts?: number;
  /** 首次退避基数（毫秒），默认 1000；之后每次 ×2 */
  baseDelayMs?: number;
  /** 注入 logger；缺省用模块级 defaultLogger（info，与现状 stderr 可见行为一致） */
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;

/** 可重试的 HTTP 状态码：429（限流）与所有 5xx（服务端错误） */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * 脱敏：移除错误文本中可能出现的密钥材料。
 * 覆盖常见密钥形态（sk-xxx、sk-ant-xxx、Bearer xxx 等）。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)\S+/gi, "$1[REDACTED]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 Response 安全读取一小段文本用于错误信息（失败则忽略） */
async function readBodySnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 带超时与重试的 fetch。
 *
 * @throws {TimeoutError} 单次尝试超过 timeoutMs
 * @throws {HttpError} 收到非 2xx 响应（重试耗尽或不可重试状态码）
 * @throws {TypeError} 网络层错误（重试耗尽后抛出最后一次的脱敏副本）
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const logger = options.logger ?? defaultLogger;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 允许调用方传入自己的 signal（合并：任一触发即中止）
    const callerSignal = init.signal;
    const onCallerAbort = (): void => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer);
        controller.abort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });

      if (!res.ok) {
        const bodySnippet = await readBodySnippet(res);
        const httpError = new HttpError(res.status, res.statusText, bodySnippet);

        // 可重试状态码且还有剩余次数 → 退避后重试
        if (isRetryableStatus(res.status) && attempt < maxAttempts) {
          lastError = httpError;
          const delay = baseDelayMs * 2 ** (attempt - 1);
          logger.info(
            `[retry] ${url} 返回 ${res.status}，${delay}ms 后进行第 ${attempt + 1}/${maxAttempts} 次尝试`
          );
          await sleep(delay);
          continue;
        }
        // 400/401/403 等不可重试，或重试耗尽 → 直接抛
        throw httpError;
      }

      return res;
    } catch (err) {
      if (err instanceof HttpError) {
        throw err;
      }

      // AbortError：区分是超时还是调用方主动中止；本封装内统一视为超时
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError(timeoutMs);
      }

      // 网络层错误（fetch 抛 TypeError）→ 可重试
      if (err instanceof TypeError && attempt < maxAttempts) {
        lastError = err;
        const delay = baseDelayMs * 2 ** (attempt - 1);
        logger.info(
          `[retry] ${url} 网络错误（${redactSecrets(err.message)}），${delay}ms 后进行第 ${attempt + 1}/${maxAttempts} 次尝试`
        );
        await sleep(delay);
        continue;
      }

      // 其他未知错误或重试耗尽
      if (err instanceof Error) {
        const sanitized = new Error(redactSecrets(err.message));
        sanitized.name = err.name;
        throw sanitized;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  // 理论上循环内已处理所有路径；兜底抛出最后的错误
  throw lastError ?? new Error("fetchWithRetry: exhausted attempts without result");
}
