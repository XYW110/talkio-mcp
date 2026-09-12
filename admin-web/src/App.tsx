import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { CardConfig, ConfigFile, Expert, ModelConfig, ProviderConfig } from "./types";
import { ExpertsPage } from "./pages/ExpertsPage";
import { ExpertEditPage } from "./pages/ExpertEditPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { ModelsPage } from "./pages/ModelsPage";
import { CardsPage } from "./pages/CardsPage";
import { RecordsPage } from "./pages/RecordsPage";
import { ChatPage } from "./pages/ChatPage";
import { ChevronRow, SectionLabel, Card } from "./components/ui";

const EMPTY: ConfigFile = {
  providers: {},
  experts: [],
  models: [],
  cards: [],
};

type Page =
  | { name: "settings" }
  | { name: "experts" }
  | { name: "provider" }
  | { name: "models" }
  | { name: "cards" }
  | { name: "records" }
  | { name: "chat" };

function ErrorBanner({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="fixed top-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-xl bg-bad px-4 py-2.5 text-on-solid shadow-lg">
      <span className="text-sm">{msg}</span>
      <button onClick={onClose} className="opacity-80 hover:opacity-100">
        ✕
      </button>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<ConfigFile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState<Page>({ name: "settings" });
  const [editing, setEditing] = useState<Expert | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const cfg = await api.getConfig();
      setConfig({
        providers: cfg.providers ?? {},
        experts: cfg.experts ?? [],
        models: cfg.models ?? [],
        cards: cfg.cards ?? [],
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upsertExpert = useCallback((expert: Expert) => {
    setConfig((prev) => {
      const idx = prev.experts.findIndex((e) => e.id === expert.id);
      const experts =
        idx >= 0
          ? prev.experts.map((e, i) =>
              i === idx
                ? { ...expert, builtin: e.builtin ?? expert.builtin ?? false }
                : e,
            )
          : [...prev.experts, { ...expert, builtin: expert.builtin ?? false }];
      return { ...prev, experts };
    });
    setDirty(true);
  }, []);

  /** 批量删除专家（内置专家跳过并提示）。级联删掉引用它们的角色卡。 */
  const deleteExperts = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      const blocked = config.experts.filter((e) => idSet.has(e.id) && e.builtin);
      if (blocked.length > 0) {
        window.alert(`内置专家不可删除：${blocked.map((e) => e.name).join("、")}`);
      }
      const deletable = new Set(
        config.experts.filter((e) => idSet.has(e.id) && !e.builtin).map((e) => e.id),
      );
      if (deletable.size === 0) return;
      setConfig((prev) => {
        // 专家删除后，级联删掉引用它的角色卡
        const cards = prev.cards.filter((c) => !deletable.has(c.expertId));
        return { ...prev, experts: prev.experts.filter((e) => !deletable.has(e.id)), cards };
      });
      setDirty(true);
    },
    [config.experts],
  );

  const deleteExpert = useCallback((id: string) => deleteExperts([id]), [deleteExperts]);

  const upsertProvider = useCallback((name: string, provider: ProviderConfig) => {
    setConfig((prev) => ({ ...prev, providers: { ...prev.providers, [name]: provider } }));
    setDirty(true);
  }, []);

  /** 批量删除 provider。级联删掉其下的模型，以及引用被删模型的角色卡。 */
  const deleteProviders = useCallback((names: string[]) => {
    const nameSet = new Set(names);
    setConfig((prev) => {
      const providers = Object.fromEntries(
        Object.entries(prev.providers).filter(([k]) => !nameSet.has(k)),
      );
      // 级联清理：models 按 providerId 过滤，cards 引用被删模型的也一并清理
      const models = prev.models.filter((m) => !nameSet.has(m.providerId));
      const modelIds = new Set(models.map((m) => m.id));
      const cards = prev.cards.filter((c) => modelIds.has(c.modelId));
      return { ...prev, providers, models, cards };
    });
    setDirty(true);
  }, []);

  const deleteProvider = useCallback(
    (name: string) => deleteProviders([name]),
    [deleteProviders],
  );

  // ── 模型 CRUD（供 ModelsPage 调用）──
  const upsertModel = useCallback((model: ModelConfig) => {
    setConfig((prev) => {
      const idx = prev.models.findIndex((m) => m.id === model.id);
      const models =
        idx >= 0
          ? prev.models.map((m, i) => (i === idx ? model : m))
          : [...prev.models, model];
      return { ...prev, models };
    });
    setDirty(true);
  }, []);

  /** 批量删除模型。级联删掉引用它们的角色卡。 */
  const deleteModels = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setConfig((prev) => {
      // 模型删除后，级联删掉引用它的角色卡
      const cards = prev.cards.filter((c) => !idSet.has(c.modelId));
      return { ...prev, models: prev.models.filter((m) => !idSet.has(m.id)), cards };
    });
    setDirty(true);
  }, []);

  const deleteModel = useCallback((id: string) => deleteModels([id]), [deleteModels]);

  // ── 角色卡 CRUD（供 CardsPage 调用）──
  const upsertCard = useCallback((card: CardConfig) => {
    setConfig((prev) => {
      const idx = prev.cards.findIndex((c) => c.id === card.id);
      const cards =
        idx >= 0
          ? prev.cards.map((c, i) => (i === idx ? card : c))
          : [
              ...prev.cards,
              { ...card, isDefault: prev.cards.length === 0 ? true : card.isDefault },
            ];
      return { ...prev, cards };
    });
    setDirty(true);
  }, []);

