import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { CardConfig, ConfigFile, Expert, ModelConfig, ProviderConfig } from "./types";
import { ExpertsPage } from "./pages/ExpertsPage";
import { ExpertEditPage } from "./pages/ExpertEditPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { ModelsPage } from "./pages/ModelsPage";
import { CardsPage } from "./pages/CardsPage";
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
  | { name: "cards" };

function ErrorBanner({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="fixed top-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-xl bg-red-600 px-4 py-2.5 text-white shadow-lg">
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

  const deleteExpert = useCallback(
    (id: string) => {
      const target = config.experts.find((e) => e.id === id);
      if (target?.builtin) {
        window.alert("内置专家不可删除");
        return;
      }
      setConfig((prev) => {
        // 专家删除后，级联删掉引用它的角色卡
        const cards = prev.cards.filter((c) => c.expertId !== id);
        return { ...prev, experts: prev.experts.filter((e) => e.id !== id), cards };
      });
      setDirty(true);
    },
    [config.experts],
  );

  const upsertProvider = useCallback((name: string, provider: ProviderConfig) => {
    setConfig((prev) => ({ ...prev, providers: { ...prev.providers, [name]: provider } }));
    setDirty(true);
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = Object.fromEntries(
        Object.entries(prev.providers).filter(([k]) => k !== name),
      );
      // 级联清理：models 按 providerId 过滤，cards 引用被删模型的也一并清理
      const models = prev.models.filter((m) => m.providerId !== name);
      const modelIds = new Set(models.map((m) => m.id));
      const cards = prev.cards.filter((c) => modelIds.has(c.modelId));
      return { ...prev, providers, models, cards };
    });
    setDirty(true);
  }, []);

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

  const deleteModel = useCallback(
    (id: string) => {
      setConfig((prev) => {
        // 模型删除后，级联删掉引用它的角色卡
        const cards = prev.cards.filter((c) => c.modelId !== id);
        return { ...prev, models: prev.models.filter((m) => m.id !== id), cards };
      });
      setDirty(true);
    },
    [],
  );

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

  const deleteCard = useCallback((id: string) => {
    setConfig((prev) => ({ ...prev, cards: prev.cards.filter((c) => c.id !== id) }));
    setDirty(true);
  }, []);

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
  ];

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-neutral-500">
        正在加载配置…
      </div>
    );
  }

  // ── 编辑浮层（全屏页）──
const editOverlay = editing && (
    <div className="fixed inset-0 z-40 bg-neutral-50 md:flex md:items-center md:justify-center md:bg-black/30 md:p-6">
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
      />
    );
  } else if (page.name === "provider") {
    content = (
      <ProvidersPage
        providers={providers}
        onUpsert={upsertProvider}
        onDelete={deleteProvider}
      />
    );
  } else if (page.name === "models") {
    content = (
      <ModelsPage
        models={config.models}
        providers={providers}
        onUpsert={upsertModel}
        onDelete={deleteModel}
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
        onToggle={toggleCard}
      />
    );
  } else {
    content = (
<div className="mx-auto w-full max-w-4xl px-4 md:max-w-none md:px-6">
        <div className="pt-3 pb-2">
          <h1 className="text-[20px] font-bold tracking-tight text-neutral-900">Talkio 管理</h1>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            配置你的 AI 专家、模型与角色卡
          </p>
        </div>

<SectionLabel>配置</SectionLabel>
        {/* 手机端：iOS 分组列表 */}
        <div className="md:hidden">
          <Card>
            {MENU_ITEMS.map((m, i) => (
              <ChevronRow
                key={m.title}
                onClick={() => setPage(m.page)}
                icon={<span className="text-xl">{m.icon}</span>}
                title={m.title}
                detail={
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
                    {m.count} {m.unit}
                  </span>
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
              className="flex flex-col gap-2 rounded-[10px] border border-neutral-200 bg-white p-4 text-left shadow-sm transition-colors hover:bg-neutral-50 active:bg-neutral-100"
            >
              <div className="flex items-center justify-between">
                <span className="text-2xl">{m.icon}</span>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
                  {m.count} {m.unit}
                </span>
              </div>
              <div>
                <p className="text-[16px] font-semibold text-neutral-900">{m.title}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-neutral-500">{m.subtitle}</p>
              </div>
            </button>
          ))}
        </div>

        {/* Save bar */}
        <div className="mt-8 flex items-center gap-2">
          {dirty && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
              有未保存的修改
            </span>
          )}
          <button
            onClick={save}
            disabled={!dirty}
            className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-[15px] font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            保存配置
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-neutral-400">
          保存后需重启 MCP server，新配置才生效
        </p>
      </div>
    );
  }

  return (
<div className="relative mx-auto flex h-screen w-full max-w-2xl flex-col bg-neutral-50 md:max-w-5xl lg:max-w-6xl xl:max-w-7xl">
      {error && <ErrorBanner msg={error} onClose={() => setError(null)} />}

      {/* 子页面顶栏（返回） */}
      {page.name !== "settings" && (
        <div className="flex items-center border-b border-neutral-200 bg-white px-2 py-2.5">
          <button
            onClick={() => setPage({ name: "settings" })}
            className="flex min-w-[64px] items-center px-1 text-[17px] text-blue-600 active:opacity-60"
          >
            <span className="text-[22px] leading-none">‹</span>
            <span className="ml-0.5">返回</span>
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
      {editOverlay}
    </div>
  );
}