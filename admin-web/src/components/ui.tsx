import type { ReactNode } from "react";

// ── iOS-style navigation bar (仿参照项目 IdentityEditPage / ProviderEditPage 顶栏) ──

export function NavBar({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-shrink-0 items-center border-b border-neutral-200 bg-white px-2 py-2.5">
      <button
        onClick={onBack}
        className="flex min-w-[64px] items-center px-1 text-[17px] text-blue-600 active:opacity-60"
      >
        <span className="text-[22px] leading-none">‹</span>
        <span className="ml-0.5">返回</span>
      </button>
      <span className="flex-1 text-center text-[17px] font-semibold text-neutral-900">{title}</span>
      <div className="flex min-w-[64px] items-center justify-end pr-1">{right}</div>
    </div>
  );
}

// ── Section label (uppercase 小节标题，仿参照项目表单分区) ──

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pb-1.5 pt-5 text-[13px] font-normal uppercase tracking-wide text-neutral-400">
      {children}
    </p>
  );
}

// ── Grouped card (iOS 分组卡片) ──

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[10px] border border-neutral-200 bg-white ${className}`}>
      {children}
    </div>
  );
}

// ── List row with chevron (仿 SettingsRow / IdentityItem) ──

export function ChevronRow({
  onClick,
  icon,
  title,
  subtitle,
  detail,
  isLast = false,
}: {
  onClick: () => void;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  detail?: ReactNode;
  isLast?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50 active:bg-neutral-100"
      style={{ borderBottom: isLast ? "none" : "0.5px solid #eee" }}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[16px] font-medium text-neutral-900">{title}</span>
          {detail}
        </div>
        {subtitle && (
          <p className="mt-0.5 truncate text-[13px] leading-relaxed text-neutral-500">{subtitle}</p>
        )}
      </div>
      <span className="shrink-0 text-[18px] leading-none text-neutral-300">›</span>
    </button>
  );
}

// ── Empty state (仿参照 EmptyState) ──

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="mb-3 text-4xl opacity-40">{icon}</span>
      <p className="text-[15px] font-medium text-neutral-500">{title}</p>
      {subtitle && <p className="mt-1 text-[13px] text-neutral-400">{subtitle}</p>}
    </div>
  );
}

// ── Toggle switch (仿参照项目 IdentityForm 的 iOS switch) ──

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="relative inline-flex flex-shrink-0 cursor-pointer items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <div className="h-[31px] w-[51px] rounded-full bg-neutral-300 after:absolute after:left-[2px] after:top-[2px] after:h-[27px] after:w-[27px] after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-5" />
    </label>
  );
}
