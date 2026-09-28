import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

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
            <X size={18} aria-hidden="true" />
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

// ── Modal：通用居中模态（移动端 bottom-sheet / ≥sm 居中弹窗）──
// 迁移自五个手写遮罩浮层（Provider/Model/Card 编辑、价格表、ModelPicker）。
// Esc 采用栈式管理：嵌套 ConfirmDialog 时只关最上层，不会连带关闭底层浮层。

/** 已打开 Modal 的栈（模块级，用于 Esc 只命中最上层） */
const modalStack: symbol[] = [];

const MODAL_SIZE_CLASS = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
} as const;

export function Modal({
  open,
  onClose,
  title,
  right,
  children,
  footer,
  size = "md",
  bodyClassName = "overflow-y-auto px-4 py-3",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof MODAL_SIZE_CLASS;
  /** 覆盖 body 布局类；如 ModelPicker 需 flex 列布局 + 内部自滚动 */
  bodyClassName?: string;
}) {
  // latest-ref 惯用法：onClose 多为内联函数，避免其身份变化导致 Esc 监听器重挂、栈序错乱
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const token = Symbol();
    modalStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === token) {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      const idx = modalStack.indexOf(token);
      if (idx >= 0) modalStack.splice(idx, 1);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="overlay-mask absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={`drawer-panel modal-panel relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl bg-island-strong shadow-2xl sm:rounded-2xl ${MODAL_SIZE_CLASS[size]}`}
      >
        {/* 头部：title + right + 关闭 */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <p className="min-w-0 truncate text-[14px] font-semibold text-ink">{title}</p>
          <div className="flex flex-shrink-0 items-center gap-1">
            {right}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-faint hover:bg-hover"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
        {/* body：默认自滚动；bodyClassName 可改为 flex 容器交给子元素滚动 */}
        <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
        {footer && (
          <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
