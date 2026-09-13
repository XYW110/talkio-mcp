import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { UsageAggregate, UsageRecord } from "../types";
import { Card, EmptyState, NavBar, SectionLabel } from "../components/ui";
import { Button, SelectInput } from "../components/controls";

// ── 本地价格表（localStorage）：modelId → { input, output }，单位 元 / 百万 token ──

const PRICE_TABLE_KEY = "talkio-price-table";

type PriceEntry = { input: number; output: number };
type PriceTable = Record<string, PriceEntry>;

/** 从 localStorage 读取价格表；缺失 / 损坏时按空表处理，页面不报错。 */
function loadPriceTable(): PriceTable {
  try {
    const raw = window.localStorage.getItem(PRICE_TABLE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PriceTable = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = v as PriceEntry | null;
      if (
        rec &&
        typeof rec === "object" &&
        typeof rec.input === "number" &&
        typeof rec.output === "number"
      ) {
        out[k] = { input: rec.input, output: rec.output };
      }
    }
    return out;
  } catch (e) {
    // localStorage 不可用 / 内容损坏：降级为空表，不阻塞页面
    console.warn("[usage] 价格表读取失败", e);
    return {};
  }
}

// ── 格式化辅助 ──

/** 入 + 出 token 总量（usage 缺失字段按 0 计，仅用于展示排序）。 */
function sumTokens(u?: UsageRecord): number {
  return (u?.promptTokens ?? 0) + (u?.completionTokens ?? 0);
}

function fmtTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}

function fmtUsage(u?: UsageRecord): string {
  if (!u) return "—";
  const parts: string[] = [];
  if (u.promptTokens !== undefined) parts.push(`入 ${fmtTokens(u.promptTokens)}`);
  if (u.completionTokens !== undefined) parts.push(`出 ${fmtTokens(u.completionTokens)}`);
  return parts.length > 0 ? parts.join(" / ") : "—";
}