/** 删除角色卡（可批量）。被删掉默认卡时，自动把剩余第一张提升为默认。 */
  const deleteCards = useCallback((ids: string[]) => {
    setConfig((prev) => {
      const idSet = new Set(ids);
      const remaining = prev.cards.filter((c) => !idSet.has(c.id));
      if (remaining.length === prev.cards.length) return prev; // 没有真正删掉任何卡
      // 默认卡被删且还有剩余卡：把第一张提升为默认
      const lostDefault = prev.cards.some((c) => c.isDefault && idSet.has(c.id));
      const cards =
        lostDefault && remaining.length > 0
          ? remaining.map((c, i) => (i === 0 ? { ...c, isDefault: true } : c))
          : remaining;
      return { ...prev, cards };
    });
    setDirty(true);
  }, []);

  const deleteCard = useCallback(
    (id: string) => deleteCards([id]),
    [deleteCards],
  );

  const toggleCard = useCallback((id: string) => {
    setConfig((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
    }));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    try {
      const result = await api.saveConfig(config);
      if (!result.ok) {
        setError(result.error || "保存失败");
        return false;
      }
      setDirty(false);
      if (result.restartRequired) {
        setError("已保存。MCP server 需重启后新配置才生效（重启 talkio-mcp 进程）。");
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [config]);

const providers = Object.entries(config.providers) as [string, ProviderConfig][];

  // ── 首页菜单项（手机端分组列表 / 桌面端卡片网格共用）──
  const MENU_ITEMS: {
    page: Page;
    icon: string;
    title: string;
    count: number;
    unit: string;
    subtitle: string;
  }[] = [
    {
      page: { name: "experts" },
      icon: "🤖",
      title: "专家",
      count: config.experts.length,
      unit: "位",
      subtitle: "管理 AI 专家：人设、参数",
    },
    {
      page: { name: "provider" },
      icon: "🔌",
      title: "Provider",
      count: providers.length,
      unit: "个",
      subtitle: "配置 API 端点与 key 环境变量",
    },
    {
      page: { name: "models" },
      icon: "🧠",
      title: "模型",
      count: config.models.length,
      unit: "个",
      subtitle: "管理各 Provider 下的模型引擎",
    },
{
      page: { name: "cards" },
      icon: "🎴",
      title: "角色卡",
      count: config.cards.length,
      unit: "张",
      subtitle: "专家 + 模型 绑定成一张角色卡",
    },
{
      page: { name: "records" },
      icon: "🗂️",
      title: "会话记录",
      count: 0,
      unit: "",
      subtitle: "查看 consult / brainstorm 调用留痕",
    },
    {
      page: { name: "chat" },
      icon: "🚀",
      title: "发起群聊",
      count: 0,
      unit: "",
      subtitle: "填话题让多位专家开会讨论",
    },
  ];

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-[13px] text-ink-dim">
        正在加载配置…
      </div>
    );
  }

  // ── 编辑浮层（全屏页）──
