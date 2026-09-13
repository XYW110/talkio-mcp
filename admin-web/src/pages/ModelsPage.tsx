import { useMemo, useState } from "react";
import type { ModelConfig, ProviderConfig, ThinkingLevel } from "../types";
import { sortByTierDesc } from "../types";
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
  models: ModelConfig[];
  providers: [string, ProviderConfig][];
  onUpsert: (model: ModelConfig) => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
}

function slugifyModel(modelId: string): string {
  return (
    modelId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "model"
  );
}

export function ModelsPage({ models, providers, onUpsert, onDelete, onDeleteMany }: Props) {
  const [editing, setEditing] = useState<{
    initial?: ModelConfig;
    isNew: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const modelIds = useMemo(() => models.map((m) => m.id), [models]);
  const visibleSelected = useMemo(
    () => modelIds.filter((id) => selected.has(id)),
    [modelIds, selected],
  );
  const allSelected = modelIds.length > 0 && visibleSelected.length === modelIds.length;

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
        for (const id of modelIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...modelIds]);
    });
  };

  const onDeleteSelected = () => {
    if (visibleSelected.length === 0) return;
    if (
      !window.confirm(
        `确定删除选中的 ${visibleSelected.length} 个模型？引用它们的角色卡会一并删除。`,
      )
    )
      return;
    onDeleteMany(visibleSelected);
    setSelected(new Set());
  };

  const onClearAll = () => {
    if (models.length === 0) return;
    if (
      !window.confirm(
        `确定清空全部 ${models.length} 个模型？引用它们的角色卡会一并删除。`,
      )
    )
      return;
    onDeleteMany(modelIds);
    setSelected(new Set());
  };

  // 按 provider 分组；组内按 tier 稳定排序（P3-B：tier 降序在前，无 tier 在后保持原序）
  const grouped = useMemo(() => {
    const map = new Map<string, ModelConfig[]>();
    for (const m of models) {
      const list = map.get(m.providerId) ?? [];
      list.push(m);
      map.set(m.providerId, list);
    }
    return [...map.entries()].map(
      ([providerId, list]) => [providerId, sortByTierDesc(list)] as const,
    );
  }, [models]);

  const providerName = (id: string) => {
    const p = providers.find(([n]) => n === id);
    return p ? `${id} · ${p[1].baseUrl}` : `${id}（未配置 provider）`;
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-[20px] font-bold tracking-tight text-ink">
            模型
            <span className="ml-2 text-sm font-normal text-ink-faint">{models.length} 个</span>
          </h1>
          <Button
            variant="icon"
            onClick={() => setEditing({ isNew: true })}
            aria-label="新建模型"
            title="新建模型"
          >
            ＋
          </Button>
        </div>
<p className="text-[13px] text-ink-dim">
          管理 API 提供方下的模型引擎。绑定专家请到「角色卡」。
        </p>
      </div>

      <div className="flex-shrink-0">
        <MultiSelectToolbar
          noun="个"
          totalText={`共 ${models.length} 个`}
          selectedCount={visibleSelected.length}
          selectableCount={modelIds.length}
          allSelected={allSelected}
          onToggleAll={toggleSelectAll}
          onDeleteSelected={onDeleteSelected}
          onClearAll={onClearAll}
          clearAllDisabled={models.length === 0}
        />
      </div>

{/* Grouped list */}
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {models.length === 0 ? (
          <EmptyState icon="🧠" title="还没有模型" subtitle="点右上角 ＋ 新建你的第一个模型" />
        ) : (
<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {grouped.map(([providerId, list]) => (
              <div key={providerId}>
                <SectionLabel>{providerName(providerId)}</SectionLabel>
                <Card>
                  {list.map((m, i) => (
<ModelRow
                      key={m.id}
                      model={m}
                      isLast={i === list.length - 1}
                      checked={selected.has(m.id)}
                      onToggleSelect={() => toggleSelect(m.id)}
                      onEdit={() => setEditing({ initial: m, isNew: false })}
                      onDelete={() => {
                        if (window.confirm(`确定删除模型「${m.displayName || m.modelId}」？引用它的角色卡会被一并删除。`))
                          onDelete(m.id);
                      }}
                      onToggle={() => onUpsert({ ...m, enabled: !m.enabled })}
                    />
                  ))}
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ModelEditOverlay
          initial={editing.initial}
          isNew={editing.isNew}
          providers={providers}
          existingIds={models.map((m) => m.id)}
          onSave={(m) => {
            onUpsert(m);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ModelRow({
  model,
  isLast,
  checked,
  onToggleSelect,
  onEdit,
  onDelete,
  onToggle,
}: {
  model: ModelConfig;
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
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-island-strong"
        style={{ borderBottom: isLast ? "none" : undefined }}
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-hover text-lg">
          🧠
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[16px] font-medium text-ink">
              {model.displayName || model.modelId}
            </p>
            {!model.enabled && <Pill tone="neutral">已禁用</Pill>}
            {model.tier !== undefined && <Pill tone="info">T{model.tier}</Pill>}
          </div>
          <p className="mt-0.5 truncate font-mono text-[12px] leading-relaxed text-ink-dim">
            {model.modelId}
          </p>
          {model.thinkingLevel && (
            <p className="mt-0.5 text-[11px] text-ink-faint">
              思考：{model.thinkingLevel === "disabled" ? "关闭" : model.thinkingLevel === "high" ? "高" : model.thinkingLevel === "medium" ? "中" : "低"}
            </p>
          )}
        </div>
        <span className="shrink-0 text-[18px] leading-none text-ink-faint">›</span>
      </button>
      <div className="flex shrink-0 items-center gap-2 px-2">
        <span
          className="cursor-pointer"
          onClick={(ev) => {
            ev.stopPropagation();
            onToggle();
          }}
          title={model.enabled ? "禁用" : "启用"}
        >
          <Toggle checked={model.enabled !== false} onChange={() => onToggle()} />
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

function ModelEditOverlay({
  initial,
  isNew,
  providers,
  existingIds,
  onSave,
  onClose,
}: {
  initial?: ModelConfig;
  isNew: boolean;
  providers: [string, ProviderConfig][];
  existingIds: string[];
  onSave: (m: ModelConfig) => void;
  onClose: () => void;
}) {
  const [id] = useState(initial?.id ?? "");
  const [providerId, setProviderId] = useState(initial?.providerId ?? providers[0]?.[0] ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">(
    initial?.thinkingLevel ?? "",
  );
  const [tier, setTier] = useState(
    initial?.tier !== undefined ? String(initial.tier) : "",
  );

  // provider 变化时自动拼 id 预览（仅新建时）
  const previewId = useMemo(() => {
    if (!isNew) return id;
    return providerId && modelId ? `${providerId}-${slugifyModel(modelId)}` : "";
  }, [isNew, providerId, modelId, id]);

  const handleSave = () => {
    if (!providerId) return window.alert("请选择 provider");
    if (!modelId.trim()) return window.alert("请填写模型 modelId（例如 gpt-4o）");
    if (isNew && !previewId) return window.alert("无法生成模型 id");
    if (isNew && existingIds.includes(previewId)) {
      return window.alert(`模型 id「${previewId}」已存在`);
    }
    // tier：空 = 不设分级（落盘删键）；填写则须为 1-100 的正整数（与后端 zod 一致）
    const tierValue = tier.trim() === "" ? undefined : Number(tier);
    if (
      tierValue !== undefined &&
      (!Number.isInteger(tierValue) || tierValue <= 0 || tierValue > 100)
    ) {
      return window.alert("分级 tier 需为 1-100 的正整数，或留空不设分级");
    }
    onSave({
      id: isNew ? previewId : id,
      providerId,
      modelId: modelId.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      enabled,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(tierValue !== undefined ? { tier: tierValue } : {}),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
<div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-island-strong shadow-2xl sm:rounded-2xl md:max-w-lg">
        <NavBar
          title={isNew ? "新建模型" : "编辑模型"}
          onBack={onClose}
          right={
            <Button variant="primary" className="!h-8 !px-3 rounded-md" onClick={handleSave}>
              保存
            </Button>
          }
        />

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pb-6">
            <SectionLabel>配置</SectionLabel>
            <Card>
              {/* provider */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">Provider</span>
                <SelectInput
                  className="flex-1"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  aria-label="Provider"
                >
                  {providers.length === 0 && <option value="">（请先添加 provider）</option>}
                  {providers.map(([n, p]) => (
                    <option key={n} value={n}>
                      {n} · {p.baseUrl}
                    </option>
                  ))}
                </SelectInput>
              </div>

              {/* modelId */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">modelId</span>
                <TextInput
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="例如 gpt-4o / claude-sonnet-4"
                  className="flex-1 !border-0 bg-transparent !px-0 font-mono text-[14px]"
                />
              </div>

              {/* displayName */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">显示名</span>
                <TextInput
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="可选，例如 GPT-4o"
                  className="flex-1 !border-0 bg-transparent !px-0"
                />
              </div>

              {/* tier（P3-B：仅展示排序用，不参与选卡） */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">分级 tier</span>
                <TextInput
                  value={tier}
                  onChange={(e) => setTier(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  placeholder="可选，1-100，越大越靠前"
                  className="flex-1 !border-0 bg-transparent !px-0"
                />
              </div>

              {/* thinkingLevel */}
              <div className="flex items-center px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">思考强度</span>
                <SelectInput
                  className="flex-1"
                  value={thinkingLevel}
                  onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel | "")}
                  aria-label="思考强度"
                >
                  <option value="">默认（模型自带）</option>
                  <option value="high">高（深度推理）</option>
                  <option value="medium">中（标准推理）</option>
                  <option value="low">低（轻量推理）</option>
                  <option value="disabled">关闭（不思考，最快）</option>
                </SelectInput>
              </div>
            </Card>

            {isNew && previewId && (
              <p className="px-1 pt-2 font-mono text-[12px] text-ink-faint">
                模型 id：{previewId}
              </p>
            )}

            <SectionLabel>状态</SectionLabel>
            <Card>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[15px] text-ink">启用此模型</span>
                <Toggle checked={enabled} onChange={setEnabled} />
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}