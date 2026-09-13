/**
 * snowapp token 管道：
 *   node scripts/gen-tokens.mjs                 — 读 src/styles/snowapp-tokens.json → src/styles/tokens.generated.css
 *   node scripts/gen-tokens.mjs --from-research — 从 .trellis research 原始行（set|type|name|value）重建快照 JSON
 *
 * 快照是单一真源；research 重建仅用于审计复现，不进入日常流程。
 * 无第三方依赖（node 内置模块）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_WEB = resolve(__dirname, "..");
const SNAPSHOT_PATH = join(ADMIN_WEB, "src", "styles", "snowapp-tokens.json");
const OUT_PATH = join(ADMIN_WEB, "src", "styles", "tokens.generated.css");
const RESEARCH_DIR = resolve(
  ADMIN_WEB,
  "..",
  ".trellis",
  "tasks",
  "09-13-snowapp-restyle",
  "research",
);

/** token 名 → CSS 变量名（数组 = 一个 token 派生多个变量）。 */
const VAR_MAP = {
  "bg.base": "--canvas",
  "surface.base": "--surface-island",
  "surface.solid": "--surface-island-strong",
  "surface.hover": "--bg-hover",
  "surface.active": "--bg-active",
  "surface.2": "--surface-2",
  "surface.3": "--surface-3",
  "surface.chrome": "--surface-chrome",
  "text.primary": "--text-primary",
  "text.secondary": "--text-secondary",
  "text.muted": "--text-tertiary",
  "text.faint": "--text-muted",
  "accent.base": "--accent-ink",
  "accent.contrast": "--on-solid",
  "border.base": "--border-color",
  "border.strong": "--border-strong",
  "semantic.success.bg": "--accent-green-bg",
  "semantic.success.fg": ["--accent-green", "--accent-green-text"],
  "semantic.danger.bg": "--accent-red-bg",
  "semantic.danger.fg": ["--accent-red", "--accent-red-text"],
  "semantic.info.bg": "--accent-blue-bg",
  "semantic.info.fg": ["--accent-blue", "--accent-blue-text"],
  "semantic.warning.bg": "--accent-amber-bg",
  "semantic.warning.fg": ["--accent-amber", "--accent-amber-text"],
  "island.shadow.base": "--island-shadow",
  "island.shadow.soft": "--island-shadow-soft",
  "focus.ring": "--focus-ring",
  "selection.bg": "--selection-bg",
  "radius.sm": "--radius-sm",
  "radius.md": "--radius-md",
  "radius.lg": "--radius-lg",
  "radius.xl": "--radius-xl",
  "gap.island": "--gap-island",
};

const PRESETS = [
  "snow",
  "cream",
  "dracula",
  "forest-green",
  "github",
  "google",
  "gruvbox",
  "midnight-blue",
  "nord",
  "rose-pink",
  "solarized",
  "tokyo-night",
];
const MODES = ["light", "dark"];

/** snow 套缺失 token 的回退（research/tokens-mapping.md FALLBACKS）。 */
const FALLBACKS = {
  "snow-light": {
    "surface.2": { type: "color", value: "#F3F4F6" },
    "surface.3": { type: "color", value: "#E5E7EB" },
    "surface.active": { type: "color", value: "#E5E7EB" },
    "surface.chrome": { type: "color", value: "#F8FAFC" },
    "selection.bg": { type: "color", value: "#3B82F633" },
  },
  "snow-dark": {
    "surface.active": { type: "color", value: "#1A1A1A" },
    "surface.chrome": { type: "color", value: "#111111" },
    "selection.bg": { type: "color", value: "#58A6FF47" },
  },
};

// ── 阴影合成 ────────────────────────────────────────────────────────────

/** layers 数组 → CSS box-shadow 值（每层 `offsetX offsetY blur spread color`，inset 层带前缀）。 */
function composeShadow(layers) {
  return layers
    .map((l) =>
      [l.inset === true ? "inset" : null, l.offsetX, l.offsetY, l.blur, l.spread, l.color]
        .filter((part) => part !== null)
        .join(" "),
    )
    .join(", ");
}

/** token 条目 → CSS 值（focus.ring 为 shadow 类型时取 layers[0].color）。 */
function tokenToCssValue(entry) {
  if (entry.type === "shadow") {
    const layers = entry.value; // 快照中 shadow.value = layers 数组
    if (entry.name === "focus.ring") {
      const color = layers[0]?.color;
      if (!color) throw new Error("focus.ring shadow 缺少 layers[0].color");
      return color;
    }
    return composeShadow(layers);
  }
  return entry.value;
}

// ── --from-research：原始行 → 快照 JSON ────────────────────────────────

