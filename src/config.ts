/**
 * 配置加载 —— 对应 design.md §3/§7。
 *
 * 流程：dotenv 加载 .env → 读取 experts.json → 检测旧格式并自动迁移（备份 .bak + 写回）
 *       → zod 校验三段结构（providers / experts / models / cards）→ 引用完整性校验。
 *
 * 策略（design.md §3/§7 + 任务 09-30-provider-keys-ui）：
 * - 校验失败 / 引用不存在的 provider / 模型或专家 / cards 为空 → 打印所有无效条目后 process.exit(1)
 * - 渠道 API key 不再来自环境变量：resolveProviderCredentials 从 keys store
 *   （keys.json，见 src/keys/store.ts）解析，缺失即抛 missing key（fail-closed，
 *   其他卡不受影响）；experts.json 遗留 apiKeyEnv 字段宽容忽略（0.2.0 回滚兼容）
 * - validateExpertsFile 是 loadConfig 的纯校验核心（无 IO / 无 exit），
 *   admin PUT /api/config 写盘前用它校验（非法 → 400，磁盘不落脏数据）
 * - 迁移幂等：新格式文件不会被二次迁移
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

import { getKeysStore } from "./keys/store.js";
import type {
  AppConfig,
  CardConfig,
  ExpertConfig,
  ModelConfig,
  ProviderConfig,
  ProviderCredentials,
} from "./types.js";
import { SIGNAL_GROUPS } from "./tools/signal-routing.js";
import { defaultLogger, type Logger } from "./utils/log.js";

/**
 * 工具开关（P2-B）保护名单与已知工具表：
 * - PROTECTED_TOOLS：核心工具，disabledTools 中出现即 loadConfig 失败；
 * - KNOWN_TOOLS：全部可注册的工具名，disabledTools 含未知名字 → loadConfig 失败。
 * server.ts 新增/删除工具时必须同步维护 KNOWN_TOOLS。
 */
export const PROTECTED_TOOLS = ["list_cards", "consult_experts", "brainstorm"] as const;
export const KNOWN_TOOLS = [...PROTECTED_TOOLS, "brainstorm_followup"] as const;

// ---------------------------------------------------------------------------
// zod schemas（描述 experts.json 的新三段结构）
// ---------------------------------------------------------------------------

const providerTypeSchema = z.enum(["openai", "anthropic", "openai-compatible"]);

const providerSchema = z.object({
  type: providerTypeSchema,
  baseUrl: z.string().url().min(1),
  // 遗留字段（0.2.0 及更早 env 方案的环境变量名）：宽容接受、不再校验、不再使用。
  // 真实密钥现从 keys.json 解析（src/keys/store.ts）；保留解析能力是为了
  // 旧 experts.json 直接加载不报错，且字段原样透传保住 0.2.0 回滚锚。
  apiKeyEnv: z.string().optional(),
});

const idRegex = /^[a-z0-9][a-z0-9_-]*$/i;

const expertSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(idRegex, "专家 id 只能包含字母、数字、连字符与下划线"),
  name: z.string().min(1),
  icon: z.string().min(1),
  systemPrompt: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
  // 可选推理策略（P1-B）：旧 experts.json 无此字段照常加载；非法值报校验错误。
  // 普通 optional（不用 .default）保证缺省时 zod 产物不新增该键，序列化文件保持干净。
  reasoningStrategy: z
    .enum(["systematic", "adversarial", "backward", "default"])
    .optional(),
});

const modelSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(idRegex, "模型 id 只能包含字母、数字、连字符与下划线"),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean().default(true),
  thinkingLevel: z.enum(["high", "medium", "low", "disabled"]).optional(),
  // 可选模型分级（P3-B）：正整数（上限 100 防手滑），仅 admin 展示排序用。
  // 普通 optional 保证缺省时 zod 产物不新增该键。
  tier: z.number().int().positive().max(100).optional(),
});

const cardSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(idRegex, "角色卡 id 只能包含字母、数字、连字符与下划线"),
  name: z.string().min(1),
  expertId: z.string().min(1),
  modelId: z.string().min(1),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().optional(),
  // 可选信号标签（P2-A）：值域 = src/tools/signal-routing.ts 的 SIGNAL_GROUPS 枚举；
  // 旧 experts.json 无此字段照常加载；空数组视为未声明。
  signals: z.array(z.enum(SIGNAL_GROUPS)).optional(),
});

const expertsFileSchema = z.object({
  $schema: z.string().optional(),
  providers: z.record(z.string().min(1), providerSchema),
  experts: z.array(expertSchema),
  models: z.array(modelSchema).default([]),
  cards: z.array(cardSchema).default([]),
  // 可选工具开关（P2-B）：缺省 = 全部工具可用；内容合法性在 loadConfig 专项校验
  // （禁用核心工具 / 未知工具名 → fail fast）。
  disabledTools: z.array(z.string()).optional(),
});

type ExpertsFileParsed = z.infer<typeof expertsFileSchema>;
type ExpertFileRecord = z.infer<typeof expertSchema>;
type ModelFileRecord = z.infer<typeof modelSchema>;
type CardFileRecord = z.infer<typeof cardSchema>;

// ---------------------------------------------------------------------------
// 旧格式迁移
// ---------------------------------------------------------------------------

interface LegacyDefaults {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

interface LegacyExpert {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  enabled?: boolean;
}

/** 真实模型名 → 内部 id 的 slug（只保留字母数字- _）。 */
function slugifyModelName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "model";
}

/**
 * 检测旧格式信号：专家对象带 provider/model 字段，或顶层存在 defaults.provider/model。
 * 新格式（experts/models/cards 三段）不含这些字段。
 */
function isLegacyExpertsFile(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;

  const defaults = obj.defaults as Record<string, unknown> | undefined;
  if (
    defaults &&
    (typeof defaults.provider === "string" || typeof defaults.model === "string")
  ) {
    return true;
  }

  const experts = obj.experts;
  if (Array.isArray(experts)) {
    return experts.some((e) => {
      if (typeof e !== "object" || e === null) return false;
      const rec = e as Record<string, unknown>;
      return (
        typeof rec.provider === "string" || typeof rec.model === "string"
      );
    });
  }
  return false;
}

/**
 * 旧格式 → 三段新结构（纯函数，不落盘）。
 * 规则（design.md §3）：
 * - 按 (provider, model) 去重生成 models，内部 id = `${provider}-${modelSlug}`
 * - 每个专家生成一张卡：id = `${expertId}-${modelId}`，name = `${专家名} · ${displayName}`，
 *   第一张卡标记 isDefault
 * - 专家吸收 temperature/maxTokens/timeoutMs（缺失时用 defaults 兜底）
 */
function migrateLegacyConfig(rawJson: unknown): unknown {
  const raw = rawJson as {
    providers?: Record<string, unknown>;
    experts?: LegacyExpert[];
    defaults?: LegacyDefaults;
  };
  const defaults = raw.defaults ?? {};
  const providers = raw.providers ?? {};

  const modelKey = (provider: string, modelName: string) =>
    `${provider}\u0000${modelName}`;

  const models: ModelFileRecord[] = [];
  const modelByKey = new Map<string, ModelFileRecord>();

  const experts: ExpertFileRecord[] = [];
  for (const e of raw.experts ?? []) {
    const provider = e.provider ?? defaults.provider;
    const modelName = e.model ?? defaults.model;
    if (!provider || !modelName) continue; // 缺引用的旧条目丢弃，由引用完整性校验兜底

    const key = modelKey(provider, modelName);
    let model = modelByKey.get(key);
    if (!model) {
      model = {
        id: `${provider}-${slugifyModelName(modelName)}`,
        providerId: provider,
        modelId: modelName,
        displayName: modelName,
        enabled: true,
      };
      modelByKey.set(key, model);
      models.push(model);
    }

    experts.push({
      id: e.id,
      name: e.name,
      icon: e.icon,
      systemPrompt: e.systemPrompt,
      temperature: e.temperature ?? defaults.temperature ?? 0.7,
      maxTokens: e.maxTokens ?? defaults.maxTokens ?? 2048,
      timeoutMs: e.timeoutMs ?? defaults.timeoutMs ?? 120000,
      enabled: e.enabled ?? true,
      // 旧格式迁移出来的都是用户自建专家，非内置
      builtin: false,
    });
  }

  const cards: CardFileRecord[] = [];
  for (const e of raw.experts ?? []) {
    const provider = e.provider ?? defaults.provider;
    const modelName = e.model ?? defaults.model;
    if (!provider || !modelName) continue;
    const model = modelByKey.get(modelKey(provider, modelName));
    if (!model) continue;
    cards.push({
      id: `${e.id}-${model.id}`,
      name: `${e.name} · ${model.displayName}`,
      expertId: e.id,
      modelId: model.id,
      enabled: true,
      ...(cards.length === 0 ? { isDefault: true } : {}),
    });
  }

  return { providers, experts, models, cards };
}

