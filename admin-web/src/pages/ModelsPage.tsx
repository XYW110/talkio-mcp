import { useMemo, useState } from "react";
import type { ModelConfig, ProviderConfig, ThinkingLevel } from "../types";
import {
  Card,
  EmptyState,
  MultiSelectToolbar,
  NavBar,
  SectionLabel,
  SelectCheckbox,
  Toggle,
} from "../components/ui";

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

  // 按 provider 分组
  const grouped = useMemo(() => {
    const map = new Map<string, ModelConfig[]>();
    for (const m of models) {
      const list = map.get(m.providerId) ?? [];
      list.push(m);
      map.set(m.providerId, list);
    }
    return [...map.entries()];
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
          <button
            onClick={() => setEditing({ isNew: true })}
            className="flex h-9 w-9 items-center justify-center rounded-full text-info-text hover:bg-info-bg active:opacity-60"
            title="新建模型"
          >
            ＋
          </button>
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
            {!model.enabled && (
              <span className="rounded bg-pressed px-1.5 py-0.5 text-[10px] text-ink-dim">
                已禁用
              </span>
            )}
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
<button
          onClick={(ev) => {
            ev.stopPropagation();
            onDelete();
          }}
          className="flex shrink-0 items-center px-2 text-[13px] text-bad hover:opacity-80 active:opacity-60"
          title="删除"
        >
          删除
        </button>
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
    onSave({
      id: isNew ? previewId : id,
      providerId,
      modelId: modelId.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      enabled,
      ...(thinkingLevel ? { thinkingLevel } : {}),
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
            <button
              onClick={handleSave}
              className="text-[17px] font-semibold text-info-text active:opacity-60"
            >
              保存
            </button>
          }
        />

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pb-6">
            <SectionLabel>配置</SectionLabel>
            <Card>
              {/* provider */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">Provider</span>
                <div className="relative flex-1">
                  <select
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                    className="w-full appearance-none bg-transparent text-[15px] text-ink outline-none"
                  >
                    {providers.length === 0 && <option value="">（请先添加 provider）</option>}
                    {providers.map(([n, p]) => (
                      <option key={n} value={n}>
                        {n} · {p.baseUrl}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-ink-faint">
                    ▾
                  </span>
                </div>
              </div>

              {/* modelId */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">modelId</span>
                <input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="例如 gpt-4o / claude-sonnet-4"
                  className="flex-1 bg-transparent font-mono text-[14px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>

              {/* displayName */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">显示名</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="可选，例如 GPT-4o"
                  className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>

              {/* thinkingLevel */}
              <div className="flex items-center px-4 py-3">
                <span className="w-20 shrink-0 text-[15px] text-ink-dim">思考强度</span>
                <div className="relative flex-1">
                  <select
                    value={thinkingLevel}
                    onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel | "")}
                    className="w-full appearance-none bg-transparent text-[15px] text-ink outline-none"
                  >
                    <option value="">默认（模型自带）</option>
                    <option value="high">高（深度推理）</option>
                    <option value="medium">中（标准推理）</option>
                    <option value="low">低（轻量推理）</option>
                    <option value="disabled">关闭（不思考，最快）</option>
                  </select>
                  <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-ink-faint">
                    ▾
                  </span>
                </div>
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