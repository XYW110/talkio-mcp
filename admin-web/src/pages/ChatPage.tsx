import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MessageCircle, Rocket, TriangleAlert } from "lucide-react";
import type { CardConfig } from "../types";
import { api } from "../api";
import { Card, SectionLabel } from "../components/ui";
import { Button, SelectInput } from "../components/controls";

interface Props {
  cards: CardConfig[];
}

type ChatStatus = "idle" | "running" | "done" | "error";

const MODES: { value: "debate" | "relay"; label: string; desc: string }[] = [
  { value: "debate", label: "辩论", desc: "每位专家逐轮围绕话题发表观点" },
  { value: "relay", label: "接龙", desc: "专家依次接力，基于上一位的发言继续" },
];

const MAX_CARDS = 6;

export function ChatPage({ cards }: Props) {
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<"debate" | "relay">("debate");
  const [rounds, setRounds] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [progress, setProgress] = useState<{ round: number; total: number } | null>(null);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const esRef = useRef<EventSource | null>(null);

  // 离开页面时关闭 SSE
  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const enabledCards = cards.filter((c) => c.enabled);

  const toggleCard = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          if (next.size >= MAX_CARDS) {
            window.alert(`最多选择 ${MAX_CARDS} 张角色卡`);
            return prev;
          }
          next.add(id);
        }
        return next;
      });
    },
    [],
  );

  const start = useCallback(async () => {
    const t = topic.trim();
    if (!t) {
      window.alert("请填写讨论话题");
      return;
    }
    if (selected.size === 0) {
      window.alert("请至少选择一张角色卡");
      return;
    }
    setBusy(true);
    setStatus("running");
    setProgress(null);
    setReport("");
    setError("");
    try {
      const { sessionId } = await api.runBrainstorm({
        topic: t,
        mode,
        rounds,
        summarize: true,
        cards: [...selected],
      });
      const es = api.chatEventSource(sessionId);
      esRef.current = es;

      es.addEventListener("progress", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            type?: string;
            round?: number;
            total?: number;
          };
          if (data.round !== undefined && data.total !== undefined) {
            setProgress({ round: data.round, total: data.total });
          }
        } catch {
          // 忽略无法解析的进度帧
        }
      });

      es.addEventListener("done", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            isError?: boolean;
            report?: string;
          };
          setReport(data.report ?? "");
          setStatus(data.isError ? "error" : "done");
          if (data.isError) setError("群聊未能产出有效讨论，请检查专家/模型配置。");
        } catch {
          setError("收到无效的完成事件");
          setStatus("error");
        }
        es.close();
        esRef.current = null;
      });

