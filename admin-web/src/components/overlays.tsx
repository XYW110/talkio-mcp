import { useEffect, type ReactNode } from "react";

// ── snowapp 浮层：DrawerSheet（移动端底部滑入）/ DetailPanel（右侧 slide-over）──

// ── DrawerSheet：底部滑入抽屉（island-strong 底 + 顶部圆角 + 拖拽条 + 遮罩）──

export function DrawerSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}) {
  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="overlay-mask absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="drawer-panel absolute bottom-0 left-0 right-0 flex max-h-[85vh] flex-col rounded-t-xl bg-island-strong shadow-island sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:w-[420px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
      >
        {/* 顶部拖拽条（32×4） */}
        <div className="flex justify-center pt-2">
          <span className="h-1 w-8 rounded-full bg-border-strong" />
        </div>
        {title && (
          <div className="px-4 pb-2 pt-1.5">
            <p className="text-[14px] font-semibold text-ink">{title}</p>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2">{children}</div>
      </div>
    </div>
  );
}

// ── DetailPanel：右侧滑入详情面板（宽 ≤420px，header / body / footer 三段）──

export function DetailPanel({
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="overlay-mask absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="detail-panel absolute bottom-0 right-0 top-0 flex w-[min(420px,92vw)] flex-col bg-island-strong shadow-island"
      >
        {/* header */}
        <div className="flex flex-shrink-0 items-start justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-ink">{title}</p>
            {subtitle && <p className="mt-0.5 truncate text-[12px] text-ink-dim">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-ink-faint hover:bg-hover"
          >
            ✕
          </button>
        </div>
        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {/* footer */}
        {footer && (
          <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
