/**
 * 信号路由（task 09-13-council-enhancement-p2 / P2-A）。
 *
 * 把问题/主题文本（小写化）对内置中英双语关键词表做子串匹配 → 命中信号组 →
 * 取「enabled 且 signals 有交集（或声明 general）」的角色卡。
 *
 * 本模块是 SIGNAL_GROUPS 值域的后端唯一来源：
 * - src/config.ts 的 zod（cardSchema.signals）用 z.enum(SIGNAL_GROUPS) 校验 experts.json；
 * - admin-web/src/types.ts 维护一份常量副本 + 中文显示名（两处注释互指，需人工保持同步）。
 *
 * 仅做纯文本匹配与卡筛选，不发起任何网络调用。
 */
import type { AppConfig, CardConfig } from "../types.js";

/** 内置信号组：id 即 CardConfig.signals 的合法值（与 admin-web/src/types.ts 的副本同步） */
export const SIGNAL_GROUPS = [
  "sql-data",
  "security",
  "infra",
  "ml",
  "api",
  "frontend",
  "cost",
  "pipeline",
  "writing",
  "general",
] as const;

export type SignalId = (typeof SIGNAL_GROUPS)[number];

/** 关键词 → 信号组（中英双语，子串匹配；英文统一小写，中文原样；匹配前对文本做 toLowerCase()） */
export const SIGNAL_KEYWORDS: Record<SignalId, string[]> = {
  "sql-data": ["sql", "数据库", "表结构", "索引", "查询优化", "migration", "schema"],
  security: ["安全", "鉴权", "权限", "加密", "漏洞", "注入", "auth", "security", "secret"],
  infra: ["部署", "运维", "容器", "k8s", "kubernetes", "docker", "devops", "infra", "服务器"],
  ml: ["模型", "训练", "推理", "embedding", "向量", "机器学习", "llm", "prompt", "rag"],
  api: ["接口", "api", "rest", "graphql", "rpc", "webhook", "集成"],
  frontend: ["前端", "ui", "界面", "组件", "react", "vue", "css", "页面", "样式"],
  cost: ["成本", "费用", "预算", "计费", "token 用量", "省钱", "cost", "billing"],
  pipeline: ["流水线", "ci", "cd", "构建", "发布", "pipeline", "workflow"],
  writing: ["文案", "写作", "文档", "博客", "翻译", "润色", "readme"],
  // 兜底信号组：卡可声明 general 表示「任意话题可参与」，不要求关键词命中
  general: [],
};

/**
 * 对文本做信号匹配：小写化后按 SIGNAL_KEYWORDS 逐组子串匹配，
 * 返回命中的信号组（保持表序）。general 永不通过关键词命中。
 */
export function matchSignals(text: string): SignalId[] {
  const lowered = text.toLowerCase();
  const matched: SignalId[] = [];
  for (const group of SIGNAL_GROUPS) {
    if (group === "general") continue;
    const keywords = SIGNAL_KEYWORDS[group] ?? [];
    if (keywords.some((kw) => lowered.includes(kw))) {
      matched.push(group);
    }
  }
  return matched;
}

/** selectCardsBySignals 的命中结果：命中信号组 + 候选卡（文件序，含禁用剔除）。 */
export interface SignalMatch {
  matched: SignalId[];
  cards: CardConfig[];
}

/**
 * 信号路径选卡（卡级别，纯函数）：
 * - matched = matchSignals(text)
 * - 候选 = enabled 卡中「signals 与 matched 有交集」或「声明 general（任意话题可参与）」的卡，保持文件序
 * - 零命中（无关键词命中且无 general 卡，或命中但无候选卡）→ null，由调用方回退默认卡
 *
 * 不做 key 检查与截断——由 select-cards.ts 的调用方统一处理。
 */
export function selectCardsBySignals(
  config: AppConfig,
  text: string
): SignalMatch | null {
  const matched = matchSignals(text);
  const cards = config.cards.filter((c) => {
    if (c.enabled === false) return false;
    const signals = c.signals ?? [];
    if (signals.includes("general")) return true;
    return signals.some((s) => matched.includes(s));
  });
  if (matched.length === 0 && cards.length === 0) return null;
  // 关键词命中了信号组但没有任何候选卡 → 同样视为零命中
  if (cards.length === 0) return null;
  return { matched, cards };
}
