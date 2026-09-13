import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";

// ── snowapp 控件层：Button / TextInput / SelectInput / Chip / Pill / NavTab ──
// 皮肤规格见 .trellis/tasks/09-13-snowapp-restyle/research/components-inventory.md

// ── Button：primary（accent-ink 实心）/ ghost（透明底）/ danger-text（红字）/ icon（方形 40px）──

export type ButtonVariant = "primary" | "ghost" | "danger-text" | "icon";

const BUTTON_BASE =
  "inline-flex flex-shrink-0 items-center justify-center gap-1.5 font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "h-10 rounded-lg bg-accent-ink px-4 text-[13px] text-on-solid hover:opacity-90",
  ghost: "h-10 rounded-lg px-3 text-[13px] text-ink-mid hover:bg-hover",
  "danger-text": "h-10 rounded-lg px-3 text-[13px] text-bad hover:opacity-80",
  icon: "h-10 w-10 rounded-lg text-info-text hover:bg-hover",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "primary", className = "", type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      {...rest}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`}
    />
  );
}

// ── TextInput：40px 高输入框（触控目标 ≥40px）──

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ className = "", ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      className={`h-10 w-full rounded-lg border border-line bg-island-strong px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-50 ${className}`}
    />
  );
}

// ── SelectInput：与 TextInput 同外观的原生下拉 ──

export type SelectInputProps = SelectHTMLAttributes<HTMLSelectElement>;

export function SelectInput({ className = "", children, ...rest }: SelectInputProps) {
  return (
    <div className={`relative ${className}`}>
      <select
        {...rest}
        className="h-10 w-full appearance-none rounded-lg border border-line bg-island-strong pl-3 pr-8 text-[13px] text-ink outline-none disabled:opacity-50"
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint"
        aria-hidden="true"
      />
    </div>
  );
}

// ── Chip：surface.2 底圆角小标签 ──

export function Chip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-[12px] text-ink-mid ${className}`}
    >
      {children}
    </span>
  );
}

// ── Pill：语义四色状态药丸（semantic.*.bg / fg 成对）──

export type PillTone = "ok" | "bad" | "info" | "warn" | "neutral";

const PILL_TONES: Record<PillTone, string> = {
  ok: "bg-ok-bg text-ok-text",
  bad: "bg-bad-bg text-bad-text",
  info: "bg-info-bg text-info-text",
  warn: "bg-warn-bg text-warn-text",
  neutral: "bg-hover text-ink-dim",
};

export function Pill({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${PILL_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

// ── NavTab：active=accent 实心胶囊 / inactive=透明底 hover──

export function NavTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center rounded-full px-3.5 text-[13px] font-medium transition-colors ${
        active ? "bg-accent-ink text-on-solid" : "text-ink-mid hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
}
