import { useMemo, useState } from "react";
import type { CardConfig, Expert, ModelConfig, ProviderConfig, SignalId } from "../types";
import { SIGNAL_GROUPS, SIGNAL_GROUP_LABELS } from "../types";
import {
  Card,
  EmptyState,
  MultiSelectToolbar,
  NavBar,
  SectionLabel,
  SelectCheckbox,
  Toggle,
} from "../components/ui";
import { Button, Pill, SelectInput, TextInput } from "../components/controls";

interface Props {
  cards: CardConfig[];
  experts: Expert[];
  models: ModelConfig[];
  providers: [string, ProviderConfig][];
  onUpsert: (card: CardConfig) => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
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

export function CardsPage({
  cards,
  experts,
  models,
  providers,
  onUpsert,
  onDelete,
  onDeleteMany,
  onToggle,
}: Props) {
  const [editing, setEditing] = useState<{ initial?: CardConfig; isNew: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const cardIds = useMemo(() => cards.map((c) => c.id), [cards]);
  const visibleSelected = useMemo(
    () => cardIds.filter((id) => selected.has(id)),
    [cardIds, selected],
  );
  const allSelected = cardIds.length > 0 && visibleSelected.length === cardIds.length;

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const id of cardIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...cardIds]);
    });
  };

  const onDeleteSelected = () => {
    if (visibleSelected.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${visibleSelected.length} 张角色卡？`)) return;
    onDeleteMany(visibleSelected);
    setSelected(new Set());
  };

  const onClearAll = () => {
    if (cards.length === 0) return;
    if (!window.confirm(`确定清空全部 ${cards.length} 张角色卡？`)) return;
    onDeleteMany(cards.map((c) => c.id));
    setSelected(new Set());
  };

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
          <h1 className="text-[20px] font-bold tracking-tight text-ink">
            角色卡
            <span className="ml-2 text-sm font-normal text-ink-faint">{cards.length} 张</span>
          </h1>
          <Button
            variant="icon"
            onClick={() => setEditing({ isNew: true })}
            aria-label="新建角色卡"
            title="新建角色卡"
          >
            ＋
          </Button>
        </div>
<p className="text-[13px] text-ink-dim">
          一张角色卡 = 一位专家 + 一个模型。MCP 调用时只传卡片 id。
        </p>
      </div>

      <div className="flex-shrink-0">
        <MultiSelectToolbar
          noun="张"
          totalText={`共 ${cards.length} 张`}
          selectedCount={visibleSelected.length}
          selectableCount={cardIds.length}
          allSelected={allSelected}
          onToggleAll={toggleSelectAll}
          onDeleteSelected={onDeleteSelected}
          onClearAll={onClearAll}
          clearAllDisabled={cards.length === 0}
        />
      </div>

{/* 手机端：iOS 分组列表 */}
      <div className="flex-1 overflow-y-auto pb-6 md:hidden">
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
                  checked={selected.has(c.id)}
                  onToggleSelect={() => toggleSelect(c.id)}
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

      {/* 桌面端（md+）：卡片网格 */}
      <div className="hidden flex-1 overflow-y-auto px-4 pb-6 md:block">
        {cards.length === 0 ? (
          <EmptyState icon="🎴" title="还没有角色卡" subtitle="点右上角 ＋ 新建第一张角色卡" />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => {
              const d = describe(c);
              return (
<div
                  key={c.id}
                  className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-island-strong p-4 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-start gap-2">
                    <SelectCheckbox
                      checked={selected.has(c.id)}
                      onClick={() => toggleSelect(c.id)}
                    />
                    <button onClick={() => setEditing({ initial: c, isNew: false })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-hover text-lg">
                        🎴
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[16px] font-medium text-ink">{c.name}</p>
                          {c.isDefault && <Pill tone="info">默认</Pill>}
                          {!c.enabled && <Pill tone="neutral">已禁用</Pill>}
                        </div>
                      </div>
                    </button>
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink-dim">
                    {d.expertName} → {d.modelText}
                  </p>
                  <div className="flex items-center justify-between border-t border-line pt-2.5">
                    <span className="truncate font-mono text-[11px] text-ink-faint">{c.id}</span>
                    <div className="flex items-center gap-2">
                      <span title={c.enabled ? "禁用" : "启用"}>
                        <Toggle checked={c.enabled !== false} onChange={() => onToggle(c.id)} />
                      </span>
                      <Button
                        variant="danger-text"
                        className="!h-auto px-2 py-0"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (window.confirm(`确定删除角色卡「${c.name}」？`)) onDelete(c.id);
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
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
  checked,
  onToggleSelect,
  onEdit,
  onDelete,
  onToggle,
}: {
  card: CardConfig;
  expertName: string;
  modelText: string;
  isLast: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="group flex items-stretch">
      <SelectCheckbox checked={checked} onClick={onToggleSelect} />
      <button
        onClick={() => {
          onEdit();
        }}
        className={`flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-hover ${
          isLast ? "" : "border-b border-line"
        }`}
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-hover text-lg">
          🎴
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[16px] font-medium text-ink">{card.name}</p>
            {card.isDefault && <Pill tone="info">默认</Pill>}
            {!card.enabled && <Pill tone="neutral">已禁用</Pill>}
          </div>
          <p className="mt-0.5 truncate text-[13px] leading-relaxed text-ink-dim">
            {expertName} → {modelText}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">`{card.id}`</span>
        <span className="shrink-0 text-[18px] leading-none text-ink-faint">›</span>
      </button>
      <div className="flex shrink-0 items-center gap-2 px-2">
        <span title={card.enabled ? "禁用" : "启用"}>
          <Toggle checked={card.enabled !== false} onChange={() => onToggle()} />
        </span>
        <Button
          variant="danger-text"
          className="!h-auto shrink-0 px-2 py-0"
          onClick={(ev) => {
            ev.stopPropagation();
            onDelete();
          }}
          aria-label="删除"
          title="删除"
        >
          删除
        </Button>
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
  const [signals, setSignals] = useState<Set<SignalId>>(
    () => new Set((initial?.signals ?? []) as SignalId[]),
  );

  const toggleSignal = (id: SignalId) => {
    setSignals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      // 信号标签：全部取消 = 不出键（落盘删键，红线「缺省字段不写入」）
      ...(signals.size > 0 ? { signals: [...signals] } : {}),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
<div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-island-strong shadow-2xl sm:rounded-2xl md:max-w-lg">
        <NavBar
          title={isNew ? "新建角色卡" : "编辑角色卡"}
          onBack={onClose}
          right={
            <Button variant="primary" className="!h-8 !px-3 rounded-md" onClick={handleSave}>
              保存
            </Button>
          }
        />

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pb-6">
            <SectionLabel>绑定</SectionLabel>
            <Card>
              {/* expert */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">专家</span>
                <SelectInput
                  className="flex-1"
                  value={expertId}
                  onChange={(e) => setExpertId(e.target.value)}
                  aria-label="专家"
                >
                  {enabledExperts.length === 0 && <option value="">（请先添加专家）</option>}
                  {enabledExperts.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.icon} {e.name} · {e.id}
                    </option>
                  ))}
                </SelectInput>
              </div>

              {/* model */}
              <div className="flex items-center px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">模型</span>
                <SelectInput
                  className="flex-1"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  aria-label="模型"
                >
                  {enabledModels.length === 0 && <option value="">（请先添加模型）</option>}
                  {enabledModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.modelId} · {m.id}
                    </option>
                  ))}
                </SelectInput>
              </div>
            </Card>

            <SectionLabel>命名</SectionLabel>
            <Card>
              <div className="flex items-center px-4 py-0">
                <TextInput
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={isNew && previewId ? `卡片名称，默认 ${previewId}` : "卡片名称（例如：架构师 · GPT-4o）"}
                  className="!h-auto flex-1 !border-0 bg-transparent py-[11px] text-[17px] !px-0"
                />
              </div>
              {isNew && (
                <div className="flex items-center border-t border-line px-4 py-0">
                  <TextInput
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    placeholder={`ID（英文唯一）: ${slugify(name) || "my-card"}`}
                    className="!h-auto flex-1 !border-0 bg-transparent py-[11px] font-mono text-[14px] !px-0"
                  />
                </div>
              )}
            </Card>

            {isNew && previewId && (
              <p className="px-1 pt-2 font-mono text-[12px] text-ink-faint">
                角色卡 id：{previewId}
              </p>
            )}

            <SectionLabel>状态</SectionLabel>
            <Card>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[15px] text-ink">启用此角色卡</span>
                <Toggle checked={enabled} onChange={setEnabled} />
              </div>
            </Card>

            <SectionLabel>信号标签</SectionLabel>
            <Card>
              <div className="px-4 py-3">
                <p className="mb-2 text-[12px] leading-relaxed text-ink-faint">
                  可不选。consult_experts / brainstorm 传 select:"auto" 时，按问题文本
                  命中的信号组挑选候选卡；「通用兜底」表示任意话题都可参与。
                </p>
                <div className="flex flex-wrap gap-2">
                  {SIGNAL_GROUPS.map((g) => {
                    const active = signals.has(g);
                    return (
                      <button
                        key={g}
                        type="button"
                        onClick={() => toggleSignal(g)}
                        className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                          active
                            ? "border-info-text bg-info-bg text-info-text"
                            : "border-line bg-island-strong text-ink-dim hover:bg-hover"
                        }`}
                        title={g}
                      >
                        {SIGNAL_GROUP_LABELS[g]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}