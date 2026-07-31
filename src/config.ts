/**
 * 配置加载 —— 对应 design.md §4/§7/§8。
 *
 * 流程：dotenv 加载 .env → 读取 experts.json → zod 校验 → defaults 合并 →
 *       解析 provider 引用与 API key 状态。
 *
 * 策略（design.md §7）：
 * - 校验失败 / 专家引用了不存在的 provider / 专家列表为空 → 打印所有无效条目后 process.exit(1)
 * - 某 provider 的 apiKeyEnv 环境变量缺失 → 仅警告，不退出；
 *   调用对应专家时由 resolveProviderCredentials 抛错（其他专家不受影响）
 * - API key 只从环境变量读取，experts.json 中只存环境变量名（apiKeyEnv 间接引用）
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

import type { AppConfig, ExpertConfig, ProviderConfig, ProviderCredentials } from "./types.js";

// ---------------------------------------------------------------------------
// zod schemas（描述 experts.json 的原始文件形态；专家字段允许缺省以承接 defaults）
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

const defaultsSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const expertSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "专家 id 只能包含字母、数字、连字符与下划线"),
  name: z.string().min(1),
  icon: z.string().min(1),
  systemPrompt: z.string().min(1),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

const expertsFileSchema = z.object({
  $schema: z.string().optional(),
  defaults: defaultsSchema.optional(),
  providers: z.record(z.string().min(1), providerSchema),
  experts: z.array(expertSchema),
});

type ExpertsFileParsed = z.infer<typeof expertsFileSchema>;

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** 是否跳过 dotenv 加载（默认 false；测试时可置 true 避免读取本地 .env） */
  skipDotenv?: boolean;
}

/**
 * 加载并校验专家配置。
 *
 * @param configPath 配置文件路径；缺省依次取 TALKIO_EXPERTS_CONFIG 环境变量、
 *                   进程 cwd 下的 experts.json
 * @returns 已合并 defaults 的 AppConfig
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

  // ---- zod 校验（打印所有无效条目） ----
  const parsed = expertsFileSchema.safeParse(rawJson);
  if (!parsed.success) {
    console.error(`[config] 配置文件校验失败 ${resolvedPath}，共 ${parsed.error.issues.length} 处问题：`);
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      console.error(`  - ${where}: ${issue.message}`);
    }
    process.exit(1);
  }

  const file = parsed.data;
  const fatalErrors: string[] = [];

  // ---- experts 非空检查 ----
  if (file.experts.length === 0) {
    fatalErrors.push("experts 数组为空：至少需要定义一个专家");
  }

  // ---- 专家 id 唯一性检查 ----
  const seenIds = new Set<string>();
  for (const expert of file.experts) {
    if (seenIds.has(expert.id)) {
      fatalErrors.push(`专家 id "${expert.id}" 重复定义`);
    }
    seenIds.add(expert.id);
  }

  // ---- 语义检查 + defaults 合并 ----
  const experts: ExpertConfig[] = [];
  for (const expert of file.experts) {
    const merged = mergeExpert(expert, file.defaults, fatalErrors);
    if (merged) {
      experts.push(merged);
    }
  }

  // ---- provider 表（zod 已校验结构，直接可用） ----
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, provider] of Object.entries(file.providers)) {
    providers[name] = provider;
  }

  if (fatalErrors.length > 0) {
    console.error(`[config] 配置文件存在 ${fatalErrors.length} 处致命问题 ${resolvedPath}：`);
    for (const msg of fatalErrors) {
      console.error(`  - ${msg}`);
    }
    process.exit(1);
  }

  // ---- API key 状态检查（仅警告，不退出；design.md §7 惰性检测策略） ----
  warnMissingApiKeys(providers, experts);

  return { providers, experts };
}

/** 将 defaults 合并进专家配置；缺失必填字段时记录致命错误并返回 null */
function mergeExpert(
  expert: ExpertsFileParsed["experts"][number],
  defaults: ExpertsFileParsed["defaults"],
  fatalErrors: string[]
): ExpertConfig | null {
  const provider = expert.provider ?? defaults?.provider;
  const model = expert.model ?? defaults?.model;
  const temperature = expert.temperature ?? defaults?.temperature;
  const maxTokens = expert.maxTokens ?? defaults?.maxTokens;
  const timeoutMs = expert.timeoutMs ?? defaults?.timeoutMs;

  const missing: string[] = [];
  if (!provider) missing.push("provider");
  if (!model) missing.push("model");
  if (temperature === undefined) missing.push("temperature");
  if (maxTokens === undefined) missing.push("maxTokens");
  if (timeoutMs === undefined) missing.push("timeoutMs");

  if (missing.length > 0) {
    fatalErrors.push(
      `专家 "${expert.id}" 缺少必填字段且无 defaults 兜底: ${missing.join(", ")}`
    );
    return null;
  }

  return {
    id: expert.id,
    name: expert.name,
    icon: expert.icon,
    systemPrompt: expert.systemPrompt,
    provider: provider as string,
    model: model as string,
    temperature: temperature as number,
    maxTokens: maxTokens as number,
    timeoutMs: timeoutMs as number,
    enabled: expert.enabled,
  };
}

/** 检查 provider 引用有效性与 API key 存在性；引用无效为致命错误，key 缺失仅警告 */
function warnMissingApiKeys(
  providers: Record<string, ProviderConfig>,
  experts: ExpertConfig[]
): void {
  const referencedProviders = new Set(experts.map((e) => e.provider));

  // 专家引用了不存在的 provider → 致命（由调用方打印后退出）
  const fatal: string[] = [];
  for (const name of referencedProviders) {
    if (!providers[name]) {
      fatal.push(
        `专家引用了未定义的 provider "${name}"（providers 表已定义: ${Object.keys(providers).join(", ") || "无"}）`
      );
    }
  }
  if (fatal.length > 0) {
    console.error(`[config] 配置文件存在 ${fatal.length} 处致命问题：`);
    for (const msg of fatal) {
      console.error(`  - ${msg}`);
    }
    process.exit(1);
  }

  // key 缺失 → 仅警告；运行时调用该 provider 的专家时才报错
  for (const name of referencedProviders) {
    const provider = providers[name];
    if (provider && !process.env[provider.apiKeyEnv]) {
      console.error(
        `[config] 警告: provider "${name}" 的环境变量 ${provider.apiKeyEnv} 未设置，` +
          `使用该 provider 的专家调用将失败（不影响其他专家）`
      );
    }
  }
}

/**
 * 按专家解析 provider 凭据（运行时惰性解析，design.md §7）。
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
