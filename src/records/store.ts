/**
 * Session records — JSONL persistence for consult_experts / brainstorm /
 * brainstorm_followup tool calls.
 *
 * One file per tool call: <recordsDir>/<sessionId>.jsonl. Line 1 is always a
 * `meta` event; the last line is always `done`. Intermediate lines are
 * milestone events (card results, dialogue turns, round boundaries, summary).
 *
 * Hard rule (PRD R3): recording must never affect the tool call itself. Every
 * IO failure inside this module is swallowed and reported via the stderr
 * logger as [records] warn. Handlers may call append/finish unguarded.
 *
 * Privacy: callers record already-redacted content (redactPII happens before
 * anything reaches the LLM or the report). This module adds no new exposure.
 */
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { defaultLogger, type Logger } from "../utils/log.js";

/** Token usage as reported by providers (missing fields stay undefined). */
export type UsageRecord = {
  promptTokens?: number;
  completionTokens?: number;
};

/** One selected card snapshot for the meta line. */
export interface RecordCardRef {
  cardId: string;
  cardName: string;
  expertId: string;
  expertName: string;
  modelId: string;
  provider: string;
}

/** Events that can be appended after the meta line (store adds `ts`). */
export type RecordEvent =
  | { type: "cards"; cards: RecordCardRef[] }
  | {
      type: "card_result";
      cardId: string;
      ok: boolean;
      content?: string;
      error?: string;
      usage?: UsageRecord;
    }
  | {
      type: "turn";
      round: number;
      expertId: string;
      expertName: string;
      icon: string;
      content: string;
      usage?: UsageRecord;
    }
  | { type: "round_end"; round: number; total: number }
  | { type: "summary"; content: string };

/** Terminal event payload. */
export interface RecordFinish {
  status: "ok" | "partial" | "all_failed" | "no_cards" | "error";
  /** Full Markdown report exactly as returned to the client. */
  report?: string;
  /** Session-wide usage sum (missing when nothing was reported). */
  usage?: UsageRecord;
}

/** Input for startSession — the tool call's identifying inputs. */
export interface StartSessionInput {
  tool: "consult_experts" | "brainstorm" | "brainstorm_followup";
  /** The question / topic / follow-up question. */
  prompt: string;
  context?: string;
  mode?: string;
  rounds?: number;
  /** brainstorm_followup: true when prior turns were unusable. */
  degraded?: boolean;
  /** brainstorm_followup: how many prior turns the client passed in. */
  prevTurnsCount?: number;
}

/** A handle to append events into one session file. All methods never throw. */
export interface RecordSession {
  readonly id: string;
  append(event: RecordEvent): void;
  finish(result: RecordFinish): void;
  /** 等待全部已排队写入落盘（测试/优雅退出用；主流程无需调用）。 */
  flush(): Promise<void>;
}

/** True unless recording was explicitly disabled via TALKIO_RECORDS=0. */
export function isRecordingEnabled(): boolean {
  return process.env.TALKIO_RECORDS !== "0";
}

/**
 * Resolve the records directory: explicit argument wins (index.ts derives
 * <experts.json dir>/records; tests pass a tmpdir), then TALKIO_RECORDS_DIR,
 * then <cwd>/records.
 */
export function resolveRecordsDir(explicit?: string): string {
  if (explicit && explicit.trim() !== "") return explicit;
  const env = process.env.TALKIO_RECORDS_DIR;
  if (env && env.trim() !== "") return env;
  return path.resolve(process.cwd(), "records");
}

/** Session id: filename-safe, lexicographic order ≈ time order. */
function buildSessionId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Sum two optional usage objects without inventing zero fields. */
export function sumUsage(
  a: UsageRecord | undefined,
  b: UsageRecord | undefined
): UsageRecord | undefined {
  if (!a && !b) return undefined;
  const merged: UsageRecord = {};
  if (a?.promptTokens !== undefined || b?.promptTokens !== undefined) {
    merged.promptTokens = (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0);
  }
  if (a?.completionTokens !== undefined || b?.completionTokens !== undefined) {
    merged.completionTokens =
      (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0);
  }
  return merged;
}

