import { useState } from "react";
import type { ProviderConfig } from "../types";
import { Card, NavBar, SectionLabel, ChevronRow, EmptyState } from "../components/ui";

interface Props {
  providers: [string, ProviderConfig][];
  onUpsert: (name: string, provider: ProviderConfig) => void;
  onDelete: (name: string) => void;
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

export function ProvidersPage({ providers, onUpsert, onDelete }: Props) {
  const [editing, setEditing] = useState<{
    name: string;
    value: ProviderConfig;
    isNew: boolean;
  } | null>(null);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-[20px] font-bold tracking-tight text-neutral-900">
            Provider
            <span className="ml-2 text-sm font-normal text-neutral-400">{providers.length} 个</span>
          </h1>
          <button
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
            className="flex h-9 w-9 items-center justify-center rounded-full text-blue-600 hover:bg-blue-50 active:opacity-60"
            title="新建 provider"
          >
            ＋
          </button>
        </div>
        <p className="text-[13px] text-neutral-500">
          配置 API 端点（自定义 URL + key 环境变量名）。真实 key 写在项目根目录 .env。
        </p>
      </div>

{/* 手机端：iOS 分组列表 */}
      <div className="flex-1 overflow-y-auto pb-6 md:hidden">
        {providers.length === 0 ? (
          <EmptyState icon="🔌" title="还没有 provider" subtitle="点右上角 ＋ 新建" />
        ) : (
          <Card>
            {providers.map(([name, p], i) => (
              <ChevronRow
                key={name}
                onClick={() => setEditing({ name, value: { ...p }, isNew: false })}
                title={name}
                subtitle={`${p.type} · ${p.baseUrl}`}
                detail={<span className="font-mono text-[11px] text-neutral-400">{p.apiKeyEnv}</span>}
                isLast={i === providers.length - 1}
              />
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
              <button
                key={name}
                onClick={() => setEditing({ name, value: { ...p }, isNew: false })}
                className="flex flex-col gap-2 rounded-[10px] border border-neutral-200 bg-white p-4 text-left shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-mono text-[15px] font-semibold text-neutral-900">{name}</p>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
                    {p.type}
                  </span>
                </div>
                <p className="truncate font-mono text-[12px] text-neutral-500">{p.baseUrl}</p>
                <p className="mt-auto truncate font-mono text-[11px] text-neutral-400">
                  环境变量 {p.apiKeyEnv}
                </p>
              </button>
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
<div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl md:max-w-lg">
        <NavBar
          title={initial.isNew ? "新建 Provider" : `编辑 ${initial.name}`}
          onBack={onClose}
          right={
            <div className="flex items-center gap-3">
              {!initial.isNew && (
                <button
                  onClick={onDelete}
                  className="text-[13px] text-red-500 active:opacity-60"
                >
                  删除
                </button>
              )}
              <button
                onClick={handleSave}
                className="text-[17px] font-semibold text-blue-600 active:opacity-60"
              >
                保存
              </button>
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
                      className="w-full bg-transparent py-[11px] font-mono text-[15px] outline-none"
                    />
                  </div>
                </Card>

                <SectionLabel>快速填充</SectionLabel>
                <Card>
                  {Object.entries(PRESETS).map(([k, p], i) => (
                    <button
                      key={k}
                      onClick={() => applyPreset(k)}
                      className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-neutral-50"
                      style={{
                        borderBottom:
                          i < Object.keys(PRESETS).length - 1 ? "0.5px solid #eee" : "none",
                      }}
                    >
                      <span className="text-[15px] text-neutral-900">{p.label}</span>
                      <span className="truncate pl-2 font-mono text-[12px] text-neutral-400">
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
              <div
                className="flex items-center px-4 py-3"
                style={{ borderBottom: "0.5px solid #eee" }}
              >
                <span className="w-24 shrink-0 text-[15px] text-neutral-500">类型</span>
                <div className="relative flex-1">
                  <select
                    value={value.type}
                    onChange={(e) =>
                      setValue({ ...value, type: e.target.value as ProviderConfig["type"] })
                    }
                    className="w-full appearance-none bg-transparent text-[15px] outline-none"
                  >
                    <option value="openai">openai</option>
                    <option value="anthropic">anthropic</option>
                    <option value="openai-compatible">openai-compatible</option>
                  </select>
                  <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-neutral-400">
                    ▾
                  </span>
                </div>
              </div>

              {/* baseUrl */}
              <div
                className="flex items-center px-4 py-3"
                style={{ borderBottom: "0.5px solid #eee" }}
              >
                <span className="w-24 shrink-0 text-[15px] text-neutral-500">Base URL</span>
                <input
                  value={value.baseUrl}
                  onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="flex-1 bg-transparent font-mono text-[13px] outline-none"
                />
              </div>

              {/* apiKeyEnv */}
              <div className="flex items-center px-4 py-3">
                <span className="w-24 shrink-0 text-[15px] text-neutral-500">API Key 环境变量</span>
                <input
                  value={value.apiKeyEnv}
                  onChange={(e) => setValue({ ...value, apiKeyEnv: e.target.value.toUpperCase() })}
                  placeholder="CUSTOM_API_KEY"
                  className="flex-1 bg-transparent font-mono text-[13px] outline-none"
                />
              </div>
            </Card>
            <p className="px-1 py-3 text-[11px] leading-relaxed text-neutral-400">
              真实 key 请写到项目根目录 .env（例如 {value.apiKeyEnv}=sk-...），不会写入 experts.json。
              改完配置后需重启 MCP server 才生效。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}