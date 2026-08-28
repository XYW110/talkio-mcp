import { useMemo, useState } from "react";
import type { CardConfig, Expert, ModelConfig, ProviderConfig } from "../types";
import { Card, EmptyState, NavBar, SectionLabel, Toggle } from "../components/ui";

interface Props {
  cards: CardConfig[];
  experts: Expert[];
  models: ModelConfig[];
  providers: [string, ProviderConfig][];
  onUpsert: (card: CardConfig) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "card"
  );
}

export function CardsPage({ cards, experts, models, providers, onUpsert, onDelete, onToggle }: Props) {
  const [editing, setEditing] = useState<{ initial?: CardConfig; isNew: boolean } | null>(null);

  const expertMap = useMemo(() => new Map(experts.map((e) => [e.id, e])), [experts]);
  const modelMap = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);

  const describe = (card: CardConfig) => {
    const ex = expertMap.get(card.expertId);
    const mo = modelMap.get(card.modelId);
    const p = mo && providers.find(([n]) => n === mo.providerId);
    return {
      expertName: ex ? `${ex.icon} ${ex.name}` : `<missing expert ${card.expertId}>`,
      modelText: mo
        ? `${mo.displayName || mo.modelId}${p ? ` · ${p[0]}` : ""}`
        : `<missing model ${card.modelId}>`,
    };
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-[20px] font-bold tracking-tight text-neutral-900">
            角色卡
            <span className="ml-2 text-sm font-normal text-neutral-400">{cards.length} 张</span>
          </h1>
          <button
            onClick={() => setEditing({ isNew: true })}
            className="flex h-9 w-9 items-center justify-center rounded-full text-blue-600 hover:bg-blue-50 active:opacity-60"
            title="新建角色卡"
          >
            ＋
          </button>
        </div>
        <p className="text-[13px] text-neutral-500">
          一张角色卡 = 一位专家 + 一个模型。MCP 调用时只传卡片 id。
        </p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto pb-6">
        {cards.length === 0 ? (
          <EmptyState icon="🎴" title="还没有角色卡" subtitle="点右上角 ＋ 新建第一张角色卡" />
        ) : (
          <Card>
            {cards.map((c, i) => {
              const d = describe(c);
              return (
                <CardRow
                  key={c.id}
                  card={c}
                  expertName={d.expertName}
                  modelText={d.modelText}
                  isLast={i === cards.length - 1}
                  onEdit={() => setEditing({ initial: c, isNew: false })}
                  onDelete={() => {
                    if (window.confirm(`确定删除角色卡「${c.name}」？`)) onDelete(c.id);
                  }}
                  onToggle={() => onToggle(c.id)}
                />
              );
            })}
          </Card>
        )}
      </div>

      {editing && (
        <CardEditOverlay
          initial={editing.initial}
          isNew={editing.isNew}
          experts={experts}
          models={models}
          existingIds={cards.map((c) => c.id)}
          onSave={(c) => {
            onUpsert(c);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CardRow({
  card,
  expertName,
  modelText,
  isLast,
  onEdit,
  onDelete,
  onToggle,
}: {
  card: CardConfig;
  expertName: string;
  modelText: string;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="group flex items-stretch">
      <button
        onClick={onEdit}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50"
        style={{ borderBottom: isLast ? "none" : "0.5px solid #eee" }}
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-50 to-indigo-100 text-lg">
          🎴
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[16px] font-medium text-neutral-900">{card.name}</p>
            {card.isDefault && (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600">
                默认
              </span>
            )}
            {!card.enabled && (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500">
                已禁用
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[13px] leading-relaxed text-neutral-500">
            {expertName} → {modelText}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-neutral-300">`{card.id}`</span>
        <span className="shrink-0 text-[18px] leading-none text-neutral-300">›</span>
      </button>
      <div className="flex shrink-0 items-center gap-2 px-2">
        <span title={card.enabled ? "禁用" : "启用"}>
          <Toggle checked={card.enabled !== false} onChange={() => onToggle()} />
        </span>
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            onDelete();
          }}
          className="text-[13px] text-red-500 opacity-0 group-hover:opacity-100"
          title="删除"
        >
          删除
        </button>
      </div>
    </div>
  );
}

function CardEditOverlay({
  initial,
  isNew,
  experts,
  models,
  existingIds,
  onSave,
  onClose,
}: {
  initial?: CardConfig;
  isNew: boolean;
  experts: Expert[];
  models: ModelConfig[];
  existingIds: string[];
  onSave: (c: CardConfig) => void;
  onClose: () => void;
}) {
  const enabledExperts = experts.filter((e) => e.enabled !== false);
  const enabledModels = models.filter((m) => m.enabled !== false);

  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [expertId, setExpertId] = useState(initial?.expertId ?? enabledExperts[0]?.id ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? enabledModels[0]?.id ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const previewId = useMemo(() => {
    if (!isNew) return id;
    return expertId && modelId ? `${expertId}-${modelId}` : "";
  }, [isNew, expertId, modelId, id]);

  const handleSave = () => {
    if (!expertId) return window.alert("请选择专家");
    if (!modelId) return window.alert("请选择模型");
    if (isNew && !previewId) return window.alert("无法生成角色卡 id");
    if (isNew && existingIds.includes(previewId)) {
      return window.alert(`角色卡 id「${previewId}」已存在`);
    }
    onSave({
      id: isNew ? previewId : id,
      name: name.trim() || previewId,
      expertId,
      modelId,
      enabled,
      ...(initial?.isDefault ? { isDefault: true } : {}),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <NavBar
          title={isNew ? "新建角色卡" : "编辑角色卡"}
          onBack={onClose}
          right={
            <button
              onClick={handleSave}
              className="text-[17px] font-semibold text-blue-600 active:opacity-60"
            >
              保存
            </button>
          }
        />

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pb-6">
            <SectionLabel>绑定</SectionLabel>
            <Card>
              {/* expert */}
              <div
                className="flex items-center px-4 py-3"
                style={{ borderBottom: "0.5px solid #eee" }}
              >
                <span className="w-20 shrink-0 text-[15px] text-neutral-500">专家</span>
                <div className="relative flex-1">
                  <select
                    value={expertId}
                    onChange={(e) => setExpertId(e.target.value)}
                    className="w-full appearance-none bg-transparent text-[15px] text-neutral-900 outline-none"
                  >
                    {enabledExperts.length === 0 && <option value="">（请先添加专家）</option>}
                    {enabledExperts.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.icon} {e.name} · {e.id}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-neutral-400">
                    ▾
                  </span>
                </div>
              </div>

              {/* model */}
              <div className="flex items-center px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-neutral-500">模型</span>
                <div className="relative flex-1">
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="w-full appearance-none bg-transparent text-[15px] text-neutral-900 outline-none"
                  >
                    {enabledModels.length === 0 && <option value="">（请先添加模型）</option>}
                    {enabledModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName || m.modelId} · {m.id}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-neutral-400">
                    ▾
                  </span>
                </div>
              </div>
            </Card>

            <SectionLabel>命名</SectionLabel>
            <Card>
              <div className="flex items-center px-4 py-0">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={isNew && previewId ? `卡片名称，默认 ${previewId}` : "卡片名称（例如：架构师 · GPT-4o）"}
                  className="bg-transparent py-[11px] text-[17px] text-neutral-900 outline-none placeholder:text-neutral-300"
                />
              </div>
              {isNew && (
                <div className="flex items-center px-4 py-0" style={{ borderTop: "0.5px solid #eee" }}>
                  <input
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    placeholder={`ID（英文唯一）: ${slugify(name) || "my-card"}`}
                    className="bg-transparent py-[11px] font-mono text-[14px] text-neutral-900 outline-none placeholder:text-neutral-300"
                  />
                </div>
              )}
            </Card>

            {isNew && previewId && (
              <p className="px-1 pt-2 font-mono text-[12px] text-neutral-400">
                角色卡 id：{previewId}
              </p>
            )}

            <SectionLabel>状态</SectionLabel>
            <Card>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[15px] text-neutral-900">启用此角色卡</span>
                <Toggle checked={enabled} onChange={setEnabled} />
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}