function warnOnce(logger: Logger, message: string): void {
  logger.warn(`[records] ${message}（不影响本次调用）`);
}

/**
 * Start a session: create the records dir, write the meta line. Returns null
 * when recording is disabled or the initial write fails (logged, never thrown).
 */
export async function startSession(
  input: StartSessionInput,
  recordsDir: string | undefined,
  logger: Logger = defaultLogger
): Promise<RecordSession | null> {
  if (!isRecordingEnabled()) return null;
  const dir = resolveRecordsDir(recordsDir);
  const id = buildSessionId(new Date());
  const filePath = path.join(dir, `${id}.jsonl`);
  const meta = {
    type: "meta",
    id,
    tool: input.tool,
    startedAt: new Date().toISOString(),
    prompt: input.prompt,
    context: input.context,
    mode: input.mode,
    rounds: input.rounds,
    degraded: input.degraded,
    prevTurnsCount: input.prevTurnsCount,
  };

  try {
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, `${JSON.stringify(meta)}\n`, "utf-8");
  } catch (err) {
    warnOnce(
      logger,
      `会话记录初始化失败: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  let closed = false;
  // 单一 tail promise：串行化写入以便 flush 能确定性地等待全部落盘。
  let tail: Promise<void> = Promise.resolve();
  // Fire-and-forget append: failures are logged, never propagated (PRD R3).
  const writeLine = (line: string): void => {
    tail = tail
      .then(() => appendFile(filePath, line, "utf-8"))
      .catch((err: unknown) => {
        warnOnce(
          logger,
          `写入失败: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  };

  return {
    id,
    append(event: RecordEvent): void {
      if (closed) return;
      writeLine(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    },
    finish(result: RecordFinish): void {
      if (closed) return;
      closed = true;
      writeLine(
        `${JSON.stringify({ type: "done", ts: new Date().toISOString(), ...result })}\n`
      );
      tail = tail.then(() => {
        logger.info(`[records] 会话已记录: ${filePath}`);
      });
    },
    flush(): Promise<void> {
      return tail;
    },
  };
}

/** Session id whitelist: what we generate — blocks path traversal in admin API. */
export function isValidSessionId(id: string): boolean {
  return /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id);
}

/** Read only the first line (meta) of a session file, capped for safety. */
async function readMetaLine(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    const buf = await readFile(filePath);
    const text = buf.subarray(0, 64 * 1024).toString("utf-8");
    const firstLine = text.split("\n", 1)[0] ?? "";
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    return parsed && parsed.type === "meta" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * List sessions (newest first) with their meta summaries. Files whose first
 * line is unreadable are skipped silently — a half-written file must not
 * break the listing.
 */
export async function listSessions(
  recordsDir: string,
  limit = 50
): Promise<Array<Record<string, unknown> & { sizeBytes: number }>> {
  let names: string[];
  try {
    names = await readdir(recordsDir);
  } catch {
    return [];
  }
  const capped = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  const jsonl = names.filter((n) => n.endsWith(".jsonl")).sort().reverse();
  const out: Array<Record<string, unknown> & { sizeBytes: number }> = [];
  for (const name of jsonl) {
    if (out.length >= capped) break;
    const filePath = path.join(recordsDir, name);
    const meta = await readMetaLine(filePath);
    if (!meta) continue;
    try {
      const st = await stat(filePath);
      out.push({ ...meta, sizeBytes: st.size });
    } catch {
      // File vanished between readdir and stat — skip.
    }
  }
  return out;
}

/** Read one session's full event list. null when missing/invalid id. */
export async function readSession(
  recordsDir: string,
  id: string
): Promise<unknown[] | null> {
  if (!isValidSessionId(id)) return null;
  try {
    const raw = await readFile(path.join(recordsDir, `${id}.jsonl`), "utf-8");
    const events: unknown[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Ignore corrupt lines; the rest of the session stays readable.
      }
    }
    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}
