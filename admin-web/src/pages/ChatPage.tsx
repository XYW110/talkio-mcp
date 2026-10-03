import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, MessageCircle, Rocket, TriangleAlert } from "lucide-react";
import type { CardConfig } from "../types";
import { api } from "../api";
import { Card, SectionLabel, SelectCheckbox } from "../components/ui";
import { Button, SelectInput } from "../components/controls";
import { useFeedback } from "../components/feedback";

interface Props {
  cards: CardConfig[];
}

type ChatStatus = "idle" | "running" | "done" | "error";

/** 实况时间线项（groupchat-p4 R2）：turn = 卡粒度发言事件，round = 轮边界。 */
type TimelineItem =
  | { kind: "round"; round: number; total: number; seq: number }
  | {
      kind: "turn";
      round: number;
      expertName: string;
      ok: boolean;
      seq: number;
    };

/** 头像配色（字面量类名保证 Tailwind 不被 purge）：按专家名哈希取色。 */
const AVATAR_COLORS = [
  "bg-info-bg text-info-text",
  "bg-ok-bg text-ok-text",
  "bg-warn-bg text-warn-text",
] as const;

function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

const MODES: { value: "debate" | "relay"; label: string; desc: string }[] = [
  { value: "debate", label: "辩论", desc: "每位专家逐轮围绕话题发表观点" },
  { value: "relay", label: "接龙", desc: "专家依次接力，基于上一位的发言继续" },
];

const MAX_CARDS = 6;

export function ChatPage({ cards }: Props) {
  const { toast } = useFeedback();
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<"debate" | "relay">("debate");
  const [rounds, setRounds] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [progress, setProgress] = useState<{ round: number; total: number } | null>(null);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 实况时间线（groupchat-p4 R2）：turn 事件流 + 轮边界分隔。
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const seqRef = useRef(0);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);

  const esRef = useRef<EventSource | null>(null);

  // 新事件到达时滚动到时间线底部（群聊"向上滚"的感觉）。
  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [timeline]);

  // 离开页面时关闭 SSE
  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const enabledCards = cards.filter((c) => c.enabled);

  // setState updater 必须纯净：上限提示移到事件层，先判断再切换
  const toggleCard = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleCard = (id: string) => {
    if (!selected.has(id) && selected.size >= MAX_CARDS) {
      toast("error", `最多选择 ${MAX_CARDS} 张角色卡`);
      return;
    }
    toggleCard(id);
  };

  /** 复制讨论总结全文（R6.5）；clipboard 不可用时降级为失败 toast */
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      toast("success", "已复制讨论总结");
    } catch {
      toast("error", "复制失败");
    }
  };

  const start = useCallback(async () => {
    const t = topic.trim();
    if (!t) {
      toast("error", "请填写讨论话题");
      return;
    }
    if (selected.size === 0) {
      toast("error", "请至少选择一张角色卡");
      return;
    }
    setBusy(true);
    setStatus("running");
    setProgress(null);
    setReport("");
    setError("");
    setTimeline([]);
    seqRef.current = 0;
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
          // progress 帧载荷 = StreamEvent（consult.card 在本页不会出现）。
          const data = JSON.parse((ev as MessageEvent).data) as {
            type?: string;
            round?: number;
            total?: number;
            expertName?: string;
            ok?: boolean;
          };
          if (data.type === "brainstorm.turn") {
            if (
              typeof data.round === "number" &&
              typeof data.expertName === "string" &&
              typeof data.ok === "boolean"
            ) {
              setTimeline((prev) => [
                ...prev,
                {
                  kind: "turn",
                  round: data.round!,
                  expertName: data.expertName!,
                  ok: data.ok!,
                  seq: seqRef.current++,
                },
              ]);
            }
          } else if (
            data.type === "brainstorm.round" &&
            data.round !== undefined &&
            data.total !== undefined
          ) {
            setProgress({ round: data.round, total: data.total });
            setTimeline((prev) => [
              ...prev,
              {
                kind: "round",
                round: data.round!,
                total: data.total!,
                seq: seqRef.current++,
              },
            ]);
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
}, [topic, mode, rounds, selected, toast]);

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

        {/* 发言实况时间线（groupchat-p4 R2）：进行中实时滚动；done 后保留供回看谁发言/谁缺席。 */}
        {timeline.length > 0 && (
          <div className="mt-4 mb-4">
            <SectionLabel>发言实况</SectionLabel>
            <Card className="p-3">
              <div className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
                {timeline.map((item) =>
                  item.kind === "turn" ? (
                    <div
                      key={item.seq}
                      className="flex items-center gap-2.5 rounded-lg bg-hover/50 px-2.5 py-1.5"
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full text-[13px] font-semibold ${avatarColor(item.expertName)}`}
                        aria-hidden="true"
                      >
                        {item.expertName.slice(0, 1)}
                      </span>
                      <span className="text-[13px] font-medium text-ink">
                        {item.expertName}
                      </span>
                      <span className="text-[11px] text-ink-faint">
                        第 {item.round} 轮
                      </span>
                      <span
                        className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          item.ok
                            ? "bg-ok-bg text-ok-text"
                            : "bg-bad-bg text-bad-text"
                        }`}
                      >
                        {item.ok ? "已发言" : "缺席"}
                      </span>
                    </div>
                  ) : (
                    <div key={item.seq} className="flex items-center gap-2 py-1">
                      <span className="h-px flex-1 bg-line" />
                      <span className="text-[11px] text-ink-faint">
                        第 {item.round} / {item.total} 轮结束
                      </span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  ),
                )}
                <div ref={timelineEndRef} />
              </div>
            </Card>
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
              <div className="mb-2 flex items-center justify-between gap-2">
                {/* 标题不带 ### 字面量（R2.1）；头部提供一键复制全文（R6.5） */}
                <h2 className="text-[16px] font-bold text-ink">讨论总结</h2>
                <Button
                  variant="icon"
                  className="!h-8 !w-8"
                  onClick={() => void copyReport()}
                  aria-label="复制讨论总结"
                  title="复制"
                >
                  <Copy size={15} aria-hidden="true" />
                </Button>
              </div>
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
                    const disabled = status === "running";
                    return (
                      // 外层用 div[role=button]：内部需嵌套 SelectCheckbox（本身是 button），
                      // 不能再用 button 包 button；键盘经 Enter/Space 触发（AC11）
                      <div
                        key={c.id}
                        role="button"
                        tabIndex={disabled ? -1 : 0}
                        aria-pressed={checked}
                        aria-disabled={disabled}
                        onClick={() => {
                          if (!disabled) handleToggleCard(c.id);
                        }}
                        onKeyDown={(e) => {
                          if (disabled) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleToggleCard(c.id);
                          }
                        }}
                        className={`flex cursor-pointer items-center gap-2 rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                          checked
                            ? "border-info bg-info-bg"
                            : "border-line bg-island-strong hover:bg-hover"
                        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <SelectCheckbox checked={checked} onClick={() => handleToggleCard(c.id)} disabled={disabled} />
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-medium text-ink">
                            {c.name}
                          </span>
                          <span className="block truncate text-[12px] text-ink-faint">
                            角色卡 · 已启用
                          </span>
                        </span>
                      </div>
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