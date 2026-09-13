import { PRESETS, PRESET_LABELS, useTheme, type Mode, type Preset } from "./ThemeProvider";
import { SelectInput } from "../components/controls";

// ── 主题切换控件：preset 下拉 + light/dark 分段按钮（桌面侧栏 / 移动抽屉共用）──

const MODES: { value: Mode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function ThemeSwitcher() {
  const { preset, mode, setPreset, setMode } = useTheme();
  return (
    <div className="flex flex-col gap-2">
      <SelectInput
        value={preset}
        onChange={(e) => setPreset(e.target.value as Preset)}
        aria-label="主题预设"
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {PRESET_LABELS[p]}
          </option>
        ))}
      </SelectInput>
      <div className="flex rounded-lg bg-hover p-0.5" role="group" aria-label="明暗模式">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            aria-pressed={mode === m.value}
            className={`h-10 min-w-[40px] flex-1 rounded-md text-[12px] font-medium transition-colors ${
              mode === m.value
                ? "bg-island-strong text-ink shadow-sm"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
