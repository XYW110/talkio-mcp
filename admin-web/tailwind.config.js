/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 语义色板：映射到 index.css 中的 snow-app design tokens（亮/暗自动切换）
        canvas: "var(--canvas)",
        island: "var(--surface-island)",
        "island-strong": "var(--surface-island-strong)",
        "island-muted": "var(--surface-island-muted)",
        hover: "var(--bg-hover)",
        pressed: "var(--bg-active)",
        line: "var(--border-color)",
        "on-solid": "var(--on-solid)",
        ink: {
          DEFAULT: "var(--text-primary)",
          mid: "var(--text-secondary)",
          dim: "var(--text-tertiary)",
          faint: "var(--text-muted)",
        },
        ok: {
          DEFAULT: "var(--accent-green)",
          bg: "var(--accent-green-bg)",
          text: "var(--accent-green-text)",
        },
        bad: {
          DEFAULT: "var(--accent-red)",
          bg: "var(--accent-red-bg)",
          text: "var(--accent-red-text)",
        },
        info: {
          DEFAULT: "var(--accent-blue)",
          bg: "var(--accent-blue-bg)",
          text: "var(--accent-blue-text)",
        },
        warn: {
          DEFAULT: "var(--accent-amber)",
          bg: "var(--accent-amber-bg)",
          text: "var(--accent-amber-text)",
        },
      },
      boxShadow: {
        island: "var(--island-shadow)",
      },
    },
  },
  plugins: [],
};
