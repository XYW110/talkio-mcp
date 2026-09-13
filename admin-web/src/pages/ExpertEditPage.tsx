import { useState } from "react";
import type { Expert } from "../types";
import { Card, NavBar, SectionLabel, Toggle } from "../components/ui";

interface Props {
  initial?: Expert;
  onSave: (expert: Expert) => void;
  onClose: () => void;
}

const ICONS = ["🏛️", "🔒", "⚡", "🔍", "💡", "💗", "🤝", "🧠", "❤️", "✍️", "📊", "🎨", "🔬", "💻", "🌐", "💰", "🌟", "🩺", "🤖"];

/** 推理策略下拉选项（P1-B）：空值 = 不指定（落盘时删除该字段）。 */
const STRATEGY_OPTIONS: Array<{ value: "" | NonNullable<Expert["reasoningStrategy"]>; label: string }> = [
  { value: "", label: "不指定" },
  { value: "default", label: "default（默认行为）" },
  { value: "systematic", label: "systematic（系统化枚举）" },
  { value: "adversarial", label: "adversarial（对抗式）" },
  { value: "backward", label: "backward（反向推理）" },
];

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "expert"
  );
}

export function ExpertEditPage({ initial, onSave, onClose }: Props) {
  const isNew = !initial;
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "🤖");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [temperature, setTemperature] = useState(initial?.temperature ?? 0.7);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [maxTokens, setMaxTokens] = useState(initial?.maxTokens ?? 2048);
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 120000);
  const [strategy, setStrategy] = useState<"" | NonNullable<Expert["reasoningStrategy"]>>(
    initial?.reasoningStrategy ?? "",
  );

  const handleSave = () => {
    const finalId = (isNew ? slugify(id || name) : initial!.id).trim();
    if (!name.trim()) return window.alert("请填写专家名称");
    if (!systemPrompt.trim()) return window.alert("请填写系统提示词");
    onSave({
      id: finalId,
      name: name.trim(),
      icon,
      systemPrompt: systemPrompt.trim(),
      temperature,
      maxTokens,
      timeoutMs,
      enabled,
      builtin: initial?.builtin ?? false,
      // 清空策略 = undefined（JSON.stringify 落盘时自动删除该字段）
      reasoningStrategy: strategy === "" ? undefined : strategy,
    });
    onClose();
  };

  return (
<div className="island island-strong flex h-full w-full flex-col md:max-h-[92vh] md:max-w-2xl">
      <NavBar
        title={isNew ? "新建专家" : "编辑专家"}
        onBack={onClose}
        right={
          <button
            onClick={handleSave}
            disabled={!name.trim() || !systemPrompt.trim()}
            className="rounded-md bg-ink px-3 py-1 text-[13px] font-semibold text-on-solid hover:bg-ink-mid disabled:opacity-30"
          >
            保存
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
<div className="mx-auto w-full max-w-lg px-4 pt-4 pb-10 md:max-w-2xl md:px-6">
          {/* ── 基本信息 ── */}
          <SectionLabel>基本信息</SectionLabel>
          <Card>
            <div className="flex items-center px-4 py-0">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="专家名称，例如：情感顾问"
                className="bg-transparent py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-faint"
              />
            </div>
            {isNew && (
              <div className="flex items-center border-t border-line px-4 py-0">
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder={`ID（英文唯一）: ${slugify(name) || "emotion"}`}
                  className="bg-transparent py-2.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>
            )}
            {/* Icon picker */}
            <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-3">
              {ICONS.map((ic) => (
                <button
                  key={ic}
                  onClick={() => setIcon(ic)}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg text-lg ${
                    icon === ic ? "bg-info-bg ring-2 ring-info" : "hover:bg-hover"
                  }`}
                >
                  {ic}
                </button>
              ))}
            </div>
          </Card>

          {/* ── 系统提示词 ── */}
          <SectionLabel>系统提示词</SectionLabel>
          <Card>
            <div className="px-4 py-3">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="描述这个专家的角色、专长、语气与边界…"
                className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
                style={{ minHeight: 120 }}
                autoFocus={false}
              />
            </div>
          </Card>

          {/* ── 参数 ── */}
          <SectionLabel>生成参数</SectionLabel>
          <Card>
            {/* Temperature slider */}
            <div className="border-b border-line px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-ink">Temperature</span>
                <span className="font-mono text-[13px] tabular-nums text-ink-dim">
                  {temperature.toFixed(1)}
                </span>
              </div>
              <div className="relative mt-2">
                <div className="h-[4px] w-full rounded-full bg-pressed">
                  <div
                    className="h-[4px] rounded-full bg-info transition-all"
                    style={{ width: `${(temperature / 2) * 100}%` }}
                  />
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="absolute inset-0 w-full cursor-pointer opacity-0"
                />
              </div>
            </div>

            {/* maxTokens / timeoutMs */}
            <div className="grid grid-cols-2">
              <div className="border-r border-line px-4 py-3">
                <p className="mb-1 text-[12px] text-ink-faint">maxTokens</p>
                <input
                  type="number"
                  min={1}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value) || 2048)}
                  className="w-full bg-transparent font-mono text-[13px] text-ink outline-none"
                />
              </div>
              <div className="px-4 py-3">
                <p className="mb-1 text-[12px] text-ink-faint">timeoutMs</p>
                <input
                  type="number"
                  min={1000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value) || 120000)}
                  className="w-full bg-transparent font-mono text-[13px] text-ink outline-none"
                />
              </div>
            </div>

            {/* 推理策略（P1-B） */}
            <div className="border-t border-line px-4 py-3">
              <p className="mb-1 text-[12px] text-ink-faint">推理策略</p>
              <select
                value={strategy}
                onChange={(e) =>
                  setStrategy(e.target.value as "" | NonNullable<Expert["reasoningStrategy"]>)
                }
                className="w-full rounded-lg border border-line bg-island-strong px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-info"
              >
                {STRATEGY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </Card>

          {/* ── 启用 ── */}
          <SectionLabel>状态</SectionLabel>
          <Card>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-[13px] text-ink">启用此专家</span>
              <Toggle checked={enabled} onChange={setEnabled} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
