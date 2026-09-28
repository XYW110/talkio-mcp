import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { Modal } from "./overlays";
import { Button } from "./controls";

// ── 全局反馈层：Toast 队列 + promise 化 ConfirmDialog（全站替换原生弹窗）──
// 跨层 toast/confirm 用 Context 是 state-management.md「全局 Context」豁免口径内的唯一例外
//（与 ThemeProvider 同模式）；ConfirmDialog 复用 Modal 外壳，Esc/遮罩/取消 = false，确认 = true。

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: ReactNode;
  /** error 默认常驻待手动关闭，success/info 自动消退 */
  sticky: boolean;
}

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** true = 确认钮红色实心（删除/清空类危险操作） */
  danger?: boolean;
}

interface FeedbackCtx {
  toast: (tone: ToastTone, message: ReactNode, opts?: { sticky?: boolean }) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackCtx | null>(null);

const TOAST_TONE_CLASS: Record<ToastTone, string> = {
  success: "bg-ok text-on-solid",
  error: "bg-bad text-on-solid",
  info: "bg-accent-ink text-on-solid",
};

const AUTO_DISMISS_MS = 3500;

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmOpts, setConfirmOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<FeedbackCtx["toast"]>(
    (tone, message, opts) => {
      const sticky = opts?.sticky ?? tone === "error";
      idRef.current += 1;
      const id = idRef.current;
      setToasts((prev) => [...prev, { id, tone, message, sticky }]);
      // 非常驻 toast 定时消退；Provider 与应用同生命周期，定时器不单独清理
      if (!sticky) window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const confirm = useCallback<FeedbackCtx["confirm"]>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setConfirmOpts(opts);
    });
  }, []);

  const settleConfirm = useCallback((v: boolean) => {
    resolveRef.current?.(v);
    resolveRef.current = null;
    setConfirmOpts(null);
  }, []);

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}

      {/* ConfirmDialog 单实例；danger 时确认钮红色实心，焦点默认落在确认钮 */}
      {confirmOpts && (
        <Modal
          open
          onClose={() => settleConfirm(false)}
          title={confirmOpts.title}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => settleConfirm(false)}>
                {confirmOpts.cancelText ?? "取消"}
              </Button>
              <Button
                autoFocus
                variant="primary"
                className={confirmOpts.danger ? "!bg-bad" : ""}
                onClick={() => settleConfirm(true)}
              >
                {confirmOpts.confirmText ?? "确认"}
              </Button>
            </>
          }
        >
          {confirmOpts.message && (
            <p className="text-[13px] leading-relaxed text-ink-dim">{confirmOpts.message}</p>
          )}
        </Modal>
      )}

      {/* Toast 栈：移动端通栏 top，桌面右上；error 常驻带 ×，success/info 自动消退 */}
      <div className="pointer-events-none fixed left-4 right-4 top-4 z-[100] flex flex-col gap-2 sm:left-auto sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={`toast-item pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 shadow-lg ${TOAST_TONE_CLASS[t.tone]}`}
          >
            <span className="text-sm">{t.message}</span>
            {t.sticky && (
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="关闭"
                className="ml-auto flex-shrink-0 opacity-80 hover:opacity-100"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackCtx {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useFeedback 必须在 FeedbackProvider 内使用");
  return ctx;
}
