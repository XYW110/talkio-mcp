import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { RecordEvent, SessionMeta, UsageRecord } from "../types";
import { Card, EmptyState, NavBar, SectionLabel } from "../components/ui";

const TOOL_LABEL: Record<string, string> = {
  consult_experts: "专家会诊",
  brainstorm: "头脑风暴",
  brainstorm_followup: "追问",
};

const TOOL_ICON: Record<string, string> = {
  consult_experts: "🩺",
  brainstorm: "💡",
  brainstorm_followup: "↩️",
};

const STATUS_LABEL: Record<string, string> = {
  ok: "成功",
  partial: "部分成功",
  all_failed: "全部失败",
  no_cards: "无可用角色卡",
  error: "出错",
};

const STATUS_STYLE: Record<string, string> = {
  ok: "bg-ok-bg text-ok-text",
  partial: "bg-warn-bg text-warn-text",
  all_failed: "bg-bad-bg text-bad-text",
  no_cards: "bg-pressed text-ink-mid",
  error: "bg-bad-bg text-bad-text",
};

function fmtBytes(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function fmtUsage(u?: UsageRecord): string {
  if (!u) return "";
  const parts: string[] = [];
  if (u.promptTokens !== undefined) parts.push(`入 ${u.promptTokens}`);
  if (u.completionTokens !== undefined) parts.push(`出 ${u.completionTokens}`);
  return parts.join(" / ");
}

/** ISO 时间 → 本地日期 yyyy-mm-dd（供日期区间筛选比较）。 */
function localDate(iso: string): string | null {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

export function RecordsPage({ onBack }: { onBack: () => void }) {
  const [records, setRecords] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.getRecords(200);
      setRecords(list ?? []);
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

  const filtered = useMemo(() => {
    let out = records;
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (r) =>
          r.prompt.toLowerCase().includes(q) ||
          r.tool.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q),
      );
    }
    if (startDate || endDate) {
      out = out.filter((r) => {
        const d = localDate(r.startedAt);
        if (!d) return false;
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      });
    }
    return out;
  }, [records, query, startDate, endDate]);

  // 选择只针对当前 filtered 列表内的 id；翻页/筛选后仍保留已选集合（不在视图内的不计入计数）
  const filteredIds = useMemo(() => filtered.map((r) => r.id), [filtered]);
  const visibleSelected = useMemo(
    () => filteredIds.filter((id) => selected.has(id)),
    [filteredIds, selected],
  );
  const allSelected = filteredIds.length > 0 && visibleSelected.length === filteredIds.length;

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
        for (const id of filteredIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });
  };

  const runDelete = async (ids: string[]) => {
    setBusy(true);
    try {
      await api.deleteRecords(ids.length > 0 ? ids : undefined);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteSelected = () => {
    if (visibleSelected.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${visibleSelected.length} 条会话记录？此操作不可撤销。`))
      return;
    void runDelete(visibleSelected);
  };

  const onClearAll = () => {
    if (records.length === 0) return;
    if (!window.confirm(`确定清空全部 ${records.length} 条会话记录？此操作不可撤销。`)) return;
    void runDelete([]);
  };

  const hasFilter = Boolean(query || startDate || endDate);

  if (viewing) {
    return <SessionDetailView id={viewing} onBack={() => setViewing(null)} />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶部导航：返回 + 标题 + 刷新 */}
      <NavBar
        title="会话记录"
        onBack={onBack}
        right={
          <button
            onClick={load}
            className="flex h-9 w-9 items-center justify-center rounded-full text-info-text hover:bg-info-bg active:opacity-60"
            title="刷新"
          >
            ⟳
          </button>
        }
      />

      <div className="flex-shrink-0 px-4 pt-3 pb-1">
        <p className="text-[13px] text-ink-dim">
          consult_experts / brainstorm / brainstorm_followup 的调用留痕。
        </p>
      </div>

      {/* Search */}
      <div className="px-4 pb-1">
        <div className="flex items-center rounded-xl bg-hover px-3 py-2">
          <span className="text-ink-faint">🔍</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索提问 / 工具 / 会话 id…"
            className="ml-2 flex-1 bg-transparent text-[15px] outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-ink-faint">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 时间区间筛选 */}
      <div className="flex items-center gap-2 px-4 py-1.5">
        <span className="shrink-0 text-[13px] text-ink-faint">时间</span>
        <input
          type="date"
          value={startDate}
          max={endDate || undefined}
          onChange={(e) => setStartDate(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line bg-island-strong px-2.5 py-1.5 text-[13px] text-ink-mid outline-none focus:border-info"
        />
        <span className="text-ink-faint">—</span>
        <input
          type="date"
          value={endDate}
          min={startDate || undefined}
          onChange={(e) => setEndDate(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line bg-island-strong px-2.5 py-1.5 text-[13px] text-ink-mid outline-none focus:border-info"
        />
        {(startDate || endDate) && (
          <button
            onClick={() => {
              setStartDate("");
              setEndDate("");
            }}
            className="shrink-0 rounded-full bg-hover px-2 py-1 text-[12px] text-ink-dim hover:bg-pressed"
          >
            清除
          </button>
        )}
      </div>

      {/* 多选 / 批量删除 / 清空工具条 */}
      <div className="flex items-center gap-2 px-4 py-1.5">
        <button
          onClick={toggleSelectAll}
          disabled={filteredIds.length === 0}
          className="flex items-center gap-1.5 text-[13px] text-ink-mid disabled:opacity-40"
        >
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border ${
              allSelected ? "border-info bg-info" : "border-line bg-island-strong"
            }`}
          >
            {allSelected && <span className="text-[10px] leading-none text-on-solid">✓</span>}
          </span>
          全选
        </button>
        <span className="text-[12px] text-ink-faint">
          {visibleSelected.length > 0
            ? `已选 ${visibleSelected.length} / ${filteredIds.length} 条`
            : `共 ${filteredIds.length} 条`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onDeleteSelected}
            disabled={visibleSelected.length === 0 || busy}
            className="rounded-lg bg-bad-bg px-3 py-1.5 text-[13px] font-medium text-bad-text hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            删除所选
          </button>
          <button
            onClick={onClearAll}
            disabled={records.length === 0 || busy}
            className="rounded-lg bg-hover px-3 py-1.5 text-[13px] font-medium text-ink-mid hover:bg-pressed disabled:cursor-not-allowed disabled:opacity-40"
          >
            清空全部
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {loading ? (
          <EmptyState icon="⏳" title="加载中…" />
        ) : error ? (
          <EmptyState icon="⚠️" title="加载失败" subtitle={error} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="🗂️"
            title={hasFilter ? "没有匹配的记录" : "还没有会话记录"}
            subtitle={hasFilter ? "换个条件试试" : "调用 MCP 工具后会自动落盘"}
          />
        ) : (
          <Card>
            {filtered.map((r, i) => {
              const checked = selected.has(r.id);
              return (
                <div
                  key={r.id}
                  onClick={() => setViewing(r.id)}
                  className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-island-strong active:bg-hover"
                  style={{
                    borderBottom: i === filtered.length - 1 ? "none" : "1px solid var(--border-color)",
                  }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSelect(r.id);
                    }}
                    aria-label={checked ? "取消选择" : "选择"}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border"
                    style={{
                      borderColor: checked ? "var(--accent-blue)" : "var(--border-color)",
                      background: checked ? "var(--accent-blue)" : "var(--surface-island-strong)",
                    }}
                  >
                    {checked && <span className="text-[11px] leading-none text-on-solid">✓</span>}
                  </button>
                  <span className="shrink-0 text-xl">{TOOL_ICON[r.tool] ?? "📝"}</span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-medium text-ink">
                      {r.prompt}
                    </span>
                    <p className="mt-0.5 truncate text-[13px] leading-relaxed text-ink-dim">
                      {`${TOOL_LABEL[r.tool] ?? r.tool} · ${fmtTime(r.startedAt)} · ${fmtBytes(
                        r.sizeBytes,
                      )}`}
                    </p>
                  </div>
                  <span className="shrink-0 text-[18px] leading-none text-ink-faint">›</span>
                </div>
              );
            })}
          </Card>
        )}
      </div>
    </div>
  );
}

