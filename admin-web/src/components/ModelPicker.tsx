import { useCallback, useState } from "react";
import { api } from "../api";
import type { ProbeModel, ProviderConfig } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (modelId: string) => void;
  selectedModelId?: string;
  provider: [string, ProviderConfig] | undefined;
}

export function ModelPicker({
  open,
  onClose,
  onSelect,
  selectedModelId,
  provider,
}: Props) {
  const [models, setModels] = useState<ProbeModel[]>([]);
  const [search, setSearch] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  // 打开时复位状态；每个 provider 只清零探测结果
  // (no auto-reset of probe list once loaded for the current provider)
  const probe = useCallback(async () => {
    if (!provider) return;
    if (!apiKey.trim()) {
      setError("请先填写该 provider 的 API Key（仅用于探测，不会写入配置文件）");
      return;
    }
    setProbing(true);
    setError(null);
    try {
      const list = await api.probeModels({ baseUrl: provider[1].baseUrl, apiKey: apiKey.trim() });
      setModels(list);
      setLoaded(true);
      if (list.length === 0) setError("该端点没有返回任何模型");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    } finally {
      setProbing(false);
    }
  }, [provider, apiKey]);

  if (!open) return null;

  const filtered = search.trim()
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(search.toLowerCase()) ||
          (m.ownedBy ?? "").toLowerCase().includes(search.toLowerCase()),
      )
    : models;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
<div className="flex max-h-[90vh] w-full max-w-sm flex-col overflow-hidden rounded-t-2xl bg-island-strong shadow-2xl sm:rounded-2xl md:max-w-lg">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center border-b border-line px-2 py-2.5">
          <button onClick={close} className="min-w-[64px] px-2 text-left text-[15px] text-info-text">
            取消
          </button>
          <span className="flex-1 text-center text-[16px] font-semibold">选择模型</span>
          <span className="min-w-[64px]" />
        </div>

        {/* Provider hint */}
        {provider && (
          <div className="border-b border-line bg-island-strong px-4 py-2">
            <p className="truncate text-[12px] text-ink-dim">
              {provider[0]} · {provider[1].baseUrl} · 环境变量 {provider[1].apiKeyEnv}
            </p>
          </div>
        )}

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col p-4">
          {!loaded && (
            <>
              <p className="mb-2 text-[12px] leading-relaxed text-ink-dim">
                填写该 provider 的 API Key 后点击「拉取模型」。key 仅用于本次探测，不会写入
                experts.json。
              </p>
              <div className="mb-2 flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && probe()}
                  placeholder={`${provider?.[1].apiKeyEnv ?? "API_KEY"} 的值`}
                  className="flex-1 rounded-xl border border-line bg-island-strong px-3 py-2 text-[14px] outline-none "
                />
                <button
                  onClick={probe}
                  disabled={probing}
                  className="rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-on-solid disabled:opacity-50"
                >
                  {probing ? "拉取中…" : "拉取模型"}
                </button>
              </div>
            </>
          )}

          {error && <p className="mb-2 text-[12px] text-bad">{error}</p>}

          {loaded && models.length > 0 && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型…"
              autoFocus
              className="mb-2 w-full rounded-xl bg-hover px-3 py-2 text-sm outline-none "
            />
          )}

          {/* Model list */}
          <div className="flex-1 overflow-y-auto">
            {loaded && models.length === 0 && !error && (
              <p className="py-8 text-center text-sm text-ink-faint">该端点没有返回模型</p>
            )}
            {!loaded && !error && (
              <p className="py-8 text-center text-sm text-ink-faint">
                填写 key 后点击「拉取模型」
              </p>
            )}
            {loaded &&
              filtered.map((m) => {
                const isSelected = m.id === selectedModelId;
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      onSelect(m.id);
                      close();
                    }}
                    className="flex w-full items-center justify-between px-1 py-2.5 text-left hover:bg-island-strong"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[13px] text-ink">{m.id}</p>
                      {m.ownedBy && (
                        <p className="truncate text-[11px] text-ink-faint">{m.ownedBy}</p>
                      )}
                    </div>
                    {isSelected && <span className="text-info-text">✓</span>}
                  </button>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}