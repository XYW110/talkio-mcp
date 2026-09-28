# design — admin-web 全站易用性与视觉优化

## 1. 总体思路

不引入新依赖、不改 token 管道，做三层增量：

1. **反馈层（新增）**：`FeedbackProvider`（Toast 队列）+ `useConfirm`（promise 化 ConfirmDialog）挂到 App 根部，全站替换原生弹窗。
2. **浮层层（重构外壳）**：overlays.tsx 新增通用 `Modal`，五个手写遮罩浮层迁移。
3. **页面层（点状修 bug + 打磨）**：8 页面按 PRD R2~R6 逐项落地。

admin-web 无路由、无 zustand，全部状态经 props 下传 —— 新反馈层用 Context 是唯一例外（跨层 toast/confirm 与既有 ThemeProvider 同模式，可接受，见 state-management.md 的「全局 Context」豁免口径）。

## 2. 新组件契约

### 2.1 Toast（新增 `components/feedback.tsx`）

```tsx
type ToastTone = "success" | "error" | "info";
interface ToastItem { id: number; tone: ToastTone; message: ReactNode; sticky?: boolean }
interface FeedbackCtx {
  toast: (tone: ToastTone, message: ReactNode, opts?: { sticky?: boolean }) => void;
  confirm: (opts: { title: string; message?: ReactNode; confirmText?: string; cancelText?: string; danger?: boolean }) => Promise<boolean>;
}
const useFeedback = (): FeedbackCtx   // 未挂 Provider 时 throw（同 useTheme 口径）
```

- 渲染：右上固定栈（桌面 `top-4 right-4`；移动端 `top-4 left-4 right-4`），入场 `snowapp-toast-in` 下滑淡入动画；success/info 3.5s 自动消退，error `sticky` 待手动关（× 按钮）。
- success 用 `bg-ok text-on-solid`，error 沿用 `bg-bad`，info `bg-accent-ink`；圆角/阴影对齐现 ErrorBanner（rounded-xl shadow-lg）。
- 现 `App.ErrorBanner` 与 UsagePage 手写 toast **删除**，统一走 `toast("error", msg, { sticky: true })` / `toast("error", …)`。
- 保存成功：`toast("success", <>已保存。MCP server 需重启后新配置才生效</>)`。

### 2.2 ConfirmDialog（同文件）

- 单实例挂 FeedbackProvider 内部，confirm() 返回 `Promise<boolean>`；Esc/遮罩/取消 = false，确认 = true。
- 结构复用 `Modal` 外壳（见 2.3），宽 `max-w-sm`；`danger: true` 时确认钮 `bg-bad`，否则 `bg-accent-ink`；取消钮 ghost。
- 焦点管理：打开时 focus 确认钮（autoFocus），关闭还焦不强制（浮层场景简单，不做 full trap，PRD AC4 只要求 Esc/取消行为）。
- 替换映射（文案沿用现有 confirm 字符串）：

| 现调用点 | 替换后 |
|---|---|
| ExpertsPage 单删/批删/清空（3） | `confirm({ danger: true, … })` |
| ProvidersPage 单删/批删/清空/编辑浮层删除（4） | 同上 |
| ModelsPage 单删/批删/清空（3） | 同上 |
| CardsPage 单删/批删/清空（3） | 同上 |
| RecordsPage 批删/清空（2） | 同上 |
| App.deleteExperts 内置专家提示 alert | `toast("error", "内置专家不可删除：…", { sticky: true })` |
| ExpertEditPage 校验 alert ×2 | 保存钮已 disabled 兜底，校验分支改 `toast("error", …)` |
| Provider/Model/Card 编辑浮层校验 alert（共 ~8） | `toast("error", …)` |
| ChatPage 话题/选卡/上限 alert ×3 | `toast("error", …)` |

### 2.3 Modal（overlays.tsx 增量导出）

```tsx
export function Modal({ open, onClose, title, right, children, footer, size = "md" }: {…})
```

- `size`: `"sm" | "md" | "lg"` → max-w-sm/md/lg。
- 结构 = 现 DrawerSheet 的桌面档形态泛化：遮罩（overlay-mask + bg-black/30 + 点击关）+ 居中面板（island-strong、rounded-2xl、max-h-[90vh]、`snowapp-pop-in` 动画：scale 0.97→1 + fade）+ NavBar 式头部（title + right）+ 滚动 body + 可选 footer；Esc 关闭（复用 DrawerSheet 的 useEffect 模式）。
- 移动端：底部滑入（复用 `drawer-panel` 动画 + rounded-t-2xl），≥sm 居中弹窗 —— 与现有五个浮层的行为一致，迁移零行为变化。
- 迁移对象：ProviderEditOverlay、ModelEditOverlay、CardEditOverlay、UsagePage 价格表、ModelPicker。迁移后各自只保留表单体内容。
- DrawerSheet / DetailPanel 不动。

