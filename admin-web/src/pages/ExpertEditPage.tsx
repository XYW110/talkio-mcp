import { useState } from "react";
import type { Expert } from "../types";
import { Card, NavBar, SectionLabel, Toggle } from "../components/ui";

interface Props {
  initial?: Expert;
  onSave: (expert: Expert) => void;
  onClose: () => void;
}

const ICONS = ["🏛️", "🔒", "⚡", "🔍", "💡", "💗", "🤝", "🧠", "❤️", "✍️", "📊", "🎨", "🩺", "🤖"];

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
    });
    onClose();
  };

  return (
<div className="flex h-full w-full flex-col bg-neutral-50 shadow-2xl md:max-h-[92vh] md:max-w-2xl md:rounded-2xl">
      <NavBar
        title={isNew ? "新建专家" : "编辑专家"}
        onBack={onClose}
        right={
          <button
            onClick={handleSave}
            disabled={!name.trim() || !systemPrompt.trim()}
            className="text-[17px] font-semibold text-blue-600 active:opacity-60 disabled:opacity-30"
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
                className="bg-transparent py-[11px] text-[17px] text-neutral-900 outline-none placeholder:text-neutral-300"
              />
            </div>
            {isNew && (
              <div
                className="flex items-center px-4 py-0"
                style={{ borderTop: "0.5px solid #eee" }}
              >
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder={`ID（英文唯一）: ${slugify(name) || "emotion"}`}
                  className="bg-transparent py-[11px] font-mono text-[15px] text-neutral-900 outline-none placeholder:text-neutral-300"
                />
              </div>
            )}
            {/* Icon picker */}
            <div className="flex flex-wrap gap-1.5 px-4 py-3" style={{ borderTop: "0.5px solid #eee" }}>
              {ICONS.map((ic) => (
                <button
                  key={ic}
                  onClick={() => setIcon(ic)}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg text-lg ${
                    icon === ic ? "bg-blue-100 ring-2 ring-blue-500" : "hover:bg-neutral-100"
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
                className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-neutral-900 outline-none placeholder:text-neutral-300"
                style={{ minHeight: 120 }}
                autoFocus={false}
              />
            </div>
          </Card>

          {/* ── 参数 ── */}
          <SectionLabel>生成参数</SectionLabel>
          <Card>
            {/* Temperature slider */}
            <div className="px-4 py-3" style={{ borderBottom: "0.5px solid #eee" }}>
              <div className="flex items-center justify-between">
                <span className="text-[15px] text-neutral-900">Temperature</span>
                <span className="font-mono text-[15px] tabular-nums text-neutral-500">
                  {temperature.toFixed(1)}
                </span>
              </div>
              <div className="relative mt-2">
                <div className="h-[4px] w-full rounded-full bg-neutral-200">
                  <div
                    className="h-[4px] rounded-full bg-blue-600 transition-all"
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
              <div className="px-4 py-3" style={{ borderRight: "0.5px solid #eee" }}>
                <p className="mb-1 text-[12px] text-neutral-400">maxTokens</p>
                <input
                  type="number"
                  min={1}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value) || 2048)}
                  className="w-full bg-transparent font-mono text-[14px] text-neutral-900 outline-none"
                />
              </div>
              <div className="px-4 py-3">
                <p className="mb-1 text-[12px] text-neutral-400">timeoutMs</p>
                <input
                  type="number"
                  min={1000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value) || 120000)}
                  className="w-full bg-transparent font-mono text-[14px] text-neutral-900 outline-none"
                />
              </div>
            </div>
          </Card>

          {/* ── 启用 ── */}
          <SectionLabel>状态</SectionLabel>
          <Card>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-[15px] text-neutral-900">启用此专家</span>
              <Toggle checked={enabled} onChange={setEnabled} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}