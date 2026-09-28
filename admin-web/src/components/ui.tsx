import { Fragment, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

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
        className="flex min-h-[40px] min-w-[64px] items-center gap-0.5 rounded-md px-1 py-2 text-[13px] font-medium text-info-text transition-colors hover:bg-hover active:bg-pressed"
      >
        <ChevronLeft size={16} className="shrink-0 leading-none" aria-hidden="true" />
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
      <ChevronRight size={16} className="shrink-0 text-ink-faint" aria-hidden="true" />
    </button>
  );
}

// ── Empty state ──

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  /** Lucide 图标节点（颜色继承文字色，尺寸由调用方传 size，一般 40） */
  icon: ReactNode;
  title: string;
  subtitle?: string;
  /** 可选主操作按钮（如「新建 XX」），渲染在副标题下 */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="mb-3 opacity-40">{icon}</span>
      <p className="text-[14px] font-medium text-ink-dim">{title}</p>
      {subtitle && <p className="mt-1 text-[12px] text-ink-faint">{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
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
      <div className="h-[28px] w-[46px] rounded-full bg-pressed after:absolute after:left-[2px] after:top-[2px] after:h-[24px] after:w-[24px] after:rounded-full after:bg-island-strong after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-info peer-checked:after:translate-x-[18px] peer-focus-visible:ring-2 peer-focus-visible:ring-info" />
    </label>
  );
}

// ── 多选勾选框（行内使用；stopPropagation 防止触发行/卡片点击）──

export function SelectCheckbox({
  checked,
  onClick,
  disabled = false,
}: {
  checked: boolean;
  onClick: () => void;
  /** true 时按钮真正 disabled：不触发 onClick，键盘也不可达（如群聊运行中锁选卡） */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={checked ? "取消选择" : "选择"}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked ? "border-info bg-info" : "border-line bg-island-strong"
      } disabled:cursor-not-allowed`}
    >
      {checked && <Check size={12} className="leading-none text-on-solid" aria-hidden="true" />}
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
          {allSelected && (
            <Check size={10} className="leading-none text-on-solid" aria-hidden="true" />
          )}
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

// ══════════ 以下为 snowapp 改造新增组件（旧组件 API 保持不变）══════════

// ── IslandHeader：岛头部（标题 + 副标题 + hairline 分隔线）──

export function IslandHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex-shrink-0 border-b border-line px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-ink">{title}</p>
          {subtitle && <p className="mt-0.5 truncate text-[12px] text-ink-dim">{subtitle}</p>}
        </div>
        {right && <div className="flex flex-shrink-0 items-center gap-1">{right}</div>}
      </div>
    </div>
  );
}

// ── SettingsRow：56px 设置行（label 左 / 控件右，行间 hairline 分隔）──

export function SettingsRow({
  label,
  description,
  children,
  isLast = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  isLast?: boolean;
}) {
  return (
    <div
      className={`flex min-h-[56px] items-center justify-between gap-4 px-4 py-2.5 ${
        isLast ? "" : "border-b border-line"
      }`}
    >
      <div className="min-w-0">
        <p className="text-[13px] text-ink">{label}</p>
        {description && <p className="mt-0.5 text-[12px] text-ink-faint">{description}</p>}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

// ── BreadcrumbStrip：面包屑条（Home > Current，分隔符 text-faint）──

export function BreadcrumbStrip({ home, current }: { home: string; current: string }) {
  return (
    <div className="flex items-center gap-1.5 px-4 py-2 text-[12px]">
      <span className="text-ink-faint">{home}</span>
      <ChevronRight size={12} className="text-ink-faint" aria-hidden="true" />
      <span className="font-medium text-ink-dim">{current}</span>
    </div>
  );
}

// ── Timeline：横向状态时间线（dots + labels，pending→active→done）──

export type TimelineStepState = "pending" | "active" | "done";

export interface TimelineStep {
  label: string;
  state: TimelineStepState;
}

const TIMELINE_DOT: Record<TimelineStepState, string> = {
  done: "bg-ok",
  active: "bg-info",
  pending: "bg-pressed",
};

export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <div className="flex w-full items-start px-4 py-3">
      {steps.map((step, i) => (
        <Fragment key={`${step.label}-${i}`}>
          {i > 0 && (
            <div
              className={`mt-[4px] h-0.5 flex-1 ${
                steps[i - 1].state === "pending" ? "bg-pressed" : "bg-info"
              }`}
            />
          )}
          <div className="flex flex-col items-center gap-1">
            <span
              className={`h-2.5 w-2.5 rounded-full ${TIMELINE_DOT[step.state]}`}
              aria-current={step.state === "active" ? "step" : undefined}
            />
            <span
              className={`whitespace-nowrap text-[11px] ${
                step.state === "pending" ? "text-ink-faint" : "text-ink-dim"
              }`}
            >
              {step.label}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// ── DiffLines：diff 着色行（ctx 默认 / del=danger / add=success）──

export type DiffLineType = "ctx" | "del" | "add";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

const DIFF_LINE_STYLE: Record<DiffLineType, string> = {
  ctx: "text-ink-dim",
  del: "bg-bad-bg text-bad-text",
  add: "bg-ok-bg text-ok-text",
};

const DIFF_LINE_PREFIX: Record<DiffLineType, string> = {
  ctx: " ",
  del: "-",
  add: "+",
};

export function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line font-mono text-[12px] leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className={`whitespace-pre-wrap break-words px-3 py-1 ${DIFF_LINE_STYLE[line.type]}`}>
          <span className="mr-1.5 select-none opacity-60">{DIFF_LINE_PREFIX[line.type]}</span>
          {line.text}
        </div>
      ))}
    </div>
  );
}
