import { useCallback, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api";
import { sortByTierDesc } from "../types";
import type { ProbeModel, ProviderConfig } from "../types";
import { Button, TextInput } from "./controls";
import { Modal } from "./overlays";

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

  const filtered = sortByTierDesc(
    search.trim()
      ? models.filter(
          (m) =>
            m.id.toLowerCase().includes(search.toLowerCase()) ||
            (m.ownedBy ?? "").toLowerCase().includes(search.toLowerCase()),
        )
      : models,
  );

  return (
    // 迁入共享 Modal 外壳（R4.1）：动画 + Esc + aria；body 改 flex 列布局，列表自滚动
    <Modal
      open
      onClose={close}
      title="选择模型"
      size="lg"
      bodyClassName="flex min-h-0 flex-col"
    >
      {/* Provider hint */}
      {provider && (
        <div className="flex-shrink-0 border-b border-line bg-island-strong px-4 py-2">
          <p className="truncate text-[12px] text-ink-dim">
            {provider[0]} · {provider[1].baseUrl}
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
              <TextInput
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && probe()}
                placeholder="API Key 的值"
                className="flex-1"
                autoFocus
              />
              <Button variant="primary" onClick={probe} disabled={probing}>
                {probing ? "拉取中…" : "拉取模型"}
              </Button>
            </div>
          </>
        )}

        {error && <p className="mb-2 text-[12px] text-bad">{error}</p>}

        {loaded && models.length > 0 && (
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模型…"
            autoFocus
            className="mb-2"
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
                  className="flex w-full items-center justify-between rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-hover"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[13px] text-ink">{m.id}</p>
                    {m.ownedBy && (
                      <p className="truncate text-[11px] text-ink-faint">{m.ownedBy}</p>
                    )}
                  </div>
                  {isSelected && <Check size={14} className="text-info-text" aria-hidden="true" />}
                </button>
              );
            })}
        </div>
      </div>
    </Modal>
  );
}