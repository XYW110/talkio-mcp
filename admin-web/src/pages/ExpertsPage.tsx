import { useMemo, useState } from "react";
import type { Expert } from "../types";
import { EmptyState } from "../components/ui";

interface Props {
  experts: Expert[];
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ExpertsPage({ experts, onAdd, onEdit, onDelete }: Props) {
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");

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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header: title + search + add */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-[20px] font-bold tracking-tight text-neutral-900">
            专家
            <span className="ml-2 text-sm font-normal text-neutral-400">{experts.length} 位</span>
          </h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSearch((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-blue-600 hover:bg-blue-50 active:opacity-60"
              title="搜索"
            >
              🔍
            </button>
            <button
              onClick={onAdd}
              className="flex h-9 w-9 items-center justify-center rounded-full text-blue-600 hover:bg-blue-50 active:opacity-60"
              title="新建专家"
            >
              ＋
            </button>
          </div>
        </div>
        <p className="text-[13px] text-neutral-500">
          设置你的 AI 专家团队：每个人物自定义人设与生成参数（模型绑定请到角色卡）。
        </p>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="px-4 pb-1">
          <div className="flex items-center rounded-xl bg-neutral-100 px-3 py-2">
            <span className="text-neutral-400">🔍</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称 / id / 人设…"
              className="ml-2 flex-1 bg-transparent text-[15px] outline-none"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-neutral-400">
                ✕
              </button>
            )}
          </div>
        </div>
      )}

{/* 手机端：iOS 分组列表 */}
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
                className="flex flex-col justify-between gap-3 rounded-[10px] border border-neutral-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <button onClick={() => onEdit(e.id)} className="flex w-full items-center gap-3 text-left">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-neutral-100 text-lg">
                    {e.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[16px] font-medium text-neutral-900">{e.name}</p>
                      {e.builtin && (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600">
                          内置
                        </span>
                      )}
                      {!e.enabled && (
                        <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500">
                          已禁用
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-[12px] text-neutral-400">{e.id}</p>
                  </div>
                </button>
                <div className="flex items-center justify-between border-t border-neutral-100 pt-2.5">
                  <span className="text-[12px] text-neutral-500">
                    {e.enabled === false ? "已禁用" : "启用中"} · temperature={e.temperature}
                  </span>
                  {!e.builtin && (
                    <button
                      onClick={() => {
                        if (window.confirm(`确定删除专家「${e.name}」？`)) onDelete(e.id);
                      }}
                      className="text-[13px] font-medium text-red-500 hover:bg-red-50 active:opacity-60"
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
  onEdit,
  onDelete,
}: {
  expert: Expert;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-stretch">
      <button
        onClick={onEdit}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50"
        style={{ borderBottom: isLast ? "none" : "0.5px solid #eee" }}
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-neutral-100 text-lg">
          {expert.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[16px] font-medium text-neutral-900">{expert.name}</p>
            {expert.builtin && (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600">
                内置
              </span>
            )}
            {!expert.enabled && (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500">
                已禁用
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[13px] leading-relaxed text-neutral-500">
            {expert.enabled === false ? "已禁用" : "启用中"} · temperature={expert.temperature}
          </p>
        </div>
        <span className="shrink-0 text-[18px] leading-none text-neutral-300">›</span>
      </button>
      {!expert.builtin && (
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            onDelete();
          }}
          className="flex shrink-0 items-center px-3 text-[13px] text-red-500 opacity-0 hover:bg-red-50 group-hover:opacity-100"
          title="删除"
        >
          删除
        </button>
      )}
    </div>
  );
}