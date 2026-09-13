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
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
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
  | {
      type: "vote";
      round: number;
      votes: {
        voterCardId: string;
        votedForAlias: string;
        reason: string;
      }[];
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

/**
 * Delete one session file by id. Returns true when a file was actually
 * removed (invalid ids and missing files yield false — never throws).
 */
export async function deleteSession(recordsDir: string, id: string): Promise<boolean> {
  if (!isValidSessionId(id)) return false;
  const filePath = path.join(recordsDir, `${id}.jsonl`);
  try {
    // 先确认文件真实存在：rm force 对不存在的文件不抛错，无法区分「已删」与「本就不存在」。
    await stat(filePath);
    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Delete the given sessions in one call. Returns how many files were removed. */
export async function deleteSessions(
  recordsDir: string,
  ids: string[]
): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    if (await deleteSession(recordsDir, id)) deleted += 1;
  }
  return deleted;
}

/** Token 用量聚合结果（GET /api/usage 响应体，见 design.md 契约）。 */
export interface UsageAggregate {
  /** 实际采用的时间窗（天） */
  days: number;
  /** 全部 turn/card_result 事件的 usage 合计（done 行为会话汇总，不计入避免重复） */
  total: UsageRecord;
  /** 时间窗内成功解析的会话文件数 */
  sessionCount: number;
  /** turn + card_result 事件数（usage 缺失也照常 +1，见 design.md 错误矩阵） */
  callCount: number;
  /** 按天聚合，date = meta.startedAt 的本地 YYYY-MM-DD，升序 */
  byDay: Array<{ date: string; usage: UsageRecord }>;
  /** 按角色卡聚合，usage 降序；turn 行 expertId 反查不到快照时归入 "unknown" 桶 */
  byCard: Array<{
    cardId: string;
    cardName: string;
    modelId: string;
    provider: string;
    usage: UsageRecord;
    sessions: number;
    calls: number;
  }>;
  /** 按模型聚合，usage 降序 */
  byModel: Array<{ modelId: string; provider: string; usage: UsageRecord; calls: number }>;
  /** 解析失败（损坏）的文件数 */
  skipped: number;
}

/** ISO 时间 → 本地 YYYY-MM-DD（与 RecordsPage 的 localDate 同口径）；无法解析返回 null。 */
function localDateKey(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 聚合输出按 usage 总量（入+出）降序；并列时按 id 字典序保证确定性。 */
function usageSize(u: UsageRecord): number {
  return (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
}

/**
 * 聚合时间窗内会话记录的 token 用量（纯函数，不碰 HTTP）。
 *
 * - 先按文件 mtime 过滤时间窗（与 listSessions 同风格），窗外文件整体排除。
 * - 逐文件全文逐行 JSON.parse：任一行损坏 → skipped+1 并跳过整个文件（简单可预测，
 *   单文件失败不影响其余）。
 * - usage 维度只统计 turn / card_result 行（done 行是会话级汇总，计入会重复）。
 * - days 也会做防御性钳制（正常路径由 API 路由钳制）。
 */
export async function aggregateUsage(
  recordsDir: string,
  days: number
): Promise<UsageAggregate> {
  // 防御性钳制（正常路径由 API 路由钳制）：NaN/非有限 → 30，其余 clamp 到 [1,90]
  const truncated = Math.trunc(days);
  const windowDays = Number.isFinite(truncated) ? Math.min(Math.max(truncated, 1), 90) : 30;
  const result: UsageAggregate = {
    days: windowDays,
    total: {},
    sessionCount: 0,
    callCount: 0,
    byDay: [],
    byCard: [],
    byModel: [],
    skipped: 0,
  };

  let names: string[];
  try {
    names = (await readdir(recordsDir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return result; // 目录不存在 / 不可读 → 空结构
  }

  const windowStartMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const dayMap = new Map<string, UsageRecord>();
  const cardMap = new Map<
    string,
    {
      cardName: string;
      modelId: string;
      provider: string;
      usage: UsageRecord;
      sessions: Set<string>;
      calls: number;
    }
  >();
  const modelMap = new Map<string, { provider: string; usage: UsageRecord; calls: number }>();

  // 归并规则复用 sumUsage：不发明零字段（只在字段出现时累加）
  const addUsage = (target: UsageRecord, usage: UsageRecord): void => {
    const merged = sumUsage(target, usage);
    if (merged) {
      target.promptTokens = merged.promptTokens;
      target.completionTokens = merged.completionTokens;
    }
  };

  for (const name of names) {
    const filePath = path.join(recordsDir, name);

    // 1) mtime 预过滤：窗外文件整体排除（不计 skipped）
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      continue; // 文件在 readdir 与 stat 之间消失——跳过
    }
    if (mtimeMs < windowStartMs) continue;

    // 2) 全文逐行解析；任一行 parse 失败 → skipped+1 并跳过整个文件
    let text: string;
    try {
      text = await readFile(filePath, "utf-8");
    } catch {
      result.skipped += 1;
      continue;
    }
    const parsed: Array<Record<string, unknown>> = [];
    let corrupt = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("非对象行");
        parsed.push(obj as Record<string, unknown>);
      } catch {
        corrupt = true;
        break;
      }
    }
    if (corrupt) {
      result.skipped += 1;
      continue;
    }

    result.sessionCount += 1;

    // 3) meta 行取 startedAt（本地日）；cards 事件行取快照（expertId/cardId → 卡片信息）
    let dayKey: string | null = null;
    let cardSnapshot: RecordCardRef[] = [];
    for (const obj of parsed) {
      if (obj.type === "meta") {
        dayKey = localDateKey(obj.startedAt);
      } else if (obj.type === "cards" && Array.isArray(obj.cards)) {
        cardSnapshot = (obj.cards as RecordCardRef[]).filter(
          (c) => c && typeof c === "object" && typeof c.cardId === "string"
        );
      }
    }

    // 4) turn / card_result 行累计 usage
    for (const obj of parsed) {
      if (obj.type !== "turn" && obj.type !== "card_result") continue;
      result.callCount += 1; // usage 缺失也照常计数（design.md 错误矩阵）
      const raw = obj.usage as Record<string, unknown> | undefined;
      if (!raw || typeof raw !== "object") continue; // 无 usage：不计入任何用量合计
      const usage: UsageRecord = {};
      if (typeof raw.promptTokens === "number" && Number.isFinite(raw.promptTokens)) {
        usage.promptTokens = raw.promptTokens;
      }
      if (typeof raw.completionTokens === "number" && Number.isFinite(raw.completionTokens)) {
        usage.completionTokens = raw.completionTokens;
      }
      if (usage.promptTokens === undefined && usage.completionTokens === undefined) continue;

      // 归属卡片：card_result 自带 cardId；turn 无 cardId，按 expertId 反查 cards 快照
      let cardId: string;
      let ref: RecordCardRef | undefined;
      if (obj.type === "card_result") {
        cardId = typeof obj.cardId === "string" && obj.cardId !== "" ? obj.cardId : "unknown";
        ref = cardSnapshot.find((c) => c.cardId === cardId);
      } else {
        const expertId = typeof obj.expertId === "string" ? obj.expertId : "";
        ref = cardSnapshot.find((c) => c.expertId === expertId);
        cardId = ref ? ref.cardId : "unknown";
      }
      const modelId = ref?.modelId ?? "";

      addUsage(result.total, usage);
      if (dayKey) {
        const dayBucket = dayMap.get(dayKey) ?? {};
        addUsage(dayBucket, usage);
        dayMap.set(dayKey, dayBucket);
      }

      let cardBucket = cardMap.get(cardId);
      if (!cardBucket) {
        cardBucket = {
          cardName: cardId === "unknown" ? "未知卡片" : (ref?.cardName ?? cardId),
          modelId,
          provider: ref?.provider ?? "",
          usage: {},
          sessions: new Set<string>(),
          calls: 0,
        };
        cardMap.set(cardId, cardBucket);
      }
      addUsage(cardBucket.usage, usage);
      cardBucket.calls += 1;
      cardBucket.sessions.add(name);

      if (modelId !== "") {
        let modelBucket = modelMap.get(modelId);
        if (!modelBucket) {
          modelBucket = { provider: ref?.provider ?? "", usage: {}, calls: 0 };
          modelMap.set(modelId, modelBucket);
        }
        addUsage(modelBucket.usage, usage);
        modelBucket.calls += 1;
      }
    }
  }

  result.byDay = [...dayMap.entries()]
    .map(([date, usage]) => ({ date, usage }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  result.byCard = [...cardMap.entries()]
    .map(([cardId, b]) => ({
      cardId,
      cardName: b.cardName,
      modelId: b.modelId,
      provider: b.provider,
      usage: b.usage,
      sessions: b.sessions.size,
      calls: b.calls,
    }))
    .sort((a, b) => usageSize(b.usage) - usageSize(a.usage) || a.cardId.localeCompare(b.cardId));
  result.byModel = [...modelMap.entries()]
    .map(([modelId, b]) => ({ modelId, provider: b.provider, usage: b.usage, calls: b.calls }))
    .sort((a, b) => usageSize(b.usage) - usageSize(a.usage) || a.modelId.localeCompare(b.modelId));
  return result;
}

/** Delete all session files in the records dir. Returns how many were removed. */
export async function clearSessions(recordsDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(recordsDir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      await rm(path.join(recordsDir, name), { force: true });
      deleted += 1;
    } catch {
      // Skip files we cannot remove (locked/permission); keep counting the rest.
    }
  }
  return deleted;
}
