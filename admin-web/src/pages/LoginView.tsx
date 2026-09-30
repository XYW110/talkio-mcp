import { useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, MessageCircle, ShieldAlert } from "lucide-react";
import { authCheck, storeToken } from "../api";
import { Button, TextInput } from "../components/controls";

/**
 * 登录页：token 输入 → GET /api/auth/check 校验 → 成功存 localStorage 进入管理台。
 * 401 按状态区分文案：fail-closed（服务器未配置 TALKIO_ADMIN_TOKEN）与令牌无效分开提示。
 */
export function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = token.trim();
    if (!t) {
      setError("请输入访问令牌");
      return;
    }
    setBusy(true);
    setError(null);
    setNotConfigured(false);
    try {
      const result = await authCheck(t);
      if (result.ok) {
        storeToken(t);
        onSuccess();
      } else if (result.notConfigured) {
        setNotConfigured(true);
        setError(
          "服务器未配置 TALKIO_ADMIN_TOKEN：请先在服务端环境变量中设置后重启，再回此页登录。",
        );
      } else {
        setError("令牌无效，请检查后重试。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-canvas p-4">
      <div className="island island-strong w-full max-w-sm px-6 py-8">
        {/* 品牌区 */}
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-info-bg">
            <MessageCircle size={24} className="text-info-text" aria-hidden="true" />
          </span>
          <h1 className="text-[20px] font-bold tracking-tight text-ink">Talkio 管理</h1>
          <p className="text-[13px] text-ink-dim">请输入访问令牌登录管理后台</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <TextInput
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="访问令牌"
            aria-label="访问令牌"
            autoComplete="current-password"
            autoFocus
          />
          <Button
            variant="primary"
            type="submit"
            disabled={!token.trim() || busy}
            className="h-11 w-full rounded-xl text-[14px] font-semibold"
          >
            {busy ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                校验中…
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <KeyRound size={14} aria-hidden="true" />
                登录
              </span>
            )}
          </Button>
        </form>

        {error && (
          <div
            role="alert"
            className={`mt-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px] leading-relaxed ${
              notConfigured ? "bg-warn-bg text-warn-text" : "bg-bad-bg text-bad-text"
            }`}
          >
            <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <p className="mt-6 text-center text-[11px] leading-relaxed text-ink-faint">
          令牌由服务端 TALKIO_ADMIN_TOKEN 环境变量配置；
          <br />
          MCP 客户端接入凭证请在登录后于「访问令牌」页生成。
        </p>
      </div>
    </div>
  );
}