// ── 详情视图：事件流按轮次分组渲染 ──

function SessionDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<{ id: string; events: RecordEvent[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .getRecord(id)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  const meta = detail?.events.find((e): e is SessionMeta => e.type === "meta") ?? null;
  const done = detail?.events.find((e) => e.type === "done") ?? null;
  const body = useMemo(
    () => (detail?.events ?? []).filter((e) => e.type !== "meta" && e.type !== "done"),
    [detail],
  );

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-dim">加载中…</div>;
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-ink-dim">
        <span className="text-4xl opacity-40">⚠️</span>
        <p>{error}</p>
        <button onClick={onBack} className="rounded-lg bg-pressed px-4 py-1.5 text-ink-mid">
          返回列表
        </button>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <NavBar title={TOOL_LABEL[meta?.tool ?? ""] ?? meta?.tool ?? "会话"} onBack={onBack} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {/* 元信息 */}
        <SectionLabel>提问</SectionLabel>
        <Card>
          <div className="px-4 py-3">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
              {meta?.prompt ?? "（无）"}
            </p>
            {meta?.context && (
              <p className="mt-2 whitespace-pre-wrap rounded-lg bg-island-strong px-3 py-2 text-[13px] leading-relaxed text-ink-dim">
                {meta.context}
              </p>
            )}
          </div>
        </Card>

        <SectionLabel>会话信息</SectionLabel>
        <Card>
          <InfoRow label="会话 id" value={<span className="font-mono text-[13px]">{detail.id}</span>} isLast={false} />
          <InfoRow
            label="工具"
            value={TOOL_LABEL[meta?.tool ?? ""] ?? meta?.tool ?? "—"}
            isLast={false}
          />
          <InfoRow label="开始时间" value={meta ? fmtTime(meta.startedAt) : "—"} isLast={false} />
          {meta?.mode && <InfoRow label="模式" value={meta.mode} isLast={false} />}
          {meta?.rounds !== undefined && <InfoRow label="轮次" value={String(meta.rounds)} isLast={false} />}
          {meta?.degraded && <InfoRow label="降级" value="是" isLast={false} />}
          <InfoRow
            label="结束状态"
            value={
              done && "status" in done ? (
                <span className={`rounded px-1.5 py-0.5 text-[12px] ${STATUS_STYLE[done.status] ?? "bg-hover text-ink-mid"}`}>
                  {STATUS_LABEL[done.status] ?? done.status}
                </span>
              ) : (
                <span className="text-ink-faint">未完成</span>
              )
            }
            isLast={true}
          />
        </Card>

        {/* 事件流 */}
        <SectionLabel>事件流</SectionLabel>
        {body.length === 0 ? (
          <EmptyState icon="📭" title="没有事件" subtitle="会话可能刚创建或无专家回复" />
        ) : (
          <div className="space-y-2">
            {body.map((ev, i) => (
              <EventItem
                key={i}
                event={ev}
                expanded={expanded[String(i)] ?? false}
                onToggle={() => setExpanded((prev) => ({ ...prev, [String(i)]: !prev[String(i)] }))}
              />
            ))}
          </div>
        )}

        {/* 最终报告 */}
        {done && "report" in done && done.report && (
          <>
            <SectionLabel>最终报告</SectionLabel>
            <Card>
              <div className="px-4 py-3">
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink-mid">
                  {done.report}
                </pre>
              </div>
            </Card>
          </>
        )}

        {/* 总用量 */}
        {done && "usage" in done && done.usage && fmtUsage(done.usage) && (
          <p className="px-1 pt-3 text-[12px] text-ink-faint">
            Token 用量：{fmtUsage(done.usage)}
          </p>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value, isLast }: { label: string; value: React.ReactNode; isLast: boolean }) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-2.5"
      style={{ borderBottom: isLast ? "none" : "1px solid var(--border-color)" }}
    >
      <span className="shrink-0 text-[14px] text-ink-dim">{label}</span>
      <span className="min-w-0 truncate text-right text-[14px] text-ink">{value}</span>
    </div>
  );
}