/** 将迁移结果写回 experts.json（写前先备份 .bak）。失败不致命，仅记录。 */
async function writeMigratedConfig(
  resolvedPath: string,
  migrated: unknown,
  logger: Logger
): Promise<void> {
  const backupPath = `${resolvedPath}.bak`;
  try {
    await copyFile(resolvedPath, backupPath);
    await writeFile(
      resolvedPath,
      JSON.stringify(migrated, null, 2) + "\n",
      "utf-8"
    );
    logger.info(`[config] 检测到旧格式配置，已自动迁移为三段结构（experts / models / cards）并写回`);
    logger.info(`[config] 迁移前备份: ${backupPath}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      `[config] 迁移写回失败（按内存中的新结构继续启动，文件未变更）: ${reason}`
    );
  }
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** 是否跳过 dotenv 加载（默认 false；测试时可置 true 避免读取本地 .env） */
  skipDotenv?: boolean;
  /** 注入 logger；缺省用模块级 defaultLogger（info，与现状可见行为一致） */
  logger?: Logger;
}

/** id 唯一性检查：同一类条目 id 重复为致命错误。 */
function checkUniqueIds(
  items: Array<{ id: string }>,
  kind: string,
  fatalErrors: string[]
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      fatalErrors.push(`${kind} id "${item.id}" 重复定义`);
    }
    seen.add(item.id);
  }
}

/**
 * disabledTools 内容校验（P2-B）：禁用核心保护名单内的工具、或出现未知工具名
 * （不在 KNOWN_TOOLS 表内，常见于拼写错误）都是配置错误，启动即失败。
 */
function validateDisabledTools(
  disabledTools: string[] | undefined,
  fatalErrors: string[]
): void {
  if (!disabledTools || disabledTools.length === 0) return;
  const seen = new Set<string>();
  for (const name of disabledTools) {
    if (seen.has(name)) continue;
    seen.add(name);
    if ((PROTECTED_TOOLS as readonly string[]).includes(name)) {
      fatalErrors.push(
        `disabledTools 不允许禁用核心工具 "${name}"（保护名单: ${PROTECTED_TOOLS.join(", ")}）`
      );
    } else if (!(KNOWN_TOOLS as readonly string[]).includes(name)) {
      fatalErrors.push(
        `disabledTools 含未知工具名 "${name}"（已知工具: ${KNOWN_TOOLS.join(", ")}）`
      );
    }
  }
}

/** 引用完整性：cards→experts/models，models→providers。 */
function validateReferences(
  file: ExpertsFileParsed,
  fatalErrors: string[]
): void {
  const expertIds = new Set(file.experts.map((e) => e.id));
  const modelIds = new Set(file.models.map((m) => m.id));
  const providerNames = new Set(Object.keys(file.providers));

  for (const card of file.cards) {
    if (!expertIds.has(card.expertId)) {
      fatalErrors.push(
        `角色卡 "${card.id}" 引用了不存在的专家 "${card.expertId}"（已定义: ${[...expertIds].join(", ") || "无"}）`
      );
    }
    if (!modelIds.has(card.modelId)) {
      fatalErrors.push(
        `角色卡 "${card.id}" 引用了不存在的模型 "${card.modelId}"（已定义: ${[...modelIds].join(", ") || "无"}）`
      );
    }
  }
  for (const model of file.models) {
    if (!providerNames.has(model.providerId)) {
      fatalErrors.push(
        `模型 "${model.id}" 引用了不存在的 provider "${model.providerId}"（已定义: ${providerNames.size > 0 ? [...providerNames].join(", ") : "无"}）`
      );
    }
  }
}

/**
 * 加载并校验专家/模型/角色卡配置。
 *
 * @param configPath 配置文件路径；缺省依次取 TALKIO_EXPERTS_CONFIG 环境变量、
 *                   进程 cwd 下的 experts.json
 * @returns 已校验的 AppConfig（providers / experts / models / cards）
 *
 * 校验失败时打印所有无效条目到 stderr 并 process.exit(1)（fail fast）。
 */
export async function loadConfig(
  configPath?: string,
  options: LoadConfigOptions = {}
): Promise<AppConfig> {
  const logger = options.logger ?? defaultLogger;

  if (!options.skipDotenv) {
    // 安静加载：.env 不存在不算错误（生产环境可直接注入环境变量）
    dotenvConfig({ quiet: true });
  }

  const resolvedPath = path.resolve(
    configPath ?? process.env.TALKIO_EXPERTS_CONFIG ?? "experts.json"
  );

  // ---- 读取文件 ----
  let rawText: string;
  try {
    rawText = await readFile(resolvedPath, "utf-8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`[config] 无法读取配置文件 ${resolvedPath}: ${reason}`);
    process.exit(1);
  }

  // ---- 解析 JSON ----
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`[config] 配置文件不是合法 JSON ${resolvedPath}: ${reason}`);
    process.exit(1);
  }

  // ---- 旧格式迁移（幂等；写前备份 .bak） ----
  if (isLegacyExpertsFile(rawJson)) {
    const migrated = migrateLegacyConfig(rawJson);
    await writeMigratedConfig(resolvedPath, migrated, logger);
    rawJson = migrated;
  }

  // ---- zod 校验（打印所有无效条目） ----
  const parsed = expertsFileSchema.safeParse(rawJson);
  if (!parsed.success) {
    logger.error(
      `[config] 配置文件校验失败 ${resolvedPath}，共 ${parsed.error.issues.length} 处问题：`
    );
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      logger.error(`  - ${where}: ${issue.message}`);
    }
    process.exit(1);
  }

  const file = parsed.data;
  const fatalErrors: string[] = [];

  // ---- 非空检查（无卡则 MCP 无可用调用目标） ----
  if (file.cards.length === 0) {
    fatalErrors.push("cards 数组为空：至少需要定义一张角色卡");
  }
  if (file.models.length === 0) {
    fatalErrors.push("models 数组为空：至少需要定义一个模型");
  }
  if (file.experts.length === 0) {
    fatalErrors.push("experts 数组为空：至少需要定义一个专家");
  }

  // ---- id 唯一性 ----
  checkUniqueIds(file.experts, "专家", fatalErrors);
  checkUniqueIds(file.models, "模型", fatalErrors);
  checkUniqueIds(file.cards, "角色卡", fatalErrors);

  // ---- 引用完整性 ----
  validateReferences(file, fatalErrors);

  // ---- 工具开关内容校验（核心保护名单 / 未知工具名，fail fast） ----
  validateDisabledTools(file.disabledTools, fatalErrors);

  if (fatalErrors.length > 0) {
    logger.error(
      `[config] 配置文件存在 ${fatalErrors.length} 处致命问题 ${resolvedPath}：`
    );
    for (const msg of fatalErrors) {
      logger.error(`  - ${msg}`);
    }
    process.exit(1);
  }

  // ---- 校验核心（与 admin PUT /api/config 共用；无 IO / 无 exit） ----
  const validation = validateExpertsFile(rawJson);
  if (!validation.ok) {
    logger.error(
      `[config] 配置文件校验失败 ${resolvedPath}，共 ${validation.errors.length} 处问题：`
    );
    for (const msg of validation.errors) {
      logger.error(`  - ${msg}`);
    }
    process.exit(1);
  }
  return validation.config;
}

// ---------------------------------------------------------------------------
// 纯校验核心（admin PUT /api/config 写盘前校验复用）
// ---------------------------------------------------------------------------

export type ConfigValidationResult =
  | { ok: true; config: AppConfig }
  | { ok: false; errors: string[] };

/**
 * 校验 experts.json 内容并产出运行时 AppConfig（loadConfig 的纯校验核心）。
 * 无文件 IO、无 process.exit —— admin PUT /api/config 用它做写盘前校验：
 * 非法 → 400 + 磁盘不落脏数据；合法 → 用返回值替换进程内配置（热生效）。
 */
export function validateExpertsFile(rawJson: unknown): ConfigValidationResult {
  // ---- zod 校验（收集所有无效条目） ----
  const parsed = expertsFileSchema.safeParse(rawJson);
  if (!parsed.success) {
    const errors: string[] = [];
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      errors.push(`${where}: ${issue.message}`);
    }
    return { ok: false, errors };
  }

  const file = parsed.data;
  const fatalErrors: string[] = [];

  // ---- 非空检查（无卡则 MCP 无可用调用目标） ----
  if (file.cards.length === 0) {
    fatalErrors.push("cards 数组为空：至少需要定义一张角色卡");
  }
  if (file.models.length === 0) {
    fatalErrors.push("models 数组为空：至少需要定义一个模型");
  }
  if (file.experts.length === 0) {
    fatalErrors.push("experts 数组为空：至少需要定义一个专家");
  }

  // ---- id 唯一性 ----
  checkUniqueIds(file.experts, "专家", fatalErrors);
  checkUniqueIds(file.models, "模型", fatalErrors);
  checkUniqueIds(file.cards, "角色卡", fatalErrors);

  // ---- 引用完整性 ----
  validateReferences(file, fatalErrors);

  // ---- 工具开关内容校验（核心保护名单 / 未知工具名，fail fast） ----
  validateDisabledTools(file.disabledTools, fatalErrors);

  if (fatalErrors.length > 0) {
    return { ok: false, errors: fatalErrors };
  }

  return {
    ok: true,
    config: {
      providers: file.providers,
      experts: file.experts,
      models: file.models,
      cards: file.cards,
      // 缺省不出键（红线：旧 experts.json 直接加载，不写入新字段）
      ...(file.disabledTools ? { disabledTools: file.disabledTools } : {}),
    },
  };
}

/**
 * 按 provider 名解析凭据（运行时惰性解析，design.md §7）。
 *
 * 密钥来源：keys store（keys.json，网页后台直配、保存即热生效），不读环境变量。
 *
 * @throws {Error} provider 不存在或该渠道未配置 key：
 *   "Provider X: missing key（管理后台-渠道页）"
 */
export function resolveProviderCredentials(
  config: AppConfig,
  providerName: string
): ProviderCredentials {
  const provider = config.providers[providerName];
  if (!provider) {
    throw new Error(
      `Provider "${providerName}" 未在 experts.json 的 providers 表中定义`
    );
  }

  const apiKey = getKeysStore().get(providerName);
  if (!apiKey) {
    throw new Error(
      `Provider ${providerName}: missing key（管理后台-渠道页可配置）`
    );
  }

  return { apiKey, baseUrl: provider.baseUrl };
}

// ---------------------------------------------------------------------------
// 单例缓存（进程内复用；index.ts 启动时调用一次）
// ---------------------------------------------------------------------------

let cachedConfig: AppConfig | undefined;

/** 获取配置单例；首次调用时加载。测试需要重载时请直接调 loadConfig。 */
export async function getConfig(
  configPath?: string,
  options?: LoadConfigOptions
): Promise<AppConfig> {
  cachedConfig ??= await loadConfig(configPath, options);
  return cachedConfig;
}
