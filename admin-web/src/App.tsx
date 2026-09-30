import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Brain,
  ChartNoAxesColumn,
  ChevronLeft,
  FolderClock,
  House,
  IdCard,
  KeyRound,
  LoaderCircle,
  MessageCircle,
  Plug,
  Rocket,
  Save,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { api, authCheck, clearToken, getStoredToken, setUnauthorizedHandler } from "./api";
import type { CardConfig, ConfigFile, Expert, ModelConfig, ProviderConfig } from "./types";
import { ExpertsPage } from "./pages/ExpertsPage";
import { ExpertEditPage } from "./pages/ExpertEditPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { ModelsPage } from "./pages/ModelsPage";
import { CardsPage } from "./pages/CardsPage";
import { RecordsPage } from "./pages/RecordsPage";
import { UsagePage } from "./pages/UsagePage";
import { ChatPage } from "./pages/ChatPage";
import { TokensPage } from "./pages/TokensPage";
import { LoginView } from "./pages/LoginView";
import { ChevronRow, SectionLabel, Card } from "./components/ui";
import { Button } from "./components/controls";
import { DrawerSheet } from "./components/overlays";
import { FeedbackProvider, useFeedback } from "./components/feedback";
import { ThemeSwitcher } from "./theme/ThemeSwitcher";

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
  | { name: "usage" }
  | { name: "tokens" }
  | { name: "chat" };

export default function App() {
  // 反馈层挂在根部：全站 toast/confirm 经 Context 下发（见 components/feedback.tsx）
  return (
    <FeedbackProvider>
      <AuthGate />
    </FeedbackProvider>
  );
}

/** 品牌化加载首屏：旋转环 + 图标 + 文案（登录校验 / 配置加载共用）。 */
function BrandedLoading({ text }: { text: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas">
      <span className="relative flex h-14 w-14 items-center justify-center">
        <span
          className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-info"
          aria-hidden="true"
        />
        <MessageCircle size={22} className="text-info-text" aria-hidden="true" />
      </span>
      <p className="text-[13px] text-ink-dim">{text}</p>
    </div>
  );
}

/**
 * 鉴权壳：启动时校验已存 token（GET /api/auth/check）；未登录渲染 LoginView；
 * 会话中任何 401（api.ts 统一拦截）清 token 并切回登录页。
 */
function AuthGate() {
  const [authState, setAuthState] = useState<"checking" | "login" | "ready">("checking");

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthState("login"));
    const token = getStoredToken();
    if (!token) {
      setAuthState("login");
      return;
    }
    authCheck(token)
      .then((r) => setAuthState(r.ok ? "ready" : "login"))
      .catch(() => {
        clearToken();
        setAuthState("login");
      });
    return () => setUnauthorizedHandler(null);
  }, []);

  if (authState === "checking") {
    return <BrandedLoading text="正在校验登录状态…" />;
  }
  if (authState === "login") {
    return <LoginView onSuccess={() => setAuthState("ready")} />;
  }
  return <AppShell />;
}

function AppShell() {
  const { toast } = useFeedback();
  const [config, setConfig] = useState<ConfigFile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState<Page>({ name: "settings" });
  const [editing, setEditing] = useState<Expert | "new" | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const cfg = await api.getConfig();
      setConfig({
        providers: cfg.providers ?? {},
        experts: cfg.experts ?? [],
        models: cfg.models ?? [],
        cards: cfg.cards ?? [],
        // 工具开关 admin 暂不编辑：原样透传，保存时不丢失该字段
        disabledTools: cfg.disabledTools,
      });
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e), { sticky: true });
    } finally {
      setLoading(false);
    }
  }, [toast]);

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
        toast(
          "error",
          `内置专家不可删除：${blocked.map((e) => e.name).join("、")}`,
          { sticky: true },
        );
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
    [config.experts, toast],
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

  const save = useCallback(async (): Promise<boolean> => {
    if (saving) return false; // busy 期间忽略重复触发（双击 / Ctrl+S）
    setSaving(true);
    try {
      const result = await api.saveConfig(config);
      if (!result.ok) {
        toast("error", result.error || "保存失败", { sticky: true });
        return false;
      }
      setDirty(false);
      if (result.restartRequired) {
        toast("success", "已保存。MCP server 需重启后新配置才生效（重启 talkio-mcp 进程）。");
      } else {
        toast("success", "已保存");
      }
      return true;
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e), { sticky: true });
      return false;
    } finally {
      setSaving(false);
    }
  }, [config, saving, toast]);

  // 全局 Ctrl/Cmd+S：dirty 时触发保存（R6.4）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

