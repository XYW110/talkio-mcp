import { useMemo, useState } from "react";
import type { ProviderConfig } from "../types";
import {
  Card,
  NavBar,
  SectionLabel,
  ChevronRow,
  EmptyState,
  MultiSelectToolbar,
  SelectCheckbox,
} from "../components/ui";
import { Button, SelectInput } from "../components/controls";

interface Props {
  providers: [string, ProviderConfig][];
  onUpsert: (name: string, provider: ProviderConfig) => void;
  onDelete: (name: string) => void;
  onDeleteMany: (names: string[]) => void;
}

// 常用 provider 预设（仿参照项目 ProviderEditPage 的 PRESETS）
const PRESETS: Record<string, { label: string; baseUrl: string; type: ProviderConfig["type"] }> = {
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", type: "openai-compatible" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", type: "openai" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", type: "anthropic" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", type: "openai-compatible" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", type: "openai-compatible" },
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", type: "openai-compatible" },
};

export function ProvidersPage({
  providers,
  onUpsert,
  onDelete,
  onDeleteMany,
}: Props) {
  const [editing, setEditing] = useState<{
    name: string;
    value: ProviderConfig;
    isNew: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // provider id 就是 name
  const providerNames = useMemo(() => providers.map(([name]) => name), [providers]);
  const visibleSelected = providerNames.filter((n) => selected.has(n));
  const allSelected = providerNames.length > 0 && visibleSelected.length === providerNames.length;

  const toggleSelect = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allSelected) return new Set();
      return new Set([...prev, ...providerNames]);
    });
  };

  const onDeleteSelected = () => {
    if (visibleSelected.length === 0) return;
    if (
      !window.confirm(
        `确定删除选中的 ${visibleSelected.length} 个 provider？其下模型与引用它们的角色卡会一并删除。`,
      )
    )
      return;
    onDeleteMany(visibleSelected);
    setSelected(new Set());
  };

  const onClearAll = () => {
    if (providers.length === 0) return;
    if (
      !window.confirm(
        `确定清空全部 ${providers.length} 个 provider？其下模型与引用它们的角色卡会一并删除。`,
      )
    )
      return;
    onDeleteMany(providerNames);
    setSelected(new Set());
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-[20px] font-bold tracking-tight text-ink">
            Provider
            <span className="ml-2 text-sm font-normal text-ink-faint">{providers.length} 个</span>
          </h1>
          <Button
            variant="icon"
            onClick={() =>
              setEditing({
                name: "",
                value: {
                  type: "openai-compatible",
                  baseUrl: "",
                  apiKeyEnv: "CUSTOM_API_KEY",
                },
                isNew: true,
              })
            }
            aria-label="新建 provider"
            title="新建 provider"
          >
            ＋
          </Button>
        </div>
<p className="text-[13px] text-ink-dim">
          配置 API 端点（自定义 URL + key 环境变量名）。真实 key 写在项目根目录 .env。
        </p>
      </div>

      <div className="flex-shrink-0">
        <MultiSelectToolbar
          noun="个"
          totalText={`共 ${providers.length} 个`}
          selectedCount={visibleSelected.length}
          selectableCount={providerNames.length}
          allSelected={allSelected}
          onToggleAll={toggleSelectAll}
          onDeleteSelected={onDeleteSelected}
          onClearAll={onClearAll}
          clearAllDisabled={providers.length === 0}
        />
      </div>

{/* 手机端：分组列表 */}
      <div className="flex-1 overflow-y-auto pb-6 md:hidden">
        {providers.length === 0 ? (
          <EmptyState icon="🔌" title="还没有 provider" subtitle="点右上角 ＋ 新建" />
        ) : (
          <Card>
            {providers.map(([name, p], i) => (
              <div key={name} className="flex items-stretch">
                <SelectCheckbox
                  checked={selected.has(name)}
                  onClick={() => toggleSelect(name)}
                />
                <div className="min-w-0 flex-1">
                  <ChevronRow
                    onClick={() => setEditing({ name, value: { ...p }, isNew: false })}
                    title={name}
                    subtitle={`${p.type} · ${p.baseUrl}`}
                    detail={<span className="font-mono text-[11px] text-ink-faint">{p.apiKeyEnv}</span>}
                    isLast={i === providers.length - 1}
                  />
                </div>
                <Button
                  variant="danger-text"
                  className="!h-auto shrink-0 px-2 py-0"
                  onClick={() => {
                    if (window.confirm(`删除 provider「${name}」？其下模型与引用它们的角色卡会一并删除。`)) {
                      onDelete(name);
                    }
                  }}
                  aria-label="删除"
                  title="删除"
                >
                  删除
                </Button>
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* 桌面端（md+）：卡片网格 */}
      <div className="hidden flex-1 overflow-y-auto px-4 pb-6 md:block">
        {providers.length === 0 ? (
          <EmptyState icon="🔌" title="还没有 provider" subtitle="点右上角 ＋ 新建" />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {providers.map(([name, p]) => (
              <div
                key={name}
                className="flex flex-col gap-2 rounded-xl border border-line bg-island-strong p-4 transition-colors hover:bg-hover"
              >
                <div className="flex items-start gap-2">
                  <SelectCheckbox
                    checked={selected.has(name)}
                    onClick={() => toggleSelect(name)}
                  />
                  <button
                    onClick={() => setEditing({ name, value: { ...p }, isNew: false })}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-mono text-[14px] font-semibold text-ink">{name}</p>
                      <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] text-ink-dim">
                        {p.type}
                      </span>
                    </div>
                    <p className="truncate font-mono text-[12px] text-ink-dim">{p.baseUrl}</p>
                  </button>
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-line pt-2.5">
                  <p className="truncate font-mono text-[11px] text-ink-faint">
                    环境变量 {p.apiKeyEnv}
                  </p>
                  <Button
                    variant="danger-text"
                    className="!h-auto px-2 py-0"
                    onClick={() => {
                      if (window.confirm(`删除 provider「${name}」？其下模型与引用它们的角色卡会一并删除。`)) {
                        onDelete(name);
                      }
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ProviderEditOverlay
          initial={editing}
          existingNames={providers.map(([n]) => n)}
          onSave={(n, v) => {
            onUpsert(n, v);
            setEditing(null);
          }}
          onDelete={() => {
            if (window.confirm(`删除 provider「${editing.name}」？引用它的专家会变成未绑定。`)) {
              onDelete(editing.name);
              setEditing(null);
            }
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProviderEditOverlay({
  initial,
  existingNames,
  onSave,
  onDelete,
  onClose,
}: {
  initial: { name: string; value: ProviderConfig; isNew: boolean };
  existingNames: string[];
  onSave: (name: string, value: ProviderConfig) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState<ProviderConfig>(initial.value);

  const applyPreset = (key: string) => {
    const p = PRESETS[key];
    if (p) {
      setValue({ ...value, baseUrl: p.baseUrl, type: p.type });
    }
  };

  const handleSave = () => {
    const n = name.trim();
    if (!n) return window.alert("请填写名称");
    if (initial.isNew && existingNames.includes(n)) {
      return window.alert(`provider「${n}」已存在`);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(value.apiKeyEnv)) {
      return window.alert("apiKeyEnv 必须是合法环境变量名（字母/数字/下划线）");
    }
    try {
      new URL(value.baseUrl);
    } catch {
      return window.alert("baseUrl 必须是合法 URL");
    }
    onSave(n, value);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
<div className="island island-strong flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-b-none shadow-2xl sm:rounded-2xl md:max-w-lg">
        <NavBar
          title={initial.isNew ? "新建 Provider" : `编辑 ${initial.name}`}
          onBack={onClose}
          right={
            <div className="flex items-center gap-3">
              {!initial.isNew && (
                <Button variant="danger-text" className="!h-auto !px-0 py-0" onClick={onDelete}>
                  删除
                </Button>
              )}
              <Button variant="primary" className="!h-8 !px-3 rounded-md" onClick={handleSave}>
                保存
              </Button>
            </div>
          }
        />

        <div className="flex-1 overflow-y-auto">
          <div className="px-4">
            {initial.isNew && (
              <>
                <SectionLabel>名称（唯一 key）</SectionLabel>
                <Card>
                  <div className="px-4 py-0">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例如 custom / moonshot"
                      className="w-full bg-transparent py-2.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
                    />
                  </div>
                </Card>

                <SectionLabel>快速填充</SectionLabel>
                <Card>
                  {Object.entries(PRESETS).map(([k, p], i) => (
                    <button
                      key={k}
                      onClick={() => applyPreset(k)}
                      className={`flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-hover ${
                        i < Object.keys(PRESETS).length - 1 ? "border-b border-line" : ""
                      }`}
                    >
                      <span className="text-[13px] text-ink">{p.label}</span>
                      <span className="truncate pl-2 font-mono text-[12px] text-ink-faint">
                        {p.baseUrl}
                      </span>
                    </button>
                  ))}
                </Card>
              </>
            )}

            <SectionLabel>配置</SectionLabel>
            <Card>
              {/* type */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-24 shrink-0 text-[13px] text-ink-dim">类型</span>
                <SelectInput
                  className="flex-1"
                  value={value.type}
                  onChange={(e) =>
                    setValue({ ...value, type: e.target.value as ProviderConfig["type"] })
                  }
                  aria-label="Provider 类型"
                >
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                  <option value="openai-compatible">openai-compatible</option>
                </SelectInput>
              </div>

              {/* baseUrl */}
              <div className="flex items-center border-b border-line px-4 py-3">
                <span className="w-24 shrink-0 text-[13px] text-ink-dim">Base URL</span>
                <input
                  value={value.baseUrl}
                  onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>

              {/* apiKeyEnv */}
              <div className="flex items-center px-4 py-3">
                <span className="w-24 shrink-0 text-[13px] text-ink-dim">API Key 环境变量</span>
                <input
                  value={value.apiKeyEnv}
                  onChange={(e) => setValue({ ...value, apiKeyEnv: e.target.value.toUpperCase() })}
                  placeholder="CUSTOM_API_KEY"
                  className="flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>
            </Card>
            <p className="px-1 py-3 text-[11px] leading-relaxed text-ink-faint">
              真实 key 请写到项目根目录 .env（例如 {value.apiKeyEnv}=sk-...），不会写入 experts.json。
              改完配置后需重启 MCP server 才生效。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
