import { useCallback, useEffect, useMemo, useState } from "react";
import { Plug } from "lucide-react";
import type { KeyStatus, ProviderConfig } from "../types";
import { api } from "../api";
import {
  Card,
  SectionLabel,
  ChevronRow,
  EmptyState,
  MultiSelectToolbar,
  SelectCheckbox,
} from "../components/ui";
import { Button, Chip, SelectInput } from "../components/controls";
import { Modal } from "../components/overlays";
import { useFeedback } from "../components/feedback";

interface Props {
  providers: [string, ProviderConfig][];
  onUpsert: (name: string, provider: ProviderConfig) => void;
  onDelete: (name: string) => void;
  onDeleteMany: (names: string[]) => void;
}

/** 内置 provider 预设（P3-C）：一键填充 baseUrl（type 固定 openai-compatible）。
 * 只填充表单，不直接写盘（保存流程不变）。API Key 与 baseUrl 分离：
 * 在编辑浮层的「API Key」区直配，独立存服务器 keys.json，保存即生效。 */
interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  hint: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "ollama", label: "Ollama（本地）", baseUrl: "http://localhost:11434/v1", hint: "本地端点通常无需 key，可留空" },
  { id: "lmstudio", label: "LM Studio（本地）", baseUrl: "http://localhost:1234/v1", hint: "本地端点通常无需 key，可留空" },
  { id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", hint: "按部署配置 token；若未启用鉴权可留空" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", hint: "在下方「API Key」区填入 key，保存即生效" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", hint: "在下方「API Key」区填入 key，保存即生效" },
  { id: "moonshot", label: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", hint: "在下方「API Key」区填入 key，保存即生效" },
  { id: "zhipu", label: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", hint: "在下方「API Key」区填入 key，保存即生效" },
];

/** 密钥状态展示文案：已配置显示掩码指纹（尾 4 位），未配置给指引。 */
function keyBadge(status: KeyStatus | undefined): string {
  if (!status || !status.hasKey) return "未配置 key";
  return `key …${status.fingerprint ?? "????"} 已配置`;
}

export function ProvidersPage({
  providers,
  onUpsert,
  onDelete,
  onDeleteMany,
}: Props) {
  const { confirm } = useFeedback();
  const [editing, setEditing] = useState<{
    name: string;
    value: ProviderConfig;
    isNew: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 渠道密钥状态（GET /api/keys 掩码列表；与 provider 元信息保存流程解耦）
  const [keyStatus, setKeyStatus] = useState<Record<string, KeyStatus>>({});

  const refreshKeys = useCallback(async () => {
    try {
      const list = await api.getKeyStatuses();
      setKeyStatus(Object.fromEntries(list.map((k) => [k.providerId, k])));
    } catch {
      // 401 由 api.ts 统一登出处理；其余失败静默（列表仍可用，密钥区显示未配置）
    }
  }, []);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  const openNew = () =>
    setEditing({
      name: "",
      value: {
        type: "openai-compatible",
        baseUrl: "",
      },
      isNew: true,
    });

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

  const onDeleteSelected = async () => {
    if (visibleSelected.length === 0) return;
    const ok = await confirm({
      title: "删除所选 provider",
      message: `确定删除选中的 ${visibleSelected.length} 个 provider？其下模型与引用它们的角色卡会一并删除。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    onDeleteMany(visibleSelected);
    setSelected(new Set());
  };

  const onClearAll = async () => {
    if (providers.length === 0) return;
    const ok = await confirm({
      title: "清空全部 provider",
      message: `确定清空全部 ${providers.length} 个 provider？其下模型与引用它们的角色卡会一并删除。`,
      confirmText: "清空",
      danger: true,
    });
    if (!ok) return;
    onDeleteMany(providerNames);
    setSelected(new Set());
  };

  /** 单个删除（列表行 / 桌面卡共用文案） */
  const deleteOne = async (name: string) => {
    const ok = await confirm({
      title: "删除 provider",
      message: `删除 provider「${name}」？其下模型与引用它们的角色卡会一并删除。`,
      confirmText: "删除",
      danger: true,
    });
    if (ok) onDelete(name);
  };

  /** 编辑浮层内的删除（提示口径不同：专家变未绑定） */
  const deleteFromOverlay = async (name: string) => {
    const ok = await confirm({
      title: "删除 provider",
      message: `删除 provider「${name}」？引用它的专家会变成未绑定。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    onDelete(name);
    setEditing(null);
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
          <Button variant="icon" onClick={openNew} aria-label="新建 provider" title="新建 provider">
            ＋
          </Button>
        </div>
<p className="text-[13px] text-ink-dim">
          配置 API 端点；API Key 在各 provider 的编辑浮层内直配，仅存服务器 keys.json，保存即生效。
        </p>
      </div>

      {/* 空列表且无选中时不渲染工具条（R3.2） */}
      {(providers.length > 0 || visibleSelected.length > 0) && (
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
      )}

      {/* 手机端：分组列表 */}
      <div className="flex-1 overflow-y-auto pb-6 md:hidden">
        {providers.length === 0 ? (
          <EmptyState
            icon={<Plug size={40} />}
            title="还没有 provider"
            subtitle="配置 API 端点，再直配 API Key"
            action={
              <Button variant="primary" onClick={openNew}>
                新建 Provider
              </Button>
            }
          />
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
                    detail={
                      <span
                        className={`rounded px-1.5 text-[11px] ${
                          keyStatus[name]?.hasKey
                            ? "bg-ok-bg text-ok-text"
                            : "bg-warn-bg text-warn-text"
                        }`}
                      >
                        {keyBadge(keyStatus[name])}
                      </span>
                    }
                    isLast={i === providers.length - 1}
                  />
                </div>
                <Button
                  variant="danger-text"
                  className="!h-auto shrink-0 px-2 py-0"
                  onClick={() => void deleteOne(name)}
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
          <EmptyState
            icon={<Plug size={40} />}
            title="还没有 provider"
            subtitle="配置 API 端点，再直配 API Key"
            action={
              <Button variant="primary" onClick={openNew}>
                新建 Provider
              </Button>
            }
          />
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
                  <span
                    className={`truncate rounded px-1.5 text-[11px] ${
                      keyStatus[name]?.hasKey
                        ? "bg-ok-bg text-ok-text"
                        : "bg-warn-bg text-warn-text"
                    }`}
                  >
                    {keyBadge(keyStatus[name])}
                  </span>
                  <Button
                    variant="danger-text"
                    className="!h-auto px-2 py-0"
                    onClick={() => void deleteOne(name)}
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
          keyStatus={keyStatus[editing.name]}
          onKeySaved={refreshKeys}
          onSave={(n, v) => {
            onUpsert(n, v);
            setEditing(null);
          }}
          onDelete={() => void deleteFromOverlay(editing.name)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProviderEditOverlay({
  initial,
  existingNames,
  keyStatus,
  onKeySaved,
  onSave,
  onDelete,
  onClose,
}: {
  initial: { name: string; value: ProviderConfig; isNew: boolean };
  existingNames: string[];
  keyStatus: KeyStatus | undefined;
  onKeySaved: () => Promise<void> | void;
  onSave: (name: string, value: ProviderConfig) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState<ProviderConfig>(initial.value);
  // 最近点击的预设提示（P3-C：baseUrl 建议值 / 本地可留空说明）
  const [presetHint, setPresetHint] = useState("");
  // API Key 表单（留空 = 不修改；与 provider 元信息保存分开提交，写入 keys.json）
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const { confirm, toast } = useFeedback();

  const applyPreset = (p: ProviderPreset) => {
    // 只填充表单：编辑已有 provider 时即覆盖当前值（名称不动）；不触发保存。
    setValue({
      ...value,
      baseUrl: p.baseUrl,
      type: "openai-compatible",
    });
    setPresetHint(p.hint || "");
  };

  const handleSave = () => {
    const n = name.trim();
    if (!n) {
      toast("error", "请填写名称");
      return;
    }
    if (initial.isNew && existingNames.includes(n)) {
      toast("error", `provider「${n}」已存在`);
      return;
    }
    try {
      new URL(value.baseUrl);
    } catch {
      toast("error", "baseUrl 必须是合法 URL");
      return;
    }
    onSave(n, value);
  };

  /** 保存/清除密钥：直接调 PUT /api/keys/:pid，写 keys.json 即时生效，
   * 不经过 experts.json 的全局保存流程。 */
  const submitKey = async (apiKey: string) => {
    if (keyBusy) return;
    setKeyBusy(true);
    try {
      const result = await api.setProviderKey(initial.name, apiKey);
      setKeyInput("");
      await onKeySaved();
      toast(
        "success",
        result.hasKey
          ? `API Key 已更新（尾4位 ${result.fingerprint ?? "????"}），即时生效`
          : "API Key 已清除，该渠道调用将报 missing key",
      );
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e), { sticky: true });
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async () => {
    // 清除前二次确认（清除后该渠道调用立即失败）
    const ok = await confirm({
      title: "清除 API Key",
      message: `清除 provider「${initial.name}」的 API Key？使用该渠道的角色卡调用将失败，直到重新配置。`,
      confirmText: "清除",
      danger: true,
    });
    if (ok) await submitKey("");
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={initial.isNew ? "新建 Provider" : `编辑 ${initial.name}`}
      size="md"
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
    >
      <div className="pb-4">
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
          </>
        )}

        <SectionLabel>快速填充</SectionLabel>
            <Card>
              <div className="flex flex-wrap gap-2 px-4 py-3">
                {PROVIDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p)}
                    title={p.baseUrl}
                    className="transition-opacity hover:opacity-80"
                  >
                    <Chip>{p.label}</Chip>
                  </button>
                ))}
              </div>
            </Card>
            {presetHint && (
              <p className="px-1 pt-1 text-[11px] leading-relaxed text-ink-faint">
                {presetHint}
              </p>
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
              <div className="flex items-center px-4 py-3">
                <span className="w-24 shrink-0 text-[13px] text-ink-dim">Base URL</span>
                <input
                  value={value.baseUrl}
                  onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>
            </Card>
            <p className="px-1 py-3 text-[11px] leading-relaxed text-ink-faint">
              端点存 experts.json（点右上「保存」后生效）；API Key 独立存服务器 keys.json，保存即生效，无需重启。
            </p>

            {/* API Key（仅已有 provider；新建需先保存元信息） */}
            {!initial.isNew && (
              <>
                <SectionLabel>API Key</SectionLabel>
                <Card>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className="w-24 shrink-0 text-[13px] text-ink-dim">当前状态</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        keyStatus?.hasKey
                          ? "bg-ok-bg text-ok-text"
                          : "bg-warn-bg text-warn-text"
                      }`}
                    >
                      {keyBadge(keyStatus)}
                      {keyStatus?.updatedAt ? ` · ${keyStatus.updatedAt.slice(0, 10)}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 border-t border-line px-4 py-3">
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="留空 = 不修改；粘贴新 key 后点「保存密钥」"
                      className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
                      autoComplete="new-password"
                    />
                    <Button
                      variant="primary"
                      className="!h-7 !px-3 text-[12px]"
                      disabled={keyBusy || keyInput.trim() === ""}
                      onClick={() => void submitKey(keyInput.trim())}
                    >
                      保存密钥
                    </Button>
                  </div>
                  {keyStatus?.hasKey && (
                    <div className="flex items-center border-t border-line px-4 py-3">
                      <Button
                        variant="danger-text"
                        className="!h-auto !px-0 py-0"
                        disabled={keyBusy}
                        onClick={() => void clearKey()}
                      >
                        清除密钥
                      </Button>
                    </div>
                  )}
                </Card>
                <p className="px-1 py-3 text-[11px] leading-relaxed text-ink-faint">
                  密钥仅存服务器 keys.json（接口与日志只回显尾 4 位指纹）；保存后该渠道调用即时生效。
                </p>
              </>
            )}
            {initial.isNew && (
              <p className="px-1 py-1 text-[11px] leading-relaxed text-ink-faint">
                保存 provider 后，重新打开编辑浮层即可配置 API Key。
              </p>
            )}
      </div>
    </Modal>
  );
}