const providers = Object.entries(config.providers) as [string, ProviderConfig][];

  // ── 首页菜单项（手机端分组列表 / 桌面端卡片网格共用）──
  const MENU_ITEMS: {
    page: Page;
    icon: LucideIcon;
    title: string;
    count: number;
    unit: string;
    subtitle: string;
  }[] = [
    {
      page: { name: "experts" },
      icon: Bot,
      title: "专家",
      count: config.experts.length,
      unit: "位",
      subtitle: "管理 AI 专家：人设、参数",
    },
    {
      page: { name: "provider" },
      icon: Plug,
      title: "Provider",
      count: providers.length,
      unit: "个",
      subtitle: "配置 API 端点与 key 环境变量",
    },
    {
      page: { name: "models" },
      icon: Brain,
      title: "模型",
      count: config.models.length,
      unit: "个",
      subtitle: "管理各 Provider 下的模型引擎",
    },
    {
      page: { name: "cards" },
      icon: IdCard,
      title: "角色卡",
      count: config.cards.length,
      unit: "张",
      subtitle: "专家 + 模型 绑定成一张角色卡",
    },
    {
      page: { name: "records" },
      icon: FolderClock,
      title: "会话记录",
      count: 0,
      unit: "",
      subtitle: "查看 consult / brainstorm 调用留痕",
    },
    {
      page: { name: "usage" },
      icon: ChartNoAxesColumn,
      title: "用量",
      count: 0,
      unit: "",
      subtitle: "Token 消耗聚合与成本估算",
    },
    {
      page: { name: "tokens" },
      icon: KeyRound,
      title: "访问令牌",
      count: 0,
      unit: "",
      subtitle: "管理 MCP 客户端接入凭证",
    },
    {
      page: { name: "chat" },
      icon: Rocket,
      title: "发起群聊",
      count: 0,
      unit: "",
      subtitle: "填话题让多位专家开会讨论",
    },
  ];

  if (loading) {
    return <BrandedLoading text="正在加载配置…" />;
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
  } else if (page.name === "usage") {
    content = <UsagePage onBack={() => setPage({ name: "settings" })} />;
  } else if (page.name === "tokens") {
    content = <TokensPage onBack={() => setPage({ name: "settings" })} />;
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
            {MENU_ITEMS.map((m, i) => {
              const MenuIcon = m.icon;
              return (
                <ChevronRow
                  key={m.title}
                  onClick={() => setPage(m.page)}
                  icon={<MenuIcon size={20} className="shrink-0" aria-hidden="true" />}
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
              );
            })}
          </Card>
        </div>
        {/* 桌面端（md+）：卡片网格 */}
<div className="hidden md:grid md:grid-cols-2 md:gap-3 lg:grid-cols-4">
          {MENU_ITEMS.map((m) => {
            const MenuIcon = m.icon;
            return (
              <button
                key={m.title}
                onClick={() => setPage(m.page)}
                className="group flex flex-col gap-2 rounded-xl border border-line bg-island-strong p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:bg-hover hover:shadow-md active:scale-[0.99] active:bg-pressed"
              >
                <div className="flex items-center justify-between">
                  <MenuIcon
                    size={24}
                    className="text-ink-mid transition-colors group-hover:text-info-text"
                    aria-hidden="true"
                  />
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
            );
          })}
        </div>

        {/* Save bar — 手机端仅在首页显示；桌面端保存按钮在侧边栏 */}
        <div className="mt-8 flex items-center gap-2 md:hidden">
          {dirty && (
            <span className="rounded-full bg-warn-bg px-3 py-1 text-xs font-medium text-warn-text">
              有未保存的修改
            </span>
          )}
          <Button
            variant="primary"
            onClick={save}
            disabled={!dirty || saving}
            className="flex-1 rounded-xl py-2.5 text-[14px] font-semibold"
          >
            {saving ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                保存中…
              </span>
            ) : (
              "保存配置"
            )}
          </Button>
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

      {/* PC：左侧悬浮岛导航（手机端不渲染） */}
      <PcSidebar
        page={page}
        onNavigate={setPage}
        menuItems={MENU_ITEMS}
        dirty={dirty}
        saving={saving}
        onSave={save}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {/* 手机端顶栏岛（返回）—— records / usage / tokens 自管理导航（NavBar 在页内），不重复渲染 */}
        {page.name !== "settings" &&
          page.name !== "records" &&
          page.name !== "usage" &&
          page.name !== "tokens" && (
            <div className="island island-strong flex flex-shrink-0 items-center px-3 py-2.5 md:hidden">
              <button
                onClick={() => setPage({ name: "settings" })}
                className="flex min-h-[40px] items-center gap-1 rounded-md px-1.5 py-2 text-[13px] font-medium text-info-text transition-colors hover:bg-hover active:bg-pressed"
              >
                <ChevronLeft size={16} className="shrink-0 leading-none" aria-hidden="true" />
                <span>返回总览</span>
              </button>
            </div>
          )}

        {/* 内容岛：桌面端始终是岛；手机端 settings / records / usage / tokens 页自身即岛，直接铺 */}
        <div
          className={
            page.name === "settings" ||
            page.name === "records" ||
            page.name === "usage" ||
            page.name === "tokens"
              ? "min-h-0 flex-1 overflow-hidden"
              : "island island-strong min-h-0 flex-1 overflow-hidden"
          }
        >
          {content}
        </div>
      </div>
      {editOverlay}

      {/* 移动端/平板档主题入口（桌面档走侧栏切换器）：Settings 图标 → DrawerSheet 内同款切换控件 */}
      <button
        type="button"
        onClick={() => setThemeOpen(true)}
        aria-label="主题设置"
        className="fixed bottom-4 right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-island-strong text-[17px] shadow-island transition-colors hover:bg-hover lg:hidden"
      >
        <Settings size={20} aria-hidden="true" />
      </button>
      <div className="lg:hidden">
        <DrawerSheet open={themeOpen} onClose={() => setThemeOpen(false)} title="主题">
          <ThemeSwitcher />
        </DrawerSheet>
      </div>
    </div>
  );
}

