# 主题与设计 Token (Theming & Design Tokens)

**状态**: 🟢 Active
**来源**: 任务 `09-13-snowapp-restyle`（admin-web 对齐 Penpot snowapp 设计体系）
**最后更新**: 2026-09-13

## Convention: Token 单一真源管道

**What**: admin-web 的所有设计 token 由 `admin-web/src/styles/snowapp-tokens.json`（快照，单一真源）经 `admin-web/scripts/gen-tokens.mjs` 生成为 `src/styles/tokens.generated.css`，入口 `npm run tokens`（`build` 已前置该步）。**禁止手改 `tokens.generated.css`；禁止在组件里硬编码颜色/圆角/阴影字面量。**

**Why**: 24 套主题（12 preset × light/dark）手写 CSS 不可维护；快照 + 生成脚本保证 Penpot 侧导出值可复现、可校验。

**Token 来源**: Penpot 文件 `snowapp`（2026-09-13 导出；OpenDesign 已弃用）。原始导出行存于 `.trellis/tasks/09-13-snowapp-restyle/research/tokens-{light,dark}.txt` + `tokens-mapping.md`（映射规则与 FALLBACKS）。快照可用 `node scripts/gen-tokens.mjs --from-research` 一键复现。

**重新导出流程**（Penpot 侧 token 变更时）: 通过 Penpot MCP 拉取各 set 的 token 行 → 更新 research 原始行 → `npm run tokens -- --from-research` 重建快照 → `npm run tokens` 重新生成 CSS → 脚本内置校验必须通过（24 套齐全 / 每套 ≥28 token / snow-light `--canvas:#EEF2F7` 抽查 / shadow 含 spread / focus.ring shadow→color 提取），失败非零退出。

## Convention: 主题运行时契约

**What**: `<html>` 携带 `data-preset`（12 选 1）与 `data-theme`（light|dark）两个属性；生成 CSS 按 `[data-preset="..."][data-theme="..."]` 选择器提供 24 个变量块，`:root` 兜底块 = snow-light。

- 状态源：`src/theme/ThemeProvider.tsx`，localStorage key `snowapp.theme`，JSON `{"preset":"snow","mode":"light"}`；非法/缺失值回退 snow/light。
- 防 FOUC：`index.html` `<head>` 内联脚本在首帧前写好两个 dataset 属性（该脚本不允许空 catch，需注释回退意图）。
- 切换 UI：`src/theme/ThemeSwitcher.tsx` 双挂载——PcSidebar 底部（`lg:block`）+ 移动/平板浮动 ⚙ → DrawerSheet（`lg:hidden`）。**两档覆盖必须互补，禁止出现视口空窗**（本次质检曾修掉 md~lg 空窗缺陷）。

**Why**: 主题 = 纯 CSS 变量切换，零重渲染、零刷新；三方（Provider/内联脚本/选择器）的 key 与结构必须严格一致，否则刷新后主题丢失或闪烁。

## Variable Mapping（token → CSS 变量速查）

| token | 变量 | token | 变量 |
|---|---|---|---|
| bg.base | `--canvas` | accent.base | `--accent-ink`（实心按钮底） |
| surface.base/solid/hover | `--surface-island/-strong/--bg-hover` | accent.contrast | `--on-solid` |
| surface.active/2/3/chrome | `--bg-active/--surface-2/-3/--surface-chrome` | border.base/strong | `--border-color/--border-strong` |
| text.primary~faint | `--text-primary/secondary/tertiary/muted` | semantic.{success,danger,info,warning}.{bg,fg} | `--accent-{green,red,blue,amber}{,-bg,-text}` |
| island.shadow.base/soft | `--island-shadow/-soft` | focus.ring | `--focus-ring`（shadow 类型取 layers[0].color） |
| radius.sm/md/lg/xl | `--radius-*` | selection.bg / gap.island | `--selection-bg` / `--gap-island` |

- 语义 DEFAULT 色 = `semantic.*.fg`（真源），不是独立实心色。
- 缺失 token 的 FALLBACKS（snow 集缺 5 个 surface/selection token）在快照中显式补齐并标 `"fallback": true`。
- Tailwind 映射在 `tailwind.config.js`（语义类 bg-island、text-ink 等向后兼容，勿改类名契约）。

## Wrong vs Correct

### Wrong：手写/硬编码主题值
```tsx
// 硬编码色值不随 24 套主题走，且绕过校验管道
<div className="bg-[#3b82f6] rounded-lg" />
```

### Correct：语义类 / token 变量
```tsx
<div className="bg-accent-ink rounded-lg" />
// 需要新语义时：先补 token 快照 → npm run tokens → 再用 Tailwind 映射
```

## Common Mistake: 动了生成文件

**Symptom**: `npm run build` 后自定义样式消失。
**Cause**: `tokens.generated.css` 是产物，`npm run tokens` 会整体重写。
**Fix/Prevention**: 改快照 JSON（或 `gen-tokens.mjs` 的派生逻辑，如 `--surface-island-muted` 派生自 surface.chrome），永远不直接编辑生成文件。

## 已知瑕疵（P3，未修）

DrawerSheet 在平板档（sm~lg，约 800px）呈右下贴边半宽面板而非居中模态；移动档全宽底部抽屉正常。修点：`src/components/overlays.tsx` 的 `sm:` 断面样式。
