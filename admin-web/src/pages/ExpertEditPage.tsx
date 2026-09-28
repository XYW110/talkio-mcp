import { useEffect, useRef, useState } from "react";
import type { Expert } from "../types";
import { Card, NavBar, SectionLabel, SettingsRow, Toggle } from "../components/ui";
import { Button, SelectInput, TextInput } from "../components/controls";
import { useFeedback } from "../components/feedback";

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
  const { confirm, toast } = useFeedback();
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

  // 任一字段 ≠ initial 即视为有未保存改动（驱动关闭二次确认）
  const isDirty =
    id !== (initial?.id ?? "") ||
    name !== (initial?.name ?? "") ||
    icon !== (initial?.icon ?? "🤖") ||
    systemPrompt !== (initial?.systemPrompt ?? "") ||
    temperature !== (initial?.temperature ?? 0.7) ||
    enabled !== (initial?.enabled ?? true) ||
    maxTokens !== (initial?.maxTokens ?? 2048) ||
    timeoutMs !== (initial?.timeoutMs ?? 120000) ||
    strategy !== (initial?.reasoningStrategy ?? "");

  // 关闭拦截：dirty 时走 ConfirmDialog（R4.2），Esc/取消不丢弃改动
  const handleClose = async () => {
    if (isDirty) {
      const ok = await confirm({
        title: "放弃未保存的修改？",
        message: "当前表单有未保存的改动，关闭后将丢失。",
        confirmText: "放弃修改",
        danger: false,
      });
      if (!ok) return;
    }
    onClose();
  };

  // 系统提示词 textarea 自动增高（min 120 / max 400，超出后内部滚动）
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(400, Math.max(120, el.scrollHeight))}px`;
  }, [systemPrompt]);

  const handleSave = () => {
    const finalId = (isNew ? slugify(id || name) : initial!.id).trim();
    if (!name.trim()) {
      toast("error", "请填写专家名称");
      return;
    }
    if (!systemPrompt.trim()) {
      toast("error", "请填写系统提示词");
      return;
    }
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
        onBack={() => void handleClose()}
        right={
          <Button
            variant="primary"
            className="!h-8 !px-3 rounded-md"
            onClick={handleSave}
            disabled={!name.trim() || !systemPrompt.trim()}
          >
            保存
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto">
<div className="mx-auto w-full max-w-lg px-4 pt-4 pb-10 md:max-w-2xl md:px-6">
          {/* ── 基本信息 ── */}
          <SectionLabel>基本信息</SectionLabel>
          <Card>
            <div className="flex items-center px-4 py-0">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="专家名称，例如：情感顾问"
                className="!h-auto flex-1 !border-0 bg-transparent py-2.5 text-[14px] !px-0"
              />
            </div>
            {isNew && (
              <div className="flex items-center border-t border-line px-4 py-0">
                <TextInput
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder={`ID（英文唯一）: ${slugify(name) || "emotion"}`}
                  className="!h-auto flex-1 !border-0 bg-transparent py-2.5 font-mono text-[13px] !px-0"
                />
              </div>
            )}
            {/* Icon picker */}
            <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-3">
              {ICONS.map((ic) => (
                <button
                  key={ic}
                  onClick={() => setIcon(ic)}
                  className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg ${
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
                ref={promptRef}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="描述这个专家的角色、专长、语气与边界…"
                className="max-h-[400px] min-h-[120px] w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
                autoFocus={false}
              />
              {/* 右下字数统计（R6.1） */}
              <div className="mt-1 flex justify-end">
                <span className="text-[11px] text-ink-faint">{systemPrompt.length} 字</span>
              </div>
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

            {/* maxTokens / timeoutMs（SettingsRow：label 左 / 控件右） */}
            <SettingsRow label="maxTokens">
              <TextInput
                type="number"
                min={1}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value) || 2048)}
                className="!h-9 w-28 text-right font-mono"
              />
            </SettingsRow>
            <SettingsRow label="timeoutMs">
              <TextInput
                type="number"
                min={1000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value) || 120000)}
                className="!h-9 w-32 text-right font-mono"
              />
            </SettingsRow>

            {/* 推理策略（P1-B，SettingsRow） */}
            <SettingsRow label="推理策略" description="留空则不指定（落盘时删除该字段）" isLast>
              <SelectInput
                className="w-52"
                value={strategy}
                onChange={(e) =>
                  setStrategy(e.target.value as "" | NonNullable<Expert["reasoningStrategy"]>)
                }
                aria-label="推理策略"
              >
                {STRATEGY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </SelectInput>
            </SettingsRow>
          </Card>

          {/* ── 启用 ── */}
          <SectionLabel>状态</SectionLabel>
          <Card>
            <SettingsRow label="启用此专家" isLast>
              <Toggle checked={enabled} onChange={setEnabled} />
            </SettingsRow>
          </Card>
        </div>
      </div>
    </div>
  );
}
