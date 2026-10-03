/**
 * 专家记忆沉淀（P3，groupchat-strengths 任务）。
 *
 * 借鉴 AgentMore 群聊「人设记忆」体验：专家跨会话沉淀经验，后续讨论注入
 * 历史记忆，形成"越用越懂你"的成长感。落地为 MCP 无状态模型的等价物：
 *
 * - 存储：`<memoryDir>/<expertId>.jsonl`，一行一条 `{ ts, text }`；
 *   memoryDir 解析链与 recordsDir 同约定（explicit > env > 装配层传入）。
 * - 写入：brainstorm 末轮 harvest 的「记忆：」行经 redactPII 后追加
 *   （appendFileSync 单行 <4KB，POSIX 原子；IO 错误一律吞掉并以
 *   `[memory]` 前缀 warn——记忆是附加能力，绝不影响工具主流程）。
 * - 注入：该专家后续所有工具调用的 prompt 头部注入记忆块（最近 ≤3 条、
 *   块长 ≤400 chars）；无记忆文件 / 空条目 → 零字节注入（prompt 逐字节
 *   不变，AC6 红线）。
 * - 管理：admin API `GET /api/memory` / `DELETE /api/memory/:expertId`。
 *
 * expertId 直接作文件名：config.ts 的 zod schema 已约束其为
 * `/^[a-z0-9][a-z0-9_-]*$/i`（防路径穿越，与 records 的 sessionId 校验同理）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { defaultLogger, type Logger } from "../utils/log.js";
import { redactPII } from "../utils/redact.js";

/** 记忆条目（JSONL 一行）。 */
export interface MemoryEntry {
  /** ISO 时间戳（写入时刻）。 */
  ts: string;
  /** 记忆正文（已 redactPII、已截断）。 */
  text: string;
}

/** 注入窗口：最多 3 条（最近的优先）。 */
export const MEMORY_MAX_ENTRIES = 3;
/** 注入块总长上限（含表头）。 */
export const MEMORY_BLOCK_MAX_CHARS = 400;
/** 单条记忆落盘截断长度（harvest 行防超长）。 */
export const MEMORY_TEXT_MAX_CHARS = 50;

/**
 * 解析 memoryDir：显式参数优先（index.ts 装配 `<experts.json 目录>/memory`，
 * 测试传 tmpdir），其次 TALKIO_MEMORY_DIR，最后 `<cwd>/memory`。
 */
export function resolveMemoryDir(explicit?: string): string {
  if (explicit && explicit.trim() !== "") return explicit;
  const env = process.env.TALKIO_MEMORY_DIR;
  if (env && env.trim() !== "") return env;
  return path.resolve(process.cwd(), "memory");
}

/**
 * 读取某专家的记忆（旧→新顺序返回全部条目；注入窗口由 buildMemoryBlock 截断）。
 * 文件不存在 → 空数组；坏行（JSON 解析失败 / 形态不符）跳过并 warn，不抛错。
 */
export function loadExpertMemories(
  memoryDir: string,
  expertId: string,
  logger: Logger = defaultLogger
): MemoryEntry[] {
  const file = path.join(memoryDir, `${expertId}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return []; // 不存在（最常见）或不可读：一律视为无记忆。
  }
  const entries: MemoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const v = JSON.parse(trimmed) as { ts?: unknown; text?: unknown };
      if (
        typeof v.ts === "string" &&
        typeof v.text === "string" &&
        v.text.trim() !== ""
      ) {
        entries.push({ ts: v.ts, text: v.text });
      }
    } catch {
      logger.warn(`[memory] 跳过 ${expertId} 记忆文件中的坏行`);
    }
  }
  return entries;
}

/**
 * 追加一条记忆（redactPII → 截断 → appendFileSync）。
 * 目录懒创建（首次写入时 mkdirSync recursive）。IO 失败吞掉 + warn，
 * 绝不影响调用方主流程（与 records store 同红线）。
 */
export function appendMemory(
  memoryDir: string,
  expertId: string,
  text: string,
  logger: Logger = defaultLogger
): void {
  const safe = redactPII(text).trim().slice(0, MEMORY_TEXT_MAX_CHARS);
  if (safe === "") return;
  const entry: MemoryEntry = { ts: new Date().toISOString(), text: safe };
  try {
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    appendFileSync(
      path.join(memoryDir, `${expertId}.jsonl`),
      `${JSON.stringify(entry)}\n`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[memory] 写入 ${expertId} 记忆失败: ${msg}`);
  }
}

/**
 * 构建注入该专家 prompt 的记忆块。空条目 → 空串（零字节注入红线）；
 * 否则取最近 N 条（旧→新排列，与讨论时间线一致），超预算从最旧开始丢。
 */
export function buildMemoryBlock(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const recent = entries.slice(-MEMORY_MAX_ENTRIES);
  const render = (list: MemoryEntry[]): string => {
    const lines = ["【你的历史记忆（来自过往讨论的沉淀，供参考，可能有误）】"];
    for (const e of list) {
      lines.push(`- ${e.text}（${e.ts.slice(0, 10)}）`);
    }
    return lines.join("\n");
  };
  let block = render(recent);
  while (
    block.length > MEMORY_BLOCK_MAX_CHARS &&
    recent.length > 1
  ) {
    recent.shift();
    block = render(recent);
  }
  return block;
}

/**
 * 从专家发言中解析「记忆：」行（harvest）。
 * 只认**最后一个**行首「记忆：」/「记忆:」（防正文多次提及造成歧义）；
 * 未命中 → content 原样返回（零改动）。返回剥离后的正文与记忆文本。
 */
export function parseMemoryLine(content: string): {
  content: string;
  memory: string | null;
} {
  const lines = content.split("\n");
  let hit = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trimStart();
    if (l.startsWith("记忆：") || l.startsWith("记忆:")) {
      hit = i;
      break;
    }
  }
  if (hit === -1) return { content, memory: null };
  const memory = lines[hit]!.trimStart().replace(/^记忆[：:]/, "").trim();
  const rest = lines
    .slice(0, hit)
    .concat(lines.slice(hit + 1))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return { content: rest, memory: memory === "" ? null : memory };
}

/** 清空某专家记忆（admin DELETE 用）。文件不存在返回 false（404 语义）。 */
export function clearExpertMemory(memoryDir: string, expertId: string): boolean {
  const file = path.join(memoryDir, `${expertId}.jsonl`);
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
