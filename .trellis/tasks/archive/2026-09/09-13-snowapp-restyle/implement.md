# 执行计划：admin-web snowapp 全量改造

> 顺序执行；每步末尾跑该步的验证命令。前置阅读：`prd.md` → `design.md` → `research/`。

## Step 1 Token 快照 + 生成脚本（R1）

- [ ] 1.1 写 `admin-web/src/styles/snowapp-tokens.json`：从 `research/snowapp-tokens-2026-09-13.txt` 转换 24 套（含 `_source` 注释字段、FALLBACKS 按 design.md 落为快照内显式值，snow 缺的 token 直接补进 snow-light/snow-dark 数据并标 `"fallback": true`）。
- [ ] 1.2 写 `admin-web/scripts/gen-tokens.mjs`：按 design.md 变量映射生成 `src/styles/tokens.generated.css`；内置校验（24 套齐全 / 每套 ≥28 token / snow-light `--canvas:#EEF2F7` / shadow 必含 spread / focus.ring shadow→color 提取）。校验失败非零退出。
- [ ] 1.3 `package.json` 加 `"tokens"` script；`src/index.css` 删手写变量块、引入 `tokens.generated.css`；`tailwind.config.js` 增 surface-2/3/chrome、border-strong、accent-ink、radius-*、shadow-soft 映射。
- 验证：`cd admin-web && npm run tokens && head -40 src/styles/tokens.generated.css`；`npm run build`。

## Step 2 主题运行时（R2）

- [ ] 2.1 `src/theme/ThemeProvider.tsx` + `main.tsx` 挂 Provider。
- [ ] 2.2 `index.html`：内联防 FOUC script，删写死的 `data-theme="light"`。
- [ ] 2.3 切换 UI：PcSidebar 底部加 preset SelectInput + light/dark 分段按钮；移动端 DrawerSheet 内同款（Step 3 组件先行内联简单版，Step 3 完成后替换为统一组件）。
- 验证：dev server 手测切 preset 不刷新生效、刷新保持、非法 localStorage 回退默认。

## Step 3 组件库（R3）

- [ ] 3.1 `src/components/controls.tsx`：Button（4 变体）、TextInput、SelectInput、Chip、Pill、NavTab。
- [ ] 3.2 `src/components/overlays.tsx`：DrawerSheet、DetailPanel。
- [ ] 3.3 ui.tsx 增补：SettingsRow、Timeline、DiffLines、IslandHeader（保持旧组件 API 不动）。
- [ ] 3.4 页面替换：8 个页面的按钮→Button、input/select→TextInput/SelectInput、状态药丸→Pill、ExpertEditPage 设置行→SettingsRow；RecordsPage 时间线/日志着色可用 Timeline/DiffLines（能用则用，不强扭）。
- 验证：`npx tsc --noEmit`；逐页 dev server 过一遍 CRUD 流程。

## Step 4 响应式 shell（R4）

- [ ] 4.1 PcSidebar 平板档（768~1023）收窄 64px 图标栏。
- [ ] 4.2 移动档触控目标 ≥40px 检查修正（按钮、行、Toggle）。
- 验证：devtools 1280 / 800 / 390 三档截图。

## Step 5 全量验证（对照 AC）

- [ ] AC1 重跑 `npm run tokens` 抽查值。
- [ ] AC2/AC3 24 主题可切换；3 个 preset（gruvbox、solarized、dracula）dark 模式截图检查对比度。
- [ ] AC4 组件清单核对 + type-check。
- [ ] AC5 三档视口截图。
- [ ] AC6 `npm run build` + `npx tsc --noEmit` + 各页功能回归。

## Step 6 收尾

- [ ] 6.1 spec 更新（trellis-update-spec）：前端 spec 增补「token 单一真源 + 主题运行时」契约。
- [ ] 6.2 提交（Phase 3.4 流程）：admin-web 改动单独 commit（仓库惯例：多流并行时 admin-web 与 backend/docs 分开提交）。

## 回滚点

- Step 1 独立可回滚（generated CSS + script 是纯增量，index.css 变更单文件可 revert）。
- Step 2~4 逐 commit，revert 单步不影响 token 层。

## 验证命令汇总

```bash
cd admin-web
npm run tokens          # Step 1 起
npx tsc --noEmit        # Step 3 起
npm run build           # Step 1 起，最终全量
npm run dev             # 手测主题切换与三档视口
```
