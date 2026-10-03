import { useCallback, useEffect, useState } from "react";
import {
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api } from "../api";
import type { ExpertMemory } from "../types";
import { Card, EmptyState, NavBar } from "../components/ui";
import { Button, Pill } from "../components/controls";
import { useFeedback } from "../components/feedback";

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return iso;
  }
}

/**
 * 「专家记忆」页（groupchat-p4 R3）：只读总览 + 单专家清空。
 * 数据来自 GET /api/memory（含配置内空态专家）；清空走 DELETE /api/memory/:id（二次确认）。
 */
export function MemoryPage({ onBack }: { onBack: () => void }) {
  const { confirm, toast } = useFeedback();
  const [items, setItems] = useState<ExpertMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      setItems(await api.listMemory());
    } catch (e) {
      // memoryDir 未装配的部署：404「记忆未启用」给出定向提示，其余透传 message。
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clearOne = async (m: ExpertMemory) => {
    const yes = await confirm({
      title: `清空「${m.expertName}」的记忆？`,
      message: `将删除其 ${m.count} 条历史记忆（不可恢复）。该专家后续讨论将不再引用这些经验。`,
      confirmText: "清空",
      danger: true,
    });
    if (!yes) return;
    setClearing(m.expertId);
    try {
      await api.clearMemory(m.expertId);
      toast("success", `已清空「${m.expertName}」的记忆`);
      await load(true);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(null);
    }
  };

  const withMemory = items.filter((m) => m.count > 0);
  const empty = items.filter((m) => m.count === 0);

  return (
    <div className="flex h-full flex-col">
      <NavBar
        title="专家记忆"
        onBack={onBack}
        right={
          <Button
            variant="icon"
            className="!h-8 !w-8"
            onClick={() => void load(true)}
            disabled={loading || refreshing}
            aria-label="刷新"
            title="刷新"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {error ? (
          <EmptyState
            icon={<TriangleAlert size={40} />}
            title="记忆不可用"
            subtitle={error}
          />
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-ink-dim">
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            正在加载…
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={40} />}
            title="还没有专家"
            subtitle="先在「专家」页创建专家，他们参与讨论后就会在这里沉淀记忆"
          />
        ) : withMemory.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={40} />}
            title="还没有沉淀任何记忆"
            subtitle="发起一次群聊（多轮讨论）后，专家会在末轮沉淀跨会话经验，自动出现在这里"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {withMemory.map((m) => (
              <Card key={m.expertId} className="p-4">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="text-[18px]" aria-hidden="true">
                    {m.icon || "🤖"}
                  </span>
                  <span className="text-[14px] font-semibold text-ink">{m.expertName}</span>
                  <Pill>{m.count} 条</Pill>
                  <Button
                    variant="icon"
                    className="ml-auto !h-8 !w-8 hover:!bg-bad-bg"
                    onClick={() => void clearOne(m)}
                    disabled={clearing === m.expertId}
                    aria-label={`清空 ${m.expertName} 的记忆`}
                    title="清空记忆"
                  >
                    {clearing === m.expertId ? (
                      <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 size={15} aria-hidden="true" />
                    )}
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {m.entries.map((entry, i) => (
                    <div
                      key={`${entry.ts}-${i}`}
                      className="flex items-start gap-2.5 rounded-lg bg-hover/50 px-2.5 py-1.5"
                    >
                      <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-ink-faint">
                        {fmtDate(entry.ts)}
                      </span>
                      <span className="text-[13px] leading-relaxed text-ink-mid">
                        {entry.text}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            ))}

            {empty.length > 0 && (
              <p className="px-1 pb-2 text-[12px] leading-relaxed text-ink-faint">
                暂无记忆的专家：{empty.map((m) => m.expertName).join("、")}
                ——参与一次多轮讨论后会出现
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