const editOverlay = editing && (
    <div className="fixed inset-0 z-40 bg-canvas md:flex md:items-center md:justify-center md:bg-black/30 md:p-6">
      <ExpertEditPage
        initial={editing === "new" ? undefined : editing}
        onSave={upsertExpert}
        onClose={() => setEditing(null)}
      />
    </div>
  );

  // ── Page content ──
  let content: React.ReactNode;
  if (page.name === "experts") {
    content = (
      <ExpertsPage
        experts={config.experts}
        onAdd={() => setEditing("new")}
        onEdit={(id) => {
          const ex = config.experts.find((e) => e.id === id);
          if (ex) setEditing(ex);
        }}
        onDelete={deleteExpert}
        onDeleteMany={deleteExperts}
      />
    );
  } else if (page.name === "provider") {
    content = (
      <ProvidersPage
        providers={providers}
        onUpsert={upsertProvider}
        onDelete={deleteProvider}
        onDeleteMany={deleteProviders}
      />
    );
  } else if (page.name === "models") {
    content = (
      <ModelsPage
        models={config.models}
        providers={providers}
        onUpsert={upsertModel}
        onDelete={deleteModel}
        onDeleteMany={deleteModels}
      />
    );
  } else if (page.name === "cards") {
    content = (
      <CardsPage
        cards={config.cards}
        experts={config.experts}
        models={config.models}
        providers={providers}
        onUpsert={upsertCard}
        onDelete={deleteCard}
        onDeleteMany={deleteCards}
        onToggle={toggleCard}
      />
    );
  } else if (page.name === "records") {
    content = <RecordsPage onBack={() => setPage({ name: "settings" })} />;
  } else if (page.name === "chat") {
    content = <ChatPage cards={config.cards} />;
  } else {
    content = (
<div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 pb-6 pt-4 md:max-w-none md:px-6">
        <div className="pb-2">
          <h1 className="text-[20px] font-bold tracking-tight text-ink">Talkio 管理</h1>
          <p className="mt-0.5 text-[13px] text-ink-dim">
            配置你的 AI 专家、模型与角色卡
          </p>
        </div>

        <SectionLabel>配置</SectionLabel>
        {/* 手机端：岛内分组列表 */}
        <div className="md:hidden">
          <Card>
            {MENU_ITEMS.map((m, i) => (
              <ChevronRow
                key={m.title}
                onClick={() => setPage(m.page)}
                icon={<span className="text-xl">{m.icon}</span>}
                title={m.title}
                detail={
                  m.unit !== "" ? (
                    <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] text-ink-dim">
                      {m.count} {m.unit}
                    </span>
                  ) : undefined
                }
                subtitle={m.subtitle}
                isLast={i === MENU_ITEMS.length - 1}
              />
            ))}
          </Card>
        </div>
        {/* 桌面端（md+）：卡片网格 */}
<div className="hidden md:grid md:grid-cols-2 md:gap-3 lg:grid-cols-4">
          {MENU_ITEMS.map((m) => (
            <button
              key={m.title}
              onClick={() => setPage(m.page)}
              className="flex flex-col gap-2 rounded-xl border border-line bg-island-strong p-4 text-left shadow-sm transition-colors hover:bg-hover active:bg-pressed"
            >
              <div className="flex items-center justify-between">
                <span className="text-2xl">{m.icon}</span>
                {m.unit !== "" && (
                  <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] text-ink-dim">
                    {m.count} {m.unit}
                  </span>
                )}
              </div>
              <div>
                <p className="text-[16px] font-semibold text-ink">{m.title}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-dim">{m.subtitle}</p>
              </div>
            </button>
          ))}
        </div>

        {/* Save bar — 手机端仅在首页显示；桌面端保存按钮在侧边栏 */}
        <div className="mt-8 flex items-center gap-2 md:hidden">
          {dirty && (
            <span className="rounded-full bg-warn-bg px-3 py-1 text-xs font-medium text-warn-text">
              有未保存的修改
            </span>
          )}
          <button
            onClick={save}
            disabled={!dirty}
            className="flex-1 rounded-xl bg-ink px-4 py-2.5 text-[14px] font-semibold text-on-solid transition active:bg-ink-mid disabled:cursor-not-allowed disabled:opacity-40"
          >
            保存配置
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-ink-faint">
          保存后需重启 MCP server，新配置才生效
        </p>
      </div>
    </div>
  );
  }

  return (
    // snow-app 布局：灰画布 + 呼吸边距，桌面端「侧栏岛 + 内容岛」，手机端「顶栏岛 + 内容岛」
    <div className="relative flex h-screen w-full flex-col gap-2.5 bg-canvas p-2.5 md:flex-row">
      {error && <ErrorBanner msg={error} onClose={() => setError(null)} />}

      {/* PC：左侧悬浮岛导航（手机端不渲染） */}
      <PcSidebar
        page={page}
        onNavigate={setPage}
        menuItems={MENU_ITEMS}
        dirty={dirty}
        onSave={save}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {/* 手机端顶栏岛（返回）—— records 自管理导航（列表↔详情），不重复渲染 */}
        {page.name !== "settings" && page.name !== "records" && (
          <div className="island island-strong flex flex-shrink-0 items-center px-3 py-2.5 md:hidden">
            <button
              onClick={() => setPage({ name: "settings" })}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium text-info-text active:bg-pressed"
            >
              <span className="text-[16px] leading-none">‹</span>
              <span>返回总览</span>
            </button>
          </div>
        )}

        {/* 内容岛：桌面端始终是岛；手机端 settings 页自身即首页，直接铺 */}
        <div
          className={
            page.name === "settings" || page.name === "records"
              ? "min-h-0 flex-1 overflow-hidden"
              : "island island-strong min-h-0 flex-1 overflow-hidden"
          }
        >
          {content}
        </div>
      </div>
      {editOverlay}
    </div>
  );
}

