import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api } from "../api";
import type { CreatedMcpToken, McpTokenInfo } from "../types";
import { Card, EmptyState, NavBar } from "../components/ui";
import { Button, Pill, TextInput } from "../components/controls";
import { Modal } from "../components/overlays";
import { useFeedback } from "../components/feedback";

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

/**
 * 「访问令牌」页：MCP 动态令牌池管理。
 * 列表（名称/创建时间/最近使用/指纹后4位）+ 生成（明文一次性展示）+ 吊销（二次确认）。
 */
export function TokensPage({ onBack }: { onBack: () => void }) {
  const { confirm, toast } = useFeedback();
  const [tokens, setTokens] = useState<McpTokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 生成对话框状态
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // 明文一次性展示（关闭后不可再查看）
  const [created, setCreated] = useState<CreatedMcpToken | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await api.listTokens();
      setTokens(list ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setName("");
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const n = name.trim();
    if (!n || creating) return;
    setCreating(true);
    try {
      const result = await api.createToken(n);
      setCreateOpen(false);
      setCreated(result);
      setCopied(false);
      await load();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  /** 复制明文（clipboard 不可用时降级为失败 toast，与 ChatPage 同款）。 */
  const copyPlaintext = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
      toast("success", "已复制令牌明文");
    } catch {
      toast("error", "复制失败，请手动选择复制");
    }
  };

  const closeCreated = () => {
    setCreated(null);
    setCopied(false);
  };

  const onDelete = async (t: McpTokenInfo) => {
    const ok = await confirm({
      title: "吊销访问令牌",
      message: `确定吊销「${t.name}」（指纹 …${t.fingerprint}）？使用该令牌的 MCP 客户端将立即 401，此操作不可撤销。`,
      confirmText: "吊销",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteToken(t.id);
      toast("success", `已吊销「${t.name}」`);
      await load();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶部导航：返回 + 标题 + 刷新 */}
      <NavBar
        title="访问令牌"
        onBack={onBack}
        right={
          <Button variant="icon" onClick={load} aria-label="刷新" title="刷新">
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
          </Button>
        }
      />

      <div className="flex-shrink-0 px-4 pt-3 pb-1">
        <p className="text-[13px] text-ink-dim">
          MCP 客户端（Cursor / mcp-remote / Snow…）接入 /sse 与 /messages 用的凭证。
          明文仅在生成时展示一次，服务端只存哈希。
        </p>
      </div>

      <div className="flex items-center justify-between px-4 py-1.5">
        <span className="text-[12px] text-ink-faint">共 {tokens.length} 个</span>
        <Button
          variant="primary"
          onClick={openCreate}
          className="h-9 rounded-lg px-3 text-[13px]"
        >
          <Plus size={14} aria-hidden="true" />
          生成令牌
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {loading ? (
          <EmptyState icon={<LoaderCircle size={40} />} title="加载中…" />
        ) : error ? (
          <EmptyState icon={<TriangleAlert size={40} />} title="加载失败" subtitle={error} />
        ) : tokens.length === 0 ? (
          <EmptyState
            icon={<KeyRound size={40} />}
            title="还没有访问令牌"
            subtitle="生成一个令牌，配置到 MCP 客户端即可接入"
            action={
              <Button variant="primary" onClick={openCreate} className="h-9 rounded-lg px-3 text-[13px]">
                <Plus size={14} aria-hidden="true" />
                生成令牌
              </Button>
            }
          />
        ) : (
          <Card>
            {tokens.map((t, i) => (
              <div
                key={t.id}
                className={`flex items-center gap-3 px-4 py-3 ${
                  i === tokens.length - 1 ? "" : "border-b border-line"
                }`}
              >
                <KeyRound size={18} className="shrink-0 text-ink-mid" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium text-ink">{t.name}</span>
                    <span
                      className="shrink-0 rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-dim"
                      title="令牌哈希指纹后 4 位"
                    >
                      …{t.fingerprint}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] leading-relaxed text-ink-dim">
                    {`创建于 ${fmtTime(t.createdAt)} · 最近使用 ${
                      t.lastUsedAt ? fmtTime(t.lastUsedAt) : "从未"
                    }`}
                  </p>
                </div>
                {/* 行内危险操作：icon-only 按钮避开窄列裁剪（见 component-guidelines 行内操作簇） */}
                <button
                  type="button"
                  onClick={() => void onDelete(t)}
                  aria-label={`吊销 ${t.name}`}
                  title="吊销"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-bad hover:bg-bad-bg"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* 生成对话框：名称输入 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="生成访问令牌"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={submitCreate}
              disabled={!name.trim() || creating}
            >
              {creating ? (
                <span className="inline-flex items-center gap-1.5">
                  <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                  生成中…
                </span>
              ) : (
                "生成"
              )}
            </Button>
          </>
        }
      >
        <label className="mb-1.5 block text-[13px] text-ink">名称</label>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：cursor-桌面"
          maxLength={50}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitCreate();
          }}
        />
        <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
          明文令牌仅生成后展示一次，请立即复制保存到 MCP 客户端配置。
        </p>
      </Modal>

      {/* 明文一次性展示：关闭后无法再查看 */}
      <Modal
        open={created !== null}
        onClose={closeCreated}
        title="令牌已生成"
        size="md"
        footer={
          <Button variant="primary" onClick={closeCreated}>
            我已保存，关闭
          </Button>
        }
      >
        {created && (
          <div className="flex flex-col gap-3">
            <Pill tone="warn" className="w-fit">
              仅显示这一次，关闭后无法再查看
            </Pill>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-hover px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink">
                {created.plaintext}
              </code>
              <Button
                variant="ghost"
                onClick={copyPlaintext}
                aria-label="复制令牌明文"
                className="shrink-0"
              >
                <Copy size={14} aria-hidden="true" />
                {copied ? "已复制" : "复制"}
              </Button>
            </div>
            <p className="text-[12px] text-ink-dim">
              名称：{created.name}
            </p>
            <p className="text-[12px] leading-relaxed text-ink-faint">
              配置示例（Cursor headers）：Authorization: Bearer {`<`}此令牌{">"}；
              或 URL 兜底 /sse?token={`<`}此令牌{">"}（建议仅作降级）。
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