es.addEventListener("error", (ev) => {
        // 带 data 的错误事件：展示后端 message；无 data 的网络断开：提示重试。
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            message?: string;
          };
          setError(data.message ?? "群聊执行出错");
          setStatus("error");
        } catch {
          setError("连接中断，请稍后重试");
          setStatus("error");
        }
        es.close();
        esRef.current = null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      setBusy(false);
    }
}, [topic, mode, rounds, selected]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-5">
        <div className="mb-1">
          <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-tight text-ink">
            <MessageCircle size={20} aria-hidden="true" />
            发起群聊
          </h1>
          <p className="mt-0.5 text-[13px] text-ink-dim">
            填一个话题，选角色卡，让多位专家开会讨论并收敛总结
          </p>
        </div>

        {/* 状态提示 */}
        {status === "running" && (
          <div className="mt-4 mb-4 rounded-xl border border-info bg-info-bg px-4 py-3">
            <div className="flex items-center gap-2 text-[14px] font-medium text-info-text">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-info" />
              群聊进行中
              {progress && (
                <span className="ml-auto text-[13px] font-normal">
                  第 {progress.round} / {progress.total} 轮
                </span>
              )}
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-pressed">
              <div
                className="h-full rounded-full bg-info transition-all duration-300"
                style={{
                  width: progress
                    ? `${Math.min(100, (progress.round / progress.total) * 100)}%`
                    : "5%",
                }}
              />
            </div>
            <p className="mt-1.5 text-[12px] text-info-text">
              每位专家每轮约需数秒~数十秒，请稍候…
            </p>
          </div>
        )}

        {status === "error" && error && (
          <div className="mt-4 mb-4 rounded-xl border border-bad bg-bad-bg px-4 py-3">
            <div className="flex items-center gap-2 text-[14px] font-medium text-bad-text">
              <TriangleAlert size={16} aria-hidden="true" /> 群聊出错
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-bad-text">{error}</p>
          </div>
        )}

        {/* 报告 */}
        {status === "done" && report && (
          <div className="mt-4 mb-6">
            <SectionLabel>讨论总结</SectionLabel>
            <Card className="p-4">
              <h2 className="mb-2 text-[16px] font-bold text-ink">### 讨论总结</h2>
              <pre className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-ink-mid">
                {report}
              </pre>
            </Card>
          </div>
        )}

        {/* 表单 */}
        <div className="mt-4">
          <SectionLabel>开始新讨论</SectionLabel>
          <Card className="p-4">
            <label className="mb-1 block text-[13px] font-medium text-ink-mid">讨论话题</label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={3}
              disabled={status === "running"}
              placeholder="例如：如何设计一个高效的多智能体协作框架？"
              className="w-full resize-none rounded-[10px] border border-line bg-island-strong px-3 py-2.5 text-[15px] text-ink outline-none  focus:bg-island-strong disabled:opacity-50"
            />

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[13px] font-medium text-ink-mid">
                  讨论轮数
                </label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setRounds((r) => Math.max(1, r - 1))}
                    disabled={status === "running"}
                    className="h-10 w-10 rounded-[8px] border border-line bg-island-strong text-[18px] text-ink-mid hover:bg-hover disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="w-8 text-center text-[16px] font-semibold text-ink">
                    {rounds}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRounds((r) => Math.min(5, r + 1))}
                    disabled={status === "running"}
                    className="h-10 w-10 rounded-[8px] border border-line bg-island-strong text-[18px] text-ink-mid hover:bg-hover disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium text-ink-mid">
                  讨论模式
                </label>
                <SelectInput
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "debate" | "relay")}
                  disabled={status === "running"}
                  aria-label="讨论模式"
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </SelectInput>
                <p className="mt-1 text-[12px] text-ink-faint">
                  {MODES.find((m) => m.value === mode)?.desc}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label className="mb-1 block text-[13px] font-medium text-ink-mid">
                参与角色卡 <span className="text-ink-faint">（最多 {MAX_CARDS} 张）</span>
              </label>
              {enabledCards.length === 0 ? (
                <p className="rounded-[10px] bg-island-strong px-3 py-3 text-[13px] text-ink-faint">
                  暂无已启用的角色卡，请先在「角色卡」页启用并保存。
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {enabledCards.map((c) => {
                    const checked = selected.has(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        disabled={status === "running"}
                        onClick={() => toggleCard(c.id)}
                        className={`flex items-center gap-2 rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                          checked
                            ? "border-info bg-info-bg"
                            : "border-line bg-island-strong hover:bg-island-strong"
                        } disabled:opacity-50`}
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border"
                          style={{
                            borderColor: checked ? "var(--accent-blue)" : "var(--border-color)",
                            background: checked ? "var(--accent-blue)" : "var(--surface-island-strong)",
                          }}
                        >
                          {checked && (
                            <Check size={12} className="leading-none text-on-solid" aria-hidden="true" />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-medium text-ink">
                            {c.name}
                          </span>
                          <span className="block truncate text-[12px] text-ink-faint">
                            角色卡 · 已启用
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <Button
              variant="primary"
              onClick={start}
              disabled={busy || status === "running" || selected.size === 0}
              className="mt-5 w-full rounded-xl py-3 text-[14px] font-semibold"
            >
              {status === "running" ? "群聊进行中…" : busy ? "正在发起…" : (
                <span className="inline-flex items-center gap-1.5">
                  <Rocket size={16} aria-hidden="true" />
                  发起群聊
                </span>
              )}
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}