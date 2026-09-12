import { useMemo, useState } from "react";
import type { Expert } from "../types";
import { EmptyState, MultiSelectToolbar, SelectCheckbox } from "../components/ui";

interface Props {
  experts: Expert[];
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
}

export function ExpertsPage({ experts, onAdd, onEdit, onDelete, onDeleteMany }: Props) {
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

const filtered = useMemo(() => {
    if (!query.trim()) return experts;
    const q = query.toLowerCase();
    return experts.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        e.systemPrompt.toLowerCase().includes(q),
    );
  }, [experts, query]);

  // 内置专家不可删，不能出现在多选里
  const deletableIds = useMemo(
    () => filtered.filter((e) => !e.builtin).map((e) => e.id),
    [filtered],
  );
  const selectableCount = deletableIds.length;
  const visibleSelected = deletableIds.filter((id) => selected.has(id));
  const allSelected = selectableCount > 0 && visibleSelected.length === selectableCount;

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
        for (const id of deletableIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...deletableIds]);
    });
  };

  const onDeleteSelected = () => {
    if (visibleSelected.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${visibleSelected.length} 位专家？引用它们的角色卡会一并删除。`))
      return;
    onDeleteMany(visibleSelected);
    setSelected(new Set());
  };

  const onClearAll = () => {
    const removable = experts.filter((e) => !e.builtin);
    if (removable.length === 0) return;
    if (
      !window.confirm(
        `确定清空全部 ${removable.length} 位专家（内置专家保留）？引用它们的角色卡会一并删除。`,
      )
    )
      return;
    onDeleteMany(removable.map((e) => e.id));
    setSelected(new Set());
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header: title + search + add */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-[20px] font-bold tracking-tight text-ink">
            专家
            <span className="ml-2 text-sm font-normal text-ink-faint">{experts.length} 位</span>
          </h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSearch((v) => !v)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-info-text hover:bg-info-bg active:bg-pressed"
              title="搜索"
            >
              🔍
            </button>
            <button
              onClick={onAdd}
              className="flex h-8 w-8 items-center justify-center rounded-md text-info-text hover:bg-info-bg active:bg-pressed"
              title="新建专家"
            >
              ＋
            </button>
          </div>
        </div>
<p className="text-[13px] text-ink-dim">
          设置你的 AI 专家团队：每个人物自定义人设与生成参数（模型绑定请到角色卡）。
        </p>
      </div>

      <div className="flex-shrink-0">
        <MultiSelectToolbar
          noun="位"
          totalText={`共 ${experts.length} 位`}
          selectedCount={visibleSelected.length}
          selectableCount={selectableCount}
          allSelected={allSelected}
          onToggleAll={toggleSelectAll}
          onDeleteSelected={onDeleteSelected}
          onClearAll={onClearAll}
          clearAllDisabled={experts.filter((e) => !e.builtin).length === 0}
        />
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="px-4 pb-1">
          <div className="flex items-center rounded-md border border-line bg-island-strong px-3 py-2">
            <span className="text-ink-faint">🔍</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称 / id / 人设…"
              className="ml-2 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-ink-faint">
                ✕
              </button>
            )}
          </div>
        </div>
      )}

{/* 手机端：分组列表 */}
      <div className="flex-1 overflow-y-auto pb-6 md:hidden">
        {filtered.length === 0 ? (
          query ? (
            <EmptyState icon="🔍" title="没有匹配的专家" />
          ) : (
            <EmptyState icon="🤖" title="还没有专家" subtitle="点右上角 ＋ 新建你的第一位专家" />
          )
        ) : (
          <div className="pb-4">
{filtered.map((e, i) => (
              <ExpertRow
                key={e.id}
                expert={e}
                isLast={i === filtered.length - 1}
                checked={!e.builtin && selected.has(e.id)}
                onToggleSelect={() => !e.builtin && toggleSelect(e.id)}
                onEdit={() => onEdit(e.id)}
                onDelete={() => {
                  if (window.confirm(`确定删除专家「${e.name}」？`)) onDelete(e.id);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 桌面端（md+）：卡片网格 */}
      <div className="hidden flex-1 overflow-y-auto px-4 pb-6 md:block">
        {filtered.length === 0 ? (
          query ? (
            <EmptyState icon="🔍" title="没有匹配的专家" />
          ) : (
            <EmptyState icon="🤖" title="还没有专家" subtitle="点右上角 ＋ 新建你的第一位专家" />
          )
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
{filtered.map((e) => (
              <div
                key={e.id}
                className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-island-strong p-4 transition-colors hover:bg-hover"
              >
                <div className="flex items-start gap-2">
                  {!e.builtin && (
                    <SelectCheckbox
                      checked={selected.has(e.id)}
                      onClick={() => toggleSelect(e.id)}
                    />
                  )}
                  <button onClick={() => onEdit(e.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-hover text-lg">
                      {e.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[14px] font-medium text-ink">{e.name}</p>
                        {e.builtin && (
                          <span className="rounded bg-info-bg px-1.5 py-0.5 text-[10px] text-info-text">
                            内置
                          </span>
                        )}
                        {!e.enabled && (
                          <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-ink-dim">
                            已禁用
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate font-mono text-[12px] text-ink-faint">{e.id}</p>
                    </div>
                  </button>
                </div>
                <div className="flex items-center justify-between border-t border-line pt-2.5">
                  <span className="text-[12px] text-ink-dim">
                    {e.enabled === false ? "已禁用" : "启用中"} · temperature={e.temperature}
                  </span>
                  {!e.builtin && (
                    <button
                      onClick={() => {
                        if (window.confirm(`确定删除专家「${e.name}」？`)) onDelete(e.id);
                      }}
                      className="text-[13px] font-medium text-bad hover:opacity-80"
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ExpertRow({
  expert,
  isLast,
  checked,
  onToggleSelect,
  onEdit,
  onDelete,
}: {
  expert: Expert;
  isLast: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-stretch">
      {!expert.builtin && <SelectCheckbox checked={checked} onClick={onToggleSelect} />}
      <button
        onClick={() => {
          onEdit();
        }}
        className={`flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-hover ${
          isLast ? "" : "border-b border-line"
        }`}
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-hover text-lg">
          {expert.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[14px] font-medium text-ink">{expert.name}</p>
            {expert.builtin && (
              <span className="rounded bg-info-bg px-1.5 py-0.5 text-[10px] text-info-text">
                内置
              </span>
            )}
            {!expert.enabled && (
              <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-ink-dim">
                已禁用
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[12px] leading-relaxed text-ink-dim">
            {expert.enabled === false ? "已禁用" : "启用中"} · temperature={expert.temperature}
          </p>
        </div>
        <span className="shrink-0 text-[16px] leading-none text-ink-faint">›</span>
      </button>
{!expert.builtin && (
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            onDelete();
          }}
          className="flex shrink-0 items-center px-2 text-[13px] text-bad hover:opacity-80"
          title="删除"
        >
          删除
        </button>
      )}
    </div>
  );
}
