import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// ── snowapp 主题：preset（12 选 1）× mode（light/dark），单 CSS 变量层切换 ──

export const PRESETS = [
  "snow",
  "cream",
  "dracula",
  "forest-green",
  "github",
  "google",
  "gruvbox",
  "midnight-blue",
  "nord",
  "rose-pink",
  "solarized",
  "tokyo-night",
] as const;

export type Preset = (typeof PRESETS)[number];
export type Mode = "light" | "dark";

export const PRESET_LABELS: Record<Preset, string> = {
  snow: "Snow",
  cream: "Cream",
  dracula: "Dracula",
  "forest-green": "Forest Green",
  github: "GitHub",
  google: "Google",
  gruvbox: "Gruvbox",
  "midnight-blue": "Midnight Blue",
  nord: "Nord",
  "rose-pink": "Rose Pink",
  solarized: "Solarized",
  "tokyo-night": "Tokyo Night",
};

const STORAGE_KEY = "snowapp.theme";
const DEFAULT_PRESET: Preset = "snow";
const DEFAULT_MODE: Mode = "light";

interface ThemeState {
  preset: Preset;
  mode: Mode;
}

function isPreset(v: unknown): v is Preset {
  return typeof v === "string" && (PRESETS as readonly string[]).includes(v);
}

function isMode(v: unknown): v is Mode {
  return v === "light" || v === "dark";
}

/** 读 localStorage（key snowapp.theme，JSON {preset, mode}）；非法值回退 snow/light。 */
function readStored(): ThemeState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { preset: DEFAULT_PRESET, mode: DEFAULT_MODE };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { preset: DEFAULT_PRESET, mode: DEFAULT_MODE };
    }
    const obj = parsed as { preset?: unknown; mode?: unknown };
    return {
      preset: isPreset(obj.preset) ? obj.preset : DEFAULT_PRESET,
      mode: isMode(obj.mode) ? obj.mode : DEFAULT_MODE,
    };
  } catch {
    return { preset: DEFAULT_PRESET, mode: DEFAULT_MODE };
  }
}

function applyToDocument(state: ThemeState): void {
  document.documentElement.dataset.preset = state.preset;
  document.documentElement.dataset.theme = state.mode;
}

function persist(state: ThemeState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 不可用（隐私模式等）：主题仍在本会话生效，仅不持久化
  }
}

interface ThemeContextValue extends ThemeState {
  setPreset: (preset: Preset) => void;
  setMode: (mode: Mode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThemeState>(readStored);

  // 首帧由 index.html 内联 script 防 FOUC；这里负责后续变更落到 <html> 属性 + 持久化
  useEffect(() => {
    applyToDocument(state);
    persist(state);
  }, [state]);

  const setPreset = useCallback((preset: Preset) => {
    setState((prev) => (prev.preset === preset ? prev : { ...prev, preset }));
  }, []);

  const setMode = useCallback((mode: Mode) => {
    setState((prev) => (prev.mode === mode ? prev : { ...prev, mode }));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ ...state, setPreset, setMode }),
    [state, setPreset, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 <ThemeProvider> 内使用");
  return ctx;
}