function EventItem({
  event,
  expanded,
  onToggle,
}: {
  event: RecordEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (event.type === "cards") {
    return (
      <Card>
        <div className="px-4 py-2.5">
          <p className="text-[13px] text-ink-faint">选用角色卡</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {event.cards.map((c) => (
              <span
                key={c.cardId}
                className="rounded-full bg-info-bg px-2.5 py-1 text-[12px] text-info-text"
                title={`${c.expertName} × ${c.modelId} (${c.provider})`}
              >
                {c.cardName}
              </span>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  if (event.type === "card_result") {
    return (
      <Card>
        <button onClick={onToggle} className="w-full px-4 py-2.5 text-left">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${event.ok ? "bg-ok-bg text-ok-text" : "bg-bad-bg text-bad-text"}`}>
              {event.ok ? "成功" : "失败"}
            </span>
            <span className="truncate font-mono text-[12px] text-ink-dim">{event.cardId}</span>
            {event.usage && (
              <span className="ml-auto shrink-0 text-[11px] text-ink-faint">{fmtUsage(event.usage)}</span>
            )}
          </div>
        </button>
        {expanded && (
          <div className="border-t border-line px-4 py-2.5">
            {event.error ? (
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-bad-text">{event.error}</p>
            ) : (
              <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink-mid">
                {event.content ?? "（无内容）"}
              </pre>
            )}
          </div>
        )}
      </Card>
    );
  }

  if (event.type === "turn") {
    return (
      <div className="flex gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hover text-base">
          {event.icon || "🤖"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-ink">{event.expertName}</span>
            <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-ink-dim">
              第 {event.round} 轮
            </span>
            {event.usage && (
              <span className="ml-auto text-[11px] text-ink-faint">{fmtUsage(event.usage)}</span>
            )}
          </div>
          <div className="mt-1 rounded-xl bg-island-strong px-3 py-2">
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink-mid">
              {event.content}
            </pre>
          </div>
        </div>
      </div>
    );
  }

  if (event.type === "vote") {
    // 互评投票（R1）：与 turn 同构的简单展示。
    return (
      <div className="flex gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hover text-base">
          {event.icon || "🗳️"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-ink">{event.expertName}</span>
            <span className="rounded bg-info-bg px-1.5 py-0.5 text-[10px] text-info-text">
              互评投票
            </span>
            {event.usage && (
              <span className="ml-auto text-[11px] text-ink-faint">{fmtUsage(event.usage)}</span>
            )}
          </div>
          <div className="mt-1 rounded-xl bg-island-strong px-3 py-2">
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink-mid">
              {event.content}
            </pre>
          </div>
        </div>
      </div>
    );
  }

  if (event.type === "round_end") {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="h-px flex-1 bg-pressed" />
        <span className="text-[11px] text-ink-faint">
          第 {event.round} / {event.total} 轮结束
        </span>
        <div className="h-px flex-1 bg-pressed" />
      </div>
    );
  }

  if (event.type === "summary") {
    return (
      <Card>
        <div className="px-4 py-2.5">
          <p className="text-[13px] text-ink-faint">总结</p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink-mid">
            {event.content}
          </pre>
        </div>
      </Card>
    );
  }

  return null;
}