// ── PC 独立版布局：左侧固定侧边栏（md+ 显示，手机端完全隐藏）──

function PcSidebar({
  page,
  onNavigate,
  menuItems,
  dirty,
  onSave,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
  menuItems: {
    page: Page;
    icon: string;
    title: string;
    count: number;
    unit: string;
    subtitle: string;
  }[];
  dirty: boolean;
  onSave: () => void;
}) {
  const navItems = [
    { page: { name: "settings" } as Page, icon: "🏠", title: "总览", count: 0, unit: "" },
    ...menuItems,
  ];
  return (
    <aside className="island island-muted hidden w-[248px] flex-shrink-0 flex-col md:flex">
      {/* 品牌区 */}
      <div className="border-b border-line px-5 py-4">
        <p className="text-[15px] font-bold tracking-tight text-ink">💬 Talkio 管理</p>
        <p className="mt-0.5 text-[12px] text-ink-faint">AI 专家 · 模型 · 角色卡</p>
      </div>

      {/* 导航项 */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-3">
        {navItems.map((item) => {
          const active = page.name === item.page.name;
          return (
            <button
              key={item.title}
              onClick={() => onNavigate(item.page)}
              className={`mb-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                active
                  ? "nav-item-active bg-info-bg font-medium text-ink"
                  : "text-ink-mid hover:bg-hover"
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              <span className="flex-1 text-[13px]">{item.title}</span>
              {item.unit !== "" && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    active ? "bg-info-bg text-info-text" : "bg-hover text-ink-dim"
                  }`}
                >
                  {item.count} {item.unit}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* 底部保存区 */}
      <div className="border-t border-line px-4 py-3">
        <button
          onClick={onSave}
          disabled={!dirty}
          className="w-full rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-on-solid transition hover:bg-ink-mid disabled:cursor-not-allowed disabled:opacity-40"
        >
          {dirty ? "保存配置 ●" : "保存配置"}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-ink-faint">
          {dirty ? "有未保存的修改" : "保存后需重启 MCP server 生效"}
        </p>
      </div>
    </aside>
  );
}