function fromResearch() {
  const sets = {};
  for (const file of ["tokens-light.txt", "tokens-dark.txt"]) {
    const raw = readFileSync(join(RESEARCH_DIR, file), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [set, type, name, value] = trimmed.split("|");
      if (!set || !type || !name || value === undefined) {
        throw new Error(`research 行格式非法: ${line}`);
      }
      sets[set] ??= {};
      sets[set][name] =
        type === "shadow" ? { type, name, value: JSON.parse(value) } : { type, name, value };
    }
  }
  for (const [set, fallbacks] of Object.entries(FALLBACKS)) {
    sets[set] ??= {};
    for (const [name, entry] of Object.entries(fallbacks)) {
      if (sets[set][name] === undefined) {
        sets[set][name] = { ...entry, name, fallback: true };
      }
    }
  }
  const snapshot = {
    _source: "Penpot file 'snowapp', exported 2026-09-13 via MCP",
    presets: PRESETS,
    sets,
  };
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`[gen-tokens] 快照已重建: ${SNAPSHOT_PATH}`);
}

// ── 校验 ───────────────────────────────────────────────────────────────

/** @returns {string[]} 校验错误列表（空 = 通过） */
function validate(snapshot) {
  const errors = [];
  const presets = snapshot.presets;
  if (!Array.isArray(presets) || presets.length !== 12) {
    errors.push(`presets 应为 12 个，实际 ${presets?.length ?? 0}`);
  }
  const sets = snapshot.sets ?? {};
  const expectedSets = [];
  for (const preset of presets) for (const mode of MODES) expectedSets.push(`${preset}-${mode}`);
  for (const setName of expectedSets) {
    const set = sets[setName];
    if (!set) {
      errors.push(`缺少 token set: ${setName}`);
      continue;
    }
    const count = Object.keys(set).length;
    if (count < 28) errors.push(`${setName} 只有 ${count} 个 token（要求 ≥28）`);
    for (const [name, entry] of Object.entries(set)) {
      if (entry.type === "shadow") {
        const layers = entry.value; // shadow.value = layers 数组
        if (!Array.isArray(layers)) {
          errors.push(`${setName}.${name} shadow 值不是 layers 数组`);
          continue;
        }
        for (const layer of layers) {
          if (typeof layer.spread !== "string") {
            errors.push(`${setName}.${name} shadow 层缺 spread`);
          }
        }
      }
      if (name === "focus.ring" && entry.type === "shadow") {
        if (typeof entry.value[0]?.color !== "string") {
          errors.push(`${setName}.focus.ring shadow 缺 layers[0].color`);
        }
      }
    }
  }
  const snowLight = sets["snow-light"];
  if (snowLight?.["bg.base"]?.value !== "#EEF2F7") {
    errors.push(`snow-light bg.base 抽查失败: ${snowLight?.["bg.base"]?.value}`);
  }
  const extra = Object.keys(sets).filter((s) => !expectedSets.includes(s));
  if (extra.length > 0) errors.push(`多余 token set: ${extra.join(", ")}`);
  return errors;
}

// ── CSS 生成 ───────────────────────────────────────────────────────────

/** 一个 set → 排序后的 `--var: value;` 行数组。 */
function setToVarLines(set) {
  const lines = [];
  for (const [name, entry] of Object.entries(set)) {
    const cssVars = VAR_MAP[name];
    if (!cssVars) continue; // 未映射 token 不输出（快照保留完整数据）
    const value = tokenToCssValue({ ...entry, name });
    for (const cssVar of Array.isArray(cssVars) ? cssVars : [cssVars]) {
      lines.push(`  ${cssVar}: ${value};`);
    }
  }
  // 兼容派生：旧类名 island-muted 底色随 preset 走（取 surface.chrome）
  if (set["surface.chrome"]) {
    lines.push(`  --surface-island-muted: ${tokenToCssValue(set["surface.chrome"])};`);
  }
  return lines.sort();
}

function generateCss(snapshot) {
  const sets = snapshot.sets;
  const snowLightLines = setToVarLines(sets["snow-light"]);
  const blocks = [];
  // :root 兜底块 = snow-light，防属性缺失时无样式
  blocks.push(":root {\n" + snowLightLines.join("\n") + "\n}");
  for (const preset of snapshot.presets) {
    for (const mode of MODES) {
      const setName = `${preset}-${mode}`;
      const lines = setName === "snow-light" ? snowLightLines : setToVarLines(sets[setName]);
      blocks.push(`[data-preset="${preset}"][data-theme="${mode}"] {\n${lines.join("\n")}\n}`);
    }
  }
  const header = `/* Generated by scripts/gen-tokens.mjs from src/styles/snowapp-tokens.json. DO NOT EDIT. */\n`;
  return header + blocks.join("\n\n") + "\n";
}

// ── main ───────────────────────────────────────────────────────────────

if (process.argv.includes("--from-research")) {
  fromResearch();
  if (!existsSync(SNAPSHOT_PATH)) throw new Error("快照写入失败");
}

if (!existsSync(SNAPSHOT_PATH)) {
  console.error(`[gen-tokens] 快照不存在: ${SNAPSHOT_PATH}（可用 --from-research 重建）`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
const errors = validate(snapshot);
if (errors.length > 0) {
  console.error("[gen-tokens] 校验失败:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, generateCss(snapshot));
console.log(`[gen-tokens] OK: 24 sets → ${OUT_PATH}`);
