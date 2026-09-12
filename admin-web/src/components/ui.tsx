import type { ReactNode } from "react";

// ── 顶栏（snow-app 岛内顶栏：透明底 + hairline 下边线）──

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
    <div className="flex flex-shrink-0 items-center border-b border-line px-3 py-2.5">
      <button
        onClick={onBack}
        className="flex min-w-[64px] items-center gap-0.5 rounded-md px-1 py-0.5 text-[13px] font-medium text-info-text active:bg-pressed"
      >
        <span className="text-[16px] leading-none">‹</span>
        <span>返回</span>
      </button>
      <span className="flex-1 text-center text-[15px] font-semibold text-ink">{title}</span>
      <div className="flex min-w-[64px] items-center justify-end pr-1">{right}</div>
    </div>
  );
}

// ── Section label（uppercase 小节标题）──

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pb-1.5 pt-5 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
      {children}
    </p>
  );
}

// ── Grouped card（岛内 hairline 分组容器）──

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-line bg-island-strong ${className}`}>
      {children}
    </div>
  );
}

// ── List row with chevron ──

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
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover active:bg-pressed ${
        isLast ? "" : "border-b border-line"
      }`}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-ink">{title}</span>
          {detail}
        </div>
        {subtitle && (
          <p className="mt-0.5 truncate text-[12px] leading-relaxed text-ink-dim">{subtitle}</p>
        )}
      </div>
      <span className="shrink-0 text-[16px] leading-none text-ink-faint">›</span>
    </button>
  );
}

// ── Empty state ──

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
      <p className="text-[14px] font-medium text-ink-dim">{title}</p>
      {subtitle && <p className="mt-1 text-[12px] text-ink-faint">{subtitle}</p>}
    </div>
  );
}

// ── Toggle switch ──

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
      <div className="h-[28px] w-[46px] rounded-full bg-pressed after:absolute after:left-[2px] after:top-[2px] after:h-[24px] after:w-[24px] after:rounded-full after:bg-island-strong after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-info peer-checked:after:translate-x-[18px]" />
    </label>
  );
}

// ── 多选勾选框（行内使用；stopPropagation 防止触发行/卡片点击）──

export function SelectCheckbox({
  checked,
  onClick,
}: {
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={checked ? "取消选择" : "选择"}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked ? "border-info bg-info" : "border-line bg-island-strong"
      }`}
    >
      {checked && <span className="text-[11px] leading-none text-on-solid">✓</span>}
    </button>
  );
}

// ── 多选工具条：全选 + 计数 + 删除所选 + 清空全部（四个配置页共用）──

export function MultiSelectToolbar({
  noun,
  totalText,
  selectedCount,
  selectableCount,
  allSelected,
  busy,
  onToggleAll,
  onDeleteSelected,
  onClearAll,
  clearAllDisabled,
}: {
  noun: string;
  /** 未选中时显示的总数文案，例如「共 5 张」 */
  totalText: string;
  selectedCount: number;
  selectableCount: number;
  allSelected: boolean;
  busy?: boolean;
  onToggleAll: () => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  clearAllDisabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <button
        type="button"
        onClick={onToggleAll}
        disabled={selectableCount === 0}
        className="flex items-center gap-1.5 text-[13px] text-ink-mid disabled:opacity-40"
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border ${
            allSelected ? "border-info bg-info" : "border-line bg-island-strong"
          }`}
        >
          {allSelected && <span className="text-[10px] leading-none text-on-solid">✓</span>}
        </span>
        全选
      </button>
      <span className="text-[12px] text-ink-faint">
        {selectedCount > 0
          ? `已选 ${selectedCount} / ${selectableCount} ${noun}`
          : totalText}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onDeleteSelected}
          disabled={selectedCount === 0 || busy}
          className="rounded-lg bg-bad-bg px-3 py-1.5 text-[13px] font-medium text-bad-text hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
        >
          删除所选
        </button>
        <button
          type="button"
          onClick={onClearAll}
          disabled={clearAllDisabled || busy}
          className="rounded-lg bg-hover px-3 py-1.5 text-[13px] font-medium text-ink-mid hover:bg-pressed disabled:cursor-not-allowed disabled:opacity-40"
        >
          清空全部
        </button>
      </div>
    </div>
  );
}
