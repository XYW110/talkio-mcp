/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 语义色板：映射到 tokens.generated.css 中的 snowapp design tokens（24 preset × mode 切换）
        canvas: "var(--canvas)",
        island: "var(--surface-island)",
        "island-strong": "var(--surface-island-strong)",
        "island-muted": "var(--surface-island-muted)",
        "surface-2": "var(--surface-2)",
        "surface-3": "var(--surface-3)",
        "surface-chrome": "var(--surface-chrome)",
        hover: "var(--bg-hover)",
        pressed: "var(--bg-active)",
        line: "var(--border-color)",
        "border-strong": "var(--border-strong)",
        "on-solid": "var(--on-solid)",
        "accent-ink": "var(--accent-ink)",
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
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      spacing: {
        island: "var(--gap-island)",
      },
      boxShadow: {
        island: "var(--island-shadow)",
        soft: "var(--island-shadow-soft)",
      },
    },
  },
  plugins: [],
};
