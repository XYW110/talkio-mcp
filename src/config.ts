/**
 * 配置加载 —— 对应 design.md §3/§7。
 *
 * 流程：dotenv 加载 .env → 读取 experts.json → 检测旧格式并自动迁移（备份 .bak + 写回）
 *       → zod 校验三段结构（providers / experts / models / cards）→ 引用完整性校验
 *       → 解析 provider 引用与 API key 状态。
 *
 * 策略（design.md §3/§7）：
 * - 校验失败 / 引用不存在的 provider / 模型或专家 / cards 为空 → 打印所有无效条目后 process.exit(1)
 * - 某 provider 的 apiKeyEnv 环境变量缺失 → 仅警告，不退出；
 *   调用对应角色卡时由 resolveProviderCredentials 抛错（其他卡不受影响）
 * - API key 只从环境变量读取，experts.json 中只存环境变量名（apiKeyEnv 间接引用）
 * - 迁移幂等：新格式文件不会被二次迁移
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

import type {
  AppConfig,
  CardConfig,
  ExpertConfig,
  ModelConfig,
  ProviderConfig,
  ProviderCredentials,
} from "./types.js";

// ---------------------------------------------------------------------------
// zod schemas（描述 experts.json 的新三段结构）
// ---------------------------------------------------------------------------

const providerTypeSchema = z.enum(["openai", "anthropic", "openai-compatible"]);

const providerSchema = z.object({
  type: providerTypeSchema,
  baseUrl: z.string().url().min(1),
  apiKeyEnv: z
    .string()
    .min(1)
    .regex(/^[A-Z_][A-Z0-9_]*$/i, "apiKeyEnv 必须是合法的环境变量名"),
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
});

const expertsFileSchema = z.object({
  $schema: z.string().optional(),
  providers: z.record(z.string().min(1), providerSchema),
  experts: z.array(expertSchema),
  models: z.array(modelSchema).default([]),
  cards: z.array(cardSchema).default([]),
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
async function writeMigratedConfig(resolvedPath: string, migrated: unknown): Promise<void> {
  const backupPath = `${resolvedPath}.bak`;
  try {
    await copyFile(resolvedPath, backupPath);
    await writeFile(
      resolvedPath,
      JSON.stringify(migrated, null, 2) + "\n",
      "utf-8"
    );
    console.error(`[config] 检测到旧格式配置，已自动迁移为三段结构（experts / models / cards）并写回`);
    console.error(`[config] 迁移前备份: ${backupPath}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
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
    console.error(`[config] 无法读取配置文件 ${resolvedPath}: ${reason}`);
    process.exit(1);
  }

  // ---- 解析 JSON ----
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[config] 配置文件不是合法 JSON ${resolvedPath}: ${reason}`);
    process.exit(1);
  }

  // ---- 旧格式迁移（幂等；写前备份 .bak） ----
  if (isLegacyExpertsFile(rawJson)) {
    const migrated = migrateLegacyConfig(rawJson);
    await writeMigratedConfig(resolvedPath, migrated);
    rawJson = migrated;
  }

  // ---- zod 校验（打印所有无效条目） ----
  const parsed = expertsFileSchema.safeParse(rawJson);
  if (!parsed.success) {
    console.error(
      `[config] 配置文件校验失败 ${resolvedPath}，共 ${parsed.error.issues.length} 处问题：`
    );
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      console.error(`  - ${where}: ${issue.message}`);
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

  if (fatalErrors.length > 0) {
    console.error(
      `[config] 配置文件存在 ${fatalErrors.length} 处致命问题 ${resolvedPath}：`
    );
    for (const msg of fatalErrors) {
      console.error(`  - ${msg}`);
    }
    process.exit(1);
  }

  // ---- API key 状态检查（仅警告，不退出；design.md §7 惰性检测策略） ----
  warnMissingApiKeys(file.providers, file.models);

  return {
    providers: file.providers,
    experts: file.experts,
    models: file.models,
    cards: file.cards,
  };
}

/** 检查各 provider 的 API key 存在性；缺失仅警告（运行时惰性抛错）。 */
function warnMissingApiKeys(
  providers: Record<string, ProviderConfig>,
  models: ModelConfig[]
): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.providerId)) continue;
    seen.add(model.providerId);
    const provider = providers[model.providerId];
    if (provider && !process.env[provider.apiKeyEnv]) {
      console.error(
        `[config] 警告: provider "${model.providerId}" 的环境变量 ${provider.apiKeyEnv} 未设置，` +
          `使用该 provider 的角色卡调用将失败（不影响其他卡）`
      );
    }
  }
}

/**
 * 按 provider 名解析凭据（运行时惰性解析，design.md §7）。
 *
 * @throws {Error} provider 不存在或对应环境变量缺失：
 *   "Provider X: missing env var Y"
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

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Provider ${providerName}: missing env var ${provider.apiKeyEnv}`);
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