/** 估算成本（元）：prompt×input + completion×output，单位 元 / 百万 token。 */
function fmtCost(u: UsageRecord, price: PriceEntry): string {
  const cost =
    ((u.promptTokens ?? 0) / 1_000_000) * price.input +
    ((u.completionTokens ?? 0) / 1_000_000) * price.output;
  return `≈ ¥${cost > 0 && cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

export function UsagePage({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<UsageAggregate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [priceTable, setPriceTable] = useState<PriceTable>(() => loadPriceTable());
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const usage = await api.getUsage(days);
      setData(usage);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  // toast 自动消失（3s）
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // 按天条形的最大日总量（条宽比例基准），至少 1 避免 0 除
  const maxDay = useMemo(
    () => Math.max(1, ...(data?.byDay ?? []).map((d) => sumTokens(d.usage))),
    [data],
  );

  const openPriceEditor = () => {
    setPriceDraft(JSON.stringify(priceTable, null, 2));
    setPriceOpen(true);
  };

  /** 保存价格表：解析失败 toast 且不保存（草稿保留），成功写 localStorage 并即时生效。 */
  const savePriceTable = () => {
    try {
      const parsed = JSON.parse(priceDraft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("价格表需要是 { \"模型ID\": { \"input\": 数字, \"output\": 数字 } } 形式的 JSON 对象");
      }
      const next: PriceTable = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const rec = v as PriceEntry | null;
        if (
          !rec ||
          typeof rec !== "object" ||
          typeof rec.input !== "number" ||
          typeof rec.output !== "number" ||
          !Number.isFinite(rec.input) ||
          !Number.isFinite(rec.output) ||
          rec.input < 0 ||
          rec.output < 0
        ) {
          throw new Error(`模型 "${k}" 的价格需要是非负数字的 { input, output }`);
        }
        next[k] = { input: rec.input, output: rec.output };
      }
      window.localStorage.setItem(PRICE_TABLE_KEY, JSON.stringify(next));
      setPriceTable(next);
      setPriceOpen(false);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <NavBar
        title="用量"
        onBack={onBack}
        right={
          <div className="flex items-center gap-1">
            <Button
              variant="icon"
              onClick={openPriceEditor}
              aria-label="价格表（成本估算）"
              title="价格表（成本估算）"
            >
              ¥
            </Button>
            <Button variant="icon" onClick={load} aria-label="刷新" title="刷新">
              ⟳
            </Button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {loading ? (
          <EmptyState icon="⏳" title="加载中…" />
        ) : error ? (
          <EmptyState icon="⚠️" title="加载失败" subtitle={error} />
        ) : !data ? null : (
          <>
            {/* 顶部统计岛卡：总 token / 会话与调用 / 时间窗 */}
            <div className="grid grid-cols-2 gap-2 pt-3 md:grid-cols-3">
              <div className="rounded-xl border border-line bg-island-strong p-4">
                <p className="text-[12px] text-ink-faint">总 Token（{data.days} 天）</p>
                <p className="mt-1 text-[20px] font-bold text-ink">
                  {fmtTokens(sumTokens(data.total))}
                </p>
                <p className="mt-1 text-[12px] text-ink-dim">{fmtUsage(data.total)}</p>
              </div>
              <div className="rounded-xl border border-line bg-island-strong p-4">
                <p className="text-[12px] text-ink-faint">会话 / 调用</p>
                <p className="mt-1 text-[20px] font-bold text-ink">
                  {fmtTokens(data.sessionCount)}
                  <span className="ml-1 text-[13px] font-normal text-ink-faint">会话</span>
                </p>
                <p className="mt-1 text-[12px] text-ink-dim">
                  {fmtTokens(data.callCount)} 次 LLM 调用
                </p>
              </div>
              <div className="col-span-2 rounded-xl border border-line bg-island-strong p-4 md:col-span-1">
                <p className="text-[12px] text-ink-faint">统计时间窗</p>
                <SelectInput
                  className="mt-2"
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  aria-label="统计时间窗"
                >
                  <option value={7}>近 7 天</option>
                  <option value={30}>近 30 天</option>
                  <option value={90}>近 90 天</option>
                </SelectInput>
                {data.skipped > 0 && (
                  <p className="mt-1.5 text-[12px] text-warn-text">
                    {data.skipped} 个记录文件解析失败已跳过
                  </p>
                )}
              </div>
            </div>

            {/* 按天消耗：横向 div 条形（宽度 = 当日总量 / 最大日总量） */}
            <SectionLabel>按天消耗</SectionLabel>
            {data.byDay.length === 0 ? (
              <Card>
                <div className="px-4 py-4 text-[13px] text-ink-dim">时间窗内没有用量数据</div>
              </Card>
            ) : (
              <Card>
                <div className="px-4 py-2">
                  {data.byDay.map((d, i) => {
                    const total = sumTokens(d.usage);
                    return (
                      <div
                        key={d.date}
                        className="py-2"
                        style={{
                          borderBottom:
                            i === data.byDay.length - 1 ? "none" : "1px solid var(--border-color)",
                        }}
                      >
                        <div className="flex items-center justify-between text-[13px]">
                          <span className="text-ink-mid">{d.date}</span>
                          <span className="text-ink-dim">{fmtTokens(total)}</span>
                        </div>
                        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-hover">
                          <div
                            className="h-full rounded-full bg-info"
                            style={{
                              width:
                                total === 0
                                  ? "0%"
                                  : `${Math.max(2, Math.round((total / maxDay) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* 排行：卡片 / 模型（usage 降序） */}
            <SectionLabel>排行</SectionLabel>
            <div className="grid gap-2 md:grid-cols-2">
              {/* 按角色卡 */}
              <Card>
                <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium text-ink">
                  按角色卡
                </div>
                {data.byCard.length === 0 ? (
                  <div className="px-4 py-4 text-[13px] text-ink-dim">暂无数据</div>
                ) : (
                  data.byCard.map((c, i) => {
                    // 命中本地价格表时追加估算成本；未命中不显示
                    const price = priceTable[c.modelId];
                    return (
                      <div
                        key={c.cardId}
                        className="flex items-center gap-2 px-4 py-2.5"
                        style={{
                          borderBottom:
                            i === data.byCard.length - 1 ? "none" : "1px solid var(--border-color)",
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[14px] font-medium text-ink">
                              {c.cardName}
                            </span>
                            <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] text-ink-dim">
                              {c.provider || "未知"}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-[12px] text-ink-faint">
                            {c.calls} 次调用 · {c.sessions} 个会话
                            {c.modelId ? ` · ${c.modelId}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-[13px] text-ink">{fmtTokens(sumTokens(c.usage))}</p>
                          {price && (
                            <p className="text-[11px] text-ink-faint">{fmtCost(c.usage, price)}</p>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </Card>
              {/* 按模型 */}
              <Card>
                <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium text-ink">
                  按模型
                </div>
                {data.byModel.length === 0 ? (
                  <div className="px-4 py-4 text-[13px] text-ink-dim">暂无数据</div>
                ) : (
                  data.byModel.map((m, i) => (
                    <div
                      key={m.modelId}
                      className="flex items-center gap-2 px-4 py-2.5"
                      style={{
                        borderBottom:
                          i === data.byModel.length - 1 ? "none" : "1px solid var(--border-color)",
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[13px] text-ink">
                            {m.modelId}
                          </span>
                          <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] text-ink-dim">
                            {m.provider || "未知"}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[12px] text-ink-faint">{m.calls} 次调用</p>
                      </div>
                      <span className="shrink-0 text-[13px] text-ink">
                        {fmtTokens(sumTokens(m.usage))}
                      </span>
                    </div>
                  ))
                )}
              </Card>
            </div>

            {data.skipped > 0 && (
              <p className="px-1 pt-3 text-[12px] text-ink-faint">
                另有 {data.skipped} 个损坏的记录文件已跳过，未计入以上统计。
              </p>
            )}
          </>
        )}
      </div>

      {/* 价格表编辑浮层 */}
      {priceOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setPriceOpen(false)}
        >
          <div
            className="island island-strong w-full max-w-lg p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[16px] font-semibold text-ink">价格表（元 / 百万 token）</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
              JSON 格式：{"{"}"模型ID": {"{"}"input": 输入价, "output": 输出价{"}"}{"}"}
              。命中模型的角色卡会显示估算成本；仅保存在浏览器本地（localStorage），不进后端。
            </p>
            <textarea
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              rows={10}
              spellCheck={false}
              className="mt-2 w-full rounded-lg border border-line bg-island px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-info"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPriceOpen(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={savePriceTable}>
                保存
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* toast（价格表解析失败等），样式对齐 App 的 ErrorBanner */}
      {toast && (
        <div className="fixed top-4 left-1/2 z-[100] flex -translate-x-1/2 items-center rounded-xl bg-bad px-4 py-2.5 text-on-solid shadow-lg">
          <span className="text-sm">{toast}</span>
        </div>
      )}
    </div>
  );
}