## 3. 页面层改动要点（按文件）

- **App.tsx**：挂 `FeedbackProvider`；删 ErrorBanner 改 toast；save() 增加 `saving` 态（按钮转圈/禁用）；Ctrl/Cmd+S（dirty 时）keydown 保存；首屏 loading 品牌化（MessageCircle 图标 + animate-spin 环 + 文案）；总览菜单卡 hover 浮起 + 图标 `group-hover:text-info-text`。
- **components/ui.tsx**：EmptyState 加 `action?: ReactNode`（渲染在副标题下、mt-4）；MultiSelectToolbar 外层由调用方条件渲染（组件内不动，四个页 + Records 判断 `total === 0 && selectedCount === 0` 时隐藏）；Toggle 输入元素加 `peer` 已有，补 `peer-focus-visible:ring-2 peer-focus-visible:ring-info`（作用于轨道 div）。
- **components/controls.tsx**：BUTTON_VARIANTS.primary 加 `active:scale-[0.98]`（克制幅度）；NavBar 不在此文件（在 ui.tsx）—— NavBar 返回按钮补 `hover:bg-hover`。
- **ExpertsPage / ProvidersPage / ModelsPage / CardsPage**：空态传 action（`<Button variant="primary" onClick={onAdd}>新建专家</Button>` 等）；confirm/alert 替换；MultiSelectToolbar 条件渲染；CardsPage id 复制（`navigator.clipboard.writeText` + `toast("success", "已复制 id")`，按钮 ghost icon Copy 图标，移动行同理）；ModelsPage Toggle 双触发修复（外层 span 只 `e.stopPropagation()`，去掉 onToggle 调用，由 Toggle 自己的 onChange 触发）。
- **RecordsPage**：工具条/勾选框换 `MultiSelectToolbar`/`SelectCheckbox`（busy 传参已有）；`style={{borderBottom…}}` 全部换 `border-b border-line` / 条件类；记录行主文案 16px→14px；详情 InfoRow 同步改 class。
- **UsagePage**：价格表浮层迁 Modal；toast 删手写；其余不动。
- **ChatPage**：`### ` 删除；报告头加复制按钮；勾选框换 SelectCheckbox（checked 样式由组件自带，外层按钮保留选中底色逻辑）。
- **ExpertEditPage**：textarea 自动增高（ref + input 时 `style.height = scrollHeight`，min 120 max 400）+ 右下字数统计（`text-[11px] text-ink-faint`）；关闭时 dirty（任一字段 ≠ initial）→ `confirm({ title: "放弃未保存的修改？", danger: false })` 拦截。
- **ModelPicker.tsx**：迁 Modal 外壳；hover 改 `hover:bg-hover`；apiKey autoFocus。
- **index.css**：新增 `@keyframes snowapp-pop-in` / `snowapp-toast-in`，`.modal-panel` / `.toast-item` 类；所有浮层/toast 动画包 `@media (prefers-reduced-motion: reduce) { animation: none }` 降级。

## 4. 兼容与回滚

- ui.tsx / controls.tsx 现有导出签名不变（只加可选 prop / 追加 class），8 页无破坏性迁移。
- 不动 `disabledTools` 透传、保存 schema、api.ts。
- 回滚：单提交 `git revert` 即可；无数据迁移、无后端联动。

## 5. 风险

- ConfirmDialog promise 化后，原 `window.confirm` 同步语义变异步 —— 所有调用点都在事件回调内 `if (!(await confirm(...))) return;` 形式改写，注意 `onDeleteSelected` 等函数改 async；RecordsPage 的 `runDelete` 本就 async，衔接自然。
- Modal 迁移时 mobile 档 `items-end` vs 桌面 `items-center` 行为必须在 Modal 内统一实现，逐个浮层迁移后浏览器双档宽各验一遍。
- clipboard API 在非 https/localhost 下不可用 —— admin-web 仅本机/内网使用（localhost:3100），`navigator.clipboard` 可用；仍包 try/catch 失败时 `toast("error", "复制失败")`。