// ── PC 独立版布局：左侧固定侧边栏（md+ 显示）。
// 三档：≥1024（lg）248px 完整栏；768~1023（md）64px 图标栏；<768 不渲染（顶栏岛 + 浮动主题按钮）──

function PcSidebar({
  page,
  onNavigate,
  menuItems,
  dirty,
  saving,
  onSave,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
  menuItems: {
    page: Page;
    icon: LucideIcon;
    title: string;
    count: number;
    unit: string;
    subtitle: string;
  }[];
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const navItems = [
    { page: { name: "settings" } as Page, icon: House, title: "总览", count: 0, unit: "" },
    ...menuItems,
  ];
  return (
    <aside className="island island-muted hidden w-16 flex-shrink-0 flex-col md:flex lg:w-[248px]">
      {/* 品牌区（平板档只留图标） */}
      <div className="border-b border-line px-2 py-4 text-center lg:px-5 lg:text-left">
        <p className="text-[15px] font-bold tracking-tight text-ink">
          <MessageCircle size={18} className="inline-block align-[-3px]" aria-hidden="true" />
          <span className="hidden lg:inline"> Talkio 管理</span>
        </p>
        <p className="mt-0.5 hidden text-[12px] text-ink-faint lg:block">AI 专家 · 模型 · 角色卡</p>
      </div>

      {/* 导航项（平板档居中只显示图标，title 走 aria-label/tooltip） */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-3">
        {navItems.map((item) => {
          const active = page.name === item.page.name;
          const NavIcon = item.icon;
          return (
            <button
              key={item.title}
              onClick={() => onNavigate(item.page)}
              title={item.title}
              aria-label={item.title}
              className={`mb-0.5 flex w-full items-center justify-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors lg:justify-start ${
                active
                  ? "nav-item-active bg-info-bg font-medium text-ink"
                  : "text-ink-mid hover:bg-hover"
              }`}
            >
              <NavIcon size={16} className="shrink-0 leading-none" aria-hidden="true" />
              <span className="hidden flex-1 text-[13px] lg:inline">{item.title}</span>
              {item.unit !== "" && (
                <span
                  className={`hidden rounded px-1.5 py-0.5 text-[11px] lg:inline ${
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

      {/* 主题切换（平板图标栏放不下，仅桌面档显示；移动端走浮动主题按钮抽屉） */}
      <div className="hidden border-t border-line px-4 py-3 lg:block">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          主题
        </p>
        <ThemeSwitcher />
      </div>

      {/* 底部保存区（平板档缩为图标按钮） */}
      <div className="border-t border-line px-3 py-3 lg:px-4">
        <Button
          variant="primary"
          onClick={onSave}
          disabled={!dirty || saving}
          aria-label="保存配置"
          className="h-11 w-full lg:h-10"
        >
          <span className="hidden lg:inline">
            {saving ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                保存中…
              </span>
            ) : (
              dirty ? "保存配置 ●" : "保存配置"
            )}
          </span>
          <span className="lg:hidden" aria-hidden="true">
            {saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}
          </span>
        </Button>
        <p className="mt-1.5 hidden text-center text-[11px] text-ink-faint lg:block">
          {dirty ? "有未保存的修改" : "保存后需重启 MCP server 生效"}
        </p>
      </div>
    </aside>
  );